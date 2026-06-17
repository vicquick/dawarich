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
    this.costing = "pedestrian" // Walk by default
    this.markers = []
    this.boundClick = this.onMapClick.bind(this)
    // --- live navigation state ---
    this.watchId = null          // navigator.geolocation.watchPosition handle
    this.userMarker = null       // blue "you are here" puck (also the route origin)
    this.manualStart = false     // user dragged the puck → stop GPS auto-follow
    this.lastRouteFrom = null    // origin used for the last drawn route {lat,lon}
    this.lastRouteAt = 0         // perf timestamp of the last route compute
    this.recomputeTimer = null
    this.tracking = false
    this.boundPosition = this.onPosition.bind(this)
    // --- turn-by-turn guidance + 3D nav camera ---
    this.routeCoords = []        // [[lon,lat], ...] full polyline
    this.maneuvers = []          // [{instruction,type,begin_shape_index,...}]
    this.maneuverMarker = null   // highlight at the next turn
    this.userPanned = false      // user dragged the map → pause follow-cam
    this.nav3d = false
    this.flatView = false        // 2D/3D toggle during nav
    this.destName = null
    this.routes = []             // [Feature, ...] best first
    this.selectedRouteIdx = 0
    this._rerouting = false
    this.boundPanStart = () => {
      if (this.tracking && !this.manualStart) { this.userPanned = true; this.showRecenter(true) }
    }
  }

  // Recompute throttle: don't hammer Valhalla on every GPS tick.
  static MOVE_THRESHOLD_M = 25      // ignore jitter below this
  static RECOMPUTE_INTERVAL_MS = 4000

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
    this.resetCamera()
    this.panel()?.classList.add("hidden")
  }

  clear() {
    this.stopTracking()
    this.exitNav()
    this.start = null
    this.end = null
    this.markers.forEach((m) => m.remove())
    this.markers = []
    this.userMarker = null
    this.manualStart = false
    this.lastRouteFrom = null
    this.lastRouteAt = 0
    this.routeCoords = []
    this.maneuvers = []
    this.routes = []
    this.selectedRouteIdx = 0
    this._rerouting = false
    const rc = document.getElementById("directions-routes")
    if (rc) { rc.style.display = "none"; rc.innerHTML = "" }
    this.removeRoute()
    this.setStatus("Click the map to set a start point.")
    this.setSummary("")
    this.setTurns([])
  }

  setCosting(value) {
    this.costing = value
    if (value === "transit") { this.computeTransit(); return }
    if (this.start && this.end) this.computeRoute(true)
  }

  // Public-transport routing via OTP2. Until the transit service is online the
  // endpoint returns 503 and we show a friendly placeholder.
  async computeTransit() {
    if (!this.start || !this.end) return
    this.setStatus("Finding public transport…")
    try {
      const res = await fetch(`/api/v1/transit?api_key=${encodeURIComponent(this.apiKey)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: this.start, to: this.end }),
      })
      if (res.status === 503 || res.status === 404) {
        this.setStatus("Public transport — coming soon")
        return
      }
      if (!res.ok) { this.setStatus("No transit route"); return }
      const data = await res.json()
      this.renderTransit(data)
    } catch (e) {
      this.setStatus("Public transport unavailable")
    }
  }

  // Placeholder until the transit itinerary UI lands with the OTP2 service.
  renderTransit(_data) {
    this.setStatus("Public transport — coming soon")
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
      this.computeRoute(true)
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
  // Route PREVIEW — 2D overview from current location to the place, with ETA +
  // mode chips + ride hand-off. No live tracking until the user taps Start.
  async preview(lat, lon, name) {
    if (!this.map) return
    this.active = true
    this.clear()
    this.costing = "pedestrian" // each new place opens in Walk
    this.destName = name || "Destination"
    this.end = { lat: Number(lat), lon: Number(lon) }
    this.addMarker([this.end.lon, this.end.lat], "#ef4444", "B")
    this.setStatus("Locating you…")
    this.start = await this.currentLocation()
    this.addUserMarker([this.start.lon, this.start.lat])
    this.showState("preview")
    this.computeRoute(true) // tracking off → 2D whole-route fit
    this.renderRideLinks()
  }

  // Back-compat: older callers may still invoke routeTo.
  routeTo(lat, lon) { return this.preview(lat, lon) }

  // Preview → live 3D turn-by-turn navigation.
  startNav() {
    if (!this.end || !this.start) return
    this.flatView = false
    const t = document.getElementById("directions-2d-toggle")
    if (t) t.textContent = "⊞ 2D"
    this.enterNav()
    this.startTracking()
    this.showState("nav")
    this.computeRoute(true) // tracking on → 3D follow-cam + guidance
  }

  // End navigation → back to the 2D route preview (keeps the route on screen).
  stopNav() {
    this.stopTracking()
    this.exitNav()
    this.showState("preview")
    this.flatView = false
    // Instant flatten (setPitch is reliable where fitBounds' pitch option is not),
    // then frame the whole route flat.
    if (this.map) { this.map.setPitch(0); this.map.setBearing(0) }
    if (this.routeCoords.length) this.fitRoute(this.routeCoords)
    this.updateGuidance(false)
  }

  // Flip the nav camera between 3D (tilted) and flat 2D.
  toggleDimension() {
    this.flatView = !this.flatView
    const btn = document.getElementById("directions-2d-toggle")
    if (btn) btn.textContent = this.flatView ? "⊟ 3D" : "⊞ 2D"
    if (!this.map) return
    if (this.tracking && !this.userPanned) this.updateGuidance(true)
    else this.map.easeTo({ pitch: this.flatView ? 0 : 58, duration: 400 })
  }

  // Show/hide the preview vs nav control groups. These are flex rows with inline
  // display, so toggle style.display (the [hidden] attribute would lose to it).
  showState(state) {
    const nav = state === "nav"
    const set = (id, show) => { const el = document.getElementById(id); if (el) el.style.display = show ? "flex" : "none" }
    set("directions-preview-header", !nav)
    set("directions-preview-actions", !nav)
    set("directions-nav-controls", nav)
    if (nav) { const rc = document.getElementById("directions-routes"); if (rc) rc.style.display = "none" }
    if (!nav) set("directions-nav-banner", false)
  }

  // Build ride-hailing hand-off links (opens the provider app with the route
  // preset). Pure deep links — no API, no data leaves beyond the two coords.
  // Only providers that actually operate at the pickup are shown (server checks
  // the country); both stay hidden until confirmed available.
  async renderRideLinks() {
    const uber = document.getElementById("ride-uber")
    const bolt = document.getElementById("ride-bolt")
    if (uber) uber.style.display = "none"
    if (bolt) bolt.style.display = "none"
    if (!this.start || !this.end) return
    const s = this.start, e = this.end
    const name = encodeURIComponent(this.destName || "Destination")
    if (uber) uber.href = `https://m.uber.com/ul/?action=setPickup&pickup[latitude]=${s.lat}&pickup[longitude]=${s.lon}&dropoff[latitude]=${e.lat}&dropoff[longitude]=${e.lon}&dropoff[nickname]=${name}`
    // Bolt app scheme (mobile, app installed). Best-effort — no public web fallback.
    if (bolt) bolt.href = `bolt://action/rideHailing?pickup_lat=${s.lat}&pickup_lng=${s.lon}&destination_lat=${e.lat}&destination_lng=${e.lon}`
    try {
      const res = await fetch(`/api/v1/ride_providers?lat=${s.lat}&lon=${s.lon}&api_key=${encodeURIComponent(this.apiKey)}`)
      if (!res.ok) return
      const avail = (await res.json()).providers || []
      if (uber && avail.includes("uber")) uber.style.display = ""
      if (bolt && avail.includes("bolt")) bolt.style.display = ""
    } catch (_) { /* leave hidden on error — only show where confirmed available */ }
  }

  // Enter navigation view: tilt to 3D, extrude buildings, watch for the user
  // panning away (so we can offer a re-center button instead of fighting them).
  enterNav() {
    this.userPanned = false
    this.add3DBuildings()
    this.map?.on("dragstart", this.boundPanStart)
  }

  exitNav() {
    this.map?.off("dragstart", this.boundPanStart)
    this.remove3DBuildings()
    if (this.maneuverMarker) { this.maneuverMarker.remove(); this.maneuverMarker = null }
    this.showRecenter(false)
    const bn = this.navBanner(); if (bn) bn.style.display = "none"
    this.userPanned = false
  }

  // Extrude the basemap's "buildings" layer for a 3D city feel under nav.
  add3DBuildings() {
    if (!this.map || this.nav3d) return
    try {
      if (!this.map.getSource("protomaps")) return
      if (this.map.getLayer("directions-buildings-3d")) return
      const before = this.map.getLayer("buildings") ? "buildings" : undefined
      this.map.addLayer({
        id: "directions-buildings-3d",
        type: "fill-extrusion",
        source: "protomaps",
        "source-layer": "buildings",
        minzoom: 14,
        paint: {
          "fill-extrusion-color": "#7c8597",
          "fill-extrusion-height": ["coalesce", ["get", "height"], ["get", "render_height"], 6],
          "fill-extrusion-base": ["coalesce", ["get", "min_height"], ["get", "render_min_height"], 0],
          "fill-extrusion-opacity": 0.55,
        },
      }, before)
      this.nav3d = true
    } catch (e) { /* basemap lacks building heights — pitch alone still reads as 3D */ }
  }

  remove3DBuildings() {
    try { if (this.map?.getLayer("directions-buildings-3d")) this.map.removeLayer("directions-buildings-3d") } catch (_) {}
    this.nav3d = false
  }

  recenter() {
    this.userPanned = false
    this.showRecenter(false)
    this.updateGuidance(true)
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

  // Live "you are here" puck — Google-style blue dot. Doubles as the route
  // origin and follows the device as it moves (see startTracking). Draggable so
  // the user can override the origin; dragging stops the GPS auto-follow.
  addUserMarker(lngLat) {
    this.ensurePuckStyle()
    const el = document.createElement("div")
    el.className = "dw-loc-puck"
    el.innerHTML = `<span class="dw-loc-pulse"></span><span class="dw-loc-dot"></span>`
    el.style.cursor = "grab"
    const marker = new maplibregl.Marker({ element: el, draggable: true })
      .setLngLat(lngLat)
      .addTo(this.map)
    marker.on("dragstart", () => { this.manualStart = true })
    marker.on("dragend", () => {
      const ll = marker.getLngLat()
      this.start = { lat: ll.lat, lon: ll.lng }
      if (this.end) this.computeRoute(true)
    })
    this.markers.push(marker)
    this.userMarker = marker
  }

  // Inject the puck CSS once (pulsing halo + solid dot).
  ensurePuckStyle() {
    if (document.getElementById("dw-loc-puck-style")) return
    const s = document.createElement("style")
    s.id = "dw-loc-puck-style"
    s.textContent = `
      .dw-loc-puck{position:relative;width:22px;height:22px}
      .dw-loc-dot{position:absolute;inset:4px;border-radius:50%;background:#1a73e8;
        border:2.5px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4)}
      .dw-loc-pulse{position:absolute;inset:0;border-radius:50%;background:rgba(26,115,232,.30);
        animation:dwLocPulse 1.8s ease-out infinite}
      @keyframes dwLocPulse{0%{transform:scale(.6);opacity:.8}100%{transform:scale(2.2);opacity:0}}`
    document.head.appendChild(s)
  }

  // Begin following the device location while directions are open.
  startTracking() {
    if (this.tracking || !navigator.geolocation) return
    this.tracking = true
    try {
      this.watchId = navigator.geolocation.watchPosition(
        this.boundPosition,
        () => { /* permission/timeout — keep the static route */ },
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
      )
    } catch (_) {
      this.tracking = false
    }
  }

  stopTracking() {
    if (this.watchId != null && navigator.geolocation) {
      try { navigator.geolocation.clearWatch(this.watchId) } catch (_) {}
    }
    this.watchId = null
    this.tracking = false
    if (this.recomputeTimer) { clearTimeout(this.recomputeTimer); this.recomputeTimer = null }
  }

  // New GPS fix: move the puck and (throttled) recompute the route.
  onPosition(pos) {
    if (this.manualStart || !this.active) return
    const here = { lat: pos.coords.latitude, lon: pos.coords.longitude }
    this.start = here
    if (this.userMarker) this.userMarker.setLngLat([here.lon, here.lat])
    // Smoothly update the banner + follow-cam every fix; recompute the actual
    // route only when throttled (below).
    this.updateGuidance(true)
    // Off-route → reroute now instead of waiting for the throttle.
    const dev = this.deviationFromRoute(here)
    if (dev != null && dev > 45 && !this._rerouting) {
      this._rerouting = true
      this.setStatus("Rerouting…")
      Promise.resolve(this.computeRoute(false)).finally(() => { this._rerouting = false })
    } else {
      this.scheduleRecompute()
    }
  }

  // Metres from the user to the nearest point on the active route (approx, by
  // nearest polyline vertex). null when there's no route yet.
  deviationFromRoute(here) {
    if (!this.routeCoords.length) return null
    const idx = this.nearestVertexIndex([here.lon, here.lat])
    return this.havLL(this.routeCoords[idx], [here.lon, here.lat])
  }

  // Recompute only when the user has actually moved (>25 m) and at most once
  // every few seconds — avoids spamming Valhalla on GPS jitter.
  scheduleRecompute() {
    if (!this.end || !this.start) return
    if (this.lastRouteFrom) {
      const moved = this.haversine(this.start, this.lastRouteFrom)
      if (moved < DirectionsManager.MOVE_THRESHOLD_M) return
    }
    const now = (typeof performance !== "undefined" ? performance.now() : Date.now())
    const wait = Math.max(0, DirectionsManager.RECOMPUTE_INTERVAL_MS - (now - this.lastRouteAt))
    if (this.recomputeTimer) return // one pending recompute is enough
    this.recomputeTimer = setTimeout(() => {
      this.recomputeTimer = null
      if (this.active && !this.manualStart) this.computeRoute(false)
    }, wait)
  }

  // Metres between two {lat,lon} points.
  haversine(a, b) {
    const R = 6371000, toRad = (d) => (d * Math.PI) / 180
    const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon)
    const s = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2
    return 2 * R * Math.asin(Math.sqrt(s))
  }

  // fit=true frames the whole route (initial open / mode change). Live
  // recomputes pass fit=false so the camera doesn't jerk while you move.
  async computeRoute(fit = false) {
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
      const data = await res.json()
      // New shape: {routes:[Feature,...]}; tolerate a bare Feature (back-compat).
      this.routes = Array.isArray(data.routes) ? data.routes : (data.type === "Feature" ? [data] : [])
      if (!this.routes.length) { this.setStatus("No route found"); return }
      this.selectedRouteIdx = 0
      this.applySelectedRoute()
      this.drawRoutes()
      this.renderRouteChoices()
      this.setStatus("")
      this.lastRouteFrom = this.start ? { ...this.start } : null
      this.lastRouteAt = (typeof performance !== "undefined" ? performance.now() : Date.now())
      // Camera: nav follow-cam when tracking live; whole-route fit otherwise.
      if (fit && this.tracking) this.updateGuidance(true)
      else if (fit) { this.fitRoute(this.routeCoords); this.updateGuidance(false) }
      else this.updateGuidance(false)
    } catch (e) {
      this.setStatus(`Routing failed: ${e.message}`)
    }
  }

  // Read coords/maneuvers/summary/turns from the currently selected route.
  applySelectedRoute() {
    const f = this.routes[this.selectedRouteIdx]
    if (!f) return
    const p = f.properties || {}
    this.routeCoords = f.geometry?.coordinates || []
    this.maneuvers = p.maneuvers || []
    const km = (p.distance_km ?? 0).toFixed(1)
    const mins = Math.round((p.duration_s ?? 0) / 60)
    const live = this.tracking && !this.manualStart ? `  <span style="color:#16a34a">● Live</span>` : ""
    this.setSummary(`${km} km · ${mins} min${live}`, true)
    this.setTurns(this.maneuvers)
  }

  // Pick an alternative route (from the preview chooser) without refetching.
  selectRoute(i) {
    if (i < 0 || i >= this.routes.length) return
    this.selectedRouteIdx = i
    this.applySelectedRoute()
    this.drawRoutes()
    this.renderRouteChoices()
    this.updateGuidance(false)
    if (!this.tracking && this.routeCoords.length) this.fitRoute(this.routeCoords)
  }

  // Render the route chooser chips (only when there's more than one option).
  renderRouteChoices() {
    const el = document.getElementById("directions-routes")
    if (!el) return
    // Chooser is a preview-only affordance — not shown during active nav.
    if (this.routes.length < 2 || this.tracking) { el.style.display = "none"; el.innerHTML = ""; return }
    el.style.display = "flex"
    el.innerHTML = ""
    this.routes.forEach((f, i) => {
      const p = f.properties || {}
      const km = (p.distance_km ?? 0).toFixed(1)
      const mins = Math.round((p.duration_s ?? 0) / 60)
      const on = i === this.selectedRouteIdx
      const btn = document.createElement("button")
      btn.type = "button"
      btn.textContent = `${i === 0 ? "Best" : "Alt " + i} · ${km} km · ${mins} min`
      btn.style.cssText = `border:1px solid ${on ? "#1a73e8" : "rgba(128,128,128,.4)"};color:${on ? "#fff" : "inherit"};background:${on ? "#1a73e8" : "transparent"};border-radius:999px;padding:5px 11px;font-size:.78rem;font-weight:600;cursor:pointer`
      btn.addEventListener("click", () => this.selectRoute(i))
      el.appendChild(btn)
    })
  }

  // Draw all routes: alternatives in grey underneath, selected in blue on top.
  drawRoutes() {
    this.removeRoute()
    this.routes.forEach((f, i) => {
      if (i === this.selectedRouteIdx) return
      const id = `directions-alt-${i}`
      this.map.addSource(id, { type: "geojson", data: f })
      this.map.addLayer({
        id, type: "line", source: id,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#9aa0a6", "line-width": 5, "line-opacity": 0.85 },
      })
      this.map.on("click", id, () => this.selectRoute(i))
      this.map.on("mouseenter", id, () => { this.map.getCanvas().style.cursor = "pointer" })
      this.map.on("mouseleave", id, () => { this.map.getCanvas().style.cursor = "" })
    })
    const sel = this.routes[this.selectedRouteIdx]
    if (!sel) return
    this.map.addSource("directions-route", { type: "geojson", data: sel })
    this.map.addLayer({
      id: "directions-route-casing", type: "line", source: "directions-route",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#1d4ed8", "line-width": 8, "line-opacity": 0.4 },
    })
    this.map.addLayer({
      id: "directions-route-line", type: "line", source: "directions-route",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#3b82f6", "line-width": 4 },
    })
  }

  removeRoute() {
    ;["directions-route-line", "directions-route-casing"].forEach((id) => {
      if (this.map?.getLayer(id)) this.map.removeLayer(id)
    })
    if (this.map?.getSource("directions-route")) this.map.removeSource("directions-route")
    // Remove any alternate layers/sources from a previous draw.
    const style = this.map?.getStyle?.()
    if (style?.layers) {
      style.layers.filter((l) => l.id.startsWith("directions-alt-")).forEach((l) => {
        if (this.map.getLayer(l.id)) this.map.removeLayer(l.id)
        if (this.map.getSource(l.id)) this.map.removeSource(l.id)
      })
    }
  }

  fitRoute(coords) {
    if (!coords || coords.length < 2) return
    const b = coords.reduce((acc, c) => acc.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]))
    // Reserve the area the place sheet covers so the route fits in the VISIBLE
    // part of the map (above the sheet), not hidden behind it.
    const sheet = document.querySelector('[data-controller~="place-sheet"]')
    const bottom = sheet && getComputedStyle(sheet).transform !== "none" ? sheet.offsetHeight + 24 : 60
    // Callers flatten the camera (setPitch 0) first; fitBounds preserves pitch,
    // so the overview comes out flat north-up.
    this.map.fitBounds(b, { padding: { top: 80, left: 40, right: 40, bottom }, duration: 600 })
  }

  // --- UI hooks (panel rendered by _directions_panel.html.erb) ---
  panel() { return document.getElementById("directions-panel") }
  setStatus(t) { const el = document.getElementById("directions-status"); if (el) el.textContent = t }
  setSummary(t, html = false) { const el = document.getElementById("directions-summary"); if (el) el[html ? "innerHTML" : "textContent"] = t }
  setTurns(list) {
    const el = document.getElementById("directions-turns")
    if (!el) return
    el.innerHTML = ""
    list.forEach((m, i) => {
      if (!m.instruction) return
      const li = document.createElement("li")
      li.className = "text-sm py-1 border-b border-base-300"
      li.dataset.mi = i
      const dist = m.length_km ? ` (${m.length_km.toFixed(1)} km)` : ""
      li.textContent = m.instruction + dist
      el.appendChild(li)
    })
  }

  // --- live guidance: next manoeuvre banner, highlight, follow-camera ---
  navBanner() { return document.getElementById("directions-nav-banner") }
  showRecenter(on) {
    const b = document.getElementById("directions-recenter")
    if (b) b.hidden = !on
  }

  // Compute progress along the route from the current origin and refresh the
  // next-manoeuvre banner + on-map highlight; optionally move the nav camera.
  updateGuidance(moveCamera) {
    if (!this.routeCoords.length || !this.maneuvers.length || !this.start) {
      const bn = this.navBanner(); if (bn) bn.style.display = "none"
      return
    }
    const here = [this.start.lon, this.start.lat]
    const idx = this.nearestVertexIndex(here)
    // Next manoeuvre = first one whose turn point is ahead of us on the line.
    let next = this.maneuvers.find((m) => (m.begin_shape_index ?? 0) > idx)
    if (!next) next = this.maneuvers[this.maneuvers.length - 1]
    const turnIdx = Math.min(next.begin_shape_index ?? this.routeCoords.length - 1, this.routeCoords.length - 1)
    const turnCoord = this.routeCoords[turnIdx]
    const dist = this.alongDistance(idx, turnIdx)

    // Banner
    const banner = this.navBanner()
    if (banner && this.tracking) {
      banner.style.display = "flex"
      const arrow = document.getElementById("directions-nav-arrow")
      const dEl = document.getElementById("directions-nav-dist")
      const iEl = document.getElementById("directions-nav-instr")
      if (arrow) arrow.textContent = this.arrowFor(next)
      if (dEl) dEl.textContent = this.fmtDist(dist)
      if (iEl) iEl.textContent = next.instruction || ""
    }
    // Bold the active step in the list
    const list = document.getElementById("directions-turns")
    if (list) {
      const activeMi = String(this.maneuvers.indexOf(next))
      list.querySelectorAll("li").forEach((li) => {
        const on = li.dataset.mi === activeMi
        li.style.fontWeight = on ? "700" : ""
        li.style.color = on ? "#1a73e8" : ""
      })
    }
    // On-map highlight at the next turn
    this.highlightManeuver(turnCoord)

    // Follow-camera (3D, facing travel) unless the user panned away.
    if (moveCamera && this.tracking && !this.manualStart && !this.userPanned) {
      const ahead = this.routeCoords[Math.min(idx + 1, this.routeCoords.length - 1)]
      const bearing = this.bearingDeg(here, ahead)
      this.navCamera(here, bearing)
    }
  }

  highlightManeuver(coord) {
    if (!coord) return
    if (!this.maneuverMarker) {
      const el = document.createElement("div")
      el.style.cssText = "width:18px;height:18px;border-radius:50%;background:#fbbc04;border:3px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,.5)"
      this.maneuverMarker = new maplibregl.Marker({ element: el }).setLngLat(coord).addTo(this.map)
    } else {
      this.maneuverMarker.setLngLat(coord)
    }
  }

  // Tilted camera centred on the user, facing the direction of travel, with the
  // sheet area reserved so the puck sits in the visible map above it.
  navCamera(center, bearing) {
    if (!this.map) return
    const sheet = document.querySelector('[data-controller~="place-sheet"]')
    const bottom = sheet && getComputedStyle(sheet).transform !== "none" ? sheet.offsetHeight + 40 : 80
    this.map.easeTo({
      center,
      bearing: this.flatView ? 0 : (Number.isFinite(bearing) ? bearing : this.map.getBearing()),
      pitch: this.flatView ? 0 : 58,
      zoom: Math.max(this.map.getZoom(), 16.5),
      padding: { top: 140, bottom, left: 0, right: 0 },
      duration: 900,
    })
  }

  resetCamera() {
    try { this.map?.easeTo({ pitch: 0, bearing: 0, padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: 500 }) } catch (_) {}
  }

  // Index of the route vertex nearest the given [lon,lat].
  nearestVertexIndex(lonlat) {
    let best = 0, bestD = Infinity
    for (let i = 0; i < this.routeCoords.length; i++) {
      const d = this.havLL(this.routeCoords[i], lonlat)
      if (d < bestD) { bestD = d; best = i }
    }
    return best
  }

  // Distance in metres along the polyline between vertex indices i and j.
  alongDistance(i, j) {
    let d = 0
    for (let k = i; k < j; k++) d += this.havLL(this.routeCoords[k], this.routeCoords[k + 1])
    return d
  }

  // Initial bearing (degrees) from a→b, both [lon,lat].
  bearingDeg(a, b) {
    const toRad = (x) => (x * Math.PI) / 180, toDeg = (x) => (x * 180) / Math.PI
    const φ1 = toRad(a[1]), φ2 = toRad(b[1]), Δλ = toRad(b[0] - a[0])
    const y = Math.sin(Δλ) * Math.cos(φ2)
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
    return (toDeg(Math.atan2(y, x)) + 360) % 360
  }

  havLL(a, b) { return this.haversine({ lon: a[0], lat: a[1] }, { lon: b[0], lat: b[1] }) }

  fmtDist(m) {
    if (m < 1000) return `${Math.max(0, Math.round(m / 10) * 10)} m`
    return `${(m / 1000).toFixed(1)} km`
  }

  // Arrow glyph for the manoeuvre (from instruction text — robust across types).
  arrowFor(m) {
    const t = (m?.instruction || "").toLowerCase()
    if (/roundabout|rotary/.test(t)) return "⟳"
    if (/destination|arrive|arrived/.test(t)) return "📍"
    if (/sharp left/.test(t)) return "↰"
    if (/sharp right/.test(t)) return "↱"
    if (/left/.test(t)) return "←"
    if (/right/.test(t)) return "→"
    if (/u-turn|uturn|make a u/.test(t)) return "⤺"
    return "↑"
  }
}
