// Panoramax Street View (vicquick fork).
//
// A fully free / open-source Street-View — no API key, no self-hosting, no
// backend. We consume the federated Panoramax API (api.panoramax.xyz):
//   • MapLibre vector tiles show where imagery exists (blue "streets").
//   • Tapping a covered spot opens a fullscreen 360° viewer (Photo Sphere
//     Viewer, lazy-loaded from a CDN), oriented to the shot's heading.
//   • Prev/next arrows walk the capture sequence, just like Google.
// CORS is open on the API + image storage, so it all runs client-side.
const API = "https://api.panoramax.xyz/api"
const TILES = `${API}/map/{z}/{x}/{y}.mvt`
const SRC = "panoramax"
const PSV_JS = "https://esm.sh/@photo-sphere-viewer/core@5"
const PSV_CSS = "https://cdn.jsdelivr.net/npm/@photo-sphere-viewer/core@5/index.min.css"
const BLUE = "#1a73e8"

// Bundler-agnostic runtime import (keeps esbuild/importmap from touching the URL).
const importURL = new Function("u", "return import(u)")

export class StreetView {
  constructor(controller) {
    this.controller = controller
    this.on = false
    this._boundClick = (e) => this.onMapClick(e)
    this._boundEnter = () => { if (this.map) this.map.getCanvas().style.cursor = "pointer" }
    this._boundLeave = () => { if (this.map && this.on) this.map.getCanvas().style.cursor = "crosshair" }
  }

  get map() { return this.controller.map }
  isOn() { return this.on }

  toggle() { this.on ? this.disable() : this.enable(); return this.on }

  enable() {
    const map = this.map
    if (!map || this.on) return
    this.on = true
    if (!map.getSource(SRC)) {
      map.addSource(SRC, {
        type: "vector", tiles: [TILES], minzoom: 0, maxzoom: 15,
        attribution: '<a href="https://panoramax.xyz" target="_blank" rel="noopener">Panoramax</a>',
      })
    }
    this._addLayers()
    map.on("click", this._boundClick)
    map.on("mouseenter", "pnx-pic", this._boundEnter)
    map.on("mouseleave", "pnx-pic", this._boundLeave)
    map.getCanvas().style.cursor = "crosshair"
    this._toast("Tap a blue street to look around")
  }

  disable() {
    const map = this.map
    this.on = false
    if (!map) return
    for (const id of ["pnx-pic", "pnx-seq", "pnx-grid"]) if (map.getLayer(id)) map.removeLayer(id)
    if (map.getSource(SRC)) map.removeSource(SRC)
    map.off("click", this._boundClick)
    map.off("mouseenter", "pnx-pic", this._boundEnter)
    map.off("mouseleave", "pnx-pic", this._boundLeave)
    map.getCanvas().style.cursor = ""
  }

