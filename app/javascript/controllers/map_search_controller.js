import { Controller } from "@hotwired/stimulus"

// Floating Google-Maps-style search (vicquick fork). Owns the top of the map.
// Empty focus → Home/Work shortcuts + recent searches + category chips. Typing
// queries your saved places and the self-hosted Photon geocoder; results drop
// dots on the map (tap between them like Google) and open the place sheet.
const RECENTS_KEY = "mapSearchRecents"
const RESULT_SRC = "search-results"

// Client-side keyword dictionary so typing "pizza" / "gym" / "hospital" fires a
// nearby POI search (like Google) instead of only a geocoder lookup. Mirrors the
// server's DiscoveryController resolver; kept compact — the server is the
// source of truth and handles anything this misses.
const CAT_KEYS = new Set([
  "restaurant", "cafe", "bar", "fast_food", "fuel", "charging", "atm", "bank",
  "pharmacy", "hospital", "supermarket", "shopping", "bakery", "hotel", "parking",
  "park", "playground", "gym", "cinema", "attraction", "museum", "hairdresser",
  "toilets", "library", "school", "station",
])
const ALIASES = {
  coffee: "cafe", cafes: "cafe", cafés: "cafe", food: "restaurant", eat: "restaurant",
  restaurants: "restaurant", gas: "fuel", petrol: "fuel", tankstelle: "fuel",
  ev: "charging", charger: "charging", cash: "atm", atms: "atm", cashpoint: "atm",
  chemist: "pharmacy", drugstore: "pharmacy", apotheke: "pharmacy", groceries: "supermarket",
  grocery: "supermarket", supermarkt: "supermarket", shop: "shopping", shops: "shopping",
  store: "shopping", mall: "shopping", hotels: "hotel", hostel: "hotel", parks: "park",
  garden: "park", gyms: "gym", fitness: "gym", pub: "bar", pubs: "bar", beer: "bar",
  bars: "bar", drinks: "bar", bakeries: "bakery", bread: "bakery", er: "hospital",
  emergency: "hospital", krankenhaus: "hospital", parking: "parking", parkplatz: "parking",
  toilet: "toilets", wc: "toilets", restroom: "toilets", barber: "hairdresser",
  salon: "hairdresser", friseur: "hairdresser", movie: "cinema", movies: "cinema",
  kino: "cinema", cinemas: "cinema", museums: "museum", sights: "attraction",
  hospitals: "hospital", takeaway: "fast_food", imbiss: "fast_food", hotels_de: "hotel",
}
const CUISINES = new Set([
  "pizza", "sushi", "burger", "burgers", "kebab", "indian", "italian", "chinese",
  "thai", "japanese", "mexican", "greek", "turkish", "korean", "vietnamese", "ramen",
  "steak", "seafood", "tapas", "vegan", "vegetarian", "falafel", "doner", "döner", "asian",
])

export default class extends Controller {
  static targets = ["input", "results", "clear", "panel", "chips", "quick", "searchArea"]
  static values = { apiKey: String }

  connect() {
    this._debounce = null
    this._items = []
    this._active = -1
    this._shortcuts = []
    this._lastPoi = null // {mode:'category'|'keyword', value, lat, lon} for "search this area"
    this._onDocClick = (e) => { if (!this.element.contains(e.target)) this.close() }
    this._onMove = () => this.maybeShowArea()
    document.addEventListener("click", this._onDocClick)
    this.loadShortcuts()
    requestAnimationFrame(() => this.bindMap())
  }

  disconnect() {
    document.removeEventListener("click", this._onDocClick)
    try { this.map?.off("moveend", this._onMove) } catch (e) { /* noop */ }
    clearTimeout(this._debounce)
    this.clearPins()
  }

  // Attach the map's moveend once it exists (map may init after this controller).
  bindMap() {
    if (this._bound) return
    const m = this.map
    if (!m) { setTimeout(() => this.bindMap(), 300); return }
    m.on("moveend", this._onMove)
    this._bound = true
  }

