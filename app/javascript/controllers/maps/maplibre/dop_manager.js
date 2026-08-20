// German state DOP20 (20cm orthophoto) overlay (vicquick fork).
//
// Esri's world imagery is cloudy and coarse over Germany. Every Bundesland
// publishes DOP20 as open data, but as 16 SEPARATE WMS endpoints — adding all
// of them to the style at once would mean 16 services asked for tiles on every
// pan. Instead we keep only the states whose extent actually overlaps the
// viewport (usually one, occasionally two near a border) and drop the rest.
//
// Endpoints come from bimavo's GetMap-verified catalogue; each was re-checked
// in EPSG:3857 before shipping. Where a state has no data the WMS returns a
// tiny transparent PNG, so Esri simply shows through underneath.
const CATALOG_URL = "/maps_maplibre/dop20.json"
const SRC = (code) => `dop20-${code}`
const MIN_ZOOM = 11        // below this, Esri's cached tiles are plenty
const MAX_ACTIVE = 3       // hard cap on simultaneously mounted services
const PAD = 0.15           // keep a state mounted slightly beyond the viewport

export class DopManager {
  constructor(controller) {
    this.controller = controller
    this.catalog = null
    this.active = new Set()
    this._loading = null
  }

  get map() { return this.controller.map }

  // Only meaningful on the satellite style — that's where Esri needs replacing.
  _aerialActive() {
    try { return !!this.map?.getSource("esri-imagery") } catch (_) { return false }
  }

  async _catalog() {
    if (this.catalog) return this.catalog
    this._loading ||= fetch(CATALOG_URL)
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({}))
    this.catalog = await this._loading
    return this.catalog
  }

  // Which states overlap the current view (padded), best-covered first.
  _statesInView(cat) {
    const b = this.map.getBounds()
    const w = b.getWest() - PAD, s = b.getSouth() - PAD
    const e = b.getEast() + PAD, n = b.getNorth() + PAD
    return Object.entries(cat)
      .map(([code, st]) => {
        const [sw, ss, se, sn] = st.b
        const ow = Math.min(e, se) - Math.max(w, sw)
        const oh = Math.min(n, sn) - Math.max(s, ss)
        return ow > 0 && oh > 0 ? { code, st, area: ow * oh } : null
      })
      .filter(Boolean)
      .sort((a, b2) => b2.area - a.area)
      .slice(0, MAX_ACTIVE)
  }

  _add(code, st) {
    const id = SRC(code)
    if (this.map.getSource(id)) return
    const sep = st.u.includes("?") ? "&" : "?"
    const url = `${st.u}${sep}SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap` +
      `&LAYERS=${encodeURIComponent(st.l)}&STYLES=&CRS=EPSG:3857` +
      `&WIDTH=512&HEIGHT=512&FORMAT=image/png&TRANSPARENT=TRUE&BBOX={bbox-epsg-3857}`
    this.map.addSource(id, {
      type: "raster", tiles: [url], tileSize: 512, minzoom: MIN_ZOOM, maxzoom: 20,
      attribution: `DOP20 © ${st.n} (dl-de/by-2-0)`,
    })
    // Above the Esri imagery, below the label overlay.
    const before = this.map.getLayer("carto-labels") ? "carto-labels" : undefined
    this.map.addLayer({ id, type: "raster", source: id, minzoom: MIN_ZOOM }, before)
    this.active.add(code)
  }

  _remove(code) {
    const id = SRC(code)
    try {
      if (this.map.getLayer(id)) this.map.removeLayer(id)
      if (this.map.getSource(id)) this.map.removeSource(id)
    } catch (_) { /* style swapped mid-flight — harmless */ }
    this.active.delete(code)
  }

  // Called on move/zoom/style changes. Cheap and idempotent.
  async refresh() {
    if (!this.map) return
    if (!this._aerialActive() || this.map.getZoom() < MIN_ZOOM) {
      for (const code of [...this.active]) this._remove(code)
      return
    }
    const cat = await this._catalog()
    if (!cat || !Object.keys(cat).length || !this._aerialActive()) return

    const want = this._statesInView(cat)
    const wanted = new Set(want.map((x) => x.code))
    for (const code of [...this.active]) {
      // A style swap wipes layers without telling us — forget those too.
      if (!wanted.has(code) || !this.map.getSource(SRC(code))) this._remove(code)
    }
    for (const { code, st } of want) this._add(code, st)
  }
}
