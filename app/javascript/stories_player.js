// Public story player (vicquick fork) — the cinematic trip animation.
//
// Standalone importmap entry: imports MapLibre + the app's style builder and
// nothing else (no Stimulus, no app bundle). One requestAnimationFrame clock
// drives everything — camera, line draw-on, photo pops, elevation cursor,
// stat counters and the soundtrack — all keyed off ONE downsampled point
// array shipped in the page bundle, so nothing can drift out of sync.
//
// The owner's builder drawer edits `config`; every knob lands here:
//   theme        midnight | paper | satellite
//   accent       hex colour for line/UI
//   camera       follow | drone | overview
//   duration     seconds (or "auto")
//   line_style   solid | glow
//   photo_size   small | large   + show_photos on/off
//   show_elevation on/off
import maplibregl from "maplibre-gl"
import { getMapStyle } from "maps_maplibre/utils/style_manager"

const bundle = JSON.parse(document.getElementById("story-bundle").textContent)
const cfg = bundle.config || {}
const el = (id) => document.getElementById(id)

const ACCENT = /^#[0-9a-fA-F]{6}$/.test(cfg.accent || "") ? cfg.accent : "#f97316"
document.documentElement.style.setProperty("--story-accent", ACCENT)

const AUTO_DURATION = Math.min(180, Math.max(45, bundle.points.length / 18))
const DURATION_S = Number(cfg.duration) > 0 ? Number(cfg.duration) : AUTO_DURATION
const CAMERA = ["follow", "drone", "overview"].includes(cfg.camera) ? cfg.camera : "follow"
const SHOW_PHOTOS = cfg.show_photos !== "off"
const SHOW_ELEV = cfg.show_elevation !== "off"

const state = {
  playing: false, progress: 0, speed: 1, started: false,
  raf: 0, lastTs: 0,
}

// ---------- helpers over the point array ----------
const P = bundle.points // [lon, lat, ele, t]
const D = bundle.dist_km
const N = P.length
const totalKm = D[N - 1] || 0

function idxAt(progress) { return Math.min(N - 1, Math.floor(progress * (N - 1))) }
function lerp(a, b, t) { return a + (b - a) * t }
function posAt(progress) {
  const f = progress * (N - 1)
  const i = Math.min(N - 2, Math.floor(f))
  const t = f - i
  return [lerp(P[i][0], P[i + 1][0], t), lerp(P[i][1], P[i + 1][1], t)]
}
function bearingBetween(a, b) {
  const toRad = Math.PI / 180
  const y = Math.sin((b[0] - a[0]) * toRad) * Math.cos(b[1] * toRad)
  const x = Math.cos(a[1] * toRad) * Math.sin(b[1] * toRad) -
    Math.sin(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.cos((b[0] - a[0]) * toRad)
  return (Math.atan2(y, x) / toRad + 360) % 360
}

// ---------- map style per theme ----------
async function themeStyle() {
  if (cfg.theme === "satellite") {
    return {
      version: 8,
      sources: {
        esri: {
          type: "raster", tileSize: 256, maxzoom: 19,
          tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
          attribution: "© Esri",
        },
      },
      layers: [{ id: "esri", type: "raster", source: "esri" }],
    }
  }
  if (cfg.theme === "paper") return getMapStyle("white", {})
  return getMapStyle("dark", {})
}

const bounds = P.reduce(
  (b, p) => [[Math.min(b[0][0], p[0]), Math.min(b[0][1], p[1])], [Math.max(b[1][0], p[0]), Math.max(b[1][1], p[1])]],
  [[Infinity, Infinity], [-Infinity, -Infinity]],
)

const map = new maplibregl.Map({
  container: "story-map",
  style: await themeStyle(),
  bounds,
  fitBoundsOptions: { padding: 80 },
  attributionControl: { compact: true },
})
await new Promise((resolve) => map.once("load", resolve))

const line = {
  type: "Feature",
  geometry: { type: "LineString", coordinates: P.map((p) => [p[0], p[1]]) },
}
map.addSource("story-line", { type: "geojson", data: line, lineMetrics: true })
map.addLayer({
  id: "story-line-dim", type: "line", source: "story-line",
  layout: { "line-cap": "round", "line-join": "round" },
  paint: {
    "line-color": cfg.theme === "satellite" ? "#ffffff" : "#94a3b8",
    "line-width": 3, "line-opacity": 0.35,
  },
})
if (cfg.line_style === "glow") {
  map.addLayer({
    id: "story-line-glow", type: "line", source: "story-line",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-width": ["interpolate", ["linear"], ["zoom"], 8, 12, 14, 18],
      "line-blur": 10, "line-gradient": gradientAt(0, 0.5),
    },
  })
}
map.addLayer({
  id: "story-line-live", type: "line", source: "story-line",
  layout: { "line-cap": "round", "line-join": "round" },
  paint: {
    "line-width": ["interpolate", ["linear"], ["zoom"], 8, 4, 14, 6],
    "line-gradient": gradientAt(0),
  },
})

