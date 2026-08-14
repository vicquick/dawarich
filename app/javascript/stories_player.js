// Public story player v2 (vicquick fork) — the cinematic trip animation.
//
// One requestAnimationFrame clock drives everything — camera, day-coloured
// line draw-on, the pack-horse caravan, photo slideshow, day/night cycle,
// grade-coloured elevation cursor and the soundtrack — all keyed off ONE
// stitched point array from the bundle, so nothing can drift.
import maplibregl from "maplibre-gl"
import { getMapStyle } from "maps_maplibre/utils/style_manager"

const bundle = JSON.parse(document.getElementById("story-bundle").textContent)
const cfg = bundle.config || {}
const el = (id) => document.getElementById(id)

const ACCENT = /^#[0-9a-fA-F]{6}$/.test(cfg.accent || "") ? cfg.accent : "#f97316"
document.documentElement.style.setProperty("--story-accent", ACCENT)

const AUTO_DURATION = Math.min(200, Math.max(60, bundle.points.length / 14))
const DURATION_S = Number(cfg.duration) > 0 ? Number(cfg.duration) : AUTO_DURATION
const CAMERA = ["follow", "drone", "overview"].includes(cfg.camera) ? cfg.camera : "follow"
const PHOTO_MODE = ["split", "full", "off"].includes(cfg.photo_mode) ? cfg.photo_mode : "split"
const SHOW_ELEV = cfg.show_elevation !== "off"
const DAY_NIGHT = cfg.day_night !== "off"
const TZ = Number(bundle.tz_offset) || 7200

const state = { playing: false, progress: 0, speed: 1, started: false, raf: 0, lastTs: 0, photoIdx: -1 }

