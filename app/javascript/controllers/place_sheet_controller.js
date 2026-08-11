import { Controller } from "@hotwired/stimulus"

// Google-Maps-style place detail bottom sheet (vicquick fork).
// Opens when a search result is selected (or via openPlace event), shows the
// place + actions (directions, save as starred, share). Pull the handle to expand.
// Self-contained: failures here never break the core map.
export default class extends Controller {
  static targets = ["title", "address", "meta", "enrichment", "info", "directions", "categoryBtn", "tagPicker", "handle",
    "startLabel", "endLabel", "endpointPicker", "endpointInput", "endpointResults", "waypoints"]
  static values = { apiKey: String, starredTagId: { type: Number, default: 5 }, tags: { type: Array, default: [] } }

  connect() {
    this.onSelected = (e) => this.open(e.detail?.location)
    document.addEventListener("location-search:selected", this.onSelected)
    // allow other code to open the sheet: dispatch CustomEvent("place-sheet:open", {detail:{name,lat,lon,address}})
    this.onOpen = (e) => this.open(e.detail)
    document.addEventListener("place-sheet:open", this.onOpen)
    this.onStops = (e) => this.renderStops(e.detail) // multi-stop trip rows
    document.addEventListener("directions:stops", this.onStops)
    this.onRestore = (e) => this.restoreSharedRoute(e.detail) // shared-link route
    document.addEventListener("directions:restore", this.onRestore)
    this.expanded = false
    this.backdrop = document.getElementById("place-sheet-backdrop")
    if (this.backdrop) this.backdrop.addEventListener("click", () => this.close())
    this.setupDragHandle()
  }

  showBackdrop() {
    if (!this.backdrop) return
    // vicquick fork: never dim or lock the map — Google keeps a live, undimmed
    // map behind the place card and stays fully interactive. The backdrop is
    // kept inert; dismissal is the X button or a downward drag. (A dimming,
    // gesture-eating scrim was the last overlay state that still walled the map.)
    this.backdrop.style.opacity = "0"
    this.backdrop.style.pointerEvents = "none"
  }

  // Register / release the sheet's footprint with the shared camera-padding
  // coordinator so marker focus & recenter stay in the visible map area.
  // In directions mode we release it and let directions_manager own the
  // camera (it already pads per-call for the route + sheet).
  syncPad() {
    try { window.dawarichMapPadding?.set("place-sheet", "bottom", this.element.offsetHeight) } catch (_) { /* noop */ }
  }

  clearPad() {
    try { window.dawarichMapPadding?.clear("place-sheet") } catch (_) { /* noop */ }
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
    document.removeEventListener("directions:stops", this.onStops)
    document.removeEventListener("directions:restore", this.onRestore)
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
    this.syncPad()
    // syncPad() schedules a rAF that eases the camera to apply sheet padding
    // (no center → keeps current center). Run the fly on the NEXT frame so it
    // supersedes that padding ease instead of being cancelled by it.
    requestAnimationFrame(() => this.flyToPlace())
    this.enrich()
  }

