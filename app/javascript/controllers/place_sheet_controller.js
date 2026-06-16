import { Controller } from "@hotwired/stimulus"

// Google-Maps-style place detail bottom sheet (vicquick fork).
// Opens when a search result is selected (or via openPlace event), shows the
// place + actions (directions, save as starred, share). Pull the handle to expand.
// Self-contained: failures here never break the core map.
export default class extends Controller {
  static targets = ["title", "address", "meta", "enrichment", "info", "directions", "categoryBtn", "tagPicker", "handle"]
  static values = { apiKey: String, starredTagId: { type: Number, default: 5 }, tags: { type: Array, default: [] } }

  connect() {
    this.onSelected = (e) => this.open(e.detail?.location)
    document.addEventListener("location-search:selected", this.onSelected)
    // allow other code to open the sheet: dispatch CustomEvent("place-sheet:open", {detail:{name,lat,lon,address}})
    this.onOpen = (e) => this.open(e.detail)
    document.addEventListener("place-sheet:open", this.onOpen)
    this.expanded = false
    this.backdrop = document.getElementById("place-sheet-backdrop")
    if (this.backdrop) this.backdrop.addEventListener("click", () => this.close())
    this.setupDragHandle()
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
    if (this._dragMove) window.removeEventListener("pointermove", this._dragMove)
    if (this._dragUp) window.removeEventListener("pointerup", this._dragUp)
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
      savedPlaceId: loc.savedPlaceId || null,
      // Full tag set [{id,name,color,icon}] (server-ordered by priority).
      tags: Array.isArray(loc.tags) ? loc.tags : (loc.tag ? [{ name: loc.tag, color: loc.tagColor }] : []),
    }
    if (this.hasTagPickerTarget) this.tagPickerTarget.hidden = true
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
    this.renderCategoryButton()
    if (this.hasMetaTarget) {
      const showType = this.place.tags.length ? "" : this.place.type
      this.metaTarget.textContent = [showType, `${this.place.lat.toFixed(5)}, ${this.place.lon.toFixed(5)}`]
        .filter(Boolean).join(" · ")
    }
    if (this.hasEnrichmentTarget) this.enrichmentTarget.innerHTML = ""
    // Reset transient button states from a previous place.
    const shareLabel = this.element.querySelector("[data-share-label]")
    if (shareLabel) shareLabel.textContent = "Share"
    if (this.hasTagPickerTarget) this.tagPickerTarget.hidden = true
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

  // --- one button: Save / current category, gateway to the picker ---
  // "Default list" is an internal bucket — never offered as a category.
  pickerTags() {
    return (this.tagsValue || []).filter((t) => t.name !== "Default list")
  }

  currentTagIds() {
    return this.place.tags.map((t) => t.id).filter((x) => x != null)
  }

  renderCategoryButton() {
    if (!this.hasCategoryBtnTarget) return
    const primary = this.place.tags[0] // server-ordered by priority
    const btn = this.categoryBtnTarget
    if (primary && primary.name) {
      btn.className = "btn btn-sm gap-1"
      btn.textContent = `${primary.icon ? primary.icon + " " : "⭐ "}${primary.name}`
      btn.style.background = primary.color || "#6366f1"
      btn.style.color = "#fff"
      btn.style.border = "0"
    } else {
      btn.className = "btn btn-outline btn-sm gap-1"
      btn.textContent = "⭐ Save"
      btn.style.background = ""
      btn.style.color = ""
      btn.style.border = ""
    }
  }

  toggleTagPicker() {
    if (!this.hasTagPickerTarget) return
    const show = this.tagPickerTarget.hidden
    if (show) this.renderTagChips()
    this.tagPickerTarget.hidden = !show
  }

  renderTagChips() {
    const active = new Set(this.currentTagIds())
    const chip = (id, label, color, on) =>
      `<button type="button" class="ps-tag-chip" data-tag-id="${id}"
        style="border:1px solid ${color};color:${on ? "#fff" : color};background:${on ? color : "transparent"};
        border-radius:999px;padding:5px 11px;font-size:.8rem;font-weight:600;cursor:pointer">${this.esc(label)}</button>`
    let html = this.pickerTags()
      .map((t) => chip(t.id, (t.icon ? t.icon + " " : "") + t.name, t.color || "#9ca3af", active.has(t.id)))
      .join("")
    if (active.size) html += chip(0, "✕ None", "#9ca3af", false)
    this.tagPickerTarget.innerHTML = html
    this.tagPickerTarget.querySelectorAll(".ps-tag-chip").forEach((el) =>
      el.addEventListener("click", () => this.toggleTag(Number(el.dataset.tagId))))
  }

  // Exclusive category: pick one (replace), or clear (None / tap the active one).
  async toggleTag(tagId) {
    const current = this.currentTagIds()
    const ids = (tagId === 0 || (current.length === 1 && current[0] === tagId)) ? [] : [tagId]
    const data = await this.persistTags(ids)
    if (!data) return
    this.place.tags = Array.isArray(data.tags) ? data.tags : []
    if (data.id) this.place.savedPlaceId = data.id
    this.renderCategoryButton()
    this.renderTagChips()
    // Surgically recolour just this marker — no full reload.
    try { window.dawarichUpsertPlace?.(data) } catch (e) { /* updates on next load */ }
  }

