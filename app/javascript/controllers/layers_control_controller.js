import { Controller } from "@hotwired/stimulus"

// Google-Maps-style Layers control (vicquick fork).
// A bottom-right button opens a card: pick a base map (Light / Dark / Public
// Transport / Topographic / Aerial) and toggle overlays (Traffic incidents).
// The active base is ringed; overlays light up. Choice persists. The actual
// basemap swap + incident layer are driven through window hooks exposed by the
// maplibre controller, so this stays a thin, self-contained UI.
export default class extends Controller {
  static targets = ["panel", "button", "chip", "trafficToggle", "streetToggle", "immichToggle", "weatherToggle", "trailsToggle", "importsList"]

  connect() {
    this.open = false
    this._onDocClick = (e) => {
      if (!this.open) return
      if (this.element.contains(e.target)) return
      this.close()
    }
    document.addEventListener("click", this._onDocClick)
    // Reflect current state once the map/controllers are up.
    requestAnimationFrame(() => this.syncActive())
  }

  disconnect() {
    document.removeEventListener("click", this._onDocClick)
  }

  toggleOpen(e) {
    e?.stopPropagation()
    this.open ? this.close() : this.openPanel()
  }

  openPanel() {
    this.open = true
    this.panelTarget.classList.add("layers-panel--open")
    this.buttonTarget.setAttribute("aria-expanded", "true")
    this.syncActive()
  }

  close() {
    this.open = false
    this.panelTarget.classList.remove("layers-panel--open")
    this.buttonTarget.setAttribute("aria-expanded", "false")
  }

  // Which base is active right now (saved choice, else theme default).
  currentBase() {
    // The map itself is the authority — ask it first. Re-deriving this locally
    // got it wrong whenever nothing was saved: the theme check below only knew
    // the literal name "dark", but our themes are "dawarich-dark"/"dawarich-light",
    // so it fell through to "white" and highlighted Light over a dark map.
    try {
      const live = window.dawarichActiveBasemap?.()
      if (live) return live === "light" ? "white" : live
    } catch (_) { /* noop */ }

    let saved = null
    try { saved = localStorage.getItem("dawarichBasemap") } catch (_) { /* noop */ }
    if (saved === "light") saved = "white"
    // "transit" (CyclOSM) was removed — anyone still holding it in localStorage
    // would otherwise be stuck on a basemap that no longer has a chip.
    if (saved === "transit") saved = null
    if (saved) return saved
    // `includes`, not `===` — matches getCurrentTheme() in popup_theme.js, which
    // is what the map actually uses ("dawarich-dark" must count as dark).
    const dark = !!document.documentElement.getAttribute("data-theme")?.includes("dark") ||
      document.documentElement.classList.contains("dark")
    return dark ? "dark" : "white"
  }

  pickBase(e) {
    const name = e.currentTarget.dataset.basemap
    if (!name) return
    try { window.dawarichSelectBasemap?.(name) } catch (_) { /* noop */ }
    this.markActive(name)
  }

  markActive(name) {
    this.chipTargets.forEach((c) =>
      c.classList.toggle("layers-chip--active", c.dataset.basemap === name))
  }

  syncActive() {
    this.markActive(this.currentBase())
    if (this.hasTrafficToggleTarget) {
      const on = !!window.dawarichTraffic?.isOn?.()
      this.trafficToggleTarget.classList.toggle("layers-overlay--on", on)
      this.trafficToggleTarget.setAttribute("aria-pressed", on ? "true" : "false")
    }
    if (this.hasStreetToggleTarget) {
      const on = !!window.dawarichStreetView?.isOn?.()
      this.streetToggleTarget.classList.toggle("layers-overlay--on", on)
      this.streetToggleTarget.setAttribute("aria-pressed", on ? "true" : "false")
    }
    if (this.hasImmichToggleTarget) {
      const on = !!window.dawarichImmich?.isOn?.()
      this.immichToggleTarget.classList.toggle("layers-overlay--on", on)
      this.immichToggleTarget.setAttribute("aria-pressed", on ? "true" : "false")
    }
    if (this.hasWeatherToggleTarget) {
      const on = !!window.dawarichWeather?.isOn?.()
      this.weatherToggleTarget.classList.toggle("layers-overlay--on", on)
      this.weatherToggleTarget.setAttribute("aria-pressed", on ? "true" : "false")
    }
    if (this.hasTrailsToggleTarget) {
      const on = !!window.dawarichTrails?.isOn?.()
      this.trailsToggleTarget.classList.toggle("layers-overlay--on", on)
      this.trailsToggleTarget.setAttribute("aria-pressed", on ? "true" : "false")
    }
  }

