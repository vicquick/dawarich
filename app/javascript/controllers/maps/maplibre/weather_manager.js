// Live rain radar as a raster overlay (vicquick fork).
//
// Exposed as window.dawarichWeather by maplibre_controller; toggled from the
// Layers control (like Photos / Street View / Traffic). Loads lazily on first
// enable: pulls RainViewer's public frame manifest, builds the latest radar
// frame's tile URL, and paints it translucently UNDER the map labels so place
// names stay readable. No API key, fully free. Refreshes the frame each time
// it's re-enabled so it never shows stale rain.
const RAINVIEWER_MANIFEST = "https://api.rainviewer.com/public/weather-maps.json"
const SRC = "weather-radar"
const LAYER = "weather-radar-layer"

export class WeatherManager {
  constructor(controller) {
    this.controller = controller
    this.map = controller.map
    this._on = false
    this._ts = null // unix seconds of the frame currently shown
  }

  isOn() { return this._on }

  async toggle() {
    this._on = !this._on
    if (this._on) { await this._show() } else { this._hide() }
    return this._on
  }

  // Latest radar frame → tile URL. RainViewer returns hashed frame paths that
  // roll over ~every 10 min, so we resolve it fresh rather than hardcoding.
  async _latestTiles() {
    const res = await fetch(RAINVIEWER_MANIFEST, { cache: "no-store" })
    if (!res.ok) return null
    const j = await res.json()
    const frames = (j.radar && (j.radar.nowcast?.length ? j.radar.nowcast : j.radar.past)) || []
    const frame = frames[frames.length - 1]
    if (!frame || !j.host) return null
    this._ts = frame.time || null
    // {host}{path}/{size}/{z}/{x}/{y}/{colorScheme}/{smooth}_{snow}.png
    return {
      host: j.host,
      tiles: [`${j.host}${frame.path}/256/{z}/{x}/{y}/4/1_1.png`],
    }
  }

  // Insert the radar just below the first label/symbol layer so text stays on
  // top — matches how weather reads on Google's map.
  _firstSymbolId() {
    const layers = this.map.getStyle()?.layers || []
    const sym = layers.find((l) => l.type === "symbol")
    return sym ? sym.id : undefined
  }

  async _show() {
    if (!this.map) return
    const conf = await this._latestTiles().catch(() => null)
    if (!conf) { this._on = false; return }

    if (this.map.getSource(SRC)) {
      // Re-enabling: swap in the fresh frame by rebuilding the source.
      this._removeLayerSource()
    }
    this.map.addSource(SRC, {
      type: "raster", tiles: conf.tiles, tileSize: 256,
      // Radar is coarse; cap native tiles at z8 and let MapLibre overzoom
      // (stretch) beyond that. Avoids RainViewer's "Zoom Level Not Supported"
      // placeholder tiles at high zoom, and keeps the layer smooth.
      maxzoom: 8,
      attribution: 'Radar © <a href="https://www.rainviewer.com/">RainViewer</a>',
    })
    this.map.addLayer({
      id: LAYER, type: "raster", source: SRC,
      paint: { "raster-opacity": 0.6, "raster-fade-duration": 300 },
    }, this._firstSymbolId())
  }

  _hide() {
    this._removeLayerSource()
  }

  _removeLayerSource() {
    if (this.map?.getLayer(LAYER)) this.map.removeLayer(LAYER)
    if (this.map?.getSource(SRC)) this.map.removeSource(SRC)
  }
}