  // PATCH replaces the exact tag set (saved place); POST creates/dedupes + merges.
  async persistTags(tagIds) {
    if (this.place.lat == null || this.place.lon == null) return null
    const saved = this.place.savedPlaceId
    const url = saved
      ? `/api/v1/places/${saved}?api_key=${encodeURIComponent(this.apiKeyValue)}`
      : `/api/v1/places?api_key=${encodeURIComponent(this.apiKeyValue)}`
    try {
      const res = await fetch(url, {
        method: saved ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          place: { name: this.place.name, latitude: this.place.lat, longitude: this.place.lon, tag_ids: tagIds },
        }),
      })
      if (!res.ok) return null
      return await res.json().catch(() => ({}))
    } catch (e) {
      return null
    }
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
      const hasWeek = Array.isArray(d.week_hours) && d.week_hours.length === 7
      if (d.today_hours) {
        parts.push(`<span class="ps-hours-toggle" style="opacity:.8;cursor:${hasWeek ? "pointer" : "default"}">Today ${this.esc(d.today_hours)}${hasWeek ? " ▾" : ""}</span>`)
      } else if (d.opening_hours) {
        parts.push(`<span style="opacity:.7">${this.esc(d.opening_hours)}</span>`)
      }
      let html = ""
      // Photo (Wikidata / Brave / Wikimedia Commons) when available.
      if (d.image) html += `<img src="${this.esc(d.image)}" alt="" loading="lazy" style="width:100%;max-height:160px;object-fit:cover;border-radius:12px;margin-bottom:10px" onerror="this.remove()">`
      if (d.rating) html += `<div style="font-size:.85rem;margin-bottom:6px">⭐ <strong>${this.esc(String(d.rating))}</strong></div>`
      if (parts.length) html += `<div style="font-size:.85rem;margin-bottom:8px">${parts.join(" · ")}</div>`
      // Full week hours (Mon-first), hidden until the toggle is tapped.
      if (hasWeek) {
        const rows = d.week_hours.map((w) =>
          `<div style="display:flex;justify-content:space-between;font-size:.8rem;padding:3px 0;${w.today ? "font-weight:700" : "opacity:.75"}">
             <span>${this.esc(w.day)}</span><span>${this.esc(w.hours || "Closed")}</span></div>`).join("")
        html += `<div class="ps-week" hidden style="margin:-2px 0 10px;padding:6px 2px;border-top:1px solid rgba(128,128,128,.15)">${rows}</div>`
      }
      const links = []
      if (d.phone) links.push(`<a href="tel:${this.esc(d.phone)}" class="btn btn-outline btn-sm gap-1">📞 Call</a>`)
      if (d.website) links.push(`<a href="${this.esc(d.website)}" target="_blank" rel="noopener" class="btn btn-outline btn-sm gap-1">🌐 Website</a>`)
      if (links.length) html += `<div style="display:flex;gap:8px;flex-wrap:wrap">${links.join("")}</div>`
      if (d.description) html += `<p style="font-size:.8rem;opacity:.7;margin-top:8px">${this.esc(d.description)}</p>`
      if (d.cuisine) html += `<p style="font-size:.75rem;opacity:.6;margin-top:6px">${this.esc(d.cuisine.replace(/;/g, ", "))}</p>`
      this.enrichmentTarget.innerHTML = html
      const toggle = this.enrichmentTarget.querySelector(".ps-hours-toggle")
      const week = this.enrichmentTarget.querySelector(".ps-week")
      if (toggle && week) toggle.addEventListener("click", () => { week.hidden = !week.hidden })
    } catch (e) { /* enrichment is best-effort */ }
  }

  esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))
  }

  togglePullUp() {
    this.expanded = !this.expanded
    this.element.style.height = this.expanded ? "85vh" : "40vh"
  }

  // Draggable handle: drag up/down to resize the sheet, tap to toggle.
  setupDragHandle() {
    if (!this.hasHandleTarget) return
    const vh = () => window.innerHeight
    let startY = 0
    let startH = 0
    let dragging = false
    let moved = false

    const down = (e) => {
      dragging = true
      moved = false
      startY = e.clientY ?? e.touches?.[0]?.clientY ?? 0
      startH = this.element.offsetHeight
      this.element.style.transition = "none"
      try { this.handleTarget.setPointerCapture(e.pointerId) } catch (_) {}
    }
    const move = (e) => {
      if (!dragging) return
      const y = e.clientY ?? e.touches?.[0]?.clientY ?? 0
      const dy = y - startY
      if (Math.abs(dy) > 4) moved = true
      const h = Math.max(vh() * 0.2, Math.min(vh() * 0.92, startH - dy))
      this.element.style.height = `${h}px`
    }
    const up = () => {
      if (!dragging) return
      dragging = false
      this.element.style.transition = ""
      if (!moved) return this.togglePullUp()
      const cur = (this.element.offsetHeight / vh()) * 100
      const near = [34, 62, 90].reduce((a, b) => (Math.abs(b - cur) < Math.abs(a - cur) ? b : a))
      this.element.style.height = `${near}vh`
      this.expanded = near > 45
    }

    this._dragMove = move
    this._dragUp = up
    this.handleTarget.addEventListener("pointerdown", down)
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
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
    // Keep it ~half height so the drawn route stays visible on the map above.
    this.element.style.height = "48vh"
    this.expanded = true
    // Reset mode to Drive.
    this.element.querySelectorAll(".dir-mode").forEach((b) =>
      b.classList.toggle("btn-active", b.dataset.mode === "auto"))
    try { window.dawarichDirections?.routeTo(this.place.lat, this.place.lon) } catch (e) { /* noop */ }
  }

  // Resume the live nav follow-camera after the user has panned away.
  recenter() {
    try { window.dawarichDirections?.recenter() } catch (_) { /* noop */ }
  }

  setMode(e) {
    const mode = e.currentTarget.dataset.mode
    try { window.dawarichDirections?.setCosting(mode) } catch (_) { /* noop */ }
    this.element.querySelectorAll(".dir-mode").forEach((b) =>
      b.classList.toggle("btn-active", b === e.currentTarget))
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