  get map() { return window.dawarichMap }

  // --- open / close ---
  onFocus() {
    this.panelTarget.hidden = false
    this.dateFloat()?.style.setProperty("display", "none")
    if (this.inputTarget.value.trim().length < 2) this.showDiscovery()
  }

  // Hide the dropdown but KEEP the result dots on the map (Google keeps them so
  // you can pan and tap between hits). The ✕ clears everything.
  close() {
    this.panelTarget.hidden = true
    this.dateFloat()?.style.removeProperty("display")
    this.clearChipState()
  }

  dateFloat() { return document.querySelector(".map-date-float") }

  // Empty-state: quick shortcuts + recents, then chips, no result list.
  showDiscovery() {
    this.renderQuick()
    this.chipsTarget.hidden = false
    this.resultsTarget.hidden = true
    this.resultsTarget.innerHTML = ""
  }

  hideQuick() { if (this.hasQuickTarget) this.quickTarget.hidden = true }

  // --- text search ---
  onInput() {
    const q = this.inputTarget.value.trim()
    this.clearTarget.hidden = q.length === 0
    this.clearChipState()
    clearTimeout(this._debounce)
    if (q.length < 2) { this.panelTarget.hidden = false; this.showDiscovery(); return }
    this.hideQuick()
    this.chipsTarget.hidden = true
    this.renderLoading()
    this._debounce = setTimeout(() => this.search(q), 220)
  }

  async search(q) {
    if (this.inputTarget.value.trim() !== q) return // stale
    // If the query reads like a category/keyword ("pizza", "gym", "hospital"),
    // also fetch nearby POIs and show them first — Google-style keyword search.
    const cat = this.looksCategorical(q)
    if (!cat) { this._lastPoi = null; this.hideArea() }
    const tasks = [this.searchSaved(q), this.searchGeocoder(q)]
    if (cat) tasks.push(this.fetchKeyword(cat, q))
    const [saved, geo, poi = []] = await Promise.all(tasks)
    if (this.inputTarget.value.trim() !== q) return // raced a newer query
    const list = [...saved, ...poi, ...geo]
    if (!list.length) { this.clearPins(); return this.renderEmpty("No matches") }
    this.renderList(list, q)
  }

  // Does this free text map to a POI category/cuisine? Returns {category} or
  // {q:true} (use free-text) or null (treat as a place-name geocode only).
  looksCategorical(q) {
    const t = q.toLowerCase().trim()
    const sing = t.replace(/s$/, "")
    if (CAT_KEYS.has(t)) return { category: t }
    if (CAT_KEYS.has(sing)) return { category: sing }
    if (ALIASES[t]) return { category: ALIASES[t] }
    if (ALIASES[sing]) return { category: ALIASES[sing] }
    if (t.split(/\s+/).some((w) => CUISINES.has(w)) || CUISINES.has(t)) return { q: true }
    return null
  }

  // Fetch nearby POIs for a keyword/category (no rendering — returns rows).
  async fetchKeyword(cat, q) {
    if (!this.map) return []
    const c = this.map.getCenter()
    this._lastPoi = { mode: cat.category ? "category" : "keyword", value: cat.category || q, lat: c.lat, lon: c.lng }
    this.hideArea()
    try {
      const openParam = this._openNow ? "&open_now=true" : ""
      const p = cat.category ? `category=${encodeURIComponent(cat.category)}` : `q=${encodeURIComponent(q)}`
      const res = await fetch(`/api/v1/nearby?api_key=${encodeURIComponent(this.apiKeyValue)}&lat=${c.lat}&lon=${c.lng}&${p}&limit=12${openParam}`)
      if (!res.ok) return []
      const data = await res.json()
      return (data.results || []).map((r) => ({
        name: r.name, address: r.address || "", type: r.category || cat.category || "",
        lat: r.lat, lon: r.lon, osm_type: r.osm_type, osm_id: r.osm_id,
        distance_m: r.distance_m, open_now: r.open_now,
      })).filter((r) => r.lat != null && r.lon != null)
    } catch (e) { return [] }
  }

