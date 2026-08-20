# frozen_string_literal: true

require 'net/http'
require 'resolv'

module Tracks
  # Snap a raw GPS track to real OSM ways via self-hosted Valhalla map
  # matching (vicquick fork).
  #
  # Raw tracks connect points with straight lines — through buildings, across
  # rivers. trace_route (Meili) finds the most probable path along the actual
  # street/path network. Verified on live data: an 18-point 1.4 km walk
  # matches with confidence 1.0 into 1.5 km of real footpaths.
  #
  # The matched line only ever SUPPLEMENTS original_path (new columns), and
  # display falls back to the raw line whenever confidence is low — matching
  # can never lose data.
  #
  # A second call to trace_attributes records metres-per-way-type
  # (footway / rail / road…), which ModeRefiner uses to correct the
  # speed-only transport classification (e.g. driving-speed on rail = train).
  class MapMatcher
    # Store matches above this floor; DISPLAY thresholds live in the
    # serializer and differ by source. Kept low on purpose: for imported
    # tracks (Google Takeout especially) the "original" line is itself an
    # interpolated straight-line guess, so even a mediocre match beats it.
    MIN_CONFIDENCE = 0.35
    MAX_POINTS = 4_000 # Valhalla shape limit guard; tracks are far smaller

    # Which Valhalla costing walks this track's kind of movement?
    COSTING_BY_MODE = {
      'walking' => 'pedestrian',
      'running' => 'pedestrian',
      'cycling' => 'bicycle',
      'driving' => 'auto',
      'motorcycle' => 'auto',
      'bus' => 'bus',
      'unknown' => nil # derive from speed below
    }.freeze

    # Modes that don't follow the routable street network — matching against
    # roads would actively make them WORSE. (Rail matching needs a rail graph
    # Valhalla's default costings don't route over.)
    UNMATCHABLE_MODES = %w[train flying boat stationary].freeze

    def initialize(track)
      @track = track
    end

    def call
      return stamp(:skipped) unless matchable?

      shape = track_shape
      return stamp(:skipped) if shape.length < 2

      costing = costing_for
      return stamp(:skipped) if costing.nil?

      matched = trace_route(shape, costing)
      # Stamp even on failure — matched_at is the backfill's "already tried"
      # marker; without it a low-confidence track would requeue forever.
      return stamp(:low_confidence) if matched.nil?

      uses = trace_uses(shape, costing)

      @track.update_columns(
        matched_path: matched[:line],
        matched_confidence: matched[:confidence],
        matched_uses: uses,
        matched_at: Time.current
      )
      :matched
    rescue StandardError => e
      Rails.logger.warn("Tracks::MapMatcher track=#{@track.id}: #{e.class}: #{e.message}")
      :error
    end

    private

    def stamp(result)
      @track.update_columns(matched_at: Time.current)
      result
    end

    def matchable?
      !UNMATCHABLE_MODES.include?(@track.dominant_mode.to_s)
    end

    def costing_for
      explicit = COSTING_BY_MODE[@track.dominant_mode.to_s]
      return explicit if explicit

      # Unknown mode: pick by speed — same boundaries the classifier uses.
      speed = @track.avg_speed.to_f
      return 'pedestrian' if speed <= 8
      return 'bicycle' if speed <= 28

      'auto'
    end

    def track_shape
      @track.points.order(:timestamp).limit(MAX_POINTS).pluck(:lonlat, :timestamp).map do |lonlat, ts|
        { lat: lonlat.y, lon: lonlat.x, time: ts }
      end
    end

    def trace_route(shape, costing)
      res = valhalla_post('/trace_route', {
                            shape: shape,
                            costing: costing,
                            shape_match: 'map_snap',
                            format: 'osrm'
                          })
      return nil unless res.is_a?(Net::HTTPSuccess)

      json = Oj.load(res.body)
      matching = json['matchings']&.first
      return nil if matching.nil?

      confidence = matching['confidence'].to_f
      return nil if confidence < MIN_CONFIDENCE

      coords = decode_polyline6(matching['geometry'].to_s)
      return nil if coords.length < 2

      factory = @track.original_path.factory
      line = factory.line_string(coords.map { |lon, lat| factory.point(lon, lat) })
      { line: line, confidence: confidence }
    end

    def trace_uses(shape, costing)
      res = valhalla_post('/trace_attributes', {
                            shape: shape.map { |p| p.except(:time) },
                            costing: costing,
                            shape_match: 'map_snap',
                            filters: { attributes: ['edge.use', 'edge.length'], action: 'include' }
                          })
      return nil unless res.is_a?(Net::HTTPSuccess)

      edges = Oj.load(res.body)['edges'] || []
      # km per way-type, rounded — enough signal for mode refinement.
      edges.group_by { |e| e['use'].to_s }
           .transform_values { |v| v.sum { |e| e['length'].to_f }.round(3) }
    rescue StandardError
      nil
    end

    def valhalla_post(path, body)
      base = ENV['VALHALLA_URL'].presence || 'http://localhost:8002'
      uri = URI("#{base}#{path}")
      # Docker publishes A + AAAA records; Valhalla binds IPv4 only and Ruby
      # may pick the AAAA → connection refused. Pin IPv4 (same fix as
      # routing_controller#valhalla_base).
      begin
        ipv4 = Resolv.getaddresses(uri.host).find { |a| a.match?(/\A\d{1,3}(\.\d{1,3}){3}\z/) }
        uri.host = ipv4 if ipv4
      rescue StandardError
        # keep the hostname
      end
      http = Net::HTTP.new(uri.host, uri.port)
      http.open_timeout = 3
      http.read_timeout = 20
      req = Net::HTTP::Post.new(uri, 'Content-Type' => 'application/json')
      req.body = Oj.dump(body, mode: :compat)
      http.request(req)
    end

    # OSRM format returns polyline6 in `geometry` (precision 1e-6).
    def decode_polyline6(str)
      coords = []
      index = lat = lon = 0
      while index < str.length
        [1, 0].each do |is_lat|
          shift = result = 0
          loop do
            b = str[index].ord - 63
            index += 1
            result |= (b & 0x1f) << shift
            shift += 5
            break if b < 0x20
          end
          delta = result.odd? ? ~(result >> 1) : (result >> 1)
          if is_lat == 1 then lat += delta else lon += delta end
        end
        coords << [lon / 1e6, lat / 1e6]
      end
      coords
    rescue StandardError
      []
    end
  end
end
