# frozen_string_literal: true

require 'resolv'

# Directions/routing proxy to a self-hosted Valhalla engine.
# Added in the vicquick/dawarich fork to bring turn-by-turn routing into
# Dawarich's own map (synthesizing Dawarich + Atlas). Geometry is decoded
# server-side to GeoJSON so the MapLibre frontend can render it directly.
class Api::V1::RoutingController < ApiController
  VALID_COSTINGS = %w[auto bicycle pedestrian bus truck motor_scooter].freeze

  def directions
    locations = parse_locations
    return render_error('Need at least 2 valid locations (lat,lon)') if locations.size < 2

    costing = params[:costing].to_s
    costing = 'auto' unless VALID_COSTINGS.include?(costing)

    body = {
      locations: locations,
      costing: costing,
      alternates: 2, # ask Valhalla for up to 2 alternative routes
      directions_options: { units: 'kilometers' }
    }

    response = valhalla_post('/route', body)
    return render_error("Routing engine error: #{response.code}", :bad_gateway) unless response.success?

    data = Oj.load(response.body)
    trips = [data['trip']] + Array(data['alternates']).map { |a| a['trip'] }
    trips = trips.compact.select { |t| t['legs'].present? }
    return render_error('No route found') if trips.empty?

    # routes[0] is the best; the rest are selectable alternatives.
    render json: { routes: trips.map { |t| build_geojson(t) } }, status: :ok
  rescue Faraday::Error, Net::OpenTimeout, Net::ReadTimeout => e
    render_error("Routing engine unreachable: #{e.message}", :service_unavailable)
  end

  # Public-transport routing via self-hosted OTP2 (all-Germany GTFS). Returns
  # itineraries (legs of walk + transit) the MapLibre frontend can list + draw.
  def transit
    from = parse_point(params[:from])
    to   = parse_point(params[:to])
    return render_error('Need from and to {lat,lon}') unless from && to

    otp = ENV['OTP_URL'].presence
    return render(json: { error: 'transit_unavailable' }, status: :service_unavailable) unless otp

    resp = Faraday.post("#{otp}/otp/routers/default/index/graphql") do |r|
      r.headers['Content-Type'] = 'application/json'
      r.body = { query: OTP_PLAN_QUERY, variables: {
        fromLat: from[:lat], fromLon: from[:lon], toLat: to[:lat], toLon: to[:lon]
      } }.to_json
      r.options.timeout = 25
      r.options.open_timeout = 5
    end
    return render_error("Transit engine error: #{resp.status}", :bad_gateway) unless resp.success?

    its = Oj.load(resp.body).dig('data', 'plan', 'itineraries') || []
    render json: { itineraries: its.map { |it| build_itinerary(it) } }, status: :ok
  rescue Faraday::Error, Net::OpenTimeout, Net::ReadTimeout
    render json: { error: 'transit_unavailable' }, status: :service_unavailable
  end

  OTP_PLAN_QUERY = <<~GQL
    query Plan($fromLat: Float!, $fromLon: Float!, $toLat: Float!, $toLon: Float!) {
      plan(from: {lat: $fromLat, lon: $fromLon}, to: {lat: $toLat, lon: $toLon},
           transportModes: [{mode: WALK}, {mode: TRANSIT}], numItineraries: 4,
           searchWindow: 25200) {
        itineraries {
          startTime endTime duration walkDistance numberOfTransfers
          legs {
            mode startTime endTime distance duration
            from { name lat lon } to { name lat lon }
            route { shortName longName mode color }
            trip { tripHeadsign }
            legGeometry { points }
          }
        }
      }
    }
  GQL

  # Which ride-hailing providers operate at a given point. Reverse-geocodes the
  # pickup to a country (Photon) and checks per-provider country allowlists, so
  # the app only offers Uber/Bolt where they actually exist. Cached 30 days.
  def providers
    lat = params[:lat].to_f
    lon = params[:lon].to_f
    return render(json: { providers: [] }) if lat.zero? && lon.zero?

    cc = Rails.cache.fetch("ride_cc/#{lat.round(1)}/#{lon.round(1)}", expires_in: 30.days) do
      reverse_country_code(lat, lon)
    end
    providers = []
    providers << 'uber' if cc && UBER_COUNTRIES.include?(cc)
    providers << 'bolt' if cc && BOLT_COUNTRIES.include?(cc)
    render json: { country: cc, providers: providers }
  rescue StandardError
    render json: { providers: [] }
  end

  private

  # ISO-3166-1 alpha-2 country codes where each provider operates (coarse, kept
  # deliberately conservative; expand as needed).
  UBER_COUNTRIES = %w[
    US CA MX GB IE FR DE NL BE PT ES IT CH AT PL CZ RO SE FI NO DK
    AU NZ JP IN BR AR CL CO PE EC CR PA DO ZA EG NG KE TZ UG SA AE QA
    TR UA GE TW HK
  ].freeze
  BOLT_COUNTRIES = %w[
    EE LV LT FI SE PL DE FR PT ES IT NL BE AT CZ SK HU RO BG HR SI GR CY MT
    GB IE UA GE AZ MD RS BA MK AL
    NG GH KE TZ UG ZA ZM MZ
    MX
  ].freeze

  def reverse_country_code(lat, lon)
    uri = URI("#{photon_base}/reverse")
    uri.query = URI.encode_www_form(lat: lat, lon: lon, limit: 1)
    resp = Faraday.get(uri.to_s) { |r| r.options.timeout = 6 }
    return nil unless resp.success?

    Oj.load(resp.body).dig('features', 0, 'properties', 'countrycode')&.upcase
  end

  def photon_base
    host = ENV['PHOTON_API_HOST'].presence || 'localhost:2322'
    scheme = ENV['PHOTON_API_USE_HTTPS'] == 'true' ? 'https' : 'http'
    host.include?('://') ? host : "#{scheme}://#{host}"
  end

  def parse_point(raw)
    return nil if raw.blank?
    raw = JSON.parse(raw) if raw.is_a?(String)
    lat = raw['lat'] || raw[:lat]
    lon = raw['lon'] || raw[:lon]
    return nil if lat.nil? || lon.nil?

    { lat: lat.to_f, lon: lon.to_f }
  end

  # Compact one OTP itinerary: total times + each leg (mode, line, headsign,
  # stops, decoded geometry for drawing).
  def build_itinerary(it)
    legs = Array(it['legs']).map do |l|
      route = l['route'] || {}
      {
        mode: l['mode'],
        start_time: l['startTime'],
        end_time: l['endTime'],
        duration_s: l['duration'],
        distance_m: l['distance'],
        from: l.dig('from', 'name'),
        to: l.dig('to', 'name'),
        line: route['shortName'] || route['longName'],
        headsign: l.dig('trip', 'tripHeadsign'),
        color: route['color'] ? "##{route['color']}" : nil,
        geometry: decode_polyline5(l.dig('legGeometry', 'points'))
      }
    end
    {
      start_time: it['startTime'],
      end_time: it['endTime'],
      duration_s: it['duration'],
      walk_distance_m: it['walkDistance'],
      transfers: it['numberOfTransfers'],
      legs: legs
    }
  end

  # OTP encodes leg geometry as a standard polyline, precision 1e5.
  def decode_polyline5(str)
    return [] if str.blank?

    index = 0
    lat = 0
    lng = 0
    coords = []
    factor = 1e5
    while index < str.length
      shift = 0; result = 0
      loop do
        b = str[index].ord - 63; index += 1
        result |= (b & 0x1f) << shift; shift += 5
        break if b < 0x20
      end
      lat += (result.odd? ? ~(result >> 1) : (result >> 1))
      shift = 0; result = 0
      loop do
        b = str[index].ord - 63; index += 1
        result |= (b & 0x1f) << shift; shift += 5
        break if b < 0x20
      end
      lng += (result.odd? ? ~(result >> 1) : (result >> 1))
      coords << [lng / factor, lat / factor]
    end
    coords
  end

  def parse_locations
    raw = params[:locations]
    raw = JSON.parse(raw) if raw.is_a?(String)
    Array(raw).filter_map do |loc|
      lat = loc['lat'] || loc[:lat]
      lon = loc['lon'] || loc[:lon]
      next if lat.nil? || lon.nil?

      { lat: lat.to_f, lon: lon.to_f }
    end
  end

  def valhalla_base
    url = ENV['VALHALLA_URL'].presence || 'http://localhost:8002'
    uri = URI(url)
    # Docker assigns both A and AAAA records; Valhalla binds IPv4 only, and Ruby's
    # resolver may prefer the IPv6 address → "connection refused". Pin to IPv4.
    begin
      ipv4 = Resolv.getaddresses(uri.host).find { |a| a.match?(/\A\d{1,3}(\.\d{1,3}){3}\z/) }
      uri.host = ipv4 if ipv4
    rescue StandardError
      # fall back to the original host
    end
    uri.to_s
  end

  def valhalla_post(path, body)
    Faraday.post("#{valhalla_base}#{path}") do |req|
      req.headers['Content-Type'] = 'application/json'
      req.body = body.to_json
      req.options.timeout = 20
      req.options.open_timeout = 5
    end
  end

  # Valhalla returns an encoded polyline (precision 6) per leg + maneuvers.
  def build_geojson(trip)
    legs = trip['legs']
    coords = legs.flat_map { |leg| decode_polyline6(leg['shape']) }
    # begin_shape_index lets the frontend locate each turn on the polyline (for
    # the "next maneuver" highlight + nav camera). Indices are per-leg, so offset
    # them by the running vertex count as legs are concatenated.
    offset = 0
    maneuvers = legs.flat_map do |leg|
      leg_pts = decode_polyline6(leg['shape']).length
      ms = (leg['maneuvers'] || []).map do |m|
        {
          instruction: m['instruction'],
          length_km: m['length'],
          time_s: m['time'],
          type: m['type'],
          begin_shape_index: (m['begin_shape_index'] || 0) + offset
        }
      end
      offset += leg_pts
      ms
    end
    summary = trip['summary'] || {}

    {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: coords },
      properties: {
        distance_km: summary['length'],
        duration_s: summary['time'],
        costing: trip['status_message'],
        maneuvers: maneuvers
      }
    }
  end

  # Valhalla polyline, precision 1e6. Returns [[lon,lat], ...] for GeoJSON.
  def decode_polyline6(str)
    return [] if str.blank?

    index = 0
    lat = 0
    lng = 0
    coordinates = []
    factor = 1e6
    while index < str.length
      shift = 0
      result = 0
      loop do
        b = str[index].ord - 63
        index += 1
        result |= (b & 0x1f) << shift
        shift += 5
        break if b < 0x20
      end
      lat += (result.odd? ? ~(result >> 1) : (result >> 1))

      shift = 0
      result = 0
      loop do
        b = str[index].ord - 63
        index += 1
        result |= (b & 0x1f) << shift
        shift += 5
        break if b < 0x20
      end
      lng += (result.odd? ? ~(result >> 1) : (result >> 1))

      coordinates << [lng / factor, lat / factor]
    end
    coordinates
  end

  def render_error(message, status = :unprocessable_content)
    render json: { error: message }, status: status
  end
end