  // Move the map to the opened place, framed above the sheet. Zooms IN when the
  // place is off-screen / far out, but never zooms out if you're already close.
  // Skipped for dropped pins (editableName) — you long-pressed that exact spot.
  flyToPlace() {
    const map = window.dawarichMap
    if (!map || this.editableName || this.place.lat == null || this.place.lon == null) return
    const sheetPx = Math.round(this.element?.offsetHeight || window.innerHeight * 0.34)
    try {
      map.flyTo({
        center: [this.place.lon, this.place.lat],
        zoom: Math.max(map.getZoom(), 16),
        padding: { top: 0, right: 0, left: 0, bottom: sheetPx },
        duration: 800,
        essential: true,
      })
    } catch (e) { /* style/animation not ready — non-fatal */ }
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
        // Raw OSM hours can be a long multi-rule string — Google never shows
        // that. Keep it only when it's short; otherwise show just the first rule.
        const oh = d.opening_hours.trim()
        const short = oh.length <= 40 ? oh : `${oh.split(";")[0].trim()} …`
        parts.push(`<span style="opacity:.7">${this.esc(short)}</span>`)
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
      if (d.description) {
        // Clamp long Wikidata/Brave blurbs to 3 lines so the sheet stays tidy.
        const desc = d.description.length > 280 ? `${d.description.slice(0, 277).trimEnd()}…` : d.description
        html += `<p style="font-size:.8rem;opacity:.72;margin-top:8px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden">${this.esc(desc)}</p>`
      }
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

  // Type glyph for a result row (OSM type/value → emoji), so the picker shows
  // what each place is instead of a uniform pin.
  glyph(type) {
    const t = String(type || "").toLowerCase()
    if (/(restaurant|cafe|bar|pub|food|fast_food|biergarten)/.test(t)) return "🍴"
    if (/(hotel|hostel|guest|motel)/.test(t)) return "🛏️"
    if (/(supermarket|convenience|mall|department|shop|store|bakery|butcher)/.test(t)) return "🛒"
    if (/(fuel|charging)/.test(t)) return "⛽"
    if (/(atm|bank)/.test(t)) return "🏧"
    if (/(pharmacy|hospital|clinic|doctor|dentist)/.test(t)) return "⚕️"
    if (/(park|forest|garden|wood|playground)/.test(t)) return "🌳"
    if (/(station|halt|bus_stop|train|railway|airport|aerodrome|subway|tram)/.test(t)) return "🚉"
    if (/(museum|gallery|attraction|artwork|viewpoint|theatre|cinema)/.test(t)) return "🎭"
    if (/(school|university|college|library|kindergarten)/.test(t)) return "🎓"
    if (/(city|town|village|suburb|hamlet|municipality|state|county)/.test(t)) return "🏙️"
    if (/(street|road|way|avenue|residential|path|highway)/.test(t)) return "🛣️"
    if (/(house|building|address|yes|apartments)/.test(t)) return "🏠"
    return "📍"
  }

  // Tallest the sheet may grow — leaves the navbar clear so the drag handle
  // stays reachable (otherwise a fully-raised sheet tucks under the navbar and
  // can't be pulled back down on mobile).
  maxSheetPx() {
    const nav = document.querySelector(".navbar") || document.querySelector("header") || document.querySelector("nav")
    const navBottom = nav ? nav.getBoundingClientRect().bottom : 0
    const reserve = Math.max(navBottom + 12, 64)
    return window.innerHeight - reserve
  }

  togglePullUp() {
    this.expanded = !this.expanded
    this.element.style.height = this.expanded ? `${this.maxSheetPx()}px` : "40vh"
    this.syncPad()
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
      const h = Math.max(vh() * 0.2, Math.min(this.maxSheetPx(), startH - dy))
      this.element.style.height = `${h}px`
    }
    const up = () => {
      if (!dragging) return
      dragging = false
      this.element.style.transition = ""
      if (!moved) return this.togglePullUp()
      // Snap to the nearest stop in px (top stop = max, clear of the navbar).
      const stops = [vh() * 0.34, vh() * 0.62, this.maxSheetPx()]
      const curPx = this.element.offsetHeight
      const near = stops.reduce((a, b) => (Math.abs(b - curPx) < Math.abs(a - curPx) ? b : a))
      this.element.style.height = `${near}px`
      this.expanded = near > vh() * 0.45
      this.syncPad()
    }

    this._dragMove = move
    this._dragUp = up
    this.handleTarget.addEventListener("pointerdown", down)
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
  }

  close() {
    this.element.style.transform = "translateY(100%)"
    this.clearHighlight()
    try { window.dawarichDirections?.disable() } catch (e) { /* noop */ }
    this.backToInfo()
    // AFTER backToInfo: it calls syncPad(), which would re-add the map
    // padding we're releasing (padding leak while the sheet is hidden).
    this.clearPad()
    this.hideBackdrop() // closing: no dim (backToInfo would have re-shown it)
  }

