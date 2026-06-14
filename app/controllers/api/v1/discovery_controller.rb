# frozen_string_literal: true

require 'resolv'

# Google-Maps-style discovery (vicquick fork) — fully self-hosted where possible.
# `nearby`     → category POIs around a point via self-hosted Photon (private).
# `place_info` → opening hours / phone / website for one OSM element via the
#                open OpenStreetMap API (open data, non-commercial; swap to a
#                self-hosted Overpass later for zero external calls).
class Api::V1::DiscoveryController < ApiController
  CATEGORIES = {
    'restaurant' => 'amenity:restaurant',
    'cafe'       => 'amenity:cafe',
    'bar'        => 'amenity:bar',
    'fuel'       => 'amenity:fuel',
    'atm'        => 'amenity:atm',
    'shopping'   => 'shop:supermarket',
    'hotel'      => 'tourism:hotel',
    'pharmacy'   => 'amenity:pharmacy',
  }.freeze

  def nearby
    lat = params[:lat]&.to_f
    lon = params[:lon]&.to_f
    return render_error('lat/lon required') if lat.nil? || lon.nil?

    osm_tag = CATEGORIES[params[:category].to_s] || 'amenity:restaurant'
    q = params[:q].presence || params[:category].presence || 'place'

    uri = URI("#{photon_base}/api")
    uri.query = URI.encode_www_form(q: q, lat: lat, lon: lon, limit: (params[:limit] || 15).to_i, osm_tag: osm_tag)
    resp = http_get(uri)
    return render_error('Search engine error', :bad_gateway) unless resp&.is_a?(Net::HTTPSuccess)

    features = Oj.load(resp.body)['features'] || []
    results = features.map do |f|
      p = f['properties']; c = f['geometry']['coordinates']
      {
        name: p['name'] || [p['street'], p['housenumber']].compact.join(' '),
        category: p['osm_value'],
        address: [p['street'], p['housenumber'], p['postcode'], p['city']].compact.join(' '),
        lat: c[1], lon: c[0],
        osm_type: p['osm_type'], osm_id: p['osm_id'],
        distance_m: haversine(lat, lon, c[1], c[0]).round
      }
    end.sort_by { |r| r[:distance_m] }

    render json: { results: results }
  end

  def place_info
    type = { 'N' => 'node', 'W' => 'way', 'R' => 'relation' }[params[:osm_type].to_s.upcase[0]]
    id = params[:osm_id].to_s[/\d+/]
    return render_error('osm_type + osm_id required') if type.nil? || id.nil?

    uri = URI("https://api.openstreetmap.org/api/0.6/#{type}/#{id}.json")
    resp = http_get(uri, host_header: nil)
    return render json: { tags: {} } unless resp&.is_a?(Net::HTTPSuccess)

    tags = (Oj.load(resp.body)['elements'] || []).first&.dig('tags') || {}
    hours = tags['opening_hours']
    render json: {
      opening_hours: hours,
      open_now: hours ? open_now?(hours) : nil,
      phone: tags['phone'] || tags['contact:phone'],
      website: tags['website'] || tags['contact:website'],
      cuisine: tags['cuisine'],
      brand: tags['brand'],
      wheelchair: tags['wheelchair']
    }
  end

  private

  def photon_base
    host = ENV['PHOTON_API_HOST'].presence || 'localhost:2322'
    scheme = ENV['PHOTON_API_USE_HTTPS'] == 'true' ? 'https' : 'http'
    url = host.include?('://') ? host : "#{scheme}://#{host}"
    uri = URI(url)
    begin
      ipv4 = Resolv.getaddresses(uri.host).find { |a| a.match?(/\A\d{1,3}(\.\d{1,3}){3}\z/) }
      uri.host = ipv4 if ipv4
    rescue StandardError
    end
    uri.to_s.chomp('/')
  end

  def http_get(uri, host_header: :auto)
    http = Net::HTTP.new(uri.host, uri.port)
    http.use_ssl = uri.scheme == 'https'
    http.open_timeout = 5
    http.read_timeout = 15
    req = Net::HTTP::Get.new(uri)
    req['User-Agent'] = 'Dawarich-vicquick/1.0'
    http.request(req)
  rescue StandardError
    nil
  end

  def haversine(lat1, lon1, lat2, lon2)
    rad = Math::PI / 180
    r = 6_371_000
    dlat = (lat2 - lat1) * rad
    dlon = (lon2 - lon1) * rad
    a = Math.sin(dlat / 2)**2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dlon / 2)**2
    2 * r * Math.asin(Math.sqrt(a))
  end

  # Best-effort "open now" for common opening_hours patterns. Complex rules → nil (unknown).
  def open_now?(spec)
    return nil if spec.blank? || spec.include?('PH') || spec.include?('week') || spec.include?('"')
    return true if spec.strip == '24/7'

    now = Time.current
    day = %w[Mo Tu We Th Fr Sa Su][(now.wday + 6) % 7]
    minutes = now.hour * 60 + now.min
    spec.split(';').each do |rule|
      rule = rule.strip
      days_part, times_part = rule.split(/\s+/, 2)
      next unless times_part
      next unless day_matches?(days_part, day)

      times_part.split(',').each do |range|
        m = range.strip.match(/\A(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})\z/)
        next unless m

        from = m[1].to_i * 60 + m[2].to_i
        to = m[3].to_i * 60 + m[4].to_i
        to += 24 * 60 if to <= from
        return true if minutes >= from && minutes <= to
      end
    end
    false
  rescue StandardError
    nil
  end

  def day_matches?(days_part, day)
    order = %w[Mo Tu We Th Fr Sa Su]
    return true if days_part.nil? || days_part.match?(/\A\d/) # times-only = every day
    days_part.split(',').any? do |token|
      if token.include?('-')
        a, b = token.split('-')
        ia = order.index(a); ib = order.index(b); idx = order.index(day)
        ia && ib && idx && (ia <= ib ? (ia..ib).include?(idx) : (idx >= ia || idx <= ib))
      else
        token == day
      end
    end
  end

  def render_error(message, status = :unprocessable_content)
    render json: { error: message }, status: status
  end
end
