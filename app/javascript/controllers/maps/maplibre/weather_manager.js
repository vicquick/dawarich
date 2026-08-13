import maplibregl from "maplibre-gl"

// Live rain radar with a scrubbable timeline (vicquick fork).
//
// Exposed as window.dawarichWeather by maplibre_controller; toggled from the
// Layers control. Frames come from our own /api/v1/weather/frames — the browser
// never talks to a radar CDN directly, because a tile request would hand that
// CDN the viewer's IP together with the z/x/y they asked for (i.e. exactly
// where they're looking, repeatedly, while the animation plays).
//
// Two sources, picked server-side by viewport:
//   dwd — Germany: 5-min product, -2 h of history AND +105 min of forecast
//   rv  — everywhere else: RainViewer, -2 h, observed only
const SRC = "weather-radar"
const LAYER = "weather-radar-layer"
const CLEAN_PROTO = "dwdclean"
const PLAY_MS = 550

// DWD paints two non-meteorological things into its tiles: a grey wash outside
// radar coverage and a magenta range ring. Neither appears in the layer's
// legend (checked — the colour scale has no magenta class), so both are safe to
// drop. Without this the map gets a bright magenta outline around Germany.
function stripDwdFurniture(imageData) {
  const d = imageData.data
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue
    const r = d[i], g = d[i + 1], b = d[i + 2]
    // grey coverage wash
    if (Math.abs(r - 126) < 8 && Math.abs(g - 126) < 8 && Math.abs(b - 126) < 8) { d[i + 3] = 0; continue }
    // magenta range ring, including its antialiased fringe
    if (r > 200 && b > 200 && g < 90) d[i + 3] = 0
  }
  return imageData
}

let protocolRegistered = false
function registerCleanProtocol() {
  if (protocolRegistered) return
  protocolRegistered = true
  // maplibre hands us `dwdclean://<our own path>`; we fetch it, scrub the
  // furniture pixels on a canvas and hand back PNG bytes.
  maplibregl.addProtocol(CLEAN_PROTO, async (params, abortController) => {
    const url = params.url.replace(`${CLEAN_PROTO}://`, "")
    const res = await fetch(url, { signal: abortController?.signal })
    if (!res.ok) throw new Error(`radar tile ${res.status}`)
    const blob = await res.blob()
    const bmp = await createImageBitmap(blob)
    const canvas = new OffscreenCanvas(bmp.width, bmp.height)
    const ctx = canvas.getContext("2d", { willReadFrequently: true })
    ctx.drawImage(bmp, 0, 0)
    bmp.close()
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
    ctx.putImageData(stripDwdFurniture(img), 0, 0)
    const out = await canvas.convertToBlob({ type: "image/png" })
    return { data: await out.arrayBuffer() }
  })
}

export class WeatherManager {
  constructor(controller) {
    this.controller = controller
    this.map = controller.map
    this._on = false
    this._frames = []
    this._meta = null
    this._i = 0
    this._timer = null
    this._ui = null
  }

  isOn() { return this._on }

  async toggle() {
    this._on = !this._on
    if (this._on) { await this._show() } else { this._hide() }
    return this._on
  }

  async _show() {
    if (!this.map) return
    registerCleanProtocol()

    const ok = await this._loadFrames()
    if (!ok) { this._on = false; return }

    // Start on the most recent observed frame — not the end of the forecast.
    const lastObserved = this._frames.map((f) => f.forecast).lastIndexOf(false)
    this._i = lastObserved >= 0 ? lastObserved : this._frames.length - 1

    this._removeLayerSource()
    this.map.addSource(SRC, {
      type: "raster",
      tiles: [this._tileUrl(this._frames[this._i])],
      tileSize: 256,
      // Radar is coarse — cap native tiles and let MapLibre overzoom, which
      // also avoids upstream "zoom not supported" placeholder tiles.
      maxzoom: this._meta.maxzoom || 8,
      attribution: this._meta.attribution,
    })
    this.map.addLayer({
      id: LAYER, type: "raster", source: SRC,
      paint: { "raster-opacity": 0.62, "raster-fade-duration": 250 },
    }, this._firstSymbolId())

    this._buildUI()
    this._syncUI()

    // Panning between Germany and elsewhere swaps the whole product, so the
    // timeline has to be rebuilt when coverage changes.
    this._onMove = () => this._maybeResource()
    this.map.on("moveend", this._onMove)
  }

