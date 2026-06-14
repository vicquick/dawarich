import { Controller } from "@hotwired/stimulus"

// Google-Maps-style "Nearby places" chips (vicquick fork). Tapping a category
// queries self-hosted Photon for POIs around the current map center and lists
// them; tapping a result opens the place detail sheet. Self-contained.
export default class extends Controller {
  static targets = ["results"]
  static values = { apiKey: String }

  category(e) {
    const cat = e.currentTarget?.dataset?.category
    if (cat) this.search(cat)
  }

  async search(category) {
    const map = window.dawarichMap
    if (!map || !this.hasResultsTarget) return
    const c = map.getCenter()
    this.resultsTarget.innerHTML = `<div style="padding:10px;opacity:.6">Searching nearby…</div>`
    try {
      const res = await fetch(
        `/api/v1/nearby?api_key=${encodeURIComponent(this.apiKeyValue)}&lat=${c.lat}&lon=${c.lng}&category=${encodeURIComponent(category)}&limit=12`,
      )
      const data = await res.json()
      const list = data.results || []
      if (!list.length) {
        this.resultsTarget.innerHTML = `<div style="padding:10px;opacity:.6">Nothing found nearby.</div>`
        return
      }
      this.resultsTarget.innerHTML = list
        .map(
          (r, i) => `
        <button type="button" data-idx="${i}" class="discovery-result"
          style="display:flex;justify-content:space-between;align-items:center;gap:8px;width:100%;text-align:left;padding:10px 4px;border:0;border-bottom:1px solid rgba(128,128,128,.2);background:transparent;color:inherit;cursor:pointer">
          <span style="min-width:0">
            <span style="display:block;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${this.esc(r.name)}</span>
            <span style="font-size:.75rem;opacity:.6">${this.esc(r.category || "")}${r.address ? " · " + this.esc(r.address) : ""}</span>
          </span>
          <span style="font-size:.75rem;opacity:.6;white-space:nowrap">${this.fmtDist(r.distance_m)}</span>
        </button>`,
        )
        .join("")
      this._list = list
      this.resultsTarget.querySelectorAll(".discovery-result").forEach((el) => {
        el.addEventListener("click", () => this.openResult(Number(el.dataset.idx)))
      })
    } catch (e) {
      this.resultsTarget.innerHTML = `<div style="padding:10px;opacity:.6">Search failed.</div>`
    }
  }

  openResult(idx) {
    const r = this._list?.[idx]
    if (!r) return
    document.dispatchEvent(
      new CustomEvent("place-sheet:open", {
        detail: {
          name: r.name,
          address: r.address,
          lat: r.lat,
          lon: r.lon,
          type: r.category,
          osm_type: r.osm_type,
          osm_id: r.osm_id,
        },
      }),
    )
    try {
      window.dawarichMap?.flyTo({ center: [r.lon, r.lat], zoom: 15 })
    } catch (e) { /* noop */ }
  }

  fmtDist(m) {
    if (m == null) return ""
    return m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1)} km`
  }

  esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))
  }
}
