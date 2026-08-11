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

  # Canonical category → Overpass tag filter (richer than Photon — carries
  # opening_hours). Broad Google-Maps-like coverage; keyword search resolves
  # free text to one of these keys via ALIASES / CUISINES below.
  OVERPASS_FILTERS = {
    'restaurant'   => '[amenity=restaurant]',
    'cafe'         => '[amenity=cafe]',
    'bar'          => '[amenity~"^(bar|pub|biergarten)$"]',
    'fast_food'    => '[amenity=fast_food]',
    'fuel'         => '[amenity=fuel]',
    'charging'     => '[amenity=charging_station]',
    'atm'          => '[amenity=atm]',
    'bank'         => '[amenity=bank]',
    'pharmacy'     => '[amenity=pharmacy]',
    'hospital'     => '[amenity~"^(hospital|clinic)$"]',
    'doctor'       => '[amenity~"^(doctors|clinic)$"]',
    'dentist'      => '[amenity=dentist]',
    'veterinary'   => '[amenity=veterinary]',
    'supermarket'  => '[shop=supermarket]',
    'shopping'     => '[shop~"^(mall|department_store|supermarket|convenience|clothes)$"]',
    'bakery'       => '[shop=bakery]',
    'butcher'      => '[shop=butcher]',
    'kiosk'        => '[shop~"^(kiosk|convenience)$"]',
    'hotel'        => '[tourism~"^(hotel|hostel|guest_house|motel|apartment)$"]',
    'parking'      => '[amenity=parking]',
    'park'         => '[leisure~"^(park|garden)$"]',
    'playground'   => '[leisure=playground]',
    'gym'          => '[leisure~"^(fitness_centre|sports_centre)$"]',
    'swimming'     => '[leisure=swimming_pool]',
    'cinema'       => '[amenity=cinema]',
    'theatre'      => '[amenity=theatre]',
    'nightclub'    => '[amenity=nightclub]',
    'attraction'   => '[tourism~"^(attraction|artwork|viewpoint|gallery|theme_park|zoo)$"]',
    'museum'       => '[tourism=museum]',
    'hairdresser'  => '[shop~"^(hairdresser|beauty)$"]',
    'post'         => '[amenity=post_office]',
    'library'      => '[amenity=library]',
    'police'       => '[amenity=police]',
    'toilets'      => '[amenity=toilets]',
    'kindergarten' => '[amenity=kindergarten]',
    'school'       => '[amenity=school]',
    'university'   => '[amenity~"^(university|college)$"]',
    'church'       => '[amenity=place_of_worship]',
    'bus_stop'     => '[highway=bus_stop]',
    'station'      => '[railway~"^(station|halt)$"]',
    'bicycle'      => '[shop=bicycle]',
    'car_repair'   => '[shop=car_repair]'
  }.freeze

  # Free-text term → canonical category (EN + DE). Google-style keyword search.
  ALIASES = {
    'coffee' => 'cafe', 'coffee shop' => 'cafe', 'café' => 'cafe', 'kaffee' => 'cafe',
    'food' => 'restaurant', 'eat' => 'restaurant', 'dinner' => 'restaurant', 'lunch' => 'restaurant',
    'essen' => 'restaurant', 'gas' => 'fuel', 'gas station' => 'fuel', 'petrol' => 'fuel',
    'tankstelle' => 'fuel', 'ev' => 'charging', 'ev charging' => 'charging', 'charger' => 'charging',
    'charging station' => 'charging', 'ladesäule' => 'charging', 'laden' => 'charging',
    'cash' => 'atm', 'cashpoint' => 'atm', 'geldautomat' => 'atm', 'money' => 'atm',
    'chemist' => 'pharmacy', 'drugstore' => 'pharmacy', 'apotheke' => 'pharmacy',
    'groceries' => 'supermarket', 'grocery' => 'supermarket', 'supermarkt' => 'supermarket',
    'shop' => 'shopping', 'store' => 'shopping', 'mall' => 'shopping', 'einkaufen' => 'shopping',
    'hostel' => 'hotel', 'accommodation' => 'hotel', 'stay' => 'hotel', 'übernachtung' => 'hotel',
    'garden' => 'park', 'green' => 'park', 'grünfläche' => 'park',
    'spielplatz' => 'playground', 'fitness' => 'gym', 'sport' => 'gym', 'fitnessstudio' => 'gym',
    'pool' => 'swimming', 'schwimmbad' => 'swimming', 'movie' => 'cinema', 'movies' => 'cinema',
    'kino' => 'cinema', 'club' => 'nightclub', 'pub' => 'bar', 'beer' => 'bar', 'drinks' => 'bar',
    'kneipe' => 'bar', 'bäckerei' => 'bakery', 'bread' => 'bakery', 'metzger' => 'butcher',
    'er' => 'hospital', 'emergency' => 'hospital', 'krankenhaus' => 'hospital', 'klinik' => 'hospital',
    'gp' => 'doctor', 'arzt' => 'doctor', 'zahnarzt' => 'dentist', 'tierarzt' => 'veterinary', 'vet' => 'veterinary',
    'parking lot' => 'parking', 'car park' => 'parking', 'parkplatz' => 'parking', 'parken' => 'parking',
    'toilet' => 'toilets', 'wc' => 'toilets', 'restroom' => 'toilets', 'bathroom' => 'toilets',
    'salon' => 'hairdresser', 'barber' => 'hairdresser', 'friseur' => 'hairdresser',
    'post office' => 'post', 'postamt' => 'post', 'bibliothek' => 'library',
    'sights' => 'attraction', 'tourist' => 'attraction', 'sehenswürdigkeit' => 'attraction',
    'museen' => 'museum', 'polizei' => 'police', 'schule' => 'school', 'uni' => 'university',
    'church' => 'church', 'kirche' => 'church', 'mosque' => 'church', 'takeaway' => 'fast_food',
    'imbiss' => 'fast_food', 'bike' => 'bicycle', 'fahrrad' => 'bicycle', 'train' => 'station',
    'bahnhof' => 'station', 'theater' => 'theatre'
  }.freeze

  # Cuisine keywords → restaurant/fast_food with a cuisine sub-filter.
  CUISINES = %w[pizza sushi burger burgers kebab indian italian chinese thai japanese
                mexican greek turkish korean vietnamese ramen steak seafood tapas
                vegan vegetarian falafel doner döner asian french spanish].freeze

  # Product / content intent → OSM shop selectors (union). Deterministic fast
  # path for "what can I buy" searches; the LLM resolver handles the long tail.
  PRODUCT_TAGS = {
    'bed linen' => ['[shop=bed]', '[shop=household_linen]', '[shop=furniture]', '[shop=department_store]'],
    'bedding'   => ['[shop=bed]', '[shop=household_linen]', '[shop=department_store]'],
    'linen'     => ['[shop=household_linen]', '[shop=department_store]'],
    'sheets'    => ['[shop=household_linen]', '[shop=bed]', '[shop=department_store]'],
    'towels'    => ['[shop=household_linen]', '[shop=department_store]'],
    'furniture' => ['[shop=furniture]', '[shop=interior_decoration]'],
    'curtains'  => ['[shop=curtain]', '[shop=interior_decoration]', '[shop=department_store]'],
    'books'     => ['[shop=books]'],
    'gift'      => ['[shop=gift]', '[shop=department_store]'],
    'flowers'   => ['[shop=florist]'],
    'shoes'     => ['[shop=shoes]'],
    'clothes'   => ['[shop=clothes]', '[shop=department_store]'],
    'electronics' => ['[shop=electronics]'],
    'phone'     => ['[shop=mobile_phone]', '[shop=electronics]'],
    'toys'      => ['[shop=toys]'],
    'jewellery' => ['[shop=jewelry]'],
    'glasses'   => ['[shop=optician]'],
    'stationery' => ['[shop=stationery]'],
    'hardware'  => ['[shop=hardware]', '[shop=doityourself]'],
    'diy'       => ['[shop=doityourself]', '[shop=hardware]'],
    'wine'      => ['[shop=wine]', '[shop=alcohol]'],
    'cosmetics' => ['[shop=cosmetics]', '[shop=chemist]'],
    'sports'    => ['[shop=sports]'],
    'pet'       => ['[shop=pet]'],
    'garden'    => ['[shop=garden_centre]'],
    'music'     => ['[shop=musical_instrument]'],
    'computer'  => ['[shop=computer]', '[shop=electronics]']
  }.freeze

  # Semantic catalog: curated OSM selectors + a synonym-rich description. The
  # always-on embedding model matches a free-text query against these (cosine),
  # so ANY phrasing ("duvet cover", "somewhere to buy a sofa", "place to fix my
  # bike") resolves to VALID OSM tags — fast (~50ms), no GPU-chat contention.
  EMBED_CATALOG = [
    { t: ['[shop=bed]', '[shop=household_linen]', '[shop=department_store]'], d: 'bed linen bedding bed sheets duvet cover pillows blankets household linen towels' },
    { t: ['[shop=furniture]', '[shop=interior_decoration]'], d: 'furniture sofa couch table chairs wardrobe interior furnishings home decor' },
    { t: ['[shop=curtain]', '[shop=interior_decoration]'], d: 'curtains blinds drapes window coverings' },
    { t: ['[shop=carpet]', '[shop=flooring]'], d: 'carpet rug flooring laminate floor tiles parquet' },
    { t: ['[shop=kitchen]'], d: 'fitted kitchen cabinets kitchen units worktops' },
    { t: ['[shop=florist]'], d: 'flowers bouquet florist plants roses birthday flowers' },
    { t: ['[shop=books]'], d: 'books bookshop bookstore novels reading literature' },
    { t: ['[shop=stationery]'], d: 'stationery pens paper notebooks office supplies' },
    { t: ['[shop=shoes]'], d: 'shoes sneakers boots footwear trainers sandals' },
    { t: ['[shop=clothes]', '[shop=boutique]'], d: 'clothes clothing fashion apparel dress shirt jacket boutique' },
    { t: ['[shop=jewelry]'], d: 'jewellery jewelry rings necklace watches gold silver' },
    { t: ['[shop=gift]'], d: 'gift present souvenir birthday present gift shop' },
    { t: ['[shop=toys]'], d: 'toys games kids children toy shop board games' },
    { t: ['[shop=electronics]', '[shop=computer]'], d: 'electronics computer laptop tv television gadgets appliances' },
    { t: ['[shop=mobile_phone]'], d: 'phone mobile smartphone cellphone phone repair phone shop' },
    { t: ['[shop=hardware]', '[shop=doityourself]'], d: 'hardware diy tools screws building materials home improvement baumarkt drill' },
    { t: ['[shop=paint]'], d: 'paint wall paint decorating brushes' },
    { t: ['[shop=garden_centre]'], d: 'garden plants seeds gardening soil garden centre' },
    { t: ['[shop=bicycle]', '[craft=bicycle]'], d: 'bicycle bike repair cycle shop bike parts fix a bike' },
    { t: ['[shop=car_repair]', '[shop=car_parts]'], d: 'car repair garage mechanic auto workshop car parts service' },
    { t: ['[shop=sports]'], d: 'sports equipment sportswear outdoor gear fitness gear' },
    { t: ['[shop=optician]'], d: 'glasses spectacles optician eyewear contact lenses eye test' },
    { t: ['[shop=hairdresser]', '[shop=beauty]'], d: 'hairdresser barber salon haircut beauty nails' },
    { t: ['[shop=cosmetics]', '[shop=chemist]'], d: 'cosmetics makeup beauty products perfume drugstore toiletries' },
    { t: ['[shop=supermarket]', '[shop=convenience]'], d: 'groceries supermarket food shop grocery store convenience' },
    { t: ['[shop=bakery]'], d: 'bakery bread pastries cake baker rolls' },
    { t: ['[shop=butcher]'], d: 'butcher meat sausage steak deli' },
    { t: ['[shop=greengrocer]'], d: 'fruit vegetables greengrocer fresh produce' },
    { t: ['[shop=wine]', '[shop=alcohol]'], d: 'wine alcohol spirits liquor beer bottle shop' },
    { t: ['[shop=pet]'], d: 'pet supplies dog cat pet food pet shop aquarium' },
    { t: ['[shop=musical_instrument]'], d: 'musical instruments guitar piano keyboard music shop' },
    { t: ['[shop=art]', '[shop=frame]'], d: 'art supplies paint canvas picture framing crafts' },
    { t: ['[amenity=restaurant]'], d: 'restaurant dinner food eat meal dining' },
    { t: ['[amenity=cafe]'], d: 'cafe coffee espresso breakfast brunch' },
    { t: ['[amenity=bar]', '[amenity=pub]'], d: 'bar pub beer drinks cocktails' },
    { t: ['[amenity=fast_food]'], d: 'fast food takeaway burger snack imbiss' },
    { t: ['[amenity=pharmacy]'], d: 'pharmacy chemist medicine prescription apotheke' },
    { t: ['[amenity~"^(hospital|clinic)$"]'], d: 'hospital emergency clinic medical urgent care' },
    { t: ['[amenity=doctors]'], d: 'doctor gp medical practice physician' },
    { t: ['[amenity=dentist]'], d: 'dentist dental teeth' },
    { t: ['[amenity=fuel]'], d: 'fuel petrol gas station diesel refuel' },
    { t: ['[amenity=charging_station]'], d: 'ev charging electric car charger charging station' },
    { t: ['[amenity=bank]', '[amenity=atm]'], d: 'bank atm cash money withdraw cashpoint' },
    { t: ['[amenity=post_office]'], d: 'post office parcel mail stamps shipping package' },
    { t: ['[amenity=library]'], d: 'library books borrow reading room study' },
    { t: ['[amenity=parking]'], d: 'parking car park parking lot parking space' },
    { t: ['[leisure~"^(park|garden)$"]'], d: 'park green space garden walk nature' },
    { t: ['[leisure=playground]'], d: 'playground kids children play area swings' },
    { t: ['[leisure~"^(fitness_centre|sports_centre)$"]'], d: 'gym fitness workout sports centre exercise training' },
    { t: ['[leisure=swimming_pool]'], d: 'swimming pool swim baths' },
    { t: ['[amenity=cinema]'], d: 'cinema movie film screening' },
    { t: ['[tourism~"^(hotel|hostel|guest_house)$"]'], d: 'hotel accommodation stay overnight room hostel' },
    { t: ['[tourism=museum]'], d: 'museum exhibition art history gallery' },
    { t: ['[tourism=attraction]'], d: 'attraction sightseeing landmark tourist sights' }
  ].freeze

  def nearby
    lat = params[:lat]&.to_f
    lon = params[:lon]&.to_f
    return render_error('lat/lon required') if lat.nil? || lon.nil?

    category = params[:category].to_s.strip
    q = params[:q].to_s.strip
    limit = (params[:limit] || 15).to_i.clamp(1, 50)
    radius = (params[:radius] || 1500).to_i.clamp(100, 5000)
    open_only = params[:open_now].to_s == 'true'
    # vicquick fork: true "search in view" — when the client passes the visible
    # viewport (bbox=s,w,n,e) we search the WHOLE box, not a fixed radius, so
    # zooming out actually widens the search like Google's "Search this area".
    # Falls back to the radius path when bbox is absent or unusably large.
    bbox = parse_bbox(params[:bbox])

    # Resolve category key and/or free-text query into an Overpass filter.
    filter, label = resolve_filter(category, q)
    return render_error('Nothing to search for') if filter.nil?

    # Cache the raw POI list (Redis, ~111m bucket); open-now is recomputed fresh
    # below so it's never stale. Prefer Overpass, fall back to Photon.
    results =
      if bbox
        k = bbox.map { |v| v.round(3) }.join(',')
        Rails.cache.fetch("v2/inview/#{label}/#{k}", expires_in: 6.hours) do
          overpass_in_bbox(bbox, filter, label)
        end
      else
        Rails.cache.fetch("v2/nearby/#{label}/#{lat.round(3)}/#{lon.round(3)}/#{radius}", expires_in: 6.hours) do
          overpass_nearby(lat, lon, filter, label, radius) ||
            photon_nearby(lat, lon, category.presence || q, limit)
        end
      end
    return render_error('Search engine error', :bad_gateway) if results.nil?

    results = results.map { |r| r.merge(open_now: r[:opening_hours] ? open_now?(r[:opening_hours]) : nil) }
    results = results.select { |r| r[:open_now] } if open_only
    results = results.sort_by { |r| r[:distance_m] }.first(limit)
    render json: { results: results, category: label, in_view: !bbox.nil? }
  end

  # Parse & sanity-check a "south,west,north,east" viewport. Returns nil unless
  # it's a valid, sanely-sized box — an oversized bbox (whole-country zoom) would
  # ask Overpass for the world, so we punt back to the radius path there.
  MAX_BBOX_SPAN_DEG = 0.9 # ~100 km lat; keeps Overpass fast and results useful
  def parse_bbox(raw)
    parts = raw.to_s.split(',').map { |v| Float(v) rescue nil }
    return nil unless parts.length == 4 && parts.all?
    s, w, n, e = parts
    return nil unless s.between?(-90, 90) && n.between?(-90, 90) && w.between?(-180, 180) && e.between?(-180, 180)
    return nil unless n > s && e > w
    return nil if (n - s) > MAX_BBOX_SPAN_DEG || (e - w) > MAX_BBOX_SPAN_DEG
    [s, w, n, e]
  end

  # Resolve a category key and/or free-text query into an Overpass filter and a
  # short cache label. Order: explicit known category → alias/singular → cuisine
  # → fuzzy name substring. Returns [filter, label] or [nil, nil].
  # Returns [Array<selector>, label] — an array so several OSM tags can be
  # unioned in one Overpass query (a product like "bed linen" maps to several
  # shop types). Order: known category → alias/singular → cuisine → product
  # dictionary → local-LLM intent → fuzzy name.
  def resolve_filter(category, q)
    cat = category.downcase
    return [[OVERPASS_FILTERS[cat]], cat] if OVERPASS_FILTERS.key?(cat)

    term = q.downcase.strip
    sing = term.sub(/s\z/, '')
    canon = ALIASES[term] || (OVERPASS_FILTERS.key?(term) ? term : nil) ||
            ALIASES[sing] || (OVERPASS_FILTERS.key?(sing) ? sing : nil)
    return [[OVERPASS_FILTERS[canon]], canon] if canon

    if (c = CUISINES.find { |x| term.split.include?(x) || term == x })
      base = c.match?(/burger|kebab|doner|döner|falafel/) ? 'restaurant|fast_food' : 'restaurant'
      return [["[amenity~\"^(#{base})$\"][cuisine~\"#{c.sub(/s\z/, '')}\",i]"], "cuisine:#{c}"]
    end

    if (prod = PRODUCT_TAGS[term] || PRODUCT_TAGS[sing])
      return [prod, "product:#{term}"]
    end

    # Semantic match against the curated OSM catalog via the always-on embedding
    # model (~50ms, no GPU-chat contention, always-valid OSM tags). Handles any
    # phrasing: "duvet cover", "somewhere to buy a sofa", "place to fix my bike".
    if term.length >= 3 && (sel = embed_resolve(term)).present?
      return [sel, "ai:#{term}"]
    end

    # Legacy LLM fallback (gated off — see llm_selectors; slow + imprecise).
    if term.length >= 3 && (sel = llm_selectors(term)).present?
      return [sel, "ai:#{term}"]
    end

    # Last resort: fuzzy name substring (matches place names carrying the term).
    return [[name_filter(q)], "name:#{term}"] if q.length >= 3

    [nil, nil]
  end

  # Overpass name-substring filter (case-insensitive), regex-escaped.
  def name_filter(q)
    esc = q.gsub('\\', '\\\\\\\\').gsub('"', '\\"')
    "[name~\"#{esc}\",i]"
  end

  # Semantic resolver: embed the query, cosine-match the curated OSM catalog,
  # union the tags of the top matches. Cached per query (30d). Threshold 0.62
  # (calibrated: correct matches score 0.71-0.84, noise 0.49-0.65).
  def embed_resolve(term)
    Rails.cache.fetch("v2/embed_q/#{Digest::MD5.hexdigest(term)}", expires_in: 30.days, skip_nil: true) do
      qv = embed(term)
      cat = catalog_vectors
      next nil if qv.nil? || cat.blank?

      scored = cat.map { |e| [cosine(qv, e['v']), e['t']] }
      best = scored.map(&:first).max
      next nil if best.nil? || best < 0.62

      scored.select { |s| s[0] >= best - 0.06 }
            .sort_by { |s| -s[0] }.first(3)
            .flat_map { |s| s[1] }.uniq
    end
  rescue StandardError
    nil
  end

  # Embed every catalog description once; cached in Redis (30d) so the ~50
  # embed calls run only on the first cold query after a cache flush.
  def catalog_vectors
    Rails.cache.fetch('v1/embed_catalog/v3', expires_in: 30.days, skip_nil: true) do
      EMBED_CATALOG.filter_map do |e|
        v = embed(e[:d])
        { 't' => e[:t], 'v' => v } if v
      end.presence
    end
  rescue StandardError
    nil
  end

  # One embedding vector from the always-on model (OpenAI-compatible endpoint).
  def embed(text)
    base = ENV['LLM_BASE_URL'].presence || 'http://10.10.10.12:8080/v1'
    model = ENV['EMBED_MODEL'].presence || 'qwen3-embedding'
    uri = URI("#{base}/embeddings")
    http = Net::HTTP.new(uri.host, uri.port)
    http.use_ssl = uri.scheme == 'https'
    http.open_timeout = 3
    http.read_timeout = 10
    req = Net::HTTP::Post.new(uri, 'Content-Type' => 'application/json')
    req.body = JSON.generate({ model: model, input: text })
    resp = http.request(req)
    return nil unless resp.is_a?(Net::HTTPSuccess)

    Oj.load(resp.body).dig('data', 0, 'embedding')
  rescue StandardError
    nil
  end

  def cosine(a, b)
    return -1.0 unless a.is_a?(Array) && b.is_a?(Array) && a.length == b.length

    dot = na = nb = 0.0
    a.each_index do |i|
      dot += a[i] * b[i]
      na += a[i]**2
      nb += b[i]**2
    end
    return -1.0 if na.zero? || nb.zero?

    dot / (Math.sqrt(na) * Math.sqrt(nb))
  end

  # Local-LLM intent resolver: free text → up to 6 OSM selectors. Uses the
  # always-loaded CPU model over the VPN (no GPU contention), cached 30 days,
  # and degrades gracefully to nil on any error so search never blocks.
  def llm_selectors(term)
    # Off by default: the CPU model is ~30s (too slow to block search) and a
    # small model emits imprecise OSM values. Enable with LLM_INTENT=on once a
    # fast/accurate resolver (embedding-catalog match) is wired. The product
    # dictionary already covers the common "what can I buy" searches instantly.
    return nil unless ENV['LLM_INTENT'].to_s == 'on'

    Rails.cache.fetch("v1/ai_tags/#{Digest::MD5.hexdigest(term)}", expires_in: 30.days) do
      base = ENV['LLM_BASE_URL'].presence || 'http://10.10.10.12:8080/v1'
      model = ENV['LLM_MODEL'].presence || 'qwen3-8b-cpu'
      sys = 'You translate a map search into OpenStreetMap tags. Reply ONLY with a ' \
            'compact JSON array of 1 to 6 OSM selectors that best find what the user ' \
            'wants NEARBY, each as "key=value" with real OSM keys (shop, amenity, ' \
            'craft, leisure, tourism, office, healthcare). No prose, no markdown.'
      body = {
        model: model, temperature: 0, max_tokens: 120,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: "#{term} /no_think" }]
      }
      uri = URI("#{base}/chat/completions")
      http = Net::HTTP.new(uri.host, uri.port)
      http.use_ssl = uri.scheme == 'https'
      http.open_timeout = 4
      http.read_timeout = 20
      req = Net::HTTP::Post.new(uri, 'Content-Type' => 'application/json')
      req.body = JSON.generate(body)
      resp = http.request(req)
      next nil unless resp.is_a?(Net::HTTPSuccess)

      content = Oj.load(resp.body).dig('choices', 0, 'message', 'content').to_s
      sanitize_selectors(content)
    end
  rescue StandardError
    nil
  end

  # Extract valid [key=value] selectors from an LLM reply (defends against
  # prompt-injection into the Overpass query — allowlisted keys, strict chars).
  def sanitize_selectors(text)
    s = text.to_s
    # Accept both "shop=bed" and {"key":"shop","value":"bed"} shapes.
    pairs = s.scan(/"key"\s*:\s*"([a-z_]+)"\s*,\s*"value"\s*:\s*"([a-z0-9_:]+)"/i)
    pairs = s.scan(/([a-z_]+)\s*=\s*([a-z0-9_:]+)/i) if pairs.empty?
    allowed = %w[shop amenity craft leisure tourism office healthcare cuisine sport]
    sel = pairs.map { |k, v| "[#{k.downcase}=#{v.downcase}]" }.uniq
    sel.select! { |x| allowed.any? { |k| x.start_with?("[#{k}=") } }
    sel.first(6).presence
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

    # Beyond OSM: Wikidata for notable places (curated description + photo).
    # Brave dropped — its free tier gives no useful place data. Fully private.
    wd = wikidata_info(tags['wikidata'] || tags['brand:wikidata'])
    hours = tags['opening_hours']
    render json: {
      opening_hours: hours,
      open_now: hours ? open_now?(hours) : nil,
      today_hours: hours ? today_hours(hours) : nil,
      week_hours: hours ? week_hours(hours) : nil,
      phone: tags['phone'] || tags['contact:phone'],
      website: tags['website'] || tags['contact:website'] || wd&.dig(:website),
      description: wd&.dig(:description),
      image: wd&.dig(:image),
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
  def brave_info(name, website = nil)
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
      results = data.dig('web', 'results') || []

      # Free tier returns generic web snippets — keep only results that actually
      # match the place (a name word appears in the title/url) and aren't
      # dictionary/encyclopaedia noise. Real ratings need Brave's paid Local plan.
      tokens = name.to_s.downcase.scan(/\p{L}{3,}/) - %w[der die das und restaurant cafe bar gmbh str]
      junk = /wiktionary|wikipedia|duden|dict\.|leo\.org|translate/
      relevant = results.find do |r|
        hay = "#{r['title']} #{r['url']}".downcase
        hay !~ junk && tokens.any? { |t| hay.include?(t) }
      end

      desc = info['long_desc'] || info['description'] || relevant&.dig('description')
      # Image: infobox (curated) or the relevant result's thumbnail ONLY when it
      # is the place's OWN website (its logo/photo) — not random portal images.
      thumb = info.dig('thumbnail', 'src')
      if thumb.blank? && relevant && website.present? && same_host?(relevant['url'], website)
        thumb = relevant.dig('thumbnail', 'src')
      end
      {
        description: strip_html(desc),
        image: thumb,
        rating: info.dig('rating', 'ratingValue') || info['rating']
      }.compact.presence
    end
  rescue StandardError
    nil
  end

  # Do two URLs share the same registrable host (ignoring www.)?
  def same_host?(a, b)
    ha = URI.parse(a.to_s).host.to_s.sub(/\Awww\./, '')
    hb = URI.parse(b.to_s).host.to_s.sub(/\Awww\./, '')
    ha.present? && ha == hb
  rescue StandardError
    false
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

  def overpass_nearby(lat, lon, selectors, label, radius)
    sel = Array(selectors).compact
    return nil if sel.empty?

    union = sel.map { |s| "nwr(around:#{radius},#{lat},#{lon})#{s};" }.join
    ql = "[out:json][timeout:25];(#{union});out center tags 80;"
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
        category: tags['amenity'] || tags['shop'] || tags['tourism'] || tags['leisure'] || label,
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

  # Search every matching POI inside the visible viewport (Overpass bbox filter).
  # Distance is measured from the box centre so the list still sorts nearest-first.
  def overpass_in_bbox(bbox, selectors, label)
    sel = Array(selectors).compact
    return nil if sel.empty?

    s, w, n, e = bbox
    box = "(#{s},#{w},#{n},#{e})"
    union = sel.map { |x| "nwr#{box}#{x};" }.join
    ql = "[out:json][timeout:25];(#{union});out center tags 120;"
    resp = overpass_post(ql)
    return nil unless resp&.is_a?(Net::HTTPSuccess)

    clat = (s + n) / 2.0
    clon = (w + e) / 2.0
    els = Oj.load(resp.body)['elements'] || []
    els.filter_map do |el|
      tags = el['tags'] || {}
      name = tags['name'] || tags['brand']
      next if name.blank?

      plat = el['lat'] || el.dig('center', 'lat')
      plon = el['lon'] || el.dig('center', 'lon')
      next if plat.nil? || plon.nil?

      {
        name: name,
        category: tags['amenity'] || tags['shop'] || tags['tourism'] || tags['leisure'] || label,
        address: [tags['addr:street'], tags['addr:housenumber'], tags['addr:postcode'], tags['addr:city']].compact.join(' '),
        lat: plat, lon: plon,
        osm_type: el['type'], osm_id: el['id'],
        opening_hours: tags['opening_hours'],
        cuisine: tags['cuisine'],
        distance_m: haversine(clat, clon, plat, plon).round
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