  // Open Street View at this place (nearest KartaView photo).
  streetView() {
    if (!this.place) return
    try { window.dawarichStreetView?.openAt(this.place.lon, this.place.lat) } catch (_) { /* noop */ }
  }

  // Switch the sheet into directions mode (route panel lives inside the sheet).
  directions() {
    if (!this.place) return
    this._enterDirectionsView("pedestrian")
    if (this.hasEndLabelTarget) this.endLabelTarget.textContent = this.place.name
    // Open the route PREVIEW (2D overview + ETA); user taps Start to navigate.
    try { window.dawarichDirections?.preview(this.place.lat, this.place.lon, this.place.name) } catch (e) { /* noop */ }
  }

  // DOM setup for directions mode (no route compute) — shared by directions()
  // and shared-link restore.
  _enterDirectionsView(activeMode) {
    if (this.hasInfoTarget) this.infoTarget.style.display = "none"
    if (this.hasDirectionsTarget) this.directionsTarget.classList.remove("hidden")
    // Google-Maps feel: no dim over the map while routing — the map is the hero.
    this.hideBackdrop()
    this.element.style.height = "48vh"
    this.expanded = true
    this.clearPad()
    this.element.querySelectorAll(".dir-mode").forEach((b) =>
      b.classList.toggle("btn-active", b.dataset.mode === activeMode))
    const trip = document.getElementById("directions-trip")
    if (trip) trip.style.display = "block"
    if (this.hasStartLabelTarget) this.startLabelTarget.textContent = "Your location"
    if (this.hasEndpointPickerTarget) this.endpointPickerTarget.hidden = true
    document.body.classList.add("routing-active")
  }

  // Share the current route as a link (opens the OS share sheet, else copies).
  async shareRoute(e) {
    const data = window.dawarichDirections?.routeShareData?.()
    if (!data) return
    const enc = btoa(unescape(encodeURIComponent(JSON.stringify(data))))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
    const url = `${location.origin}/map?dir=${enc}`
    try {
      if (navigator.share) await navigator.share({ title: "Route", url })
      else { await navigator.clipboard.writeText(url); this._flash(e?.currentTarget, "✓ Link copied") }
    } catch (_) { /* user cancelled — noop */ }
  }

  // Download the current route as a GPX track.
  exportGpx(e) {
    try { window.dawarichDirections?.exportGpx?.() } catch (_) { /* noop */ }
    this._flash(e?.currentTarget, "✓ GPX")
  }

  // Rebuild a shared route from ?dir= (dispatched by the map controller on load).
  restoreSharedRoute(data) {
    if (!data?.s || data.s.length < 2) return
    const last = data.s[data.s.length - 1]
    this.open({ name: last[2] || "Destination", lat: last[0], lon: last[1], type: "", tags: [] })
    this._enterDirectionsView(data.c || "pedestrian")
    try { window.dawarichDirections?.restoreRoute(data) } catch (_) { /* noop */ }
  }

  _flash(btn, txt) {
    if (!btn) return
    const orig = btn.dataset._orig || btn.textContent
    btn.dataset._orig = orig
    btn.textContent = txt
    clearTimeout(this._flashT)
    this._flashT = setTimeout(() => { btn.textContent = orig }, 1600)
  }

  // --- Editable Start/End/stops trip planner ---
  editEndpoint(e) {
    this._editing = e.currentTarget.dataset.end // "start" | "end"
    this._openPicker()
  }

  editWaypoint(e) {
    this._editing = Number(e.currentTarget.dataset.wp) // stop index
    this._openPicker()
  }

  addStop() {
    this._editing = "new"
    this._openPicker()
  }

  removeStop(e) {
    const i = Number(e.currentTarget.dataset.wp)
    try { window.dawarichDirections?.removeStop(i) } catch (_) { /* noop */ }
  }

