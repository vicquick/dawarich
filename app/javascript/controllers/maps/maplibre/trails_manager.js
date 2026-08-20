// Waymarked Trails hiking overlay (vicquick fork).
//
// Exposed as window.dawarichTrails; toggled from the Layers control. Overlays
// OSM marked hiking routes (transparent PNG tiles) on top of ANY basemap — so
// CyclOSM/Satellite/Mapy all gain colour-coded trail waymarks. Keyless, free.
const SRC = "waymarked-trails"
const LAYER = "waymarked-trails-layer"

export class TrailsManager {
  constructor(controller) {
    this.controller = controller
    this.map = controller.map
    this._on = false
  }

  isOn() { return this._on }

  async toggle() {
    this._on = !this._on
    this._on ? this._show() : this._hide()
    return this._on
  }

  // Keep trails BELOW map labels so place names stay readable.
  _firstSymbolId() {
    const layers = this.map.getStyle()?.layers || []
    const sym = layers.find((l) => l.type === "symbol")
    return sym ? sym.id : undefined
  }

  _show() {
    if (!this.map) return
    if (this.map.getSource(SRC)) this._remove()
    this.map.addSource(SRC, {
      type: "raster",
      tiles: ["https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png"],
      tileSize: 256, maxzoom: 18,
      attribution: 'Trails © <a href="https://hiking.waymarkedtrails.org">Waymarked Trails</a>',
    })
    this.map.addLayer({
      id: LAYER, type: "raster", source: SRC,
      paint: { "raster-opacity": 0.85 },
    }, this._firstSymbolId())
  }

  _hide() { this._remove() }

  _remove() {
    if (this.map?.getLayer(LAYER)) this.map.removeLayer(LAYER)
    if (this.map?.getSource(SRC)) this.map.removeSource(SRC)
  }
}