const P = bundle.points // [lon, lat, ele, t]
const D = bundle.dist_km
const DAYS = bundle.days || []
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
function hexToRgba(hex, a) {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`
}
function dayColorAt(i) {
  let c = DAYS[0]?.color || ACCENT
  for (const d of DAYS) { if (d.i <= i) c = d.color; else break }
  return c
}

// ---------- map ----------
async function themeStyle() {
  if (cfg.theme === "satellite") {
    return {
      version: 8,
      sources: { esri: { type: "raster", tileSize: 256, maxzoom: 19,
        tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
        attribution: "© Esri" } },
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

// In split mode the photo panel owns one side — pad every camera move so the
// caravan stays centred in the VISIBLE map, not under the panel.
function applySplitPadding() {
  if (PHOTO_MODE !== "split") return
  const portrait = window.matchMedia("(max-aspect-ratio: 1/1)").matches
  map.setPadding(portrait ? { top: Math.round(innerHeight * 0.34) } : { right: Math.round(innerWidth * 0.38) })
}
applySplitPadding()
window.addEventListener("resize", applySplitPadding)

const line = { type: "Feature", geometry: { type: "LineString", coordinates: P.map((p) => [p[0], p[1]]) } }
map.addSource("story-line", { type: "geojson", data: line, lineMetrics: true })
map.addLayer({
  id: "story-line-dim", type: "line", source: "story-line",
  layout: { "line-cap": "round", "line-join": "round" },
  paint: { "line-color": cfg.theme === "satellite" ? "#ffffff" : "#94a3b8", "line-width": 3, "line-opacity": 0.4 },
})
// White casing under the coloured line — visibility on any basemap.
map.addLayer({
  id: "story-line-casing", type: "line", source: "story-line",
  layout: { "line-cap": "round", "line-join": "round" },
  paint: {
    "line-color": "#ffffff",
    "line-width": ["interpolate", ["linear"], ["zoom"], 8, 9, 14, 13],
    "line-opacity": 0.9,
    "line-gradient": casingGradientAt(0),
  },
})
if (cfg.line_style === "glow") {
  map.addLayer({
    id: "story-line-glow", type: "line", source: "story-line",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-width": ["interpolate", ["linear"], ["zoom"], 8, 16, 14, 24],
      "line-blur": 12, "line-gradient": dayGradientAt(0, 0.5),
    },
  })
}
map.addLayer({
  id: "story-line-live", type: "line", source: "story-line",
  layout: { "line-cap": "round", "line-join": "round" },
  paint: {
    "line-width": ["interpolate", ["linear"], ["zoom"], 8, 6, 14, 9],
    "line-gradient": dayGradientAt(0),
  },
})

// Day-rainbow gradient up to the playhead, transparent beyond. Stops are the
// day boundaries — the drawn line replays the journey day by day in colour.
function dayGradientAt(prog, alpha = 1) {
  const t = Math.max(0.0002, Math.min(0.9998, prog))
  const stops = []
  let last = 0
  for (let d = 0; d < DAYS.length; d++) {
    const from = DAYS[d].i / (N - 1)
    if (from >= t) break
    if (from > last) stops.push([from, DAYS[d].color])
    else if (d === 0) stops.push([0, DAYS[0].color])
    last = from
  }
  if (!stops.length) stops.push([0, DAYS[0]?.color || ACCENT])
  const expr = ["step", ["line-progress"]]
  expr.push(alpha === 1 ? stops[0][1] : hexToRgba(stops[0][1], alpha))
  for (let k = 1; k < stops.length; k++) {
    expr.push(stops[k][0], alpha === 1 ? stops[k][1] : hexToRgba(stops[k][1], alpha))
  }
  expr.push(t, "rgba(0,0,0,0)")
  return expr
}
function casingGradientAt(prog) {
  const t = Math.max(0.0002, Math.min(0.9998, prog))
  return ["step", ["line-progress"], "rgba(255,255,255,0.9)", t, "rgba(0,0,0,0)"]
}

// ---------- flags + caravan ----------
function flag(iconText, coords, cls) {
  const d = document.createElement("div")
  d.className = `story-flag ${cls}`
  d.textContent = iconText
  new maplibregl.Marker({ element: d, anchor: "bottom" }).setLngLat(coords).addTo(map)
}
flag("🚩", [P[0][0], P[0][1]], "story-flag--start")
flag("🏁", [P[N - 1][0], P[N - 1][1]], "story-flag--end")

// Four pack horses, walking. Legs swing, bodies bob, luggage sways; the whole
// caravan flips to face the direction of travel.
const HORSE = `
<svg viewBox="0 0 64 44" width="52" height="36" class="horse">
  <g class="horse-body">
    <rect x="30" y="6" width="16" height="8" rx="3" fill="#7c4a1e" class="luggage"/>
    <rect x="33" y="3" width="10" height="5" rx="2" fill="#a16b34" class="luggage"/>
    <path d="M14 18 q2 -8 12 -8 h22 q9 0 10 8 q1 7 -5 8 l-2 0 q-6 2 -30 0 q-8 0 -7 -8" fill="#5b3a21"/>
    <path d="M13 16 q-6 -1 -8 -8 q-1 -4 3 -4 q5 0 7 5 l2 5 z" fill="#5b3a21"/>
    <path d="M8 4 l-2 -4 3 1 2 -1 z" fill="#3f2917"/>
    <path d="M56 20 q5 2 4 9" stroke="#3f2917" stroke-width="2.5" fill="none" class="tail"/>
  </g>
  <rect x="18" y="24" width="3.6" height="15" rx="1.8" fill="#4a2f1b" class="leg leg-a"/>
  <rect x="26" y="24" width="3.6" height="15" rx="1.8" fill="#3f2917" class="leg leg-b"/>
  <rect x="42" y="24" width="3.6" height="15" rx="1.8" fill="#4a2f1b" class="leg leg-b"/>
  <rect x="50" y="24" width="3.6" height="15" rx="1.8" fill="#3f2917" class="leg leg-a"/>
</svg>`
const caravanEl = document.createElement("div")
caravanEl.className = "story-caravan"
caravanEl.innerHTML = HORSE + HORSE + HORSE + HORSE
const caravan = new maplibregl.Marker({ element: caravanEl, anchor: "center" })
  .setLngLat([P[0][0], P[0][1]]).addTo(map)

function updateCaravanFacing(prog) {
  const b = bearingBetween(posAt(Math.max(0, prog - 0.002)), posAt(Math.min(1, prog + 0.002)))
  // heading west-ish → flip so the horses walk forward
  caravanEl.classList.toggle("flip", b > 180)
  caravanEl.classList.toggle("walking", state.playing)
}

// ---------- photo slideshow (split / full) ----------
const photoPanel = el("story-photos")
if (PHOTO_MODE === "off") photoPanel.remove()
else photoPanel.classList.add(`mode-${PHOTO_MODE}`)
let slideA = el("slide-a")
let slideB = el("slide-b")
function updatePhotos(prog) {
  if (PHOTO_MODE === "off" || !bundle.photos.length) return
  const i = idxAt(prog)
  // latest photo at or before the playhead
  let k = -1
  for (let j = 0; j < bundle.photos.length; j++) {
    if (bundle.photos[j].idx <= i) k = j
    else break
  }
  if (k === state.photoIdx) return
  state.photoIdx = k
  if (k < 0) { photoPanel.classList.remove("active"); return }
  photoPanel.classList.add("active")
  // crossfade: load into the hidden slide, then swap opacity
  const incoming = slideB
  incoming.src = bundle.photos[k].url
  incoming.onload = () => {
    incoming.classList.add("show")
    slideA.classList.remove("show")
    const t = slideA
    slideA = incoming
    slideB = t
  }
}

// ---------- day/night ----------
const skyEl = el("story-sky")
function updateSky(prog) {
  if (!DAY_NIGHT) return
  const t = P[idxAt(prog)][3] + TZ
  const h = (t / 3600) % 24
  // darkness 0 at 13:00, 1 at 01:00 — smooth cosine day curve
  const darkness = Math.min(1, Math.max(0, (1 - Math.cos(((h - 1 + 24) % 24) / 24 * Math.PI * 2)) / 2) * 1.25 - 0.25)
  const dusk = Math.max(0, 1 - Math.abs(h - 20.5) / 1.6) + Math.max(0, 1 - Math.abs(h - 5.5) / 1.6)
  skyEl.style.background = `linear-gradient(rgba(8,10,26,${(darkness * 0.55).toFixed(3)}), rgba(8,10,26,${(darkness * 0.35).toFixed(3)}))`
  skyEl.style.boxShadow = dusk > 0.05 ? `inset 0 0 30vmax rgba(249,115,22,${(dusk * 0.28).toFixed(3)})` : "none"
  el("story-stars").style.opacity = String(Math.max(0, darkness - 0.45) * 1.6)
}

// ---------- elevation: grade-coloured, like the map's profile ----------
const canvas = el("story-elev")
if (!SHOW_ELEV) canvas.style.display = "none"
const ctx = canvas.getContext("2d")
function gradeColor(g) {
  const a = Math.abs(g)
  if (a < 4) return "#16a34a"
  if (a < 8) return "#84cc16"
  if (a < 12) return "#f59e0b"
  return "#dc2626"
}
function drawElevation(prog) {
  if (!SHOW_ELEV) return
  const w = canvas.width = canvas.clientWidth * devicePixelRatio
  const h = canvas.height = canvas.clientHeight * devicePixelRatio
  const eles = P.map((p) => p[2])
  const min = Math.min(...eles)
  const max = Math.max(...eles, min + 10)
  ctx.clearRect(0, 0, w, h)
  const x = (i) => (D[i] / totalKm) * w
  const y = (e) => h - ((e - min) / (max - min)) * (h * 0.8) - h * 0.08
  const win = Math.max(3, Math.round(N / 220))
  // grade-coloured strokes segment by segment (Komoot-style, same as /map)
  for (let i = 0; i < N - 1; i += 1) {
    const j = Math.min(N - 1, i + win)
    const dKm = D[j] - D[i]
    const g = dKm > 0.005 ? ((eles[j] - eles[i]) / (dKm * 1000)) * 100 : 0
    ctx.beginPath()
    ctx.moveTo(x(i), y(eles[i]))
    ctx.lineTo(x(i + 1), y(eles[i + 1]))
    ctx.strokeStyle = gradeColor(g)
    ctx.lineWidth = 2.2 * devicePixelRatio
    ctx.stroke()
  }
  // soft fill under the line
  ctx.beginPath()
  ctx.moveTo(0, h)
  for (let i = 0; i < N; i++) ctx.lineTo(x(i), y(eles[i]))
  ctx.lineTo(w, h)
  ctx.closePath()
  ctx.fillStyle = "rgba(148,163,184,0.12)"
  ctx.fill()
  // cursor
  const i = idxAt(prog)
  ctx.beginPath()
  ctx.moveTo(x(i), 0); ctx.lineTo(x(i), h)
  ctx.strokeStyle = "rgba(255,255,255,0.7)"
  ctx.lineWidth = devicePixelRatio
  ctx.stroke()
  ctx.beginPath()
  ctx.arc(x(i), y(eles[i]), 4.5 * devicePixelRatio, 0, Math.PI * 2)
  ctx.fillStyle = "#fff"
  ctx.fill()
}

// ---------- audio ----------
const audio = bundle.audio_url ? new Audio(bundle.audio_url) : null
if (audio) { audio.loop = true; audio.preload = "auto" }

// ---------- HUD / camera / timeline ----------
function fmtClock(ts) {
  return new Date(ts * 1000).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })
}
function updateHud(prog) {
  const i = idxAt(prog)
  el("hud-dist").textContent = `${D[i].toFixed(1)} km`
  el("hud-ele").textContent = `${P[i][2]} m`
  el("hud-date").textContent = fmtClock(P[i][3])
  el("hud-date").style.color = dayColorAt(i)
  el("story-scrub").value = String(Math.round(prog * 1000))
}

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

function applyProgress(prog, { moveCamera = true } = {}) {
  state.progress = Math.max(0, Math.min(1, prog))
  map.setPaintProperty("story-line-live", "line-gradient", dayGradientAt(state.progress))
  map.setPaintProperty("story-line-casing", "line-gradient", casingGradientAt(state.progress))
  if (cfg.line_style === "glow" && map.getLayer("story-line-glow")) {
    map.setPaintProperty("story-line-glow", "line-gradient", dayGradientAt(state.progress, 0.5))
  }
  caravan.setLngLat(posAt(state.progress))
  updateCaravanFacing(state.progress)
  if (moveCamera && state.playing) updateCamera(state.progress)
  updatePhotos(state.progress)
  updateSky(state.progress)
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
  caravanEl.classList.add("walking")
  if (!state.started) {
    state.started = true
    if (CAMERA !== "overview") {
      map.easeTo({ center: posAt(0), zoom: 13, pitch: CAMERA === "drone" ? 60 : 48, bearing: 0, duration: 2200 })
      setTimeout(() => { state.raf = requestAnimationFrame(tick) }, 2100)
    } else { state.raf = requestAnimationFrame(tick) }
  } else { state.raf = requestAnimationFrame(tick) }
  audio?.play?.().catch(() => {})
}

function pause(finished = false) {
  state.playing = false
  cancelAnimationFrame(state.raf)
  el("btn-play").classList.remove("playing")
  caravanEl.classList.remove("walking")
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
  (PHOTO_MODE !== "off" ? ` · ${bundle.photos.length} photos` : "")
applyProgress(0, { moveCamera: false })
window.addEventListener("resize", () => drawElevation(state.progress))
