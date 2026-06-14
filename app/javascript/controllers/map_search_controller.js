import { Controller } from "@hotwired/stimulus"

// Floating Google-Maps-style search (vicquick fork). Debounced suggestions
// from self-hosted Photon (/api/v1/locations/suggestions); selecting a result
// opens the place detail sheet and flies there. Self-contained.
export default class extends Controller {
  static targets = ["input", "results", "clear"]
  static values = { apiKey: String }

  connect() {
    this._debounce = null
    this._items = []
    this._active = -1
    this._onDocClick = (e) => {
      if (!this.element.contains(e.target)) this.hideResults()
    }
    document.addEventListener("click", this._onDocClick)
  }

  disconnect() {
    document.removeEventListener("click", this._onDocClick)
    clearTimeout(this._debounce)
  }

  onFocus() {
    if (this._items.length) this.showResults()
  }

  onInput() {
    const q = this.inputTarget.value.trim()
    this.clearTarget.hidden = q.length === 0
    clearTimeout(this._debounce)
    if (q.length < 2) {
      this.renderEmpty(null)
      return
    }
    this._debounce = setTimeout(() => this.search(q), 220)
  }

  onKeydown(e) {
    if (e.key === "Escape") return this.hideResults()
    if (!this._items.length) return
    if (e.key === "ArrowDown") {
      e.preventDefault()
      this._active = (this._active + 1) % this._items.length
      this.highlight()
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      this._active = (this._active - 1 + this._items.length) % this._items.length
      this.highlight()
    } else if (e.key === "Enter") {
      e.preventDefault()
      this.choose(this._active >= 0 ? this._active : 0)
    }
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
      this._items = list
      this._active = -1
      if (!list.length) return this.renderEmpty("No matches")
      this.renderList(list)
    } catch (e) {
      this.renderEmpty("Search failed")
    }
  }

  renderList(list) {
    this.resultsTarget.innerHTML = list
      .map(
        (s, i) => `
        <li>
          <button type="button" class="map-search__row" data-idx="${i}">
            <span class="map-search__row-dot">${this.glyph(s.type)}</span>
            <span class="map-search__row-text">
              <span class="map-search__row-name">${this.esc(s.name)}</span>
              ${s.address ? `<span class="map-search__row-sub">${this.esc(s.address)}</span>` : ""}
            </span>
          </button>
        </li>`,
      )
      .join("")
    // Wire clicks (avoid relying on a unicode action name).
    this.resultsTarget.querySelectorAll(".map-search__row").forEach((el) => {
      el.addEventListener("click", () => this.choose(Number(el.dataset.idx)))
    })
    this.showResults()
  }

  renderEmpty(msg) {
    this._items = []
    this._active = -1
    if (!msg) {
      this.hideResults()
      this.resultsTarget.innerHTML = ""
      return
    }
    this.resultsTarget.innerHTML = `<li class="map-search__empty">${this.esc(msg)}</li>`
    this.showResults()
  }

  choose(idx) {
    const s = this._items[idx]
    if (!s) return
    this.inputTarget.value = s.name
    this.hideResults()
    document.dispatchEvent(
      new CustomEvent("place-sheet:open", {
        detail: {
          name: s.name,
          address: s.address,
          lat: s.lat,
          lon: s.lon,
          type: s.type,
          osm_type: s.osm_type,
          osm_id: s.osm_id,
        },
      }),
    )
    try {
      window.dawarichMap?.flyTo({ center: [s.lon, s.lat], zoom: 16 })
    } catch (e) { /* noop */ }
  }

  clear() {
    this.inputTarget.value = ""
    this.clearTarget.hidden = true
    this.renderEmpty(null)
    this.inputTarget.focus()
  }

  highlight() {
    const rows = this.resultsTarget.querySelectorAll(".map-search__row")
    rows.forEach((el, i) => el.setAttribute("aria-selected", i === this._active ? "true" : "false"))
    rows[this._active]?.scrollIntoView({ block: "nearest" })
  }

  showResults() { this.resultsTarget.hidden = false }
  hideResults() { this.resultsTarget.hidden = true }

  glyph(type) {
    const t = String(type || "").toLowerCase()
    if (/(restaurant|cafe|bar|food|pub)/.test(t)) return "🍴"
    if (/(hotel|hostel|guest)/.test(t)) return "🛏️"
    if (/(shop|store|supermarket|mall)/.test(t)) return "🛒"
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
