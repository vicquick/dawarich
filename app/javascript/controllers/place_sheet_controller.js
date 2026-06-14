import { Controller } from "@hotwired/stimulus"

// Google-Maps-style place detail bottom sheet (vicquick fork).
// Opens when a search result is selected (or via openPlace event), shows the
// place + actions (directions, save as starred, share). Pull the handle to expand.
// Self-contained: failures here never break the core map.
export default class extends Controller {
  static targets = ["title", "address", "meta", "enrichment"]
  static values = { apiKey: String, starredTagId: { type: Number, default: 5 } }

  connect() {
    this.onSelected = (e) => this.open(e.detail?.location)
    document.addEventListener("location-search:selected", this.onSelected)
    // allow other code to open the sheet: dispatch CustomEvent("place-sheet:open", {detail:{name,lat,lon,address}})
    this.onOpen = (e) => this.open(e.detail)
    document.addEventListener("place-sheet:open", this.onOpen)
    this.expanded = false
  }

  disconnect() {
    document.removeEventListener("location-search:selected", this.onSelected)
    document.removeEventListener("place-sheet:open", this.onOpen)
  }

  open(loc) {
    if (!loc) return
    const coords = loc.coordinates || [loc.lat, loc.lon]
    this.place = {
      name: loc.name || loc.title || "Unnamed place",
      address: loc.address || "",
      type: loc.type || "",
      lat: Number(coords[0]),
      lon: Number(coords[1]),
    }
    if (this.hasTitleTarget) this.titleTarget.textContent = this.place.name
    if (this.hasAddressTarget) this.addressTarget.textContent = this.place.address
    if (this.hasMetaTarget) {
      this.metaTarget.textContent = [this.place.type, `${this.place.lat.toFixed(5)}, ${this.place.lon.toFixed(5)}`]
        .filter(Boolean).join(" · ")
    }
    if (this.hasEnrichmentTarget) this.enrichmentTarget.innerHTML = ""
    this.element.style.height = "34vh"
    this.element.style.transform = "translateY(0)"
    this.expanded = false
  }

  togglePullUp() {
    this.expanded = !this.expanded
    this.element.style.height = this.expanded ? "78vh" : "34vh"
  }

  close() {
    this.element.style.transform = "translateY(100%)"
  }

  directions() {
    if (!this.place) return
    try {
      window.dawarichDirections?.routeTo(this.place.lat, this.place.lon)
    } catch (e) { /* noop */ }
    this.close()
  }

  async save() {
    if (!this.place) return
    try {
      const res = await fetch(`/api/v1/places?api_key=${encodeURIComponent(this.apiKeyValue)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          place: {
            name: this.place.name,
            latitude: this.place.lat,
            longitude: this.place.lon,
            tag_ids: [this.starredTagIdValue],
          },
        }),
      })
      const btn = this.element.querySelector("[data-save-label]")
      if (btn) btn.textContent = res.ok ? "Saved ⭐" : "Save failed"
    } catch (e) {
      const btn = this.element.querySelector("[data-save-label]")
      if (btn) btn.textContent = "Save failed"
    }
  }

  async share() {
    if (!this.place) return
    const text = `${this.place.name} — https://www.openstreetmap.org/?mlat=${this.place.lat}&mlon=${this.place.lon}#map=17/${this.place.lat}/${this.place.lon}`
    try {
      if (navigator.share) {
        await navigator.share({ title: this.place.name, text })
      } else {
        await navigator.clipboard.writeText(text)
        const btn = this.element.querySelector("[data-share-label]")
        if (btn) btn.textContent = "Copied ✓"
      }
    } catch (e) { /* user cancelled */ }
  }
}