  // Open the fullscreen picker for whatever this._editing points at.
  _openPicker() {
    if (!this.hasEndpointPickerTarget) return
    // The sheet's transform makes position:fixed resolve relative to the sheet,
    // not the viewport. Drop it so the picker overlay is truly fullscreen (the
    // sheet is hidden behind the overlay while it's open).
    this.element.style.transform = "none"
    // The map content sits in a z-20 stacking context; the navbar is a z-40
    // sibling, so the overlay's z-index can't beat it from inside. Lift the whole
    // map layer above the navbar while the picker is open (it's covered anyway).
    this._mapLayer = this.element.closest(".z-20")
    if (this._mapLayer) { this._mapLayerZ = this._mapLayer.style.zIndex; this._mapLayer.style.zIndex = "100" }
    this.endpointPickerTarget.hidden = false
    this.endpointInputTarget.value = ""
    // "Your location" shortcut only when editing the START point.
    this.endpointResultsTarget.innerHTML = this._editing === "start"
      ? `<li><button type="button" data-loc="me"><span class="ep-res-dot">📍</span><span class="ep-res-txt"><span class="ep-res-name">Your location (GPS)</span></span></button></li>`
      : ""
    this.endpointResultsTarget.querySelector('[data-loc="me"]')
      ?.addEventListener("click", () => { window.dawarichDirections?.useMyLocation(); this.closeEndpointPicker() })
    requestAnimationFrame(() => this.endpointInputTarget.focus())
  }

  // Re-render the trip rows (start label, end label, waypoint rows) from the
  // directions manager's emitted stop snapshot.
  renderStops(d) {
    if (!d) return
    if (this.hasStartLabelTarget) this.startLabelTarget.textContent = d.start?.isMe ? "Your location" : (d.start?.name || "Your location")
    if (this.hasEndLabelTarget) this.endLabelTarget.textContent = d.end?.name || "Destination"
    if (!this.hasWaypointsTarget) return
    const wps = d.waypoints || []
    const draggable = wps.length >= 2
    this.waypointsTarget.innerHTML = wps.map((w, i) => `
      <div class="trip-wp" data-wp="${i}">
        ${draggable ? `<span class="trip-drag" data-action="pointerdown->place-sheet#dragStop" data-wp="${i}" aria-label="Reorder stop">⠿</span>` : `<span class="trip-drag" style="opacity:.15">⠿</span>`}
        <span class="trip-dot trip-dot--wp"></span>
        <button type="button" class="trip-text" data-action="click->place-sheet#editWaypoint" data-wp="${i}">${this.esc(w.name || "Stop")}</button>
        <button type="button" class="trip-wp-del" data-action="click->place-sheet#removeStop" data-wp="${i}" aria-label="Remove stop">✕</button>
      </div>`).join("")
  }

  // Smooth pointer drag-reorder (touch + mouse). The dragged row tracks the
  // finger 1:1; the other rows slide to open a gap where it will drop. On
  // release we commit via moveStop and the manager re-emits stops to rebuild.
  dragStop(e) {
    e.preventDefault()
    const handle = e.currentTarget
    const row = handle.closest(".trip-wp")
    const container = this.hasWaypointsTarget ? this.waypointsTarget : null
    if (!row || !container) return
    const rows = [...container.querySelectorAll(".trip-wp")]
    const from = rows.indexOf(row)
    const h = row.offsetHeight || 40
    const startY = e.clientY
    let target = from
    row.style.transition = "none"
    row.style.position = "relative"
    row.style.zIndex = "5"
    row.classList.add("trip-wp--dragging")
    try { handle.setPointerCapture(e.pointerId) } catch (_) { /* noop */ }

    const move = (ev) => {
      const dy = ev.clientY - startY
      row.style.transform = `translateY(${dy}px)`
      const idx = Math.max(0, Math.min(rows.length - 1, from + Math.round(dy / h)))
      if (idx !== target) {
        target = idx
        rows.forEach((r, i) => {
          if (r === row) return
          let shift = 0
          if (from < target && i > from && i <= target) shift = -h
          else if (from > target && i < from && i >= target) shift = h
          r.style.transition = "transform .18s cubic-bezier(.2,.7,.2,1)"
          r.style.transform = shift ? `translateY(${shift}px)` : ""
        })
      }
    }
    const up = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      rows.forEach((r) => { r.style.transition = ""; r.style.transform = ""; r.style.zIndex = ""; r.style.position = "" })
      row.classList.remove("trip-wp--dragging")
      if (target !== from) { try { window.dawarichDirections?.moveStop(from, target) } catch (_) { /* noop */ } }
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
  }

