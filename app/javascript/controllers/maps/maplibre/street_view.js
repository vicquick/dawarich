// Street View via KartaView (vicquick fork).
//
// Free & open street-level imagery, no API key, no self-hosting, no backend.
// KartaView (ex-OpenStreetCam) has dense coverage — Lüneburg has 10-20 driven
// sequences per block. We:
//   • query nearby photos as you pan → draw the covered "streets" in blue,
//   • tap a blue street → fullscreen photo viewer (flat dashcam frames),
//   • ‹ › walk the capture sequence, like Google.
// The API is CORS-open (*) and images come off a CDN, so it's pure client-side.
import maplibregl from "maplibre-gl"

const API1 = "https://api.kartaview.org/1.0"
const API2 = "https://api.kartaview.org/2.0"
const SRC = "kartaview"
const BLUE = "#1a73e8"

export class StreetView {
  constructor(controller) {
    this.controller = controller
    this.on = false
    this._photos = []          // flat cache of nearby photos for tap-nearest
    this._seqCache = {}         // sequenceId -> ordered [photo]
    this._imgCache = new Map()  // url -> decoded HTMLImageElement (prefetch)
    this._boundClick = (e) => this.onMapClick(e)
    this._boundMove = () => this._debounceRefresh()
  }

  get map() { return this.controller.map }
  isOn() { return this.on }
  toggle() { this.on ? this.disable() : this.enable(); return this.on }

