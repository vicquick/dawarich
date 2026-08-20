# frozen_string_literal: true

require 'net/http'
require 'uri'
require 'cgi'

# Immich photos as NATIVE map data (vicquick fork).
#
# `index` → proxies Immich's /api/map/markers (all geotagged assets) into a
#           GeoJSON FeatureCollection for a clustered MapLibre layer.
# `thumb` → streams an asset thumbnail/preview so the Immich API key never
#           reaches the browser.
#
# Source creds come from ENV (single-user self-hosted) with a per-user
# safe_settings fallback. Immich sits behind Cloudflare, which 403s the default
# Ruby/urllib User-Agent — so every call sends a browser UA. Immich is HTTPS,
# so we do NOT pin IPv4 (that would break TLS SNI / cert validation), unlike the
# self-hosted HTTP services (Overpass/Photon/Valhalla).
class Api::V1::Immich::MarkersController < ApiController
  MARKERS_TTL = 1.hour

  def index
    fav = ActiveModel::Type::Boolean.new.cast(params[:favorites])
    geojson = Rails.cache.fetch("immich:markers:#{fav ? 'fav' : 'all'}", expires_in: MARKERS_TTL) do
      to_geojson(fetch_markers(fav))
    end
    # Expose the Immich web base (foreign GeoJSON member) so the map popup can
    # deep-link each photo to its Immich viewer without shipping a URL per asset.
    render json: geojson.merge('immich_web' => immich_base.chomp('/'))
  rescue StandardError => e
    Rails.logger.warn("immich markers failed: #{e.message}")
    render json: { type: 'FeatureCollection', features: [] }
  end

  def thumb
    size = params[:size].to_s == 'preview' ? 'preview' : 'thumbnail'
    resp = immich_get("/api/assets/#{CGI.escape(params[:id].to_s)}/thumbnail?size=#{size}")
    return head :bad_gateway unless resp&.code.to_i == 200

    response.set_header('Cache-Control', 'private, max-age=86400')
    send_data resp.body, type: (resp['content-type'] || 'image/webp'), disposition: 'inline'
  rescue StandardError => e
    Rails.logger.warn("immich thumb failed: #{e.message}")
    head :bad_gateway
  end

  private

  def immich_base
    (ENV['IMMICH_URL'].presence || current_api_user&.safe_settings&.immich_url).to_s
  end

  def immich_key
    ENV['IMMICH_API_KEY'].presence || current_api_user&.safe_settings&.immich_api_key
  end

  def immich_get(path)
    base = immich_base
    return nil if base.blank?

    uri = URI.join("#{base.chomp('/')}/", path.sub(%r{\A/}, ''))
    http = Net::HTTP.new(uri.host, uri.port)
    http.use_ssl = uri.scheme == 'https'
    http.open_timeout = 5
    http.read_timeout = 25
    req = Net::HTTP::Get.new(uri)
    req['x-api-key'] = immich_key
    req['User-Agent'] = 'Mozilla/5.0'
    http.request(req)
  end

  def fetch_markers(fav)
    resp = immich_get(fav ? '/api/map/markers?isFavorite=true' : '/api/map/markers')
    return [] unless resp&.code.to_i == 200

    JSON.parse(resp.body)
  end

  def to_geojson(markers)
    features = Array(markers).filter_map do |m|
      lat = m['lat']
      lon = m['lon']
      next if lat.nil? || lon.nil?

      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lon.to_f, lat.to_f] },
        properties: { id: m['id'], city: m['city'] }
      }
    end
    { type: 'FeatureCollection', features: features }
  end
end
