import { Controller } from "@hotwired/stimulus"

// Settings → Saved addresses (vicquick fork).
//
// Home and Work are exclusive-tag places, set here with a proper address
// lookup (self-hosted Photon via /api/v1/locations/suggestions) instead of
// the place sheet's quick chips — an address is a deliberate, rare choice.
//
// Picking a suggestion UPDATES the existing Home/Work place in-place (PATCH)
// so there is only ever one; with none yet, it creates one (POST). Clear
// strips the tag from the current place.
export default class extends Controller {
  static targets = ["row", "input", "results", "current"]
  static values = { apiKey: String }

  connect() {
    this._debounce = null
    // Close any open suggestion list when tapping elsewhere.
    this._onDocClick = (e) => {
      if (!this.element.contains(e.target)) this.hideAllResults()
    }
    document.addEventListener("click", this._onDocClick)
  }

  disconnect() {
    document.removeEventListener("click", this._onDocClick)
    if (this._debounce) clearTimeout(this._debounce)
  }

  hideAllResults() {
    for (const ul of this.resultsTargets) ul.classList.add("hidden")
  }

  search(event) {
    const input = event.target
    const q = input.value.trim()
    const row = input.closest("[data-saved-addresses-target='row']")
    const ul = row.querySelector("[data-saved-addresses-target='results']")
    if (this._debounce) clearTimeout(this._debounce)
    if (q.length < 3) { ul.classList.add("hidden"); return }
    this._debounce = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/v1/locations/suggestions?q=${encodeURIComponent(q)}&api_key=${encodeURIComponent(this.apiKeyValue)}`,
        )
        if (!res.ok) return
        const data = await res.json()
        const list = (data.suggestions || [])
          .filter((s) => s.coordinates?.[0] != null)
          .slice(0, 6)
        if (!list.length) { ul.classList.add("hidden"); return }
        ul.innerHTML = list
          .map(
            (s, i) => `<li><button type="button" class="w-full text-left px-3 py-2 text-xs hover:bg-base-200" data-i="${i}">
              <span class="font-medium">${this.esc(s.name || "")}</span>
              <span class="opacity-60 block truncate">${this.esc(s.address || "")}</span>
            </button></li>`,
          )
          .join("")
        ul.classList.remove("hidden")
        ul.querySelectorAll("button").forEach((btn) =>
          btn.addEventListener("click", () => this.pick(row, list[Number(btn.dataset.i)])),
        )
      } catch (_) { /* keep quiet — settings must never break the map */ }
    }, 250)
  }

  async pick(row, s) {
    const tagId = Number(row.dataset.tagId)
    const placeId = row.dataset.placeId
    const body = {
      place: {
        name: s.name || s.address || "Saved address",
        latitude: s.coordinates[0],
        longitude: s.coordinates[1],
        tag_ids: [tagId],
      },
    }
    const url = placeId
      ? `/api/v1/places/${placeId}?api_key=${encodeURIComponent(this.apiKeyValue)}`
      : `/api/v1/places?api_key=${encodeURIComponent(this.apiKeyValue)}`
    try {
      const res = await fetch(url, {
        method: placeId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      if (!res.ok) return
      const data = await res.json().catch(() => ({}))
      if (data.id) row.dataset.placeId = data.id
      const cur = row.querySelector("[data-saved-addresses-target='current']")
      if (cur) cur.textContent = body.place.name
      row.querySelector("[data-saved-addresses-target='input']").value = ""
      this.hideAllResults()
      try { window.dawarichUpsertPlace?.(data) } catch (_) { /* next load */ }
    } catch (_) { /* noop */ }
  }

  async clear(event) {
    const row = event.target.closest("[data-saved-addresses-target='row']")
    const placeId = row.dataset.placeId
    if (!placeId) return
    try {
      const res = await fetch(`/api/v1/places/${placeId}?api_key=${encodeURIComponent(this.apiKeyValue)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ place: { tag_ids: [] } }),
      })
      if (!res.ok) return
      row.dataset.placeId = ""
      const cur = row.querySelector("[data-saved-addresses-target='current']")
      if (cur) cur.textContent = "Not set"
      event.target.remove()
    } catch (_) { /* noop */ }
  }

  esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c])
  }
}
