# frozen_string_literal: true

require 'resolv'
require 'digest'
require 'cgi'

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

  # Overpass tag filters per category (richer than Photon — carries opening_hours).
  OVERPASS_FILTERS = {
    'restaurant'  => '[amenity=restaurant]',
    'cafe'        => '[amenity=cafe]',
    'bar'         => '[amenity~"^(bar|pub)$"]',
    'fuel'        => '[amenity=fuel]',
    'atm'         => '[amenity~"^(atm|bank)$"]',
    'shopping'    => '[shop]',
    'supermarket' => '[shop=supermarket]',
    'hotel'       => '[tourism=hotel]',
    'pharmacy'    => '[amenity=pharmacy]'
  }.freeze

  def nearby
    lat = params[:lat]&.to_f
    lon = params[:lon]&.to_f
    return render_error('lat/lon required') if lat.nil? || lon.nil?

    category = params[:category].to_s
    limit = (params[:limit] || 15).to_i.clamp(1, 50)
    radius = (params[:radius] || 1500).to_i.clamp(100, 5000)
    open_only = params[:open_now].to_s == 'true'

    # Cache the raw POI list (Redis, ~111m bucket); open-now is recomputed fresh
    # below so it's never stale. Prefer Overpass, fall back to Photon.
    key = "v1/nearby/#{category}/#{lat.round(3)}/#{lon.round(3)}/#{radius}"
    results = Rails.cache.fetch(key, expires_in: 6.hours) do
      overpass_nearby(lat, lon, category, radius) || photon_nearby(lat, lon, category, limit)
    end
    return render_error('Search engine error', :bad_gateway) if results.nil?

    results = results.map { |r| r.merge(open_now: r[:opening_hours] ? open_now?(r[:opening_hours]) : nil) }
    results = results.select { |r| r[:open_now] } if open_only
    results = results.sort_by { |r| r[:distance_m] }.first(limit)
    render json: { results: results }
  end

  def place_info
    type = { 'N' => 'node', 'W' => 'way', 'R' => 'relation' }[params[:osm_type].to_s.upcase[0]]
    id = params[:osm_id].to_s[/\d+/]
    return render_error('osm_type + osm_id or lat + lon required') if type.nil? && params[:lat].blank?

    # Cache the stable OSM tags (Redis); open_now / today_hours are recomputed
    # fresh on every request so they're never served stale.
    cache_key = if type && id
                  "v2/place_info/#{type}/#{id}"
                else
                  "v2/place_info/coord/#{params[:lat].to_f.round(5)}/#{params[:lon].to_f.round(5)}/#{Digest::MD5.hexdigest(params[:name].to_s)}"
                end
    tags = Rails.cache.fetch(cache_key, expires_in: 14.days) { fetch_place_tags(type, id) || {} }

    # Extra resources beyond OSM: Wikidata (notable places) → Wikimedia Commons
    # (nearby open photo) → Brave (ratings/description, external, opt-in key).
    wd = wikidata_info(tags['wikidata'] || tags['brand:wikidata'])
    lat = params[:lat]&.to_f || tags['lat']&.to_f
    lon = params[:lon]&.to_f || tags['lon']&.to_f
    brave = brave_info([tags['name'] || params[:name], tags['addr:city']].compact.join(' ').presence, lat, lon)
    image = wd&.dig(:image) || brave&.dig(:image) || commons_photo(lat, lon)
    hours = tags['opening_hours']
    render json: {
      opening_hours: hours,
      open_now: hours ? open_now?(hours) : nil,
      today_hours: hours ? today_hours(hours) : nil,
      week_hours: hours ? week_hours(hours) : nil,
      phone: tags['phone'] || tags['contact:phone'],
      website: tags['website'] || tags['contact:website'] || wd&.dig(:website),
      description: wd&.dig(:description) || brave&.dig(:description),
      image: image,
      rating: brave&.dig(:rating),
      cuisine: tags['cuisine'],
      brand: tags['brand'],
      wheelchair: tags['wheelchair']
    }
  end

  # OSM tags for a place, by OSM id (Overpass→OSM API) or by coords+name
  # (Overpass around) for map-tapped POIs that only carry vector-tile ids.
  def fetch_place_tags(type, id)
    tags = nil
    if type && id
      tags = overpass_element(type, id)
      if tags.nil?
        uri = URI("https://api.openstreetmap.org/api/0.6/#{type}/#{id}.json")
        resp = http_get(uri, host_header: nil)
        tags = resp&.is_a?(Net::HTTPSuccess) ? (Oj.load(resp.body)['elements'] || []).first&.dig('tags') : nil
      end
    end
    if tags.blank? && params[:lat].present? && params[:lon].present?
      tags = overpass_around_tags(params[:lat].to_f, params[:lon].to_f, params[:name])
    end
    tags
  end

  # Open-data lookup (Wikidata) to fill fields OSM lacks. Sends only an
  # anonymous Q-id; cached 30 days. No Google/Brave.
  def wikidata_info(qid)
    return nil unless qid.is_a?(String) && qid.match?(/\AQ\d+\z/)

    Rails.cache.fetch("v1/wikidata/#{qid}", expires_in: 30.days) do
      uri = URI("https://www.wikidata.org/wiki/Special:EntityData/#{qid}.json")
      resp = http_get(uri, host_header: nil)
      if resp&.is_a?(Net::HTTPSuccess)
        ent = Oj.load(resp.body).dig('entities', qid) || {}
        claims = ent['claims'] || {}
        website = claims.dig('P856', 0, 'mainsnak', 'datavalue', 'value')
        image = claims.dig('P18', 0, 'mainsnak', 'datavalue', 'value')
        image_url = image ? "https://commons.wikimedia.org/wiki/Special:FilePath/#{URI.encode_www_form_component(image)}?width=480" : nil
        desc = ent.dig('descriptions', 'en', 'value') || ent.dig('descriptions', 'de', 'value')
        { website: website, image: image_url, description: desc }
      end
    end
  rescue StandardError
    nil
  end

  # Strip HTML tags + unescape entities from a snippet (Brave descriptions).
  def strip_html(str)
    return nil if str.blank?

    CGI.unescapeHTML(str.gsub(/<[^>]+>/, '')).strip.presence
  end

  # Open photo near the coords from Wikimedia Commons (free, no key). Tight
  # radius so it's likely the place itself; hit-or-miss for ordinary POIs.
  def commons_photo(lat, lon)
    return nil if lat.nil? || lon.nil?

    Rails.cache.fetch("v1/commons/#{lat.round(4)}/#{lon.round(4)}", expires_in: 30.days) do
      uri = URI("https://commons.wikimedia.org/w/api.php?action=query&list=geosearch" \
                "&gscoord=#{lat}%7C#{lon}&gsradius=110&gslimit=1&gsnamespace=6&format=json")
      resp = http_get(uri, host_header: nil)
      next nil unless resp&.is_a?(Net::HTTPSuccess)

      f = (Oj.load(resp.body).dig('query', 'geosearch') || []).first
      next nil unless f && f['title']

      title = f['title'].sub(/\AFile:/, '')
      "https://commons.wikimedia.org/wiki/Special:FilePath/#{URI.encode_www_form_component(title)}?width=480"
    end
  rescue StandardError
    nil
  end

  # Brave Search (external, opt-in) — description + photo for a place. Needs
  # ENV['BRAVE_SEARCH_API_KEY']; ratings require Brave's paid Local plan.
  def brave_info(name, _lat, _lon)
    key = ENV['BRAVE_SEARCH_API_KEY'].presence
    return nil if key.blank? || name.blank?

    Rails.cache.fetch("v1/brave/#{Digest::MD5.hexdigest(name)}", expires_in: 14.days) do
      uri = URI("https://api.search.brave.com/res/v1/web/search?q=#{URI.encode_www_form_component(name)}&count=3")
      http = Net::HTTP.new(uri.host, uri.port)
      http.use_ssl = true
      http.open_timeout = 5
      http.read_timeout = 10
      req = Net::HTTP::Get.new(uri)
      req['X-Subscription-Token'] = key
      req['Accept'] = 'application/json'
      resp = http.request(req)
      next nil unless resp.is_a?(Net::HTTPSuccess)

      data = Oj.load(resp.body)
      info = data.dig('infobox', 'results', 0) || {}
      result = data.dig('web', 'results', 0) || {}
      desc = info['long_desc'] || info['description'] || result['description']
      thumb = info.dig('thumbnail', 'src') || result.dig('thumbnail', 'src')
      {
        description: strip_html(desc),
        image: thumb,
        rating: info.dig('rating', 'ratingValue') || info['rating']
      }.compact.presence
    end
  rescue StandardError
    nil
  end

  # Today's opening ranges from an opening_hours spec, e.g. "08:00–18:00" or
  # "08:00–13:00, 15:00–19:00", or "Closed today" / nil if not parseable.
  def today_hours(spec)
    day = %w[Mo Tu We Th Fr Sa Su][(Time.current.wday + 6) % 7]
    r = day_ranges(spec, day)
    r == 'Closed' ? 'Closed today' : r
  rescue StandardError
    nil
  end

  # All 7 days (Mon-first) as [{day, hours, today}] for the place sheet dropdown.
  def week_hours(spec)
    return nil if spec.blank?

    names = { 'Mo' => 'Mon', 'Tu' => 'Tue', 'We' => 'Wed', 'Th' => 'Thu', 'Fr' => 'Fri', 'Sa' => 'Sat', 'Su' => 'Sun' }
    today = %w[Mo Tu We Th Fr Sa Su][(Time.current.wday + 6) % 7]
    %w[Mo Tu We Th Fr Sa Su].map do |d|
      { day: names[d], hours: day_ranges(spec, d), today: d == today }
    end
  rescue StandardError
    nil
  end

  # Opening ranges for one weekday: "08:00–18:00", "08:00–12:30, 15:00–18:00",
  # a quoted comment like "by appointment", "Closed", or "24 hours".
  def day_ranges(spec, day)
    return nil if spec.blank?
    return '24 hours' if spec.strip == '24/7'

    parts = []
    spec.split(';').each do |rule|
      rule = rule.strip
      days_part, times_part = rule.split(/\s+/, 2)
      next unless times_part
      next unless day_matches?(days_part, day)

      times_part.split(',').each do |r|
        r = r.strip
        if r.match?(/\A\d{1,2}:\d{2}-\d{1,2}:\d{2}\z/)
          parts << r.tr('-', '–')
        elsif (m = r.match(/\A"(.+)"\z/)) # free-text note, e.g. "nach Vereinbarung"
          parts << m[1]
        end
      end
    end
    parts.empty? ? 'Closed' : parts.join(', ')
  end

  private

  # --- Overpass (self-hosted Germany DB) ---

  def overpass_nearby(lat, lon, category, radius)
    filter = OVERPASS_FILTERS[category]
    return nil unless filter

    ql = "[out:json][timeout:25];nwr(around:#{radius},#{lat},#{lon})#{filter};out center tags 80;"
    resp = overpass_post(ql)
    return nil unless resp&.is_a?(Net::HTTPSuccess)

    els = Oj.load(resp.body)['elements'] || []
    els.filter_map do |e|
      tags = e['tags'] || {}
      name = tags['name'] || tags['brand']
      next if name.blank?

      plat = e['lat'] || e.dig('center', 'lat')
      plon = e['lon'] || e.dig('center', 'lon')
      next if plat.nil? || plon.nil?

      hours = tags['opening_hours']
      {
        name: name,
        category: tags['amenity'] || tags['shop'] || tags['tourism'] || category,
        address: [tags['addr:street'], tags['addr:housenumber'], tags['addr:postcode'], tags['addr:city']].compact.join(' '),
        lat: plat, lon: plon,
        osm_type: e['type'], osm_id: e['id'],
        opening_hours: hours,
        cuisine: tags['cuisine'],
        distance_m: haversine(lat, lon, plat, plon).round
      }
    end
  rescue StandardError
    nil
  end

  # Resolve a POI's tags by coordinates (map-tapped POIs carry tile ids).
  # Tries an exact name match first, then the nearest named POI.
  def overpass_around_tags(lat, lon, name)
    queries = []
    if name.present?
      esc = name.gsub('\\', '\\\\\\\\').gsub('"', '\\"')
      queries << "nwr(around:45,#{lat},#{lon})[name=\"#{esc}\"];"
    end
    queries << "nwr(around:35,#{lat},#{lon})[name];"

    queries.each do |body|
      resp = overpass_post("[out:json][timeout:15];#{body}out tags 8;")
      next unless resp&.is_a?(Net::HTTPSuccess)

      els = Oj.load(resp.body)['elements'] || []
      next if els.empty?

      # Prefer a richer element (has hours/website) over a bare one.
      best = els.find { |e| (e['tags'] || {}).key?('opening_hours') || (e['tags'] || {}).key?('website') }
      return (best || els.first)['tags']
    end
    nil
  rescue StandardError
    nil
  end

  # Single element lookup (place_info) straight from Overpass.
  def overpass_element(type, id)
    ql = "[out:json][timeout:10];#{type}(#{id});out tags;"
    resp = overpass_post(ql)
    return nil unless resp&.is_a?(Net::HTTPSuccess)

    (Oj.load(resp.body)['elements'] || []).first&.dig('tags')
  rescue StandardError
    nil
  end

  def overpass_post(ql)
    base = overpass_base
    return nil unless base

    uri = URI("#{base}/api/interpreter")
    http = Net::HTTP.new(uri.host, uri.port)
    http.use_ssl = uri.scheme == 'https'
    http.open_timeout = 5
    http.read_timeout = 30
    req = Net::HTTP::Post.new(uri)
    req['User-Agent'] = 'Dawarich-vicquick/1.0'
    req.body = "data=#{URI.encode_www_form_component(ql)}"
    http.request(req)
  rescue StandardError
    nil
  end

  def overpass_base
    host = ENV['OVERPASS_API_HOST'].presence
    return nil if host.blank?

    scheme = ENV['OVERPASS_API_USE_HTTPS'] == 'true' ? 'https' : 'http'
    url = host.include?('://') ? host : "#{scheme}://#{host}"
    uri = URI(url)
    begin
      ipv4 = Resolv.getaddresses(uri.host).find { |a| a.match?(/\A\d{1,3}(\.\d{1,3}){3}\z/) }
      uri.host = ipv4 if ipv4
    rescue StandardError
    end
    uri.to_s.chomp('/')
  end

  # --- Photon fallback (no opening_hours) ---

  def photon_nearby(lat, lon, category, limit)
    osm_tag = CATEGORIES[category] || 'amenity:restaurant'
    q = params[:q].presence || category.presence || 'place'

    uri = URI("#{photon_base}/api")
    uri.query = URI.encode_www_form(q: q, lat: lat, lon: lon, limit: limit, osm_tag: osm_tag)
    resp = http_get(uri)
    return nil unless resp&.is_a?(Net::HTTPSuccess)

    features = Oj.load(resp.body)['features'] || []
    features.map do |f|
      p = f['properties']; c = f['geometry']['coordinates']
      {
        name: p['name'] || [p['street'], p['housenumber']].compact.join(' '),
        category: p['osm_value'],
        address: [p['street'], p['housenumber'], p['postcode'], p['city']].compact.join(' '),
        lat: c[1], lon: c[0],
        osm_type: p['osm_type'], osm_id: p['osm_id'],
        open_now: nil,
        distance_m: haversine(lat, lon, c[1], c[0]).round
      }
    end
  end

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
    return nil if spec.blank? || spec.include?('week')
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
