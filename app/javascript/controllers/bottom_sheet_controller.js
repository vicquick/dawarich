import { Controller } from "@hotwired/stimulus"

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
    if (this._move) window.removeEventListener("pointermove", this._move)
    if (this._up) window.removeEventListener("pointerup", this._up)
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
    let startY = 0, startH = 0, dragging = false, moved = false

    const down = (e) => {
      if (!this.isMobile()) return
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
      this.syncPad()
    }
    const up = () => {
      if (!dragging) return
      dragging = false
      this.element.style.transition = ""
      if (!moved) {
        // tap toggles between peek and full
        const full = this.element.offsetHeight > vh() * 0.55
        this.element.style.height = `${full ? vh() * 0.42 : this.maxSheetPx()}px`
      } else {
        const stops = [vh() * 0.42, vh() * 0.62, this.maxSheetPx()]
        const cur = this.element.offsetHeight
        this.element.style.height = `${stops.reduce((a, b) => (Math.abs(b - cur) < Math.abs(a - cur) ? b : a))}px`
      }
      this.syncPad()
    }

    this._move = move
    this._up = up
    this.handleTarget.addEventListener("pointerdown", down)
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
  }
}
