import { Controller } from "@hotwired/stimulus"
import maplibregl from "maplibre-gl"

// Live German road-incidents layer (vicquick fork) — NAPSPAN events (closures,
// roadworks, restrictions). Toggle on → fetch incidents for the viewport and
// refresh as the map moves. Self-contained; never blocks the core map.
export default class extends Controller {
  static targets = ["btn"]
  static values = { apiKey: String }

  connect() {
    this.on = false
    this._moveHandler = null
    this._t = null
  }

  get map() { return window.dawarichMap }

  toggle() {
    this.on = !this.on
    this.btnTarget.setAttribute("aria-pressed", this.on ? "true" : "false")
    this.on ? this.enable() : this.disable()
  }

  enable() {
    if (!this.map) return
    this.fetchAndRender()
    this._moveHandler = () => { clearTimeout(this._t); this._t = setTimeout(() => this.fetchAndRender(), 500) }
    this.map.on("moveend", this._moveHandler)
  }

  disable() {
    if (this._moveHandler && this.map) this.map.off("moveend", this._moveHandler)
    this._moveHandler = null
    try {
      this._popup?.remove()
      if (this.map?.getLayer("napspan-incidents")) this.map.removeLayer("napspan-incidents")
      if (this.map?.getSource("napspan-incidents")) this.map.removeSource("napspan-incidents")
    } catch (e) { /* noop */ }
  }

  async fetchAndRender() {
    if (!this.map) return
    const b = this.map.getBounds()
    const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((n) => n.toFixed(4)).join(",")
    try {
      const r = await fetch(`/api/v1/traffic/incidents?bbox=${bbox}&api_key=${encodeURIComponent(this.apiKeyValue)}`)
      if (!r.ok) return
      this.render(await r.json())
    } catch (e) { /* best-effort */ }
  }

  render(fc) {
    if (!this.map) return
    const src = this.map.getSource("napspan-incidents")
    if (src) { src.setData(fc); this.flash(fc); return }
    this.map.addSource("napspan-incidents", { type: "geojson", data: fc })
    this.map.addLayer({
      id: "napspan-incidents",
      type: "circle",
      source: "napspan-incidents",
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 7, 4, 14, 7.5],
        "circle-color": ["match", ["get", "severity"],
          "severe", "#c62828", "major", "#ea4335", "moderate", "#f59e0b", "minor", "#fbbf24", "#9aa0a6"],
        "circle-stroke-color": "oklch(var(--b1))",
        "circle-stroke-width": 1.6,
        "circle-opacity": 0.92,
      },
    })
    this.map.on("click", "napspan-incidents", (e) => this.popup(e))
    this.map.on("mouseenter", "napspan-incidents", () => { this.map.getCanvas().style.cursor = "pointer" })
    this.map.on("mouseleave", "napspan-incidents", () => { this.map.getCanvas().style.cursor = "" })
    this.flash(fc)
  }

  flash(fc) {
    const n = fc?.features?.length || 0
    if (!this.hasBtnTarget) return
    this.btnTarget.dataset.count = n
    this.btnTarget.title = n ? `${n} road incidents nearby` : "No incidents nearby"
  }

  popup(e) {
    const p = e.features?.[0]?.properties
    if (!p) return
    const sev = p.severity ? `<span style="color:#ea4335;font-weight:600;text-transform:capitalize">${this.esc(p.severity)}</span> · ` : ""
    const html = `<div style="font:inherit;max-width:230px">
      <div style="font-weight:700;text-transform:capitalize">${this.esc(p.sub_type || p.type || "Incident")}</div>
      ${p.road ? `<div style="font-size:.8rem;opacity:.7">${this.esc(p.road)}</div>` : ""}
      <div style="font-size:.82rem;margin-top:4px">${sev}${this.esc(p.title || p.description || "")}</div></div>`
    this._popup?.remove()
    this._popup = new maplibregl.Popup({ offset: 12, closeButton: true, maxWidth: "260px" })
      .setLngLat(e.lngLat).setHTML(html).addTo(this.map)
  }

  esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))
  }

  disconnect() { this.disable() }
}
