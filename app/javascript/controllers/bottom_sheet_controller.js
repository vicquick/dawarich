import { Controller } from "@hotwired/stimulus"
import { attachSheetDrag } from "maps_maplibre/utils/sheet_drag"

// Shared mobile bottom-sheet behaviour (vicquick fork).
//
// Attached to overlays that, on desktop, are side panels but on phones should
// behave like the place sheet: a draggable card pinned to the bottom that
// leaves the map visible AND interactive above it — never a full-screen wall.
//
// Responsibilities (mobile only — completely inert on desktop):
//   1. Register the sheet's footprint with window.dawarichMapPadding while it
//      is open, so the camera keeps its subject in the visible map area.
//   2. Drag the handle to resize between detents (peek / half / full); tap to
//      toggle. Mirrors place_sheet_controller's drag for a consistent feel.
//
// The host element keeps its own open/close logic (an `open` /
// `place-drawer--open` class toggled elsewhere); we only observe it.
export default class extends Controller {
  static targets = ["handle"]

  connect() {
    this.mq = window.matchMedia("(max-width: 768px)")
    this.id = this.element.id || `bottom-sheet-${Math.random().toString(36).slice(2, 8)}`
    this._onResize = () => this.refresh()
    window.addEventListener("resize", this._onResize)

    // Observe the open/close class toggled by the host controller.
    this.observer = new MutationObserver(() => this.refresh())
    this.observer.observe(this.element, { attributes: true, attributeFilter: ["class"] })

    if (this.hasHandleTarget) this.setupDrag()
    this.refresh()
  }

  disconnect() {
    window.removeEventListener("resize", this._onResize)
    this.observer?.disconnect()
    this._detachDrag?.()
    this.clearPad()
  }

  isMobile() { return this.mq.matches }

  isOpen() {
    return this.element.classList.contains("open") ||
      this.element.classList.contains("place-drawer--open")
  }

  // Sync padding + clamp the sheet height to the mobile detent range.
  refresh() {
    if (this.isMobile() && this.isOpen()) {
      this.syncPad()
    } else {
      this.clearPad()
      // On desktop, drop any inline height left over from a drag so the
      // side-panel layout (CSS-driven) takes over cleanly.
      if (!this.isMobile()) this.element.style.height = ""
    }
  }

  syncPad() {
    try { window.dawarichMapPadding?.set(this.id, "bottom", this.element.offsetHeight) } catch (_) { /* noop */ }
  }

  clearPad() {
    try { window.dawarichMapPadding?.clear(this.id) } catch (_) { /* noop */ }
  }

  maxSheetPx() {
    const nav = document.querySelector(".navbar") || document.querySelector("header") || document.querySelector("nav")
    const navBottom = nav ? nav.getBoundingClientRect().bottom : 0
    return window.innerHeight - Math.max(navBottom + 12, 64)
  }

  setupDrag() {
    const vh = () => window.innerHeight
    this._detachDrag = attachSheetDrag(this.element, this.handleTarget, {
      enabled: () => this.isMobile(),
      detents: () => [vh() * 0.42, vh() * 0.62, this.maxSheetPx()],
      onHeight: () => this.syncPad(),
      // A firm flick down (or dropping the sheet below the lowest detent)
      // closes it — the drag bar doubles as the dismiss control. Route the
      // dismissal through the host's own close button so its cleanup (class
      // toggles, map padding, `map-panel:closed` event) all still runs.
      onDismiss: () => {
        // Close while still collapsed (height 0), then restore the natural
        // height once the slide-out transform has finished — avoids a flash
        // of the full sheet re-appearing mid-exit.
        const close = this.element.querySelector(
          "[data-sheet-close], .panel-header button, .place-drawer__close",
        )
        if (close) close.click()
        else this.element.classList.remove("open", "place-drawer--open")
        this.clearPad()
        setTimeout(() => { this.element.style.height = "" }, 320)
      },
    })
  }
}