function hexToRgba(hex, a) {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`
}
function gradientAt(prog, alpha = 1) {
  const t = Math.max(0.0001, Math.min(0.9999, prog))
  return ["step", ["line-progress"], alpha === 1 ? ACCENT : hexToRgba(ACCENT, alpha), t, "rgba(0,0,0,0)"]
}

// Start / finish flags
function flag(iconText, coords, cls) {
  const d = document.createElement("div")
  d.className = `story-flag ${cls}`
  d.textContent = iconText
  new maplibregl.Marker({ element: d, anchor: "bottom" }).setLngLat(coords).addTo(map)
}
flag("🚩", [P[0][0], P[0][1]], "story-flag--start")
flag("🏁", [P[N - 1][0], P[N - 1][1]], "story-flag--end")

const puckEl = document.createElement("div")
puckEl.className = "story-puck"
const puck = new maplibregl.Marker({ element: puckEl }).setLngLat([P[0][0], P[0][1]]).addTo(map)

// ---------- photos ----------
const photoMarkers = []
if (SHOW_PHOTOS) {
  for (const ph of bundle.photos) {
    const w = document.createElement("div")
    w.className = `story-photo${cfg.photo_size === "large" ? " story-photo--lg" : ""}`
    w.innerHTML = `<img loading="lazy" src="${ph.url}" alt="">${ph.type === "VIDEO" ? '<span class="story-photo__play">▶</span>' : ""}`
    w.addEventListener("click", () => openLightbox(ph.url))
    const m = new maplibregl.Marker({ element: w, anchor: "bottom" })
      .setLngLat([P[ph.idx][0], P[ph.idx][1]])
    photoMarkers.push({ ph, marker: m, added: false })
  }
}
function openLightbox(url) {
  el("story-lightbox").innerHTML = `<img src="${url}" alt="">`
  el("story-lightbox").classList.add("open")
}
el("story-lightbox").addEventListener("click", () => el("story-lightbox").classList.remove("open"))

// ---------- elevation canvas ----------
const canvas = el("story-elev")
if (!SHOW_ELEV) canvas.style.display = "none"
const ctx = canvas.getContext("2d")
function drawElevation(prog) {
  if (!SHOW_ELEV) return
  const w = canvas.width = canvas.clientWidth * devicePixelRatio
  const h = canvas.height = canvas.clientHeight * devicePixelRatio
  const eles = P.map((p) => p[2])
  const min = Math.min(...eles)
  const max = Math.max(...eles, min + 10)
  ctx.clearRect(0, 0, w, h)
  const x = (i) => (D[i] / totalKm) * w
  const y = (e) => h - ((e - min) / (max - min)) * (h * 0.82) - h * 0.06
  ctx.beginPath()
  ctx.moveTo(0, h)
  for (let i = 0; i < N; i++) ctx.lineTo(x(i), y(eles[i]))
  ctx.lineTo(w, h)
  ctx.closePath()
  ctx.fillStyle = hexToRgba(ACCENT, 0.18)
  ctx.fill()
  ctx.beginPath()
  for (let i = 0; i < N; i++) i ? ctx.lineTo(x(i), y(eles[i])) : ctx.moveTo(x(i), y(eles[i]))
  ctx.strokeStyle = ACCENT
  ctx.lineWidth = 2 * devicePixelRatio
  ctx.stroke()
  const i = idxAt(prog)
  ctx.beginPath()
  ctx.moveTo(x(i), 0); ctx.lineTo(x(i), h)
  ctx.strokeStyle = "rgba(255,255,255,0.7)"
  ctx.lineWidth = devicePixelRatio
  ctx.stroke()
  ctx.beginPath()
  ctx.arc(x(i), y(eles[i]), 4 * devicePixelRatio, 0, Math.PI * 2)
  ctx.fillStyle = "#fff"
  ctx.fill()
}

// ---------- audio ----------
const audio = bundle.audio_url ? new Audio(bundle.audio_url) : null
if (audio) { audio.loop = true; audio.preload = "auto" }

// ---------- HUD ----------
function fmtClock(ts) {
  return new Date(ts * 1000).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })
}
function updateHud(prog) {
  const i = idxAt(prog)
  el("hud-dist").textContent = `${D[i].toFixed(1)} km`
  el("hud-ele").textContent = `${P[i][2]} m`
  el("hud-date").textContent = fmtClock(P[i][3])
  el("story-scrub").value = String(Math.round(prog * 1000))
}

// ---------- camera modes ----------
let camBearing = 0
function updateCamera(prog) {
  if (CAMERA === "overview") return
  const pos = posAt(prog)
  if (CAMERA === "drone") {
    camBearing = (camBearing + 0.06) % 360
    map.jumpTo({ center: pos, zoom: Math.max(map.getZoom(), 12), bearing: camBearing, pitch: 60 })
    return
  }
  const ahead = posAt(Math.min(1, prog + 0.004))
  const target = bearingBetween(pos, ahead)
  let diff = ((target - camBearing + 540) % 360) - 180
  camBearing = (camBearing + diff * 0.06 + 360) % 360
  map.jumpTo({ center: pos, zoom: Math.max(map.getZoom(), 12.8), bearing: camBearing, pitch: 48 })
}

// ---------- timeline ----------
function applyProgress(prog, { moveCamera = true } = {}) {
  state.progress = Math.max(0, Math.min(1, prog))
  map.setPaintProperty("story-line-live", "line-gradient", gradientAt(state.progress))
  if (cfg.line_style === "glow" && map.getLayer("story-line-glow")) {
    map.setPaintProperty("story-line-glow", "line-gradient", gradientAt(state.progress, 0.5))
  }
  puck.setLngLat(posAt(state.progress))
  if (moveCamera && state.playing) updateCamera(state.progress)
  for (const pm of photoMarkers) {
    const at = pm.ph.idx / (N - 1)
    if (!pm.added && at <= state.progress) {
      pm.marker.addTo(map)
      pm.added = true
      requestAnimationFrame(() => pm.marker.getElement().classList.add("pop"))
    } else if (pm.added && at > state.progress) {
      pm.marker.remove()
      pm.marker.getElement().classList.remove("pop")
      pm.added = false
    }
  }
  drawElevation(state.progress)
  updateHud(state.progress)
  if (state.progress >= 1) pause(true)
}

function tick(ts) {
  if (!state.playing) return
  const dt = state.lastTs ? (ts - state.lastTs) / 1000 : 0
  state.lastTs = ts
  applyProgress(state.progress + (dt * state.speed) / DURATION_S)
  state.raf = requestAnimationFrame(tick)
}

function play() {
  if (state.progress >= 1) applyProgress(0)
  state.playing = true
  state.lastTs = 0
  el("story-title-card").classList.add("dismissed")
  el("btn-play").classList.add("playing")
  if (!state.started) {
    state.started = true
    if (CAMERA !== "overview") {
      map.easeTo({ center: posAt(0), zoom: 13, pitch: CAMERA === "drone" ? 60 : 48, bearing: 0, duration: 2200 })
      setTimeout(() => { state.raf = requestAnimationFrame(tick) }, 2100)
    } else {
      state.raf = requestAnimationFrame(tick)
    }
  } else {
    state.raf = requestAnimationFrame(tick)
  }
  audio?.play?.().catch(() => {})
}

function pause(finished = false) {
  state.playing = false
  cancelAnimationFrame(state.raf)
  el("btn-play").classList.remove("playing")
  audio?.pause?.()
  if (finished) map.fitBounds(bounds, { padding: 80, pitch: 0, bearing: 0, duration: 2500 })
}

el("btn-play").addEventListener("click", () => (state.playing ? pause() : play()))
el("story-scrub").addEventListener("input", (e) => {
  const wasPlaying = state.playing
  state.playing = false
  cancelAnimationFrame(state.raf)
  applyProgress(Number(e.target.value) / 1000)
  if (CAMERA !== "overview") updateCamera(state.progress)
  if (wasPlaying) { state.playing = true; state.lastTs = 0; state.raf = requestAnimationFrame(tick) }
})
el("btn-speed").addEventListener("click", (e) => {
  state.speed = state.speed >= 4 ? 1 : state.speed * 2
  e.target.textContent = `${state.speed}×`
})
if (audio) {
  el("btn-mute").hidden = false
  el("btn-mute").addEventListener("click", (e) => {
    audio.muted = !audio.muted
    e.target.textContent = audio.muted ? "🔇" : "🔊"
  })
}

el("hud-total").textContent =
  `${totalKm.toFixed(0)} km · ${bundle.stats.days} days · ↑${bundle.stats.elevation_gain_m} m` +
  (SHOW_PHOTOS ? ` · ${bundle.photos.length} photos` : "")
applyProgress(0, { moveCamera: false })
window.addEventListener("resize", () => drawElevation(state.progress))
