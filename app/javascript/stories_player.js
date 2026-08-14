// Public story player (vicquick fork) — the cinematic trip animation.
//
// Standalone importmap entry: imports MapLibre + the app's style builder and
// nothing else (no Stimulus, no app bundle). One requestAnimationFrame clock
// drives everything — camera, line draw-on, photo pops, elevation cursor,
// stat counters and the soundtrack — all keyed off ONE downsampled point
// array shipped in the page bundle, so nothing can drift out of sync.
import maplibregl from "maplibre-gl"
import { getMapStyle } from "maps_maplibre/utils/style_manager"

const bundle = JSON.parse(document.getElementById("story-bundle").textContent)
const el = (id) => document.getElementById(id)

const DURATION_S = Math.min(180, Math.max(45, bundle.points.length / 18)) // 45s–3min
const state = {
  playing: false,
  progress: 0, // 0..1 along the timeline
  speed: 1,
  started: false,
  raf: 0,
  lastTs: 0,
  shownPhotos: new Set(),
}

// ---------- helpers over the point array ----------
const P = bundle.points // [lon, lat, ele, t]
const D = bundle.dist_km
const N = P.length
const totalKm = D[N - 1] || 0

function idxAt(progress) {
  return Math.min(N - 1, Math.floor(progress * (N - 1)))
}
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

// ---------- map ----------
const bounds = P.reduce(
  (b, p) => [[Math.min(b[0][0], p[0]), Math.min(b[0][1], p[1])], [Math.max(b[1][0], p[0]), Math.max(b[1][1], p[1])]],
  [[Infinity, Infinity], [-Infinity, -Infinity]],
)

const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches
const map = new maplibregl.Map({
  container: "story-map",
  style: await getMapStyle(prefersDark ? "dark" : "white", {}),
  bounds,
  fitBoundsOptions: { padding: 80 },
  attributionControl: { compact: true },
  interactive: true,
})

await new Promise((resolve) => map.once("load", resolve))

const line = {
  type: "Feature",
  geometry: { type: "LineString", coordinates: P.map((p) => [p[0], p[1]]) },
}
map.addSource("story-line", { type: "geojson", data: line, lineMetrics: true })
// Dim full route underneath
map.addLayer({
  id: "story-line-dim", type: "line", source: "story-line",
  layout: { "line-cap": "round", "line-join": "round" },
  paint: { "line-color": "#94a3b8", "line-width": 3, "line-opacity": 0.35 },
})
// Progress line — revealed by animating a gradient stop along line-progress
map.addLayer({
  id: "story-line-live", type: "line", source: "story-line",
  layout: { "line-cap": "round", "line-join": "round" },
  paint: {
    "line-width": ["interpolate", ["linear"], ["zoom"], 8, 4, 14, 6],
    "line-gradient": gradientAt(0),
  },
})

function gradientAt(prog) {
  const t = Math.max(0.0001, Math.min(0.9999, prog))
  return [
    "step", ["line-progress"],
    "#f97316", // vivid head colour up to the playhead
    t, "rgba(0,0,0,0)",
  ]
}

// Start / finish flags (SVG markers with pulse)
function flag(iconText, coords, cls) {
  const d = document.createElement("div")
  d.className = `story-flag ${cls}`
  d.textContent = iconText
  new maplibregl.Marker({ element: d, anchor: "bottom" }).setLngLat(coords).addTo(map)
}
flag("🚩", [P[0][0], P[0][1]], "story-flag--start")
flag("🏁", [P[N - 1][0], P[N - 1][1]], "story-flag--end")

// Playhead puck
const puckEl = document.createElement("div")
puckEl.className = "story-puck"
const puck = new maplibregl.Marker({ element: puckEl }).setLngLat([P[0][0], P[0][1]]).addTo(map)

