// "Imported files" map layer (vicquick fork).
//
// GPX / KML / Takeout imports live in the same points table as live tracking,
// so upstream has no way to see ONE file on the map except a full-page
// ?import_id= filter. This manager renders any imported file as its own
// coloured overlay, independent of the date range — toggle your Sweden hike
// on and it stays visible whatever day the map shows.
//
// Exposed as window.dawarichImportLayers; driven by the Layers panel's
// "Imported files" section. Enabled ids persist in localStorage.
const STORE_KEY = "dawarichImportLayers"
const PALETTE = [
  "#3b82f6", "#f97316", "#a855f7", "#10b981", "#ef4444",
  "#eab308", "#06b6d4", "#ec4899", "#84cc16", "#f43f5e",
]

export class ImportsManager {
  constructor(controller) {
    this.controller = controller
    this.map = controller.map
    this._cache = new Map() // id -> geojson feature
  }

  colorFor(id) {
    return PALETTE[Math.abs(Number(id)) % PALETTE.length]
  }

  enabledIds() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || "[]") } catch (_) { return [] }
  }

  _persist(ids) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(ids)) } catch (_) { /* noop */ }
  }

  isOn(id) {
    return this.enabledIds().includes(Number(id))
  }

  // Restore persisted overlays once the style is ready.
  async restore() {
    for (const id of this.enabledIds()) {
      await this._add(id).catch(() => {})
    }
  }

  async toggle(id, { fly = true } = {}) {
    id = Number(id)
    const ids = this.enabledIds()
    if (ids.includes(id)) {
      this._remove(id)
      this._persist(ids.filter((x) => x !== id))
      return false
    }
    await this._add(id, { fly })
    this._persist([...ids, id])
    return true
  }

  async _fetchFeature(id) {
    if (this._cache.has(id)) return this._cache.get(id)
    const res = await fetch(`/api/v1/imports/${id}/geojson?api_key=${encodeURIComponent(this.controller.apiKeyValue)}`)
    if (!res.ok) throw new Error(`import ${id}: ${res.status}`)
    const f = await res.json()
    this._cache.set(id, f)
    return f
  }

  async _add(id, { fly = false } = {}) {
    if (!this.map) return
    const feature = await this._fetchFeature(id)
    const src = `import-${id}`
    if (!this.map.getSource(src)) {
      this.map.addSource(src, { type: "geojson", data: feature })
      const color = this.colorFor(id)
      this.map.addLayer({
        id: `${src}-casing`, type: "line", source: src,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#ffffff", "line-opacity": 0.55,
          "line-width": ["interpolate", ["linear"], ["zoom"], 8, 5.5, 14, 8],
        },
      })
      this.map.addLayer({
        id: `${src}-line`, type: "line", source: src,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": color, "line-opacity": 0.95,
          "line-width": ["interpolate", ["linear"], ["zoom"], 8, 3, 14, 5],
        },
      })
    }
    if (fly) this._fitTo(feature)
  }

  _fitTo(feature) {
    const coords = (feature.geometry?.coordinates || []).flat()
    if (coords.length < 2) return
    let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity
    for (const [lng, lat] of coords) {
      if (lng < minLng) minLng = lng
      if (lat < minLat) minLat = lat
      if (lng > maxLng) maxLng = lng
      if (lat > maxLat) maxLat = lat
    }
    try {
      this.map.fitBounds([[minLng, minLat], [maxLng, maxLat]], { padding: 60, duration: 900, maxZoom: 14 })
    } catch (_) { /* camera busy — non-fatal */ }
  }

  _remove(id) {
    const src = `import-${id}`
    if (this.map?.getLayer(`${src}-line`)) this.map.removeLayer(`${src}-line`)
    if (this.map?.getLayer(`${src}-casing`)) this.map.removeLayer(`${src}-casing`)
    if (this.map?.getSource(src)) this.map.removeSource(src)
  }

  // Overlays live outside the normal style lifecycle — re-add after a basemap
  // swap wipes the style.
  reapply() {
    for (const id of this.enabledIds()) {
      this._add(id).catch(() => {})
    }
  }

  async listImports() {
    const res = await fetch(`/api/v1/imports?per_page=100&api_key=${encodeURIComponent(this.controller.apiKeyValue)}`)
    if (!res.ok) return []
    const data = await res.json()
    return Array.isArray(data) ? data : (data.imports || [])
  }
}