  _addLayers() {
    const map = this.map
    if (!map.getLayer("pnx-grid")) {
      map.addLayer({
        id: "pnx-grid", type: "circle", source: SRC, "source-layer": "geovisio_grid", maxzoom: 7,
        paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 2, 2, 6, 7], "circle-color": BLUE, "circle-opacity": 0.35, "circle-blur": 0.4 },
      })
    }
    if (!map.getLayer("pnx-seq")) {
      map.addLayer({
        id: "pnx-seq", type: "line", source: SRC, "source-layer": "geovisio_sequences", minzoom: 7,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": BLUE, "line-width": ["interpolate", ["linear"], ["zoom"], 10, 2, 16, 5], "line-opacity": 0.9 },
      })
    }
    if (!map.getLayer("pnx-pic")) {
      map.addLayer({
        id: "pnx-pic", type: "circle", source: SRC, "source-layer": "geovisio_pictures", minzoom: 14,
        paint: { "circle-radius": 4.5, "circle-color": "#fff", "circle-stroke-color": BLUE, "circle-stroke-width": 2.5 },
      })
    }
  }

  async onMapClick(e) {
    const { lng, lat } = e.lngLat
    this._toast("Loading view…", 900)
    const item = await this._nearest(lng, lat)
    if (!item) return this._toast("No imagery right here — try a blue street")
    this.openViewer(item)
  }

  // Public: open the nearest pano to a coordinate (used by the place sheet too).
  async openAt(lng, lat) {
    await this._ensurePsv()
    const item = await this._nearest(lng, lat)
    if (!item) { this._toast("No Street View here"); return false }
    this.openViewer(item)
    return true
  }

  async _nearest(lng, lat) {
    const d = 0.0006 // ~50 m box around the tap
    const bbox = `${lng - d},${lat - d},${lng + d},${lat + d}`
    try {
      const r = await fetch(`${API}/search?bbox=${bbox}&limit=40`)
      if (!r.ok) return null
      const feats = (await r.json()).features || []
      if (!feats.length) return null
      feats.sort((a, b) => this._d2(a, lng, lat) - this._d2(b, lng, lat))
      return feats[0]
    } catch (_) { return null }
  }
  _d2(f, lng, lat) { const c = f.geometry?.coordinates || [0, 0]; return (c[0] - lng) ** 2 + (c[1] - lat) ** 2 }

  async _ensurePsv() {
    if (this._PSV) return
    if (!document.getElementById("pnx-psv-css")) {
      const l = document.createElement("link")
      l.id = "pnx-psv-css"; l.rel = "stylesheet"; l.href = PSV_CSS
      document.head.appendChild(l)
    }
    this._PSV = await importURL(PSV_JS)
  }

  async openViewer(item) {
    await this._ensurePsv()
    this._current = item
    if (!this._overlay) this._buildOverlay()
    this._overlay.style.display = "block"
    requestAnimationFrame(() => this._overlay.classList.add("pnx--in"))
    const url = item.assets?.hd?.href || item.assets?.sd?.href
    const yaw = ((item.properties?.["view:azimuth"] || 0) * Math.PI) / 180
    if (!this._viewer) {
      this._viewer = new this._PSV.Viewer({
        container: this._canvas, panorama: url, defaultYaw: yaw,
        navbar: false, mousewheel: true, touchmoveTwoFingers: false,
        defaultZoomLvl: 0, loadingTxt: "",
      })
    } else {
      this._viewer.setPanorama(url, { transition: 200 }).then(() => this._viewer.rotate({ yaw })).catch(() => {})
    }
    this._updateMeta(item)
  }

  _updateMeta(item) {
    const dt = (item.properties?.datetime || "").slice(0, 10)
    if (this._date) this._date.textContent = dt || ""
    const has = (rel) => (item.links || []).some((l) => l.rel === rel)
    this._prev.style.visibility = has("prev") ? "visible" : "hidden"
    this._next.style.visibility = has("next") ? "visible" : "hidden"
  }

  async _nav(rel) {
    const link = (this._current?.links || []).find((l) => l.rel === rel)
    if (!link?.href) return
    try {
      const r = await fetch(link.href)
      if (!r.ok) return
      this.openViewer(await r.json())
    } catch (_) { /* noop */ }
  }

  close() {
    if (!this._overlay) return
    this._overlay.classList.remove("pnx--in")
    setTimeout(() => {
      if (this._overlay) this._overlay.style.display = "none"
      try { this._viewer?.destroy() } catch (_) { /* noop */ }
      this._viewer = null
    }, 200)
  }

  _buildOverlay() {
    this._injectStyle()
    const o = document.createElement("div")
    o.className = "pnx-overlay"
    o.innerHTML = `
      <div class="pnx-canvas"></div>
      <div class="pnx-top">
        <button class="pnx-btn pnx-close" aria-label="Close Street View">✕</button>
        <div class="pnx-meta"><span class="pnx-dot"></span><span class="pnx-date"></span>
          <a href="https://panoramax.xyz" target="_blank" rel="noopener" class="pnx-credit">© Panoramax</a></div>
      </div>
      <button class="pnx-arrow pnx-prev" aria-label="Previous">‹</button>
      <button class="pnx-arrow pnx-next" aria-label="Next">›</button>`
    document.body.appendChild(o)
    this._overlay = o
    this._canvas = o.querySelector(".pnx-canvas")
    this._date = o.querySelector(".pnx-date")
    this._prev = o.querySelector(".pnx-prev")
    this._next = o.querySelector(".pnx-next")
    o.querySelector(".pnx-close").addEventListener("click", () => this.close())
    this._prev.addEventListener("click", () => this._nav("prev"))
    this._next.addEventListener("click", () => this._nav("next"))
    document.addEventListener("keydown", (e) => {
      if (this._overlay?.style.display !== "block") return
      if (e.key === "Escape") this.close()
      else if (e.key === "ArrowLeft") this._nav("prev")
      else if (e.key === "ArrowRight") this._nav("next")
    })
  }

  _injectStyle() {
    if (document.getElementById("pnx-style")) return
    const s = document.createElement("style")
    s.id = "pnx-style"
    s.textContent = `
      .pnx-overlay{position:fixed;inset:0;z-index:2000;background:#0b0b0d;display:none;
        opacity:0;transition:opacity .22s ease}
      .pnx-overlay.pnx--in{opacity:1}
      .pnx-canvas{position:absolute;inset:0}
      .pnx-top{position:absolute;top:0;left:0;right:0;display:flex;align-items:center;gap:12px;
        padding:calc(env(safe-area-inset-top) + 12px) 16px 28px;
        background:linear-gradient(to bottom,rgba(0,0,0,.55),transparent);z-index:2;pointer-events:none}
      .pnx-top>*{pointer-events:auto}
      .pnx-btn,.pnx-arrow{border:0;cursor:pointer;color:#fff;background:rgba(20,20,22,.55);
        backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)}
      .pnx-close{width:40px;height:40px;border-radius:50%;font-size:1rem;line-height:1;flex:0 0 auto}
      .pnx-close:hover{background:rgba(40,40,44,.7)}
      .pnx-meta{display:flex;align-items:center;gap:8px;color:#fff;font-size:.82rem;
        background:rgba(20,20,22,.5);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);
        padding:7px 12px;border-radius:999px}
      .pnx-dot{width:7px;height:7px;border-radius:50%;background:${BLUE};flex:0 0 auto}
      .pnx-date{font-weight:600;font-variant-numeric:tabular-nums}
      .pnx-credit{color:rgba(255,255,255,.6);text-decoration:none;font-size:.72rem;margin-left:2px}
      .pnx-credit:hover{color:#fff}
      .pnx-arrow{position:absolute;top:50%;transform:translateY(-50%);width:52px;height:52px;
        border-radius:50%;font-size:1.8rem;line-height:1;display:flex;align-items:center;justify-content:center;z-index:2}
      .pnx-arrow:hover{background:rgba(40,40,44,.75)}
      .pnx-arrow:active{transform:translateY(-50%) scale(.92)}
      .pnx-prev{left:14px}.pnx-next{right:14px}
      @media (max-width:768px){.pnx-arrow{width:46px;height:46px;font-size:1.5rem}}`
    document.head.appendChild(s)
  }

  _toast(msg, ms = 2200) {
    let t = document.getElementById("pnx-toast")
    if (!t) {
      t = document.createElement("div"); t.id = "pnx-toast"
      t.style.cssText = "position:fixed;left:50%;bottom:calc(env(safe-area-inset-bottom) + 92px);transform:translateX(-50%);z-index:1600;background:rgba(20,20,22,.9);color:#fff;padding:9px 15px;border-radius:999px;font-size:.85rem;font-weight:500;box-shadow:0 3px 14px rgba(0,0,0,.4);opacity:0;transition:opacity .18s ease;pointer-events:none;max-width:90vw;text-align:center"
      document.body.appendChild(t)
    }
    t.textContent = msg
    t.style.opacity = "1"
    clearTimeout(this._toastT)
    this._toastT = setTimeout(() => { t.style.opacity = "0" }, ms)
  }
}
