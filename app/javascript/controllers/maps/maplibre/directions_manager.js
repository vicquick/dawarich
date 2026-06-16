// DirectionsManager — turn-by-turn routing on the Dawarich map via self-hosted
// Valhalla (vicquick fork, "synthesize Dawarich + Atlas"). Self-contained:
// click to set start/destination, draw the route, show distance/time + turns.
import maplibregl from "maplibre-gl"

export class DirectionsManager {
  constructor(controller) {
    this.controller = controller
    this.active = false
    this.start = null
    this.end = null
    this.costing = "auto"
    this.markers = []
    this.boundClick = this.onMapClick.bind(this)
  }

  get map() {
    return this.controller.map
  }

  get apiKey() {
    return this.controller.apiKeyValue
  }

  toggle() {
    this.active ? this.disable() : this.enable()
    return this.active
  }

  enable() {
    if (!this.map) return
    this.active = true
    this.map.getCanvas().style.cursor = "crosshair"
    this.map.on("click", this.boundClick)
    this.setStatus("Click the map to set a start point.")
    this.panel()?.classList.remove("hidden")
  }

  disable() {
    this.active = false
    if (this.map) {
      this.map.getCanvas().style.cursor = ""
      this.map.off("click", this.boundClick)
    }
    // Second press of the toggle: fully clear route/markers and close the panel.
    this.clear()
    this.panel()?.classList.add("hidden")
  }

  clear() {
    this.start = null
    this.end = null
    this.markers.forEach((m) => m.remove())
    this.markers = []
    this.removeRoute()
    this.setStatus("Click the map to set a start point.")
    this.setSummary("")
    this.setTurns([])
  }

  setCosting(value) {
    this.costing = value
    if (this.start && this.end) this.computeRoute()
  }

  onMapClick(e) {
    if (!this.active) return
    const pt = { lat: e.lngLat.lat, lon: e.lngLat.lng }
    if (!this.start) {
      this.start = pt
      this.addMarker(e.lngLat, "#22c55e", "A")
      this.setStatus("Now click a destination.")
    } else if (!this.end) {
      this.end = pt
      this.addMarker(e.lngLat, "#ef4444", "B")
      this.computeRoute()
    } else {
      // third click restarts
      this.clear()
      this.start = pt
      this.addMarker(e.lngLat, "#22c55e", "A")
      this.setStatus("Now click a destination.")
    }
  }

  addMarker(lngLat, color, label) {
    const el = document.createElement("div")
    el.style.cssText = `background:${color};color:#fff;width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;font:bold 12px sans-serif;box-shadow:0 1px 4px rgba(0,0,0,.4)`
    el.textContent = label
    const marker = new maplibregl.Marker({ element: el }).setLngLat(lngLat).addTo(this.map)
    this.markers.push(marker)
  }

  // Programmatic "directions to here" — destination = given coords, start =
  // the user's current location (falls back to map center if unavailable).
  // The start marker stays draggable so it can be corrected.
  async routeTo(lat, lon) {
    if (!this.map) return
    // Don't enable manual map-click point-picking here — this is "directions to
    // a place", so the map should stay fully pannable/zoomable.
    this.active = true
    this.clear()
    this.end = { lat: Number(lat), lon: Number(lon) }
    this.addMarker([this.end.lon, this.end.lat], "#ef4444", "B")
    this.setStatus("Locating you…")
    this.start = await this.currentLocation()
    this.addStartMarker([this.start.lon, this.start.lat])
    this.computeRoute()
  }

  // Resolve the user's position; resolve to map center on denial/timeout.
  currentLocation() {
    const center = () => {
      const c = this.map.getCenter()
      return { lat: c.lat, lon: c.lng }
    }
    return new Promise((resolve) => {
      if (!navigator.geolocation) return resolve(center())
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
        () => resolve(center()),
        { enableHighAccuracy: true, timeout: 6000, maximumAge: 30000 },
      )
    })
  }

  // Draggable green start marker — lets the user re-pick the origin.
  addStartMarker(lngLat) {
    const el = document.createElement("div")
    el.style.cssText = `background:#22c55e;color:#fff;width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;font:bold 12px sans-serif;box-shadow:0 1px 4px rgba(0,0,0,.4);cursor:grab`
    el.textContent = "A"
    const marker = new maplibregl.Marker({ element: el, draggable: true })
      .setLngLat(lngLat)
      .addTo(this.map)
    marker.on("dragend", () => {
      const ll = marker.getLngLat()
      this.start = { lat: ll.lat, lon: ll.lng }
      if (this.end) this.computeRoute()
    })
    this.markers.push(marker)
  }

  async computeRoute() {
    this.setStatus("Routing…")
    try {
      const res = await fetch(`/api/v1/directions?api_key=${encodeURIComponent(this.apiKey)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locations: [this.start, this.end], costing: this.costing }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        this.setStatus(`No route: ${err.error || res.status}`)
        return
      }
      const feature = await res.json()
      this.drawRoute(feature)
      const p = feature.properties || {}
      const km = (p.distance_km ?? 0).toFixed(1)
      const mins = Math.round((p.duration_s ?? 0) / 60)
      this.setSummary(`${km} km · ${mins} min`)
      this.setTurns(p.maneuvers || [])
      this.setStatus("")
      this.fitRoute(feature.geometry.coordinates)
    } catch (e) {
      this.setStatus(`Routing failed: ${e.message}`)
    }
  }

  drawRoute(feature) {
    this.removeRoute()
    this.map.addSource("directions-route", { type: "geojson", data: feature })
    this.map.addLayer({
      id: "directions-route-casing",
      type: "line",
      source: "directions-route",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#1d4ed8", "line-width": 8, "line-opacity": 0.4 },
    })
    this.map.addLayer({
      id: "directions-route-line",
      type: "line",
      source: "directions-route",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#3b82f6", "line-width": 4 },
    })
  }

  removeRoute() {
    ;["directions-route-line", "directions-route-casing"].forEach((id) => {
      if (this.map?.getLayer(id)) this.map.removeLayer(id)
    })
    if (this.map?.getSource("directions-route")) this.map.removeSource("directions-route")
  }

  fitRoute(coords) {
    if (!coords || coords.length < 2) return
    const b = coords.reduce((acc, c) => acc.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]))
    // Reserve the area the place sheet covers so the route fits in the VISIBLE
    // part of the map (above the sheet), not hidden behind it.
    const sheet = document.querySelector('[data-controller~="place-sheet"]')
    const bottom = sheet && getComputedStyle(sheet).transform !== "none" ? sheet.offsetHeight + 24 : 60
    this.map.fitBounds(b, { padding: { top: 80, left: 40, right: 40, bottom }, duration: 600 })
  }

  // --- UI hooks (panel rendered by _directions_panel.html.erb) ---
  panel() { return document.getElementById("directions-panel") }
  setStatus(t) { const el = document.getElementById("directions-status"); if (el) el.textContent = t }
  setSummary(t) { const el = document.getElementById("directions-summary"); if (el) el.textContent = t }
  setTurns(list) {
    const el = document.getElementById("directions-turns")
    if (!el) return
    el.innerHTML = ""
    list.filter((m) => m.instruction).forEach((m) => {
      const li = document.createElement("li")
      li.className = "text-sm py-1 border-b border-base-300"
      const dist = m.length_km ? ` (${m.length_km.toFixed(1)} km)` : ""
      li.textContent = m.instruction + dist
      el.appendChild(li)
    })
  }
}
