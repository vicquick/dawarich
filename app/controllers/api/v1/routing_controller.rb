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

    # Prefer MOTIS (lighter engine + correct regional feeds); fall back to OTP2.
    motis = ENV['MOTIS_URL'].presence
    return transit_motis(pin_ipv4(motis), from, to) if motis

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

  # MOTIS (motis-project) GET /api/v1/plan — fromPlace/toPlace as "lat,lon", ISO time.
  def transit_motis(base, from, to)
    resp = Faraday.get("#{base}/api/v1/plan") do |r|
      r.params['fromPlace'] = "#{from[:lat]},#{from[:lon]}"
      r.params['toPlace']   = "#{to[:lat]},#{to[:lon]}"
      r.params['time']      = Time.now.utc.iso8601
      r.params['arriveBy']  = 'false'
      r.options.timeout = 25
      r.options.open_timeout = 5
    end
    return render_error("Transit engine error: #{resp.status}", :bad_gateway) unless resp.success?

    its = Oj.load(resp.body)['itineraries'] || []
    render json: { itineraries: its.map { |it| build_motis_itinerary(it) } }, status: :ok
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

  # Live road incidents (closures/roadworks/restrictions) from NAPSPAN, as
  # GeoJSON for a map viewport. Free tier = events (no live speeds). The API key
  # stays server-side. Cached 5 min (incidents change slowly + respects quota).
  def traffic_incidents
    key = ENV['NAPSPAN_API_KEY'].presence
    return render(json: EMPTY_FC) unless key

    bbox = parse_bbox(params) # {min_lng,min_lat,max_lng,max_lat}
    return render_error('bbox required (min_longitude,…)') unless bbox

    cx = (bbox[:min_lng] + bbox[:max_lng]) / 2.0
    cy = (bbox[:min_lat] + bbox[:max_lat]) / 2.0
    radius = [(haversine(cy, bbox[:min_lng], cy, bbox[:max_lng]) / 2000.0).ceil + 5, 150].min
    states = GERMAN_STATES.select { |_, b| boxes_intersect?(bbox, b) }.keys.first(4)
    return render(json: EMPTY_FC) if states.empty?

    feats = Rails.cache.fetch("napspan/#{states.join(',')}/#{cx.round(1)}/#{cy.round(1)}/#{radius}", expires_in: 5.minutes) do
      states.flat_map { |st| napspan_events(key, st, cx, cy, radius) }
    end
    render json: { type: 'FeatureCollection', features: feats }
  rescue StandardError
    render json: EMPTY_FC
  end

  private

  EMPTY_FC = { type: 'FeatureCollection', features: [] }.freeze

  # Rough [min_lng, min_lat, max_lng, max_lat] per German Bundesland → NAPSPAN code.
  GERMAN_STATES = {
    'DEU-SH' => [7.8, 53.3, 11.4, 55.1], 'DEU-HH' => [9.6, 53.3, 10.4, 53.8],
    'DEU-HB' => [8.4, 53.0, 9.0, 53.65], 'DEU-NI' => [6.6, 51.2, 11.7, 53.95],
    'DEU-MV' => [10.5, 53.0, 14.5, 54.8], 'DEU-NW' => [5.8, 50.3, 9.5, 52.6],
    'DEU-BB' => [11.2, 51.3, 14.9, 53.6], 'DEU-BE' => [13.0, 52.3, 13.8, 52.7],
    'DEU-ST' => [10.5, 50.9, 13.3, 53.1], 'DEU-SN' => [11.8, 50.1, 15.1, 51.7],
    'DEU-TH' => [9.8, 50.2, 12.7, 51.7], 'DEU-HE' => [7.7, 49.3, 10.3, 51.7],
    'DEU-RP' => [6.1, 48.9, 8.6, 51.0], 'DEU-SL' => [6.3, 49.1, 7.5, 49.7],
    'DEU-BW' => [7.5, 47.5, 10.6, 49.8], 'DEU-BY' => [8.9, 47.2, 14.0, 50.6]
  }.freeze

  def boxes_intersect?(a, b)
    a[:min_lng] <= b[2] && a[:max_lng] >= b[0] && a[:min_lat] <= b[3] && a[:max_lat] >= b[1]
  end

  def napspan_events(key, jurisdiction, cx, cy, radius)
    resp = Faraday.get('https://api.napspan.com/api/v1/events') do |r|
      r.headers['X-API-Key'] = key
      r.params['jurisdiction'] = jurisdiction
      r.params['lat'] = cy
      r.params['lng'] = cx
      r.params['radius_km'] = radius
      r.params['status'] = 'active'
      r.params['limit'] = 200
      r.options.timeout = 12
    end
    return [] unless resp.success?

    Array(Oj.load(resp.body)['data']).filter_map do |e|
      coords = e.dig('location', 'coordinates') || [e['longitude'], e['latitude']]
      next unless coords && coords[0] && coords[1]

      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [coords[0].to_f, coords[1].to_f] },
        properties: {
          id: e['id'], type: e['type'], sub_type: e['sub_type'], severity: e['severity'],
          title: e['title'], road: Array(e['affected_roads']).join(', '), description: e['description']
        }
      }
    end
  rescue StandardError
    []
  end

  def parse_bbox(params)
    if params[:bbox].present?
      a = params[:bbox].to_s.split(',').map(&:to_f)
      return nil unless a.size == 4

      return { min_lng: a[0], min_lat: a[1], max_lng: a[2], max_lat: a[3] }
    end
    return nil if params[:min_longitude].blank?

    { min_lng: params[:min_longitude].to_f, min_lat: params[:min_latitude].to_f,
      max_lng: params[:max_longitude].to_f, max_lat: params[:max_latitude].to_f }
  rescue StandardError
    nil
  end

  def haversine(lat1, lon1, lat2, lon2)
    r = 6_371_000.0
    to_rad = ->(d) { d * Math::PI / 180 }
    dlat = to_rad.call(lat2 - lat1)
    dlon = to_rad.call(lon2 - lon1)
    a = (Math.sin(dlat / 2)**2) + (Math.cos(to_rad.call(lat1)) * Math.cos(to_rad.call(lat2)) * (Math.sin(dlon / 2)**2))
    2 * r * Math.asin(Math.sqrt(a))
  end

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

  # Decode a Google-style polyline. OTP uses precision 5; MOTIS uses 7 (it
  # reports `precision` in legGeometry).
  def decode_polyline5(str, precision = 5)
    return [] if str.blank?

    index = 0
    lat = 0
    lng = 0
    coords = []
    factor = 10.0**precision
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

  # Map a MOTIS itinerary to the same shape the frontend consumes.
  def build_motis_itinerary(it)
    legs = Array(it['legs']).map do |l|
      geo = l['legGeometry'] || {}
      {
        mode: motis_mode(l['mode']),
        start_time: iso_ms(l['startTime']),
        end_time: iso_ms(l['endTime']),
        duration_s: l['duration'],
        distance_m: l['distance'],
        from: l.dig('from', 'name'),
        to: l.dig('to', 'name'),
        line: clean_line(l['routeShortName'].presence || l['routeLongName']),
        headsign: l['headsign'],
        color: l['routeColor'].present? ? "##{l['routeColor']}" : nil,
        real_time: l['realTime'],
        geometry: decode_polyline5(geo['points'], (geo['precision'] || 5).to_i)
      }
    end
    {
      start_time: iso_ms(it['startTime']),
      end_time: iso_ms(it['endTime']),
      duration_s: it['duration'],
      walk_distance_m: nil,
      transfers: it['transfers'],
      legs: legs
    }
  end

  # Docker publishes both A + AAAA; Ruby's resolver may prefer the IPv6 address
  # which the service (IPv4-only) refuses. Pin the host to its IPv4.
  def pin_ipv4(url)
    uri = URI(url)
    ipv4 = Resolv.getaddresses(uri.host).find { |a| a.match?(/\A\d{1,3}(\.\d{1,3}){3}\z/) }
    uri.host = ipv4 if ipv4
    uri.to_s
  rescue StandardError
    url
  end

  def iso_ms(str)
    return nil if str.blank?

    (Time.parse(str).to_f * 1000).to_i
  rescue StandardError
    nil
  end

  # Normalise MOTIS modes to the small set the frontend colours/icons know.
  def motis_mode(mode)
    case mode.to_s
    when 'WALK' then 'WALK'
    when 'METRO', 'SUBWAY' then 'SUBWAY'
    when 'TRAM' then 'TRAM'
    when 'BUS', 'COACH' then 'BUS'
    when 'FERRY' then 'FERRY'
    else 'RAIL' # REGIONAL_RAIL, HIGHSPEED_RAIL, LONG_DISTANCE, RAIL, ...
    end
  end

  # MOTIS routeShortName comes as e.g. "RE3 (81620)" — drop the trip number.
  def clean_line(str)
    return nil if str.blank?

    str.sub(/\s*\(\d+\)\s*\z/, '').strip
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
