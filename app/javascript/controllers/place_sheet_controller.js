import { Controller } from "@hotwired/stimulus"

// Google-Maps-style place detail bottom sheet (vicquick fork).
// Opens when a search result is selected (or via openPlace event), shows the
// place + actions (directions, save as starred, share). Pull the handle to expand.
// Self-contained: failures here never break the core map.
export default class extends Controller {
  static targets = ["title", "address", "meta", "enrichment", "info", "directions", "tagBadge"]
  static values = { apiKey: String, starredTagId: { type: Number, default: 5 } }

  connect() {
    this.onSelected = (e) => this.open(e.detail?.location)
    document.addEventListener("location-search:selected", this.onSelected)
    // allow other code to open the sheet: dispatch CustomEvent("place-sheet:open", {detail:{name,lat,lon,address}})
    this.onOpen = (e) => this.open(e.detail)
    document.addEventListener("place-sheet:open", this.onOpen)
    this.expanded = false
    this.backdrop = document.getElementById("place-sheet-backdrop")
    if (this.backdrop) this.backdrop.addEventListener("click", () => this.close())
  }

  showBackdrop() {
    if (!this.backdrop) return
    this.backdrop.style.opacity = "1"
    this.backdrop.style.pointerEvents = "auto"
  }

  hideBackdrop() {
    if (!this.backdrop) return
    this.backdrop.style.opacity = "0"
    this.backdrop.style.pointerEvents = "none"
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
      osmType: loc.osm_type || loc.osmType,
      osmId: loc.osm_id || loc.osmId,
    }
    this.editableName = !!loc.editableName
    if (this.hasTitleTarget) {
      this.titleTarget.textContent = this.place.name
      // Dropped pins: let the user label the place inline before saving.
      this.titleTarget.contentEditable = this.editableName ? "true" : "false"
      this.titleTarget.style.outline = this.editableName ? "1px dashed rgba(128,128,128,.5)" : ""
      this.titleTarget.style.borderRadius = this.editableName ? "6px" : ""
      this.titleTarget.style.padding = this.editableName ? "0 4px" : ""
      if (this.editableName) {
        this.titleTarget.setAttribute("aria-label", "Pin label (editable)")
        requestAnimationFrame(() => {
          this.titleTarget.focus()
          document.getSelection()?.selectAllChildren(this.titleTarget)
        })
      }
    }
    if (this.hasAddressTarget) this.addressTarget.textContent = this.place.address
    // Tag badge (saved places carry a tag + colour).
    if (this.hasTagBadgeTarget) {
      if (loc.tag) {
        this.tagBadgeTarget.textContent = loc.tag
        this.tagBadgeTarget.style.backgroundColor = loc.tagColor || "#6366f1"
        this.tagBadgeTarget.hidden = false
      } else {
        this.tagBadgeTarget.hidden = true
      }
    }
    if (this.hasMetaTarget) {
      const showType = loc.tag ? "" : this.place.type
      this.metaTarget.textContent = [showType, `${this.place.lat.toFixed(5)}, ${this.place.lon.toFixed(5)}`]
        .filter(Boolean).join(" · ")
    }
    if (this.hasEnrichmentTarget) this.enrichmentTarget.innerHTML = ""
    this.element.style.height = "34vh"
    this.element.style.transform = "translateY(0)"
    this.expanded = false
    this.showBackdrop()
    this.highlightOnMap()
    this.enrich()
  }

  // Blue selection ring on the map for the active place (Google-style).
  highlightOnMap() {
    const map = window.dawarichMap
    if (!map || this.place.lat == null || this.place.lon == null) return
    const data = {
      type: "FeatureCollection",
      features: [{ type: "Feature", geometry: { type: "Point", coordinates: [this.place.lon, this.place.lat] }, properties: {} }],
    }
    try {
      if (map.getSource("place-highlight")) {
        map.getSource("place-highlight").setData(data)
      } else {
        map.addSource("place-highlight", { type: "geojson", data })
        map.addLayer({
          id: "place-highlight",
          type: "circle",
          source: "place-highlight",
          paint: {
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 9, 15, 16, 18, 22],
            "circle-color": "#2563eb",
            "circle-opacity": 0.22,
            "circle-stroke-color": "#2563eb",
            "circle-stroke-width": 3,
          },
        })
      }
    } catch (e) { /* style not ready — non-fatal */ }
  }

  clearHighlight() {
    const map = window.dawarichMap
    try {
      if (map?.getLayer("place-highlight")) map.removeLayer("place-highlight")
      if (map?.getSource("place-highlight")) map.removeSource("place-highlight")
    } catch (e) { /* noop */ }
  }

  // Fetch open-now / hours / phone / website (OSM) and render it.
  async enrich() {
    if (!this.hasEnrichmentTarget || !this.place) return
    const hasOsm = this.place.osmType && this.place.osmId
    const hasCoords = this.place.lat != null && this.place.lon != null
    if (!hasOsm && !hasCoords) return
    try {
      const params = new URLSearchParams({ api_key: this.apiKeyValue })
      if (hasOsm) { params.set("osm_type", this.place.osmType); params.set("osm_id", this.place.osmId) }
      if (hasCoords) { params.set("lat", this.place.lat); params.set("lon", this.place.lon) }
      if (this.place.name) params.set("name", this.place.name)
      const res = await fetch(`/api/v1/place_info?${params.toString()}`)
      if (!res.ok) return
      const d = await res.json()
      const parts = []
      if (d.open_now === true) parts.push(`<span style="color:#16a34a;font-weight:600">Open now</span>`)
      else if (d.open_now === false) parts.push(`<span style="color:#dc2626;font-weight:600">Closed now</span>`)
      if (d.today_hours) parts.push(`<span style="opacity:.75">Today ${this.esc(d.today_hours)}</span>`)
      else if (d.opening_hours) parts.push(`<span style="opacity:.7">${this.esc(d.opening_hours)}</span>`)
      let html = ""
      // Wikidata photo (Wikimedia Commons) when available.
      if (d.image) html += `<img src="${this.esc(d.image)}" alt="" loading="lazy" style="width:100%;max-height:160px;object-fit:cover;border-radius:12px;margin-bottom:10px" onerror="this.remove()">`
      if (parts.length) html += `<div style="font-size:.85rem;margin-bottom:8px">${parts.join(" · ")}</div>`
      const links = []
      if (d.phone) links.push(`<a href="tel:${this.esc(d.phone)}" class="btn btn-outline btn-sm gap-1">📞 Call</a>`)
      if (d.website) links.push(`<a href="${this.esc(d.website)}" target="_blank" rel="noopener" class="btn btn-outline btn-sm gap-1">🌐 Website</a>`)
      if (links.length) html += `<div style="display:flex;gap:8px;flex-wrap:wrap">${links.join("")}</div>`
      if (d.description) html += `<p style="font-size:.8rem;opacity:.7;margin-top:8px">${this.esc(d.description)}</p>`
      if (d.cuisine) html += `<p style="font-size:.75rem;opacity:.6;margin-top:6px">${this.esc(d.cuisine.replace(/;/g, ", "))}</p>`
      this.enrichmentTarget.innerHTML = html
    } catch (e) { /* enrichment is best-effort */ }
  }

  esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))
  }

  togglePullUp() {
    this.expanded = !this.expanded
    this.element.style.height = this.expanded ? "78vh" : "34vh"
  }

  close() {
    this.element.style.transform = "translateY(100%)"
    this.hideBackdrop()
    this.clearHighlight()
    try { window.dawarichDirections?.disable() } catch (e) { /* noop */ }
    this.backToInfo()
  }

  // Switch the sheet into directions mode (route panel lives inside the sheet).
  directions() {
    if (!this.place) return
    if (this.hasInfoTarget) this.infoTarget.style.display = "none"
    if (this.hasDirectionsTarget) this.directionsTarget.classList.remove("hidden")
    this.element.style.height = "78vh"
    this.expanded = true
    try { window.dawarichDirections?.routeTo(this.place.lat, this.place.lon) } catch (e) { /* noop */ }
  }

  // Back from directions to the place info view.
  backToInfo() {
    if (this.hasDirectionsTarget) this.directionsTarget.classList.add("hidden")
    if (this.hasInfoTarget) this.infoTarget.style.display = ""
    this.element.style.height = "34vh"
    this.expanded = false
    try { window.dawarichDirections?.disable() } catch (e) { /* noop */ }
  }

  async save() {
    if (!this.place) return
    // Pick up an edited label for dropped pins.
    const name = this.hasTitleTarget && this.editableName
      ? (this.titleTarget.textContent || "").trim() || this.place.name
      : this.place.name
    try {
      const res = await fetch(`/api/v1/places?api_key=${encodeURIComponent(this.apiKeyValue)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          place: {
            name,
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
