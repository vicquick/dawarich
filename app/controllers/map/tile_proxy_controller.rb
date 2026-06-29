# frozen_string_literal: true

require 'net/http'
require 'cgi'

module Map
  # vicquick fork: CORS-adding tile proxy. memomaps (ÖPNVKarte) and the German
  # state DOP WMS servers don't send Access-Control-Allow-Origin, so MapLibre
  # (which loads raster tiles with crossOrigin=anonymous for WebGL) can't use
  # them directly. We fetch server-side and re-emit with CORS + caching.
  #
  # Public on purpose (the upstreams are open data) — but the provider whitelist
  # means it can only ever fetch these specific tile/WMS endpoints (no SSRF).
  class TileProxyController < ApplicationController
    skip_before_action :verify_authenticity_token, raise: false

    XYZ = {
      'opnv' => 'https://tileserver.memomaps.de/tilegen/%<z>d/%<x>d/%<y>d.png'
    }.freeze

    # WMS providers → the single RGB orthophoto layer to render.
    # PNG + TRANSPARENT so areas OUTSIDE the state's coverage come back
    # transparent (not opaque white) and the global Esri layer shows through.
    WMS = {
      'ni_dop' => { base: 'https://opendata.lgln.niedersachsen.de/doorman/noauth/dop_wms',
                    layers: 'ni_dop20', format: 'image/png' },
      'sh_dop' => { base: 'https://dienste.gdi-sh.de/WMS_SH_DOP20col_OpenGBD',
                    layers: 'sh_dop20_rgb', format: 'image/png' }
    }.freeze

    def xyz
      tmpl = XYZ[params[:provider]] or return head(:not_found)
      proxy(format(tmpl, z: params[:z].to_i, x: params[:x].to_i, y: params[:y].to_i))
    end

    def wms
      cfg = WMS[params[:provider]] or return head(:not_found)
      bbox = params[:bbox].to_s
      return head(:bad_request) unless bbox.match?(/\A-?\d+(\.\d+)?(,-?\d+(\.\d+)?){3}\z/)

      w = params.fetch(:width, 256).to_i.clamp(1, 1024)
      h = params.fetch(:height, 256).to_i.clamp(1, 1024)
      qs = {
        SERVICE: 'WMS', VERSION: '1.3.0', REQUEST: 'GetMap',
        LAYERS: cfg[:layers], STYLES: '', CRS: 'EPSG:3857',
        BBOX: bbox, WIDTH: w, HEIGHT: h, FORMAT: cfg[:format], TRANSPARENT: 'true'
      }.map { |k, v| "#{k}=#{CGI.escape(v.to_s)}" }.join('&')
      proxy("#{cfg[:base]}?#{qs}")
    end

    private

    def proxy(url)
      uri = URI.parse(url)
      resp = Net::HTTP.start(uri.host, uri.port, use_ssl: uri.scheme == 'https',
                             open_timeout: 6, read_timeout: 12) do |http|
        http.get(uri.request_uri, 'User-Agent' => 'Dawarich-maps/1.0')
      end

      if resp.is_a?(Net::HTTPSuccess) && resp.content_type.to_s.start_with?('image/')
        response.set_header('Access-Control-Allow-Origin', '*')
        response.set_header('Cache-Control', 'public, max-age=604800')
        send_data resp.body, type: resp.content_type, disposition: 'inline'
      else
        head :bad_gateway
      end
    rescue StandardError => e
      Rails.logger.warn("[tile_proxy] #{url} -> #{e.class}: #{e.message}")
      head :bad_gateway
    end
  end
end