  closeEndpointPicker() {
    // No-op unless the picker is actually open: close() routes through
    // backToInfo() -> here, and the unconditional translateY(0) "restore"
    // was clobbering close()'s translateY(100%) in the same tick — the
    // ✕ button visibly did nothing. Only restore what we actually hid.
    const wasOpen = this.hasEndpointPickerTarget && !this.endpointPickerTarget.hidden
    if (!wasOpen && !this._mapLayer) return
    if (this.hasEndpointPickerTarget) this.endpointPickerTarget.hidden = true
    if (wasOpen) this.element.style.transform = "translateY(0)" // restore the sheet
    if (this._mapLayer) { this._mapLayer.style.zIndex = this._mapLayerZ || ""; this._mapLayer = null }
  }

  swapEnds() {
    try { window.dawarichDirections?.swapEndpoints() } catch (_) { /* noop */ }
    if (this.hasStartLabelTarget && this.hasEndLabelTarget) {
      const a = this.startLabelTarget.textContent
      this.startLabelTarget.textContent = this.endLabelTarget.textContent
      this.endLabelTarget.textContent = a
    }
  }

  endpointSearch() {
    clearTimeout(this._epDebounce)
    const q = this.endpointInputTarget.value.trim()
    if (q.length < 2) return
    this._epDebounce = setTimeout(async () => {
      const [saved, geo] = await Promise.all([this._epSaved(q), this._epGeo(q)])
      const list = [...saved, ...geo].slice(0, 8)
      this._epList = list
      this.endpointResultsTarget.innerHTML = list.map((s, i) => `
        <li><button type="button" data-idx="${i}">
          <span class="ep-res-dot">${s.saved ? (s.icon || "⭐") : this.glyph(s.type)}</span>
          <span class="ep-res-txt">
            <span class="ep-res-name">${this.esc(s.name)}</span>
            ${s.address ? `<span class="ep-res-sub">${this.esc(s.address)}</span>` : ""}
          </span></button></li>`).join("")
      this.endpointResultsTarget.querySelectorAll("button[data-idx]").forEach((el) =>
        el.addEventListener("click", () => this.pickEndpoint(this._epList[Number(el.dataset.idx)])))
    }, 200)
  }

  endpointKeydown(e) {
    if (e.key === "Escape") this.closeEndpointPicker()
    if (e.key === "Enter" && this._epList?.length) { e.preventDefault(); this.pickEndpoint(this._epList[0]) }
  }

  pickEndpoint(loc) {
    if (!loc) return
    const d = window.dawarichDirections
    // Labels + waypoint rows re-render from the manager's "directions:stops" emit.
    try {
      if (this._editing === "start") d?.setStart(loc.lat, loc.lon, loc.name)
      else if (this._editing === "end") d?.setEnd(loc.lat, loc.lon, loc.name)
      else if (this._editing === "new") d?.addStop(loc.lat, loc.lon, loc.name)
      else if (typeof this._editing === "number") d?.setStop(this._editing, loc.lat, loc.lon, loc.name)
    } catch (_) { /* noop */ }
    this.closeEndpointPicker()
  }

  async _epSaved(q) {
    try {
      const r = await fetch(`/api/v1/places?q=${encodeURIComponent(q)}&api_key=${encodeURIComponent(this.apiKeyValue)}`)
      if (!r.ok) return []
      return (await r.json()).filter((p) => p.latitude != null).map((p) => ({
        name: p.name, address: p.tags?.[0]?.name || p.note || "Saved", lat: p.latitude, lon: p.longitude,
        icon: p.icon || p.tags?.[0]?.icon, saved: true,
      }))
    } catch (_) { return [] }
  }