  async searchSaved(q) {
    try {
      const res = await fetch(`/api/v1/places?q=${encodeURIComponent(q)}&api_key=${encodeURIComponent(this.apiKeyValue)}`)
      if (!res.ok) return []
      const data = await res.json()
      return (Array.isArray(data) ? data : [])
        .filter((p) => p.latitude != null && p.longitude != null)
        .map((p) => this.fromSaved(p))
    } catch (e) { return [] }
  }

  fromSaved(p) {
    return {
      name: p.name,
      address: p.tags?.[0]?.name || p.note || "Saved place",
      type: p.tags?.[0]?.name || "saved",
      lat: p.latitude, lon: p.longitude,
      savedPlaceId: p.id, tags: p.tags || [], color: p.color,
      icon: p.icon || p.tags?.[0]?.icon, saved: true,
    }
  }

  async searchGeocoder(q) {
    try {
      const res = await fetch(`/api/v1/locations/suggestions?q=${encodeURIComponent(q)}&api_key=${encodeURIComponent(this.apiKeyValue)}`)
      if (!res.ok) return []
      const data = await res.json()
      return (data.suggestions || []).map((s) => ({
        name: s.name,
        address: s.address || s.display_name || "",
        type: s.type || "",
        lat: s.coordinates?.[0],
        lon: s.coordinates?.[1],
        osm_type: s.osm_type,
        osm_id: s.osm_id,
      })).filter((s) => s.lat != null && s.lon != null)
    } catch (e) { return [] }
  }

  // --- category (nearby) search ---
  category(e) {
    const btn = e.currentTarget
    const cat = btn?.dataset?.category
    if (!cat) return
    if (this._lastCategory === cat && btn.getAttribute("aria-pressed") === "true") {
      btn.setAttribute("aria-pressed", "false")
      this._lastCategory = null
      this._lastPoi = null
      this.hideArea()
      this.clearPins()
      this.showDiscovery()
      return
    }
    this.chipsTarget.querySelectorAll("[data-category]").forEach((c) => c.setAttribute("aria-pressed", c === btn ? "true" : "false"))
    this.hideQuick()
    this.runCategory(cat)
  }

  async runCategory(cat) {
    this._lastCategory = cat
    if (!this.map) return
    const c = this.map.getCenter()
    this._lastPoi = { mode: "category", value: cat, lat: c.lat, lon: c.lng }
    this.hideArea()
    this.renderLoading()
    try {
      const openParam = this._openNow ? "&open_now=true" : ""
      const res = await fetch(`/api/v1/nearby?api_key=${encodeURIComponent(this.apiKeyValue)}&lat=${c.lat}&lon=${c.lng}&category=${encodeURIComponent(cat)}&limit=20${openParam}`)
      if (!res.ok) return this.renderEmpty("Nearby unavailable")
      const data = await res.json()
      const list = (data.results || []).map((r) => ({
        name: r.name,
        address: r.address || "",
        type: r.category || cat,
        lat: r.lat,
        lon: r.lon,
        osm_type: r.osm_type,
        osm_id: r.osm_id,
        distance_m: r.distance_m,
        open_now: r.open_now,
      })).filter((r) => r.lat != null && r.lon != null)
      if (!list.length) { this.clearPins(); return this.renderEmpty("Nothing found nearby") }
      this.renderList(list)
    } catch (err) {
      this.renderEmpty("Nearby search failed")
    }
  }

  // --- "Search this area" (re-run last POI search at the new map center) ---
  searchThisArea() {
    if (!this._lastPoi) return
    this.hideArea()
    this.panelTarget.hidden = false
    if (this._lastPoi.mode === "category") {
      this.runCategory(this._lastPoi.value)
    } else {
      this.inputTarget.value = this._lastPoi.value
      this.search(this._lastPoi.value)
    }
  }

