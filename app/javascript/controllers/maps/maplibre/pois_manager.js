// POIsManager (vicquick fork) — makes the basemap POIs interactive.
//
// The `pois` / `poi_circles` layers (injected into every style by
// bin/inject_pois.py) render Magic-Earth-density points straight from the
// Protomaps planet tiles. This wires gestures to them:
//   * desktop  — click a POI to open its detail sheet
//   * mobile   — long-press a POI to open it (a plain tap pans, like Google)
//   * long-press on empty map (either input) — drop a labeled pin
//
// Handlers are bound once on the map; the layer IDs persist across basemap
// (theme) switches because every style ships them, so no re-binding needed.

const POI_LAYERS = ["pois", "poi_circles"]
const LONG_PRESS_MS = 450
const MOVE_TOLERANCE = 10 // px of finger travel that cancels a long-press
const TOUCH_CLICK_WINDOW = 700 // ms: suppress the click MapLibre synthesizes after touch

export class POIsManager {
  constructor(controller) {
    this.controller = controller
    this.map = controller.map
    this._lastTouch = 0
    this._pressTimer = null
    this._pinMarker = null
  }

  setup() {
    if (!this.map || this._wired) return
    this._wired = true

    // Desktop: pointer cursor when hovering a POI.
    POI_LAYERS.forEach((layer) => {
      this.map.on("mouseenter", layer, () => {
        this.map.getCanvas().style.cursor = "pointer"
      })
      this.map.on("mouseleave", layer, () => {
        this.map.getCanvas().style.cursor = ""
      })
    })

    // Desktop click (ignored when it trails a touch — mobile uses long-press).
    this.map.on("click", (e) => {
      if (Date.now() - this._lastTouch < TOUCH_CLICK_WINDOW) return
      const poi = this.poiAt(e.point)
      if (poi) {
        e.preventDefault?.()
        this.openPoi(poi)
      }
    })

    // Mobile: long-press detection on the canvas.
    const canvas = this.map.getCanvas()
    canvas.addEventListener("touchstart", (ev) => this.onTouchStart(ev), { passive: true })
    canvas.addEventListener("touchmove", (ev) => this.onTouchMove(ev), { passive: true })
    canvas.addEventListener("touchend", () => this.clearPress(), { passive: true })
    canvas.addEventListener("touchcancel", () => this.clearPress(), { passive: true })
  }

  onTouchStart(ev) {
    this._lastTouch = Date.now()
    if (ev.touches.length !== 1) return this.clearPress()
    const t = ev.touches[0]
    this._pressStart = { x: t.clientX, y: t.clientY }
    const rect = this.map.getCanvas().getBoundingClientRect()
    const point = [t.clientX - rect.left, t.clientY - rect.top]
    const lngLat = this.map.unproject(point)
    this.clearPress()
    this._pressTimer = setTimeout(() => {
      this._pressTimer = null
      if (navigator.vibrate) try { navigator.vibrate(12) } catch (_) {}
      const poi = this.poiAt(point)
      if (poi) this.openPoi(poi)
      else this.dropPin(lngLat.lat, lngLat.lng)
    }, LONG_PRESS_MS)
  }

  onTouchMove(ev) {
    if (!this._pressStart || !this._pressTimer) return
    const t = ev.touches[0]
    if (!t) return
    const dx = t.clientX - this._pressStart.x
    const dy = t.clientY - this._pressStart.y
    if (dx * dx + dy * dy > MOVE_TOLERANCE * MOVE_TOLERANCE) this.clearPress()
  }

  clearPress() {
    if (this._pressTimer) {
      clearTimeout(this._pressTimer)
      this._pressTimer = null
    }
  }

  // Topmost POI feature under a screen point, or null.
  // `point` is either a MapLibre Point ({x,y}) from click, or [x,y] from touch.
  poiAt(point) {
    const layers = POI_LAYERS.filter((l) => this.map.getLayer(l))
    if (!layers.length) return null
    const x = point.x != null ? point.x : point[0]
    const y = point.y != null ? point.y : point[1]
    const slop = 7 // px — finger/cursor tolerance so the small dot is easy to hit
    const box = [[x - slop, y - slop], [x + slop, y + slop]]
    const feats = this.map.queryRenderedFeatures(box, { layers })
    return feats && feats.length ? feats[0] : null
  }

  openPoi(feature) {
    const p = feature.properties || {}
    const coords = feature.geometry?.coordinates || []
    const name = p["name:en"] || p["pgf:name"] || p.name || this.prettyKind(p.kind) || "Place"
    document.dispatchEvent(
      new CustomEvent("place-sheet:open", {
        detail: {
          name,
          lat: coords[1],
          lon: coords[0],
          type: this.prettyKind(p.kind),
          kind: p.kind,
          // Protomaps encodes the OSM id as the feature id — best-effort node
          // lookup for enrichment (open-now/hours); falls back gracefully.
          osm_type: feature.id ? "node" : undefined,
          osm_id: feature.id || undefined,
        },
      }),
    )
  }

  // Long-press on empty map → drop a pin the user can label/save.
  dropPin(lat, lon) {
    if (navigator.vibrate) try { navigator.vibrate(12) } catch (_) {}
    document.dispatchEvent(
      new CustomEvent("place-sheet:open", {
        detail: {
          name: "Dropped pin",
          lat,
          lon,
          type: "Pin",
          droppedPin: true,
          editableName: true,
        },
      }),
    )
  }

  prettyKind(kind) {
    if (!kind) return ""
    return String(kind).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  }
}