  toggleTraffic(e) {
    e?.stopPropagation()
    try { window.dawarichTraffic?.toggle?.() } catch (_) { /* noop */ }
    // state flips synchronously in the controller; reflect it
    this.syncActive()
  }

  toggleStreet(e) {
    e?.stopPropagation()
    try { window.dawarichStreetView?.toggle?.() } catch (_) { /* noop */ }
    this.syncActive()
    this.close() // get out of the way so you can tap the map
  }

  // Immich photos overlay — toggle is async (lazy-loads on first enable).
  async toggleImmich(e) {
    e?.stopPropagation()
    if (!this.hasImmichToggleTarget) return
    let on = false
    try { on = !!(await window.dawarichImmich?.toggle?.()) } catch (_) { /* noop */ }
    this.immichToggleTarget.classList.toggle("layers-overlay--on", on)
    this.immichToggleTarget.setAttribute("aria-pressed", on ? "true" : "false")
  }

  // Weather radar overlay — async (fetches the latest frame on enable).
  async toggleWeather(e) {
    e?.stopPropagation()
    if (!this.hasWeatherToggleTarget) return
    let on = false
    try { on = !!(await window.dawarichWeather?.toggle?.()) } catch (_) { /* noop */ }
    this.weatherToggleTarget.classList.toggle("layers-overlay--on", on)
    this.weatherToggleTarget.setAttribute("aria-pressed", on ? "true" : "false")
  }

  // Imported files (GPX/KML/Takeout) as individual overlays — rows are built
  // lazily the first time the section is expanded.
  async loadImports(e) {
    if (!e.target.open || this._importsLoaded || !this.hasImportsListTarget) return
    this._importsLoaded = true
    const mgr = window.dawarichImportLayers
    const list = this.importsListTarget
    try {
      const imports = (await mgr.listImports()).filter((i) => i.id != null)
      if (!imports.length) {
        list.innerHTML = '<div class="layers-imports__hint">No imports yet</div>'
        return
      }
      list.innerHTML = imports.map((i) => `
        <button type="button" class="layers-imports__row${mgr.isOn(i.id) ? " layers-imports__row--on" : ""}"
                data-import-id="${i.id}" aria-pressed="${mgr.isOn(i.id)}">
          <span class="layers-imports__dot" style="background:${mgr.colorFor(i.id)}"></span>
          <span class="layers-imports__name">${this.esc(i.name || `Import ${i.id}`)}</span>
          <span class="layers-imports__switch" aria-hidden="true"></span>
        </button>`).join("")
      list.querySelectorAll(".layers-imports__row").forEach((row) =>
        row.addEventListener("click", async (ev) => {
          ev.stopPropagation()
          let on = false
          try { on = await mgr.toggle(Number(row.dataset.importId)) } catch (_) { /* noop */ }
          row.classList.toggle("layers-imports__row--on", on)
          row.setAttribute("aria-pressed", String(on))
        }))
    } catch (_) {
      this._importsLoaded = false
      list.innerHTML = '<div class="layers-imports__hint">Couldn’t load imports</div>'
    }
  }

  esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c])
  }

  // Waymarked Trails hiking overlay.
  async toggleTrails(e) {
    e?.stopPropagation()
    if (!this.hasTrailsToggleTarget) return
    let on = false
    try { on = !!(await window.dawarichTrails?.toggle?.()) } catch (_) { /* noop */ }
    this.trailsToggleTarget.classList.toggle("layers-overlay--on", on)
    this.trailsToggleTarget.setAttribute("aria-pressed", on ? "true" : "false")
  }
}