  _hide() {
    this.pause()
    if (this._onMove) { this.map?.off("moveend", this._onMove); this._onMove = null }
    this._removeLayerSource()
    this._destroyUI()
  }

  async _loadFrames() {
    const c = this.map.getCenter()
    try {
      const res = await fetch(`/api/v1/weather/frames?lat=${c.lat.toFixed(3)}&lon=${c.lng.toFixed(3)}` +
        `&api_key=${encodeURIComponent(this.controller.apiKeyValue || "")}`)
      if (!res.ok) return false
      const j = await res.json()
      if (!j.frames?.length) return false
      this._frames = j.frames
      this._meta = j
      return true
    } catch (_) {
      return false
    }
  }

  // Re-fetch only when the viewport crosses into (or out of) DWD coverage.
  async _maybeResource() {
    if (!this._on) return
    const c = this.map.getCenter()
    const inDe = c.lat > 45.7 && c.lat < 56.5 && c.lng > 3.5 && c.lng < 17.6
    const want = inDe ? "dwd" : "rv"
    if (want === this._meta?.source) return

    const wasPlaying = !!this._timer
    this.pause()
    if (!(await this._loadFrames())) return
    const lastObserved = this._frames.map((f) => f.forecast).lastIndexOf(false)
    this._i = lastObserved >= 0 ? lastObserved : this._frames.length - 1
    if (this.map.getSource(SRC)) {
      this.map.getSource(SRC).setTiles([this._tileUrl(this._frames[this._i])])
    }
    this._buildUI()
    this._syncUI()
    if (wasPlaying) this.play()
  }

  _tileUrl(frame) {
    const base = `/api/v1/weather/tile?src=${this._meta.source}&t=${encodeURIComponent(frame.t)}` +
      `&z={z}&x={x}&y={y}&api_key=${encodeURIComponent(this.controller.apiKeyValue || "")}`
    return this._meta.needs_cleanup ? `${CLEAN_PROTO}://${base}` : base
  }

  _firstSymbolId() {
    const layers = this.map.getStyle()?.layers || []
    const sym = layers.find((l) => l.type === "symbol")
    return sym ? sym.id : undefined
  }

  _removeLayerSource() {
    if (this.map?.getLayer(LAYER)) this.map.removeLayer(LAYER)
    if (this.map?.getSource(SRC)) this.map.removeSource(SRC)
  }

  // -- playback -------------------------------------------------------------

  seek(i) {
    if (!this._frames.length) return
    this._i = Math.max(0, Math.min(this._frames.length - 1, i))
    const src = this.map?.getSource(SRC)
    if (src?.setTiles) src.setTiles([this._tileUrl(this._frames[this._i])])
    this._syncUI()
  }

  play() {
    if (this._timer || this._frames.length < 2) return
    this._timer = setInterval(() => {
      const next = this._i + 1 >= this._frames.length ? 0 : this._i + 1
      this.seek(next)
    }, PLAY_MS)
    this._ui?.classList.add("wx--playing")
  }

  pause() {
    if (this._timer) { clearInterval(this._timer); this._timer = null }
    this._ui?.classList.remove("wx--playing")
  }

  togglePlay() { this._timer ? this.pause() : this.play() }

  // -- UI -------------------------------------------------------------------

  _label(frame) {
    const d = new Date(frame.at * 1000)
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  }

  _buildUI() {
    this._destroyUI()
    this._injectStyle()

    const el = document.createElement("div")
    el.className = "wx"
    // Where "now" sits on the track, so the forecast half can be shaded.
    const firstForecast = this._frames.findIndex((f) => f.forecast)
    const nowPct = firstForecast < 0 ? 100 : (firstForecast / (this._frames.length - 1)) * 100

    el.innerHTML = `
      <button type="button" class="wx__play" aria-label="Play radar animation">
        <svg class="wx__icon-play" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>
        <svg class="wx__icon-pause" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>
      </button>
      <div class="wx__track">
        <div class="wx__forecast" style="left:${nowPct}%"></div>
        <div class="wx__now" style="left:${nowPct}%"></div>
        <input class="wx__range" type="range" min="0" max="${this._frames.length - 1}" step="1"
               value="${this._i}" aria-label="Radar time">
        <div class="wx__ticks">
          <span>${this._label(this._frames[0])}</span>
          <span>${this._label(this._frames[this._frames.length - 1])}</span>
        </div>
      </div>
      <div class="wx__readout">
        <strong class="wx__time">${this._label(this._frames[this._i])}</strong>
        <span class="wx__state"></span>
      </div>`

    const container = document.getElementById("maps-maplibre-container") || document.body
    container.appendChild(el)
    this._ui = el

    el.querySelector(".wx__play").addEventListener("click", () => this.togglePlay())
    const range = el.querySelector(".wx__range")
    range.addEventListener("input", (e) => { this.pause(); this.seek(Number(e.target.value)) })
    this._range = range
  }

