# frozen_string_literal: true

# Serves the "topo" basemap style dynamically so we can inject the Mapy.com
# outdoor API key from ENV (Mapy keys are client-visible — they live in tile
# URLs). Falls back to CyclOSM when no key is configured. This replaces the
# static OpenTopoMap topo.json (vicquick fork — Victor disliked OpenTopoMap;
# Mapy.com "outdoor" is the target look, behind a free API key).
class MapStylesController < ActionController::Base
  GLYPHS = 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf'

  def topo
    key = ENV['MAPY_API_KEY'].to_s.strip
    render json: (key.present? ? mapy_outdoor(key) : cyclosm)
  end

  private

  def mapy_outdoor(key)
    {
      version: 8, name: 'Mapy Outdoor', glyphs: GLYPHS,
      sources: { mapy: {
        type: 'raster',
        tiles: ["https://api.mapy.com/v1/maptiles/outdoor/256/{z}/{x}/{y}?apikey=#{key}"],
        tileSize: 256, maxzoom: 19,
        attribution: '© <a href="https://mapy.com/">Seznam.cz, a.s.</a> and partners'
      } },
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': '#eef2ea' } },
        { id: 'mapy', type: 'raster', source: 'mapy' }
      ]
    }
  end

  def cyclosm
    {
      version: 8, name: 'CyclOSM', glyphs: GLYPHS,
      sources: { cyclosm: {
        type: 'raster',
        tiles: [
          'https://a.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
          'https://b.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
          'https://c.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png'
        ],
        tileSize: 256, maxzoom: 18,
        attribution: '© <a href="https://www.cyclosm.org">CyclOSM</a>, © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
      } },
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': '#f2efe9' } },
        { id: 'cyclosm', type: 'raster', source: 'cyclosm' }
      ]
    }
  end
end
