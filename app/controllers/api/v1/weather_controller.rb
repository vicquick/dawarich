# frozen_string_literal: true

require 'net/http'
require 'uri'
require 'json'
require 'time'

# Rain radar for the map's weather overlay (vicquick fork).
#
# Every upstream call is proxied through here on purpose. A radar tile fetched
# straight from a CDN leaks the viewer's IP together with the z/x/y they asked
# for — which is to say, exactly where they are looking, every few seconds while
# the animation plays. Routing it through Rails means the upstream only ever
# sees this server.
#
# Two sources, chosen by where the map is pointed:
#   dwd        Deutscher Wetterdienst RV composite. 5-minute steps, ~3 days of
#              history AND ~2 h of genuine forecast. Germany + neighbouring
#              radar range only. Public-sector open data (GeoNutzV), no ads.
#   rainviewer Global fallback. 10-minute steps, last 2 h, no forecast on the
#              free tier.
class Api::V1::WeatherController < ApiController
  RAINVIEWER_MANIFEST = 'https://api.rainviewer.com/public/weather-maps.json'
  RAINVIEWER_HOST     = 'tilecache.rainviewer.com'
  DWD_WMS             = 'https://maps.dwd.de/geoserver/dwd/wms'
  DWD_LAYER           = 'Radar_rv_product_1x1km_ger'

  # RV composite coverage: Germany plus the neighbouring area still inside
  # radar range. Outside this we fall back to RainViewer.
  DWD_BOUNDS = { min_lon: 3.5, min_lat: 45.7, max_lon: 17.6, max_lat: 56.5 }.freeze

  # DWD publishes RV out to +2 h; stay just inside so the tail of the slider
  # never asks for a frame that does not exist yet.
  DWD_FORECAST_MINUTES = 105
  DWD_PAST_MINUTES     = 120
  DWD_STEP_MINUTES     = 15

  MAX_TILE_BYTES = 2_000_000
  ORIGIN_SHIFT   = 20_037_508.342789244

  # Timeline for the current viewport: which source, and every frame the slider
  # can scrub to. The client never builds an upstream URL itself.
  def frames
    lat = params[:lat].to_f
    lon = params[:lon].to_f

    if dwd_covers?(lat, lon)
      render json: dwd_frames
    else
      render json: rainviewer_frames
    end
  rescue StandardError => e
    Rails.logger.warn("weather#frames: #{e.class}: #{e.message}")
    render json: { source: nil, frames: [] }
  end

  # One radar tile. `src` picks the upstream; everything else is validated
  # rather than trusted, so a crafted request cannot aim this proxy elsewhere.
  def tile
    z = params[:z].to_i
    x = params[:x].to_i
    y = params[:y].to_i
    return head :bad_request unless z.between?(0, 12) && x >= 0 && y >= 0 && x < (1 << z) && y < (1 << z)

    body, type =
      case params[:src]
      when 'dwd' then dwd_tile(params[:t].to_s, z, x, y)
      when 'rv'  then rainviewer_tile(params[:t].to_i, z, x, y)
      end

    return head :bad_gateway if body.nil?

    # Past frames never change; the newest one is superseded every few minutes.
    response.set_header('Cache-Control', 'private, max-age=600')
    send_data body, type: type, disposition: 'inline'
  rescue StandardError => e
    Rails.logger.warn("weather#tile: #{e.class}: #{e.message}")
    head :bad_gateway
  end

  private

  def dwd_covers?(lat, lon)
    lat.between?(DWD_BOUNDS[:min_lat], DWD_BOUNDS[:max_lat]) &&
      lon.between?(DWD_BOUNDS[:min_lon], DWD_BOUNDS[:max_lon])
  end

  # -- DWD ------------------------------------------------------------------

  def dwd_frames
    now  = Time.now.utc
    # Snap to the 5-minute grid DWD publishes on, then walk in slider steps.
    base = now - (now.min % DWD_STEP_MINUTES).minutes
    base = Time.utc(base.year, base.month, base.day, base.hour, base.min, 0)

    frames = []
    t = base - DWD_PAST_MINUTES.minutes
    while t <= base + DWD_FORECAST_MINUTES.minutes
      frames << {
        t: t.strftime('%Y-%m-%dT%H:%M:00.000Z'),
        at: t.to_i,
        forecast: t > now
      }
      t += DWD_STEP_MINUTES.minutes
    end

    {
      source: 'dwd',
      label: 'DWD radar + 2 h forecast',
      attribution: 'Radar © <a href="https://www.dwd.de/">Deutscher Wetterdienst</a>',
      # The client strips DWD's grey coverage wash and magenta range ring.
      needs_cleanup: true,
      maxzoom: 11,
      frames: frames
    }
  end

  def dwd_tile(time, z, x, y)
    return [nil, nil] unless /\A\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z\z/.match?(time)

    # Reject anything outside the window we advertise, so this cannot be used
    # as a general-purpose scraper against DWD.
    parsed = Time.parse(time).utc
    return [nil, nil] unless parsed.between?(Time.now.utc - 1.day, Time.now.utc + 3.hours)

    minx, miny, maxx, maxy = tile_bbox_3857(z, x, y)
    uri = URI(DWD_WMS)
    uri.query = URI.encode_www_form(
      service: 'WMS', version: '1.3.0', request: 'GetMap',
      layers: DWD_LAYER, styles: '', format: 'image/png',
      transparent: 'true', crs: 'EPSG:3857',
      bbox: "#{minx},#{miny},#{maxx},#{maxy}",
      width: 256, height: 256, time: time
    )
    fetch_tile(uri)
  end

  # Slippy tile → Web Mercator bounds (WMS 1.3.0 with EPSG:3857 wants
  # easting/northing order).
  def tile_bbox_3857(z, x, y)
    span = (ORIGIN_SHIFT * 2) / (2**z)
    minx = -ORIGIN_SHIFT + (x * span)
    maxy = ORIGIN_SHIFT - (y * span)
    [minx, maxy - span, minx + span, maxy]
  end

  # -- RainViewer -----------------------------------------------------------

  def rainviewer_frames
    manifest = rainviewer_manifest
    return { source: nil, frames: [] } if manifest.nil?

    past = manifest.dig('radar', 'past') || []
    {
      source: 'rv',
      label: 'RainViewer (last 2 h)',
      attribution: 'Radar © <a href="https://www.rainviewer.com/">RainViewer</a>',
      needs_cleanup: false,
      maxzoom: 8,
      frames: past.map { |f| { t: f['time'].to_s, at: f['time'].to_i, forecast: false } }
    }
  end

  def rainviewer_tile(time, z, x, y)
    manifest = rainviewer_manifest
    return [nil, nil] if manifest.nil?

    # Resolve the hashed frame path server-side rather than letting the client
    # hand us a path to append — that would be an open redirect into the CDN.
    frames = (manifest.dig('radar', 'past') || []) + (manifest.dig('radar', 'nowcast') || [])
    frame  = frames.find { |f| f['time'].to_i == time }
    return [nil, nil] if frame.nil? || frame['path'].blank?
    return [nil, nil] unless %r{\A/v\d+/radar/[a-z0-9_-]+\z}.match?(frame['path'])

    host = URI(manifest['host'].to_s).host
    return [nil, nil] unless host == RAINVIEWER_HOST

    fetch_tile(URI("https://#{RAINVIEWER_HOST}#{frame['path']}/256/#{z}/#{x}/#{y}/4/1_1.png"))
  end

  def rainviewer_manifest
    Rails.cache.fetch('weather/rainviewer_manifest', expires_in: 60.seconds) do
      uri  = URI(RAINVIEWER_MANIFEST)
      resp = http_get(uri)
      resp.is_a?(Net::HTTPSuccess) ? JSON.parse(resp.body) : nil
    end
  rescue StandardError
    nil
  end

  # -- shared ---------------------------------------------------------------

  def fetch_tile(uri)
    resp = http_get(uri)
    return [nil, nil] unless resp.is_a?(Net::HTTPSuccess)

    type = resp['content-type'].to_s
    return [nil, nil] unless type.start_with?('image/')
    return [nil, nil] if resp.body.bytesize > MAX_TILE_BYTES

    [resp.body, type]
  end

  def http_get(uri)
    http = Net::HTTP.new(uri.host, uri.port)
    http.use_ssl = uri.scheme == 'https'
    http.open_timeout = 4
    http.read_timeout = 12
    req = Net::HTTP::Get.new(uri)
    req['User-Agent'] = 'Dawarich/1.0 (self-hosted map)'
    http.request(req)
  end
end