  enable() {
    const map = this.map
    if (!map || this.on) return
    this.on = true
    if (!map.getSource(SRC)) {
      map.addSource(SRC, { type: "geojson", data: this._empty(), attribution: '<a href="https://kartaview.org" target="_blank" rel="noopener">KartaView</a>' })
      map.addLayer({ id: "kv-seq", type: "line", source: SRC, filter: ["==", "$type", "LineString"], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": BLUE, "line-width": ["interpolate", ["linear"], ["zoom"], 12, 2.5, 17, 6], "line-opacity": 0.9 } })
      map.addLayer({ id: "kv-pic", type: "circle", source: SRC, filter: ["==", "$type", "Point"], minzoom: 16, paint: { "circle-radius": 4, "circle-color": "#fff", "circle-stroke-color": BLUE, "circle-stroke-width": 2 } })
    }
    map.on("click", this._boundClick)
    map.on("moveend", this._boundMove)
    map.getCanvas().style.cursor = "crosshair"
    this.refresh()
    this._toast("Tap a blue street to look around")
  }

  disable() {
    const map = this.map
    this.on = false
    if (!map) return
    for (const id of ["kv-pic", "kv-seq"]) if (map.getLayer(id)) map.removeLayer(id)
    if (map.getSource(SRC)) map.removeSource(SRC)
    map.off("click", this._boundClick)
    map.off("moveend", this._boundMove)
    map.getCanvas().style.cursor = ""
  }

  _empty() { return { type: "FeatureCollection", features: [] } }
  _debounceRefresh() { clearTimeout(this._refreshT); this._refreshT = setTimeout(() => this.refresh(), 350) }

  // Pull nearby photos for the current viewport → blue coverage lines.
  async refresh() {
    const map = this.map
    if (!map || !this.on) return
    if (map.getZoom() < 13) { map.getSource(SRC)?.setData(this._empty()); this._photos = []; this._lastQ = null; return }
    const c = map.getCenter()
    // skip refetch when we've barely moved (smoother panning, fewer requests)
    if (this._lastQ && this._haversine(c.lat, c.lng, this._lastQ.lat, this._lastQ.lng) < 220 && Math.abs(map.getZoom() - this._lastQ.z) < 0.5) return
    this._lastQ = { lat: c.lat, lng: c.lng, z: map.getZoom() }
    const b = map.getBounds()
    const radius = Math.min(1600, Math.round(this._haversine(c.lat, c.lng, b.getNorth(), b.getEast())))
    const items = await this._nearby(c.lat, c.lng, radius)
    if (!items || !this.on) return
    this._photos = this._mapItems(items)
    // group into sequences → LineStrings
    const bySeq = {}
    for (const p of items) (bySeq[p.sequence_id] ||= []).push(p)
    const feats = []
    for (const seq of Object.values(bySeq)) {
      seq.sort((a, b2) => (+a.sequence_index) - (+b2.sequence_index))
      if (seq.length >= 2) feats.push({ type: "Feature", geometry: { type: "LineString", coordinates: seq.map((p) => [+p.lng, +p.lat]) }, properties: {} })
      else if (seq.length === 1) feats.push({ type: "Feature", geometry: { type: "Point", coordinates: [+seq[0].lng, +seq[0].lat] }, properties: {} })
    }
    map.getSource(SRC)?.setData({ type: "FeatureCollection", features: feats })
  }

  async _nearby(lat, lng, radius) {
    try {
      const r = await fetch(`${API1}/list/nearby-photos/`, {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `lat=${lat}&lng=${lng}&radius=${radius}`,
      })
      if (!r.ok) return null
      return (await r.json()).currentPageItems || []
    } catch (_) { return null }
  }

  async onMapClick(e) {
    const { lng, lat } = e.lngLat
    // Always query around the EXACT tapped point so we open the imagery there —
    // not whatever happened to be cached in the viewport.
    const items = await this._nearby(lat, lng, 70)
    const best = this._closest(this._mapItems(items), lng, lat, 70)
    if (!best) return this._toast("No imagery right here — try a blue street")
    this.openPhoto(best.id, best.seq)
  }

  async openAt(lng, lat) {
    const items = await this._nearby(lat, lng, 120)
    const best = this._closest(this._mapItems(items), lng, lat, 120)
    if (!best) { this._toast("No Street View here"); return false }
    this.openPhoto(best.id, best.seq)
    return true
  }

  _mapItems(items) {
    return (items || []).map((p) => ({ id: p.id, seq: p.sequence_id, idx: +p.sequence_index, lat: +p.lat, lng: +p.lng, date: p.shot_date, heading: +p.heading }))
  }

  // Snap to the nearest photo, but among photos at the same spot prefer the
  // NEWEST capture (KartaView has several drives per street on different dates).
  _closest(list, lng, lat, maxMeters) {
    const scored = []
    for (const p of list || []) {
      const m = this._haversine(lat, lng, p.lat, p.lng)
      if (m <= maxMeters) scored.push({ p, m })
    }
    if (!scored.length) return null
    scored.sort((a, b) => a.m - b.m)
    const dmin = scored[0].m
    const cluster = scored.filter((x) => x.m <= dmin + 18) // ≈ same spot (±18 m)
    cluster.sort((a, b) => String(b.p.date || "").localeCompare(String(a.p.date || "")))
    return cluster[0].p
  }

  // --- viewer ---
  async openPhoto(id, seqId) {
    if (!this._overlay) this._buildOverlay()
    this._overlay.style.display = "block"
    requestAnimationFrame(() => { this._overlay.classList.add("kv--in"); this._miniMap?.resize() })
    const seq = await this._sequence(seqId)
    this._seq = seq
    this._idx = Math.max(0, seq.findIndex((p) => String(p.id) === String(id)))
    this._panX = 50; this._panY = 50 // centered on a fresh open
    this._showFrame()
  }

  _preload(url) {
    if (!url) return null
    let img = this._imgCache.get(url)
    if (img) return img
    img = new Image(); img.decoding = "async"; img.src = url
    this._imgCache.set(url, img)
    if (this._imgCache.size > 48) { // evict oldest
      const k = this._imgCache.keys().next().value
      this._imgCache.delete(k)
    }
    return img
  }

  // Prefetch a rolling window so driving forward is instant.
  _prefetchWindow() {
    const s = this._seq; if (!s) return
    for (let i = this._idx - 2; i <= this._idx + 8; i++) {
      const p = s[i]; if (p) this._preload(p.imageLthUrl || p.imageProcUrl)
    }
  }

  // Hold a chevron to keep driving; a quick tap advances one frame.
  _startDrive(dir) {
    this._nav(dir)
    this._driving = true
    clearInterval(this._driveT)
    this._driveT = setInterval(() => {
      const i = this._idx + dir
      if (i < 0 || i >= (this._seq?.length || 0)) return this._stopDrive()
      this._nav(dir)
    }, 300)
  }
  _stopDrive() { this._driving = false; clearInterval(this._driveT) }

  async _sequence(seqId) {
    if (this._seqCache[seqId]) return this._seqCache[seqId]
    try {
      const r = await fetch(`${API2}/sequence/${seqId}/photos`)
      const data = (await r.json())?.result?.data || []
      data.sort((a, b) => (+a.sequenceIndex) - (+b.sequenceIndex))
      this._seqCache[seqId] = data
      return data
    } catch (_) { return [] }
  }

  _showFrame() {
    const p = this._seq?.[this._idx]
    if (!p) return
    const lth = p.imageLthUrl || p.imageProcUrl
    const th = p.imageThUrl
    // show only once the image is decoded (so _fit knows the natural aspect)
    const show = (u) => { if (this._seq?.[this._idx] !== p) return; this._stage.style.backgroundImage = `url("${u}")`; this._fit(u); this._applyPan() }
    const lthImg = this._preload(lth)
    if (lthImg.complete && lthImg.naturalWidth) {
      show(lth)
    } else {
      if (th) { const t = this._preload(th); if (t.complete && t.naturalWidth) show(th); else t.addEventListener("load", () => { if (!(lthImg.complete && lthImg.naturalWidth)) show(th) }, { once: true }) }
      lthImg.addEventListener("load", () => show(lth), { once: true })
    }
    this._date.textContent = (p.shotDate || "").slice(0, 10)
    this._fwd.style.display = this._idx < this._seq.length - 1 ? "block" : "none"
    this._back.style.display = this._idx > 0 ? "block" : "none"
    this._prefetchWindow()
    this._maybeNearby()   // keep _photos fresh around us (junctions + minimap)
    this._updateMini()
    this._updateJunctions()
  }

  // Refresh nearby photos when we've moved enough (drives junctions + minimap).
  _maybeNearby() {
    const p = this._seq?.[this._idx]; if (!p) return
    const lat = +p.lat, lng = +p.lng
    if (this._nbCenter && this._haversine(lat, lng, this._nbCenter.lat, this._nbCenter.lng) < 55) return
    this._nbCenter = { lat, lng }
    this._nearby(lat, lng, 160).then((items) => {
      if (!items) return
      this._photos = this._mapItems(items)
      this._updateJunctions()
      this._updateMiniCoverage()
    })
  }

  _bearing(lat1, lon1, lat2, lon2) {
    const r = Math.PI / 180
    const y = Math.sin((lon2 - lon1) * r) * Math.cos(lat2 * r)
    const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r)
    return (Math.atan2(y, x) / r + 360) % 360
  }

  // At junctions, show extra chevrons pointing onto crossing sequences.
  _updateJunctions() {
    (this._turns || []).forEach((b) => b.remove())
    this._turns = []
    const p = this._seq?.[this._idx]
    if (!p || !this._overlay) return
    const hLat = +p.lat, hLng = +p.lng, fwd = +p.heading || this._bearing(hLat, hLng, +(this._seq[this._idx + 1]?.lat ?? hLat), +(this._seq[this._idx + 1]?.lng ?? hLng))
    // nearest photo of each OTHER sequence within ~28 m
    const bySeq = {}
    for (const q of this._photos || []) {
      if (String(q.seq) === String(p.sequenceId)) continue
      const d = this._haversine(hLat, hLng, q.lat, q.lng)
      if (d > 22) continue // only a genuinely-adjacent crossing counts as a junction
      if (!bySeq[q.seq] || d < bySeq[q.seq].d) bySeq[q.seq] = { q, d }
    }
    const cands = []
    for (const { q } of Object.values(bySeq)) {
      // Reject parallel drives of the SAME road: fold both travel headings to a
      // 0-90° road orientation and require a real angular difference (a crossing).
      if (Number.isFinite(q.heading)) {
        let hd = (((q.heading - fwd) % 180) + 180) % 180
        if (hd > 90) hd = 180 - hd
        if (hd < 38) continue // <38° apart = same/parallel street, not a junction
      }
      const rel = ((this._bearing(hLat, hLng, q.lat, q.lng) - fwd + 540) % 360) - 180
      if (Math.abs(rel) < 25 || Math.abs(rel) > 155) continue // straight ahead/behind
      cands.push({ q, rel })
    }
    cands.sort((a, b) => Math.abs(Math.abs(a.rel) - 90) - Math.abs(Math.abs(b.rel) - 90)) // prefer the most perpendicular
    const used = []
    for (const t of cands) {
      if (used.some((u) => Math.abs(u - t.rel) < 50)) continue
      used.push(t.rel)
      this._renderTurn(t)
      if (used.length >= 2) break
    }
  }

  _renderTurn(t) {
    const b = document.createElement("button")
    b.className = "kv-ground kv-turn"
    b.setAttribute("aria-label", t.rel > 0 ? "Turn right" : "Turn left")
    b.innerHTML = '<svg viewBox="0 0 64 44" aria-hidden="true"><path d="M8 34 L32 11 L56 34"/></svg>'
    b.style.left = `${Math.max(15, Math.min(85, 50 + (t.rel / 90) * 40))}%`
    b.style.bottom = "30%"
    const tilt = Math.max(-82, Math.min(82, t.rel * 0.9)) // point the chevron toward the turn
    b.querySelector("svg").style.transform = `rotateX(48deg) rotateZ(${tilt}deg)`
    b.addEventListener("pointerdown", (e) => { e.preventDefault(); this.openPhoto(t.q.id, t.q.seq) })
    this._overlay.appendChild(b)
    this._turns.push(b)
  }

  _nav(delta) {
    if (!this._seq) return
    const i = this._idx + delta
    if (i < 0 || i >= this._seq.length) return
    this._idx = i
    this._showFrame()
  }

  close() {
    if (!this._overlay) return
    this._overlay.classList.remove("kv--in")
    setTimeout(() => { if (this._overlay) this._overlay.style.display = "none" }, 200)
  }

  _buildOverlay() {
    this._injectStyle()
    const o = document.createElement("div")
    o.className = "kv-overlay"
    o.innerHTML = `
      <div class="kv-stage"></div>
      <div class="kv-top">
        <button class="kv-btn kv-close" aria-label="Close Street View">✕</button>
        <div class="kv-meta"><span class="kv-dot"></span><span class="kv-date"></span>
          <a href="https://kartaview.org" target="_blank" rel="noopener" class="kv-credit">© KartaView</a></div>
      </div>
      <button class="kv-ground kv-fwd" aria-label="Move forward">
        <svg viewBox="0 0 64 44" aria-hidden="true"><path d="M8 34 L32 11 L56 34"/></svg></button>
      <button class="kv-ground kv-back" aria-label="Move back">
        <svg viewBox="0 0 64 44" aria-hidden="true"><path d="M8 12 L32 34 L56 12"/></svg></button>
      <div class="kv-mini" aria-label="Street View minimap"></div>`
    document.body.appendChild(o)
    this._overlay = o
    this._mini = o.querySelector(".kv-mini")
    this._stage = o.querySelector(".kv-stage")
    this._date = o.querySelector(".kv-date")
    this._fwd = o.querySelector(".kv-fwd")
    this._back = o.querySelector(".kv-back")
    this._pan = 50
    o.querySelector(".kv-close").addEventListener("click", () => this.close())
    // Hold a chevron to keep driving; a quick tap = one frame.
    const hold = (btn, dir) => {
      btn.addEventListener("pointerdown", (e) => { e.preventDefault(); this._startDrive(dir) })
      const stop = () => this._stopDrive()
      btn.addEventListener("pointerup", stop)
      btn.addEventListener("pointerleave", stop)
      btn.addEventListener("pointercancel", stop)
    }
    hold(this._fwd, 1)
    hold(this._back, -1)
    // drag-to-look (pan the cover-filled frame horizontally). Window-level move/up
    // listeners are more robust than setPointerCapture across touch devices.
    this._stage.addEventListener("pointerdown", (e) => {
      if (e.button === 2) return
      this._drag = { x: e.clientX, y: e.clientY, px: this._panX ?? 50, py: this._panY ?? 50 }
      this._stage.style.cursor = "grabbing"
    })
    this._onDragMove = (e) => {
      if (!this._drag) return
      const dx = e.clientX - this._drag.x, dy = e.clientY - this._drag.y
      this._panX = Math.max(0, Math.min(100, this._drag.px - (dx / (this._ovX || 1)) * 100))
      this._panY = Math.max(0, Math.min(100, this._drag.py - (dy / (this._ovY || 1)) * 100))
      this._applyPan()
    }
    this._onDragEnd = () => { this._drag = null; if (this._stage) this._stage.style.cursor = "grab" }
    window.addEventListener("pointermove", this._onDragMove, { passive: true })
    window.addEventListener("pointerup", this._onDragEnd)
    window.addEventListener("pointercancel", this._onDragEnd)
    document.addEventListener("keydown", (e) => {
      if (this._overlay?.style.display !== "block") return
      if (e.key === "Escape") this.close()
      else if (e.key === "ArrowUp" || e.key === "ArrowRight") this._nav(1)
      else if (e.key === "ArrowDown" || e.key === "ArrowLeft") this._nav(-1)
    })
  }

  _applyPan() { if (this._stage) this._stage.style.backgroundPosition = `${this._panX ?? 50}% ${this._panY ?? 50}%` }

  // Scale the frame ~1.18× past cover so BOTH axes overflow → drag pans in any
  // direction regardless of whether the photo is landscape or portrait.
  _fit(url) {
    const img = this._imgCache.get(url)
    if (!this._stage || !img || !img.naturalWidth) { if (this._stage) this._stage.style.backgroundSize = "cover"; this._ovX = this._ovY = 1; return }
    const cw = this._stage.clientWidth || 1, ch = this._stage.clientHeight || 1
    const scale = Math.max(cw / img.naturalWidth, ch / img.naturalHeight) * 1.18
    const w = img.naturalWidth * scale, h = img.naturalHeight * scale
    this._stage.style.backgroundSize = `${Math.round(w)}px ${Math.round(h)}px`
    this._ovX = Math.max(1, w - cw)
    this._ovY = Math.max(1, h - ch)
  }

  // --- minimap (Google-style) ---
  _buildMini() {
    if (this._miniMap || !this._mini) return
    let style
    try {
      style = JSON.parse(JSON.stringify(window.dawarichMap?.getStyle()))
      // keep only the basemap — drop our overlays so the minimap stays clean
      const drop = /^(kv-|pnx-|directions|route|places|place-|search-results|pois|poi_|traffic|napspan|highlight)/i
      style.layers = (style.layers || []).filter((l) => !drop.test(l.id))
    } catch (_) { /* noop */ }
    if (!style) return
    this._miniMap = new maplibregl.Map({
      container: this._mini, style, interactive: true, attributionControl: false,
      center: this._nbCenter ? [this._nbCenter.lng, this._nbCenter.lat] : [0, 0], zoom: 16,
    })
    this._miniMap.on("load", () => {
      this._miniMap.addSource("mini-cov", { type: "geojson", data: this._empty() })
      this._miniMap.addLayer({ id: "mini-seq", type: "line", source: "mini-cov", paint: { "line-color": BLUE, "line-width": 3, "line-opacity": 0.9 } })
      this._miniMap.addSource("mini-here", { type: "geojson", data: this._empty() })
      this._miniMap.addLayer({ id: "mini-here", type: "circle", source: "mini-here", paint: { "circle-radius": 6, "circle-color": "#fff", "circle-stroke-color": BLUE, "circle-stroke-width": 3 } })
      this._miniReady = true
      this._updateMiniCoverage(); this._updateMini()
    })
    this._miniMap.on("click", (e) => this.openAt(e.lngLat.lng, e.lngLat.lat))
  }

  _updateMini() {
    if (!this._miniMap) { this._buildMini(); return }
    if (!this._miniReady) return
    const p = this._seq?.[this._idx]; if (!p) return
    const here = [+p.lng, +p.lat]
    this._miniMap.easeTo({ center: here, bearing: +p.heading || 0, duration: 250 })
    this._miniMap.getSource("mini-here")?.setData({ type: "Feature", geometry: { type: "Point", coordinates: here }, properties: {} })
  }

  _updateMiniCoverage() {
    if (!this._miniReady) return
    const bySeq = {}
    for (const q of this._photos || []) (bySeq[q.seq] ||= []).push(q)
    const feats = Object.values(bySeq).filter((s) => s.length >= 2)
      .map((s) => { s.sort((a, b) => a.idx - b.idx); return { type: "Feature", geometry: { type: "LineString", coordinates: s.map((q) => [q.lng, q.lat]) }, properties: {} } })
    this._miniMap.getSource("mini-cov")?.setData({ type: "FeatureCollection", features: feats })
  }

  _injectStyle() {
    if (document.getElementById("kv-style")) return
    const s = document.createElement("style")
    s.id = "kv-style"
    s.textContent = `
      .kv-overlay{position:fixed;inset:0;z-index:2000;background:#0b0b0d;display:none;opacity:0;transition:opacity .22s ease}
      .kv-overlay.kv--in{opacity:1}
      .kv-stage{position:absolute;inset:0;background:#0b0b0d center/cover no-repeat;
        transition:opacity .14s ease;cursor:grab;touch-action:none}
      .kv-stage:active{cursor:grabbing}
      .kv-top{position:absolute;top:0;left:0;right:0;display:flex;align-items:center;gap:12px;
        padding:calc(env(safe-area-inset-top) + 12px) 16px 28px;background:linear-gradient(to bottom,rgba(0,0,0,.55),transparent);z-index:4;pointer-events:none}
      .kv-top>*{pointer-events:auto}
      .kv-btn{border:0;cursor:pointer;color:#fff;background:rgba(20,20,22,.55);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)}
      .kv-close{width:40px;height:40px;border-radius:50%;font-size:1rem;line-height:1;flex:0 0 auto}
      .kv-close:hover{background:rgba(40,40,44,.7)}
      .kv-meta{display:flex;align-items:center;gap:8px;color:#fff;font-size:.82rem;background:rgba(20,20,22,.5);
        backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);padding:7px 12px;border-radius:999px}
      .kv-dot{width:7px;height:7px;border-radius:50%;background:${BLUE};flex:0 0 auto}
      .kv-date{font-weight:600;font-variant-numeric:tabular-nums}
      .kv-credit{color:rgba(255,255,255,.6);text-decoration:none;font-size:.72rem;margin-left:2px}
      .kv-credit:hover{color:#fff}
      /* Google-style movement chevrons painted on the road */
      .kv-ground{position:absolute;left:50%;transform:translateX(-50%);border:0;background:none;padding:6px 10px;
        cursor:pointer;z-index:3;perspective:340px;-webkit-tap-highlight-color:transparent}
      .kv-ground svg{width:70px;height:48px;display:block;filter:drop-shadow(0 4px 7px rgba(0,0,0,.55));
        transition:transform .12s ease}
      .kv-ground path{stroke:rgba(255,255,255,.94);stroke-width:9;fill:none;stroke-linecap:round;stroke-linejoin:round}
      .kv-fwd{bottom:19%}
      .kv-fwd svg{transform:rotateX(50deg)}
      .kv-fwd:hover svg{transform:rotateX(50deg) translateY(-3px) scale(1.06)}
      .kv-fwd:active svg{transform:rotateX(50deg) scale(.93)}
      .kv-back{bottom:5%}
      .kv-back svg{width:52px;height:36px;transform:rotateX(-46deg);opacity:.85}
      .kv-back:hover svg{transform:rotateX(-46deg) scale(1.06);opacity:1}
      .kv-back:active svg{transform:rotateX(-46deg) scale(.93)}
      /* turn chevrons at junctions reuse .kv-ground; positioned inline */
      .kv-turn svg{width:60px;height:42px}
      /* minimap */
      .kv-mini{position:absolute;left:14px;bottom:calc(env(safe-area-inset-bottom) + 16px);
        width:132px;height:132px;border-radius:14px;overflow:hidden;z-index:3;background:#0b0b0d;
        box-shadow:0 4px 18px rgba(0,0,0,.55);border:2px solid rgba(255,255,255,.85)}
      .kv-mini .maplibregl-ctrl,.kv-mini .maplibregl-ctrl-attrib{display:none!important}
      .kv-mini .maplibregl-canvas{cursor:pointer}`
    document.head.appendChild(s)
  }

  _haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000, rad = Math.PI / 180
    const dlat = (lat2 - lat1) * rad, dlon = (lon2 - lon1) * rad
    const a = Math.sin(dlat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dlon / 2) ** 2
    return 2 * R * Math.asin(Math.sqrt(a))
  }

  _toast(msg, ms = 2200) {
    let t = document.getElementById("kv-toast")
    if (!t) {
      t = document.createElement("div"); t.id = "kv-toast"
      t.style.cssText = "position:fixed;left:50%;bottom:calc(env(safe-area-inset-bottom) + 92px);transform:translateX(-50%);z-index:1600;background:rgba(20,20,22,.9);color:#fff;padding:9px 15px;border-radius:999px;font-size:.85rem;font-weight:500;box-shadow:0 3px 14px rgba(0,0,0,.4);opacity:0;transition:opacity .18s ease;pointer-events:none;max-width:90vw;text-align:center"
      document.body.appendChild(t)
    }
    t.textContent = msg; t.style.opacity = "1"
    clearTimeout(this._toastT); this._toastT = setTimeout(() => { t.style.opacity = "0" }, ms)
  }
}