// ---------- photos ----------
const photoMarkers = []
for (const ph of bundle.photos) {
  const w = document.createElement("div")
  w.className = "story-photo"
  w.innerHTML = `<img loading="lazy" src="${ph.url}" alt="">${ph.type === "VIDEO" ? '<span class="story-photo__play">▶</span>' : ""}`
  w.addEventListener("click", () => openLightbox(ph.url))
  const m = new maplibregl.Marker({ element: w, anchor: "bottom" })
    .setLngLat([P[ph.idx][0], P[ph.idx][1]])
  photoMarkers.push({ ph, marker: m, added: false })
}

function openLightbox(url) {
  el("story-lightbox").innerHTML = `<img src="${url.replace(/$/, "")}" alt="">`
  el("story-lightbox").classList.add("open")
}
el("story-lightbox").addEventListener("click", () => el("story-lightbox").classList.remove("open"))

// ---------- elevation canvas ----------
const canvas = el("story-elev")
const ctx = canvas.getContext("2d")
function drawElevation(prog) {
  const w = canvas.width = canvas.clientWidth * devicePixelRatio
  const h = canvas.height = canvas.clientHeight * devicePixelRatio
  const eles = P.map((p) => p[2])
  const min = Math.min(...eles)
  const max = Math.max(...eles, min + 10)
  ctx.clearRect(0, 0, w, h)
  const x = (i) => (D[i] / totalKm) * w
  const y = (e) => h - ((e - min) / (max - min)) * (h * 0.82) - h * 0.06
  // area
  ctx.beginPath()
  ctx.moveTo(0, h)
  for (let i = 0; i < N; i++) ctx.lineTo(x(i), y(eles[i]))
  ctx.lineTo(w, h)
  ctx.closePath()
  ctx.fillStyle = "rgba(249, 115, 22, 0.18)"
  ctx.fill()
  // line
  ctx.beginPath()
  for (let i = 0; i < N; i++) i ? ctx.lineTo(x(i), y(eles[i])) : ctx.moveTo(x(i), y(eles[i]))
  ctx.strokeStyle = "#f97316"
  ctx.lineWidth = 2 * devicePixelRatio
  ctx.stroke()
  // progress cursor
  const i = idxAt(prog)
  ctx.beginPath()
  ctx.moveTo(x(i), 0)
  ctx.lineTo(x(i), h)
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

// ---------- camera ----------
let camBearing = 0
function updateCamera(prog) {
  const pos = posAt(prog)
  const ahead = posAt(Math.min(1, prog + 0.004))
  const target = bearingBetween(pos, ahead)
  // shortest-arc smoothing so the camera glides through turns
  let diff = ((target - camBearing + 540) % 360) - 180
  camBearing = (camBearing + diff * 0.06 + 360) % 360
  map.jumpTo({ center: pos, zoom: Math.max(map.getZoom(), 12.8), bearing: camBearing, pitch: 48 })
}

// ---------- timeline ----------
function applyProgress(prog, { moveCamera = true } = {}) {
  state.progress = Math.max(0, Math.min(1, prog))
  map.setPaintProperty("story-line-live", "line-gradient", gradientAt(state.progress))
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
    map.easeTo({ center: posAt(0), zoom: 13, pitch: 48, bearing: 0, duration: 2200 })
    setTimeout(() => { state.raf = requestAnimationFrame(tick) }, 2100)
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
  if (finished) {
    map.fitBounds(bounds, { padding: 80, pitch: 0, bearing: 0, duration: 2500 })
  }
}

el("btn-play").addEventListener("click", () => (state.playing ? pause() : play()))
el("story-scrub").addEventListener("input", (e) => {
  const wasPlaying = state.playing
  state.playing = false
  cancelAnimationFrame(state.raf)
  applyProgress(Number(e.target.value) / 1000)
  updateCamera(state.progress)
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

// initial paint
el("hud-total").textContent = `${totalKm.toFixed(0)} km · ${bundle.stats.days} days · ↑${bundle.stats.elevation_gain_m} m · ${bundle.photos.length} photos`
applyProgress(0, { moveCamera: false })
window.addEventListener("resize", () => drawElevation(state.progress))
