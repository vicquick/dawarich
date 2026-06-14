import { Controller } from "@hotwired/stimulus"

// Floating Google-Maps-style search (vicquick fork). Owns the top of the map.
// Focus reveals category chips beneath the bar; typing queries self-hosted
// Photon suggestions; a chip queries nearby POIs around the map centre. A
// result opens the place detail sheet and flies there. Self-contained.
export default class extends Controller {
  static targets = ["input", "results", "clear", "panel", "chips"]
  static values = { apiKey: String }

  connect() {
    this._debounce = null
    this._items = []
    this._active = -1
    this._onDocClick = (e) => { if (!this.element.contains(e.target)) this.close() }
    document.addEventListener("click", this._onDocClick)
  }

  disconnect() {
    document.removeEventListener("click", this._onDocClick)
    clearTimeout(this._debounce)
  }

  // --- open / close ---
  onFocus() {
    this.panelTarget.hidden = false
    this.dateFloat()?.style.setProperty("display", "none")
    if (this.inputTarget.value.trim().length < 2) this.showChips()
  }

  close() {
    this.panelTarget.hidden = true
    this.dateFloat()?.style.removeProperty("display")
    this.clearChipState()
  }

  dateFloat() {
    return document.querySelector(".map-date-float")
  }

  showChips() {
    this.chipsTarget.hidden = false
    this.resultsTarget.hidden = true
    this.resultsTarget.innerHTML = ""
  }

  hideChips() { this.chipsTarget.hidden = true }

  // --- text search ---
  onInput() {
    const q = this.inputTarget.value.trim()
    this.clearTarget.hidden = q.length === 0
    this.clearChipState()
    clearTimeout(this._debounce)
    if (q.length < 2) { this.panelTarget.hidden = false; this.showChips(); return }
    this.hideChips()
    this._debounce = setTimeout(() => this.search(q), 220)
  }

  async search(q) {
    try {
      const res = await fetch(`/api/v1/locations/suggestions?q=${encodeURIComponent(q)}`)
      if (!res.ok) return this.renderEmpty("Search unavailable")
      const data = await res.json()
      const list = (data.suggestions || []).map((s) => ({
        name: s.name,
        address: s.address || s.display_name || "",
        type: s.type || "",
        lat: s.coordinates?.[0],
        lon: s.coordinates?.[1],
        osm_type: s.osm_type,
        osm_id: s.osm_id,
      })).filter((s) => s.lat != null && s.lon != null)
      if (!list.length) return this.renderEmpty("No matches")
      this.renderList(list)
    } catch (e) {
      this.renderEmpty("Search failed")
    }
  }

  // --- category (nearby) search ---
  category(e) {
    const btn = e.currentTarget
    const cat = btn?.dataset?.category
    if (!cat) return
    this.chipsTarget.querySelectorAll("[data-category]").forEach((c) => c.setAttribute("aria-pressed", c === btn ? "true" : "false"))
    this.runCategory(cat)
  }

  async runCategory(cat) {
    this._lastCategory = cat
    const map = window.dawarichMap
    if (!map) return
    const c = map.getCenter()
    this.renderEmpty("Searching nearby…")
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
      })).filter((r) => r.lat != null && r.lon != null)
      if (!list.length) return this.renderEmpty("Nothing found nearby")
      this.renderList(list)
    } catch (err) {
      this.renderEmpty("Nearby search failed")
    }
  }

  // --- rendering ---
  renderList(list) {
    this._items = list
    this._active = -1
    this.resultsTarget.innerHTML = list
      .map(
        (s, i) => `
        <li>
          <button type="button" class="map-search__row" data-idx="${i}">
            <span class="map-search__row-dot">${this.glyph(s.type)}</span>
            <span class="map-search__row-text">
              <span class="map-search__row-name">${this.esc(s.name)}</span>
              <span class="map-search__row-sub">${this.openBadge(s.open_now)}${s.address ? this.esc(s.address) : ""}</span>
            </span>
            ${s.distance_m != null ? `<span class="map-search__row-dist">${this.fmtDist(s.distance_m)}</span>` : ""}
          </button>
        </li>`,
      )
      .join("")
    this.resultsTarget.querySelectorAll(".map-search__row").forEach((el) => {
      el.addEventListener("click", () => this.choose(Number(el.dataset.idx)))
    })
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

  choose(idx) {
    const s = this._items[idx]
    if (!s) return
    this.inputTarget.value = s.name
    this.close()
    document.dispatchEvent(
      new CustomEvent("place-sheet:open", {
        detail: {
          name: s.name, address: s.address, lat: s.lat, lon: s.lon,
          type: s.type, osm_type: s.osm_type, osm_id: s.osm_id,
        },
      }),
    )
    try { window.dawarichMap?.flyTo({ center: [s.lon, s.lat], zoom: 16 }) } catch (e) { /* noop */ }
  }

  clear() {
    this.inputTarget.value = ""
    this.clearTarget.hidden = true
    this.showChips()
    this.inputTarget.focus()
  }

  clearChipState() {
    this.chipsTarget?.querySelectorAll('[data-category][aria-pressed="true"]').forEach((c) => c.setAttribute("aria-pressed", "false"))
  }

  onKeydown(e) {
    if (e.key === "Escape") return this.close()
    if (!this._items.length || this.resultsTarget.hidden) return
    if (e.key === "ArrowDown") { e.preventDefault(); this._active = (this._active + 1) % this._items.length; this.highlight() }
    else if (e.key === "ArrowUp") { e.preventDefault(); this._active = (this._active - 1 + this._items.length) % this._items.length; this.highlight() }
    else if (e.key === "Enter") { e.preventDefault(); this.choose(this._active >= 0 ? this._active : 0) }
  }

  highlight() {
    const rows = this.resultsTarget.querySelectorAll(".map-search__row")
    rows.forEach((el, i) => el.setAttribute("aria-selected", i === this._active ? "true" : "false"))
    rows[this._active]?.scrollIntoView({ block: "nearest" })
  }

  fmtDist(m) { return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km` }

  openBadge(open) {
    if (open === true) return `<span style="color:#16a34a;font-weight:600">Open</span> · `
    if (open === false) return `<span style="color:#dc2626;font-weight:600">Closed</span> · `
    return ""
  }

  // "Open now" filter toggle — re-runs the active category, open ones only.
  toggleOpenNow(e) {
    const btn = e.currentTarget
    this._openNow = !this._openNow
    btn.setAttribute("aria-pressed", this._openNow ? "true" : "false")
    if (this._lastCategory) this.runCategory(this._lastCategory)
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

  esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))
  }
}