  _syncUI() {
    if (!this._ui || !this._frames.length) return
    const f = this._frames[this._i]
    if (this._range && Number(this._range.value) !== this._i) this._range.value = String(this._i)
    this._ui.querySelector(".wx__time").textContent = this._label(f)
    const state = this._ui.querySelector(".wx__state")
    state.textContent = f.forecast ? "forecast" : (this._i === this._frames.map((x) => x.forecast).lastIndexOf(false) ? "now" : "observed")
    this._ui.classList.toggle("wx--forecast", !!f.forecast)
  }

  _destroyUI() {
    this._ui?.remove()
    this._ui = null
    this._range = null
  }

  _injectStyle() {
    if (document.getElementById("wx-style")) return
    const s = document.createElement("style")
    s.id = "wx-style"
    s.textContent = `
      .wx {
        position: absolute; left: 50%; transform: translateX(-50%);
        bottom: 1.35rem; z-index: 5;
        display: flex; align-items: center; gap: .7rem;
        padding: .5rem .8rem .5rem .55rem;
        width: min(30rem, calc(100% - 6.5rem));
        background: var(--dw-surface, rgba(24,28,36,.92));
        color: var(--dw-text, #e8eaed);
        border-radius: 999px;
        box-shadow: 0 2px 14px rgba(0,0,0,.32);
        backdrop-filter: blur(10px);
        font: 500 .78rem/1 system-ui, sans-serif;
      }
      @media (prefers-color-scheme: light) {
        .wx { background: rgba(255,255,255,.94); color: #202124; }
      }
      .wx__play {
        flex: 0 0 auto; width: 2rem; height: 2rem; border: 0; border-radius: 50%;
        display: grid; place-items: center; cursor: pointer;
        background: #0284c7; color: #fff; transition: background .15s ease;
      }
      .wx__play:hover { background: #0369a1; }
      .wx__icon-pause { display: none; }
      .wx--playing .wx__icon-play { display: none; }
      .wx--playing .wx__icon-pause { display: block; }
      .wx__track { position: relative; flex: 1 1 auto; padding-top: .1rem; }
      .wx__range {
        -webkit-appearance: none; appearance: none;
        width: 100%; height: 4px; border-radius: 2px; margin: 0;
        background: linear-gradient(90deg, #38bdf8, #0284c7);
        cursor: pointer; position: relative; z-index: 2;
      }
      .wx__range::-webkit-slider-thumb {
        -webkit-appearance: none; width: 14px; height: 14px; border-radius: 50%;
        background: #fff; border: 2.5px solid #0284c7; cursor: grab;
        box-shadow: 0 1px 4px rgba(0,0,0,.3);
      }
      .wx__range::-moz-range-thumb {
        width: 14px; height: 14px; border-radius: 50%;
        background: #fff; border: 2.5px solid #0284c7; cursor: grab;
      }
      /* Forecast half of the track reads as "not measured yet". */
      .wx__forecast {
        position: absolute; top: .1rem; right: 0; height: 4px; border-radius: 0 2px 2px 0;
        background: repeating-linear-gradient(45deg, rgba(148,163,184,.75) 0 3px, rgba(148,163,184,.3) 3px 6px);
        z-index: 1; pointer-events: none;
      }
      .wx__now {
        position: absolute; top: -2px; width: 2px; height: 12px; border-radius: 1px;
        background: currentColor; opacity: .5; z-index: 1; pointer-events: none;
      }
      .wx__ticks {
        display: flex; justify-content: space-between;
        margin-top: .3rem; font-size: .65rem; opacity: .6;
      }
      .wx__readout { flex: 0 0 auto; text-align: right; min-width: 3.6rem; }
      .wx__time { display: block; font-size: .9rem; font-variant-numeric: tabular-nums; }
      .wx__state { font-size: .62rem; text-transform: uppercase; letter-spacing: .04em; opacity: .6; }
      .wx--forecast .wx__state { color: #38bdf8; opacity: .95; }
      @media (max-width: 480px) {
        .wx { width: calc(100% - 5rem); bottom: 4.6rem; }
      }
    `
    document.head.appendChild(s)
  }
}
