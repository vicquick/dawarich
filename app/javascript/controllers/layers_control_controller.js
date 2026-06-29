import { Controller } from "@hotwired/stimulus"

// Google-Maps-style Layers control (vicquick fork).
// A bottom-right button opens a card: pick a base map (Light / Dark / Public
// Transport / Topographic / Aerial) and toggle overlays (Traffic incidents).
// The active base is ringed; overlays light up. Choice persists. The actual
// basemap swap + incident layer are driven through window hooks exposed by the
// maplibre controller, so this stays a thin, self-contained UI.
export default class extends Controller {
  static targets = ["panel", "button", "chip", "trafficToggle"]

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
    let saved = null
    try { saved = localStorage.getItem("dawarichBasemap") } catch (_) { /* noop */ }
    if (saved === "light") saved = "white"
    if (saved) return saved
    const dark = document.documentElement.getAttribute("data-theme") === "dark" ||
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
  }

  toggleTraffic(e) {
    e?.stopPropagation()
    try { window.dawarichTraffic?.toggle?.() } catch (_) { /* noop */ }
    // state flips synchronously in the controller; reflect it
    this.syncActive()
  }
}