  async _epGeo(q) {
    try {
      const r = await fetch(`/api/v1/locations/suggestions?q=${encodeURIComponent(q)}&api_key=${encodeURIComponent(this.apiKeyValue)}`)
      if (!r.ok) return []
      return (await r.json()).suggestions?.map((s) => ({
        name: s.name, address: s.address || "", lat: s.coordinates?.[0], lon: s.coordinates?.[1],
        type: s.type || s.osm_value || "",
      })).filter((s) => s.lat != null) || []
    } catch (_) { return [] }
  }

  // Preview → live 3D navigation.
  startNav() {
    this.element.style.height = "62vh"
    try { window.dawarichDirections?.startNav() } catch (_) { /* noop */ }
  }

  // End navigation → back to the route preview.
  endNav() {
    this.element.style.height = "48vh"
    try { window.dawarichDirections?.stopNav() } catch (_) { /* noop */ }
  }

  toggle2D() {
    try { window.dawarichDirections?.toggleDimension() } catch (_) { /* noop */ }
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
    const trip = document.getElementById("directions-trip")
    if (trip) trip.style.display = "none"
    this.closeEndpointPicker()
    document.body.classList.remove("routing-active")
    this.showBackdrop() // back to the place-info view (backdrop is inert now)
    this.syncPad() // re-take the camera padding in info mode
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

  // Share chooser: coordinates / clean link / OSM link. First tap opens a
  // small inline row of options; each option hands its payload to the native
  // share sheet (or clipboard fallback).
  // Share is ONE tap: shares the current mode's payload (default: clean map
  // link). ▾ opens the chips; picking one becomes the sticky mode, updates the
  // Share button icon, shares immediately, and collapses the row.
  share() {
    if (!this.place) return
    this._shareText(this._payload(this._shareMode || "link"))
  }

  shareOptions() {
    const host = this.element.querySelector("[data-share-options]")
    if (host) host.style.display = host.style.display === "none" ? "flex" : "none"
  }

  // Tap the "cafe · 53.24665, 10.40620" meta line -> coordinates to clipboard.
  async copyCoords() {
    if (!this.place || !this.hasMetaTarget) return
    const coords = `${(+this.place.lat).toFixed(5)}, ${(+this.place.lon).toFixed(5)}`
    try {
      await navigator.clipboard.writeText(coords)
      const prev = this.metaTarget.textContent
      this.metaTarget.textContent = "coordinates copied ✓"
      setTimeout(() => { this.metaTarget.textContent = prev }, 1200)
    } catch (_) { /* clipboard unavailable */ }
  }

  shareCoords() { this._pickShareMode("coords", "📍") }
  shareLink()   { this._pickShareMode("link", "🔗") }
  shareOsm()    { this._pickShareMode("osm", "🌍") }

  _pickShareMode(mode, emoji) {
    this._shareMode = mode
    const em = this.element.querySelector("[data-share-emoji]")
    if (em) em.textContent = emoji
    const host = this.element.querySelector("[data-share-options]")
    if (host) host.style.display = "none"
    this._shareText(this._payload(mode))
  }

  _payload(mode) {
    if (mode === "coords") return `${(+this.place.lat).toFixed(5)}, ${(+this.place.lon).toFixed(5)}`
    if (mode === "osm") return `https://www.openstreetmap.org/?mlat=${this.place.lat}&mlon=${this.place.lon}#map=17/${this.place.lat}/${this.place.lon}`
    return this._mapLink()
  }

  _mapLink() {
    const name = encodeURIComponent(this.place.name || "")
    return `${location.origin}/map?p=${this.place.lon},${this.place.lat}${name ? `&pname=${name}` : ""}`
  }

  async _shareText(text) {
    try {
      if (navigator.share) {
        await navigator.share({ text })  // no title: payloads stay clean
      } else {
        await navigator.clipboard.writeText(text)
        const btn = this.element.querySelector("[data-share-label]")
        if (btn) btn.textContent = "Copied ✓"
      }
    } catch (e) { /* user cancelled */ }
  }
}