  maybeShowArea() {
    if (!this._lastPoi || !this.map) { this.hideArea(); return }
    const c = this.map.getCenter()
    const moved = this.haversine(c.lat, c.lng, this._lastPoi.lat, this._lastPoi.lon)
    const b = this.map.getBounds()
    const half = this.haversine(b.getNorth(), b.getWest(), b.getSouth(), b.getEast()) / 2
    if (moved > half * 0.45) this.showArea(); else this.hideArea()
  }

  showArea() { if (this.hasSearchAreaTarget) this.searchAreaTarget.hidden = false }
  hideArea() { if (this.hasSearchAreaTarget) this.searchAreaTarget.hidden = true }

  haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000, rad = Math.PI / 180
    const dlat = (lat2 - lat1) * rad, dlon = (lon2 - lon1) * rad
    const a = Math.sin(dlat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dlon / 2) ** 2
    return 2 * R * Math.asin(Math.sqrt(a))
  }

  // --- rendering ---
  renderList(list, q, header = null) {
    this._items = list
    this._active = -1
    const rows = list.map((s, i) => this.rowHTML(s, i, q)).join("")
    let top = ""
    if (header) {
      top = `<li class="map-search__head">${this.esc(header)}</li>`
    } else if (q && q.trim().length >= 2) {
      // Google-style affordance: turn any free text into a content search.
      top = `
        <li>
          <button type="button" class="map-search__row map-search__row--action" data-content-action>
            <span class="map-search__row-dot">🔎</span>
            <span class="map-search__row-text">
              <span class="map-search__row-name">Search nearby for “${this.esc(q)}”</span>
              <span class="map-search__row-sub">Shops &amp; places matching this</span>
            </span>
            <span class="map-search__row-go">↵</span>
          </button>
        </li>`
    }
    this.resultsTarget.innerHTML = top + rows
    this.resultsTarget.querySelectorAll(".map-search__row").forEach((el) => {
      if (el.hasAttribute("data-content-action")) {
        el.addEventListener("click", () => this.contentSearch(this.inputTarget.value.trim()))
      } else {
        el.addEventListener("click", () => this.choose(Number(el.dataset.idx)))
      }
    })
    this.resultsTarget.hidden = false
    this.panelTarget.hidden = false
    this.drawPins(list)
  }

  // Content/intent search: resolve free text ("bed linen", "birthday gift") to
  // real places via the backend (product dict + local LLM → OSM tags).
  async contentSearch(q) {
    q = (q || "").trim()
    if (!q || !this.map) return
    this.hideQuick()
    this.chipsTarget.hidden = true
    this.renderLoading()
    const c = this.map.getCenter()
    this._lastPoi = { mode: "keyword", value: q, lat: c.lat, lon: c.lng }
    this.hideArea()
    try {
      const openParam = this._openNow ? "&open_now=true" : ""
      const res = await fetch(`/api/v1/nearby?api_key=${encodeURIComponent(this.apiKeyValue)}&lat=${c.lat}&lon=${c.lng}&q=${encodeURIComponent(q)}&limit=24${openParam}`)
      if (!res.ok) return this.renderEmpty("Nothing found nearby")
      const data = await res.json()
      const list = (data.results || []).map((r) => ({
        name: r.name, address: r.address || "", type: r.category || "",
        lat: r.lat, lon: r.lon, osm_type: r.osm_type, osm_id: r.osm_id,
        distance_m: r.distance_m, open_now: r.open_now,
      })).filter((r) => r.lat != null && r.lon != null)
      if (!list.length) { this.clearPins(); return this.renderEmpty(`No places matching “${q}” nearby`) }
      const smart = String(data.category || "").startsWith("ai:")
      this.renderList(list, null, `${smart ? "✨ " : ""}Nearby · ${q}`)
    } catch (e) { this.renderEmpty("Search failed") }
  }

  rowHTML(s, i, q) {
    return `
      <li>
        <button type="button" class="map-search__row" data-idx="${i}">
          ${this.rowDot(s)}
          <span class="map-search__row-text">
            <span class="map-search__row-name">${this.mark(s.name, q)}</span>
            <span class="map-search__row-sub">${this.openBadge(s.open_now)}${s.address ? this.esc(s.address) : ""}</span>
          </span>
          ${s.distance_m != null ? `<span class="map-search__row-dist">${this.fmtDist(s.distance_m)}</span>` : ""}
        </button>
      </li>`
  }

  renderLoading() {
    this.resultsTarget.innerHTML = `
      <li class="map-search__loading">
        <span class="map-search__spinner" aria-hidden="true"></span>
        <span>Searching…</span>
      </li>`
    this.resultsTarget.hidden = false
    this.panelTarget.hidden = false
  }

  renderEmpty(msg) {
    this._items = []
    this._active = -1
    this.resultsTarget.innerHTML = `<li class="map-search__empty">${this.esc(msg)}</li>`
    this.resultsTarget.hidden = false
    this.panelTarget.hidden = false
  }

  // Empty-state discovery rows: Home/Work shortcuts + recent searches.
  renderQuick() {
    if (!this.hasQuickTarget) return
    const recents = this.recents()
    if (!this._shortcuts.length && !recents.length) { this.quickTarget.hidden = true; return }
    const sc = this._shortcuts.map((s) => `
      <button type="button" class="map-search__quick-row" data-kind="shortcut" data-id="${s.savedPlaceId}">
        ${this.rowDot(s)}
        <span class="map-search__row-text">
          <span class="map-search__row-name">${this.esc(s.name)}</span>
          <span class="map-search__row-sub">${this.esc(s.address || "")}</span>
        </span>
      </button>`).join("")
    const rc = recents.map((s, i) => `
      <button type="button" class="map-search__quick-row" data-kind="recent" data-ridx="${i}">
        <span class="map-search__row-dot map-search__row-dot--ghost">🕘</span>
        <span class="map-search__row-text">
          <span class="map-search__row-name">${this.esc(s.name)}</span>
          <span class="map-search__row-sub">${this.esc(s.address || "")}</span>
        </span>
        <span class="map-search__recent-del" data-ridx="${i}" aria-label="Remove">✕</span>
      </button>`).join("")
    this.quickTarget.innerHTML = sc + rc
    this.quickTarget.hidden = false
    this.quickTarget.querySelectorAll(".map-search__quick-row").forEach((el) => {
      el.addEventListener("click", (e) => {
        if (e.target.classList.contains("map-search__recent-del")) {
          e.stopPropagation()
          this.removeRecent(Number(e.target.dataset.ridx)); this.renderQuick(); return
        }
        if (el.dataset.kind === "recent") this.chooseItem(this.recents()[Number(el.dataset.ridx)])
        else this.chooseItem(this._shortcuts.find((s) => String(s.savedPlaceId) === el.dataset.id))
      })
    })
  }

  choose(idx) { this.chooseItem(this._items[idx]) }

  chooseItem(s) {
    if (!s) return
    this.inputTarget.value = s.name
    this.pushRecent(s)
    this.close()
    document.dispatchEvent(new CustomEvent("place-sheet:open", {
      detail: {
        name: s.name, address: s.address, lat: s.lat, lon: s.lon,
        type: s.type, osm_type: s.osm_type, osm_id: s.osm_id,
        savedPlaceId: s.savedPlaceId || null, tags: s.tags || [],
      },
    }))
    this.highlightPin(s)
    // Camera move is owned by the place sheet's open() (sheet-aware padding).
  }

  clear() {
    this.inputTarget.value = ""
    this.clearTarget.hidden = true
    this._lastPoi = null
    this.hideArea()
    this.clearPins()
    this.showDiscovery()
    this.inputTarget.focus()
  }

  clearChipState() {
    this.chipsTarget?.querySelectorAll('[data-category][aria-pressed="true"]').forEach((c) => c.setAttribute("aria-pressed", "false"))
  }

  onKeydown(e) {
    if (e.key === "Escape") return this.close()
    if (e.key === "Enter") {
      e.preventDefault()
      // Highlighted a result → open it. Otherwise treat the text as a content
      // search ("bed linen" → nearby shops), like Google's Enter behaviour.
      if (this._active >= 0 && this._items[this._active]) return this.choose(this._active)
      const q = this.inputTarget.value.trim()
      if (q.length >= 2) return this.contentSearch(q)
      return
    }
    if (!this._items.length || this.resultsTarget.hidden) return
    if (e.key === "ArrowDown") { e.preventDefault(); this._active = (this._active + 1) % this._items.length; this.highlight() }
    else if (e.key === "ArrowUp") { e.preventDefault(); this._active = (this._active - 1 + this._items.length) % this._items.length; this.highlight() }
  }

  highlight() {
    const rows = this.resultsTarget.querySelectorAll(".map-search__row")
    rows.forEach((el, i) => el.setAttribute("aria-selected", i === this._active ? "true" : "false"))
    rows[this._active]?.scrollIntoView({ block: "nearest" })
  }

  // --- result pins on the map (Google-style dots that persist) ---
  drawPins(list) {
    if (!this.map) return
    const fc = {
      type: "FeatureCollection",
      features: list.filter((s) => s.lat != null && s.lon != null).map((s, i) => ({
        type: "Feature", geometry: { type: "Point", coordinates: [s.lon, s.lat] },
        properties: { idx: i, sel: 0 },
      })),
    }
    this._pinData = fc
    const src = this.map.getSource(RESULT_SRC)
    if (src) { src.setData(fc); return }
    this.map.addSource(RESULT_SRC, { type: "geojson", data: fc })
    this.map.addLayer({
      id: `${RESULT_SRC}-halo`, type: "circle", source: RESULT_SRC,
      paint: {
        "circle-radius": ["case", ["==", ["get", "sel"], 1], 10, 7],
        "circle-color": "#ea4335", "circle-opacity": 0.18,
      },
    })
    this.map.addLayer({
      id: `${RESULT_SRC}-dot`, type: "circle", source: RESULT_SRC,
      paint: {
        "circle-radius": ["case", ["==", ["get", "sel"], 1], 6.5, 5],
        "circle-color": "#ea4335",
        "circle-stroke-color": "#ffffff", "circle-stroke-width": 2,
      },
    })
    this.map.on("click", `${RESULT_SRC}-dot`, (e) => {
      const idx = e.features?.[0]?.properties?.idx
      if (idx != null) this.choose(Number(idx))
    })
    this.map.on("mouseenter", `${RESULT_SRC}-dot`, () => { this.map.getCanvas().style.cursor = "pointer" })
    this.map.on("mouseleave", `${RESULT_SRC}-dot`, () => { this.map.getCanvas().style.cursor = "" })
  }

  highlightPin(s) {
    const src = this.map?.getSource(RESULT_SRC)
    const data = this._pinData
    if (!src || !s || !data?.features) return
    data.features.forEach((f) => {
      f.properties.sel = (Math.abs(f.geometry.coordinates[0] - s.lon) < 1e-7 &&
        Math.abs(f.geometry.coordinates[1] - s.lat) < 1e-7) ? 1 : 0
    })
    src.setData(data)
  }

  clearPins() {
    if (!this.map) return
    try {
      for (const id of [`${RESULT_SRC}-dot`, `${RESULT_SRC}-halo`]) {
        if (this.map.getLayer(id)) this.map.removeLayer(id)
      }
      if (this.map.getSource(RESULT_SRC)) this.map.removeSource(RESULT_SRC)
    } catch (e) { /* noop */ }
    this._pinData = null
  }

  // --- recents (localStorage) ---
  recents() {
    try { return JSON.parse(localStorage.getItem(RECENTS_KEY) || "[]") } catch (e) { return [] }
  }

  pushRecent(s) {
    if (!s?.name) return
    const slim = { name: s.name, address: s.address, lat: s.lat, lon: s.lon, type: s.type, osm_type: s.osm_type, osm_id: s.osm_id }
    const key = (x) => `${x.name}|${(x.lat || 0).toFixed(4)},${(x.lon || 0).toFixed(4)}`
    const next = [slim, ...this.recents().filter((r) => key(r) !== key(slim))].slice(0, 6)
    try { localStorage.setItem(RECENTS_KEY, JSON.stringify(next)) } catch (e) { /* noop */ }
  }

  removeRecent(i) {
    const r = this.recents(); r.splice(i, 1)
    try { localStorage.setItem(RECENTS_KEY, JSON.stringify(r)) } catch (e) { /* noop */ }
  }

  // Home/Work/Favourite saved places → empty-state shortcuts.
  async loadShortcuts() {
    try {
      const res = await fetch(`/api/v1/places?filter=tagged&api_key=${encodeURIComponent(this.apiKeyValue)}`)
      if (!res.ok) return
      const data = await res.json()
      const want = ["Home", "Work", "Favourite"]
      this._shortcuts = (Array.isArray(data) ? data : [])
        .filter((p) => p.latitude != null && p.tags?.some((t) => want.includes(t.name)))
        .sort((a, b) => want.indexOf(a.tags[0]?.name) - want.indexOf(b.tags[0]?.name))
        .slice(0, 3)
        .map((p) => this.fromSaved(p))
    } catch (e) { /* noop */ }
  }

  // --- bits ---
  rowDot(s) {
    if (s.saved) {
      return `<span class="map-search__row-dot" style="background:${this.esc(s.color || "#6366f1")};color:#fff">${this.esc(s.icon || "⭐")}</span>`
    }
    return `<span class="map-search__row-dot">${this.glyph(s.type)}</span>`
  }

  fmtDist(m) { return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km` }

  openBadge(open) {
    if (open === true) return `<span style="color:#16a34a;font-weight:600">Open</span> · `
    if (open === false) return `<span style="color:#dc2626;font-weight:600">Closed</span> · `
    return ""
  }

  toggleOpenNow(e) {
    const btn = e.currentTarget
    this._openNow = !this._openNow
    btn.setAttribute("aria-pressed", this._openNow ? "true" : "false")
    if (this._lastCategory) this.runCategory(this._lastCategory)
    else if (this._lastPoi?.mode === "keyword") this.search(this._lastPoi.value)
  }

  glyph(type) {
    const t = String(type || "").toLowerCase()
    if (/(restaurant|cafe|bar|food|pub|fast_food)/.test(t)) return "🍴"
    if (/(hotel|hostel|guest)/.test(t)) return "🛏️"
    if (/(shop|store|supermarket|mall|convenience|pharmacy)/.test(t)) return "🛒"
    if (/(fuel|gas)/.test(t)) return "⛽"
    if (/(atm|bank)/.test(t)) return "🏧"
    if (/(park|forest|garden|wood)/.test(t)) return "🌳"
    if (/(station|bus|train|airport|aerodrome)/.test(t)) return "🚉"
    if (/(city|town|village|suburb|hamlet)/.test(t)) return "🏙️"
    if (/(street|road|way|avenue)/.test(t)) return "🛣️"
    return "📍"
  }

  // Bold the matched substring in a result name (Google-style).
  mark(name, q) {
    const safe = this.esc(name)
    if (!q) return safe
    const i = name.toLowerCase().indexOf(q.toLowerCase())
    if (i < 0) return safe
    return `${this.esc(name.slice(0, i))}<b>${this.esc(name.slice(i, i + q.length))}</b>${this.esc(name.slice(i + q.length))}`
  }

  esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))
  }
}
