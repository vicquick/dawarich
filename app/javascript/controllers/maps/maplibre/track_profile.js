import maplibregl from "maplibre-gl"

// Elevation + speed profile for a track (vicquick fork).
//
// Exposed as window.dawarichTrackProfile; opened from event_handlers when a
// track is clicked. Pulls the track's points (/api/v1/tracks/:id/points),
// builds a distance-indexed profile, and draws a compact interactive chart in a
// bottom panel: elevation area (hero) + a subtle speed line, with a scrubber
// that drops a marker on the map so you can read the terrain along the route —
// the Komoot/OrganicMaps move. Self-contained: builds its own DOM + styles.
const R = 6371000
const rad = Math.PI / 180
function haversine(a, b, c, d) {
  const dlat = (c - a) * rad, dlon = (d - b) * rad
  const x = Math.sin(dlat / 2) ** 2 + Math.cos(a * rad) * Math.cos(c * rad) * Math.sin(dlon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(x))
}

export class TrackProfileManager {
  constructor(controller) {
    this.controller = controller
    this.map = controller.map
    this.apiKey = controller.apiKeyValue
    this._el = null
    this._marker = null
    this._prof = null
  }

  async open(trackId) {
    if (trackId == null) return
    this._ensureDom()
    this._el.classList.add("tp--open")
    this._body.innerHTML = `<div class="tp__loading">Loading elevation…</div>`
    let pts = []
    try {
      const res = await fetch(`/api/v1/tracks/${encodeURIComponent(trackId)}/points?api_key=${encodeURIComponent(this.apiKey)}`)
      if (res.ok) pts = await res.json()
    } catch (_) { /* noop */ }
    const prof = this._build(Array.isArray(pts) ? pts : [])
    this._prof = prof
    if (!prof || prof.P.length < 2) {
      this._body.innerHTML = `<div class="tp__loading">No elevation data for this track.</div>`
      return
    }
    this._render(prof)
  }

  close() {
    if (this._el) this._el.classList.remove("tp--open")
    this._removeMarker()
    this._prof = null
  }

  // --- data ---
  _build(points) {
    const P = []
    let dist = 0, prev = null
    for (const p of points) {
      const lat = parseFloat(p.latitude), lon = parseFloat(p.longitude)
      if (!isFinite(lat) || !isFinite(lon)) continue
      const ele = (p.altitude != null && p.altitude !== "") ? parseFloat(p.altitude) : null
      const t = Number(p.timestamp) || null
      if (prev) dist += haversine(prev.lat, prev.lon, lat, lon)
      P.push({ lat, lon, d: dist, ele, t, spd: null })
      prev = { lat, lon }
    }
    // Speed over a WINDOW, not point-to-point: 1-second GPS samples make
    // consecutive-pair speeds pure noise (the line looked like a barcode).
    // Measure across ±k samples so it reads like a real pace curve.
    const k = Math.max(4, Math.round(P.length / 150))
    for (let i = 0; i < P.length; i++) {
      const a = P[Math.max(0, i - k)], b = P[Math.min(P.length - 1, i + k)]
      const dt = (b.t || 0) - (a.t || 0)
      P[i].spdS = dt > 0 ? ((b.d - a.d) / dt) * 3.6 : null
    }
    // Grade (%) over the same window — drives the Komoot-style colouring.
    for (let i = 0; i < P.length; i++) {
      const a = P[Math.max(0, i - k)], b = P[Math.min(P.length - 1, i + k)]
      const dd = b.d - a.d
      P[i].grade = dd > 1 && a.ele != null && b.ele != null ? ((b.ele - a.ele) / dd) * 100 : 0
    }
    let asc = 0, desc = 0
    for (let i = 1; i < P.length; i++) {
      if (P[i].ele != null && P[i - 1].ele != null) {
        const dz = P[i].ele - P[i - 1].ele
        dz > 0 ? (asc += dz) : (desc -= dz)
      }
    }
    const eles = P.map((p) => p.ele).filter((v) => v != null)
    const spds = P.map((p) => p.spdS).filter((v) => v != null)
    return {
      P, distM: dist, asc: Math.round(asc), desc: Math.round(desc),
      minE: eles.length ? Math.min(...eles) : null,
      maxE: eles.length ? Math.max(...eles) : null,
      maxV: spds.length ? Math.max(...spds) : null,
      hasEle: eles.length > 1,
    }
  }

  // --- render ---
  _render(prof) {
    const km = (prof.distM / 1000).toFixed(1)
    const stat = (label, val) => `<div class="tp__stat"><span>${val}</span><label>${label}</label></div>`
    const stats = [
      stat("Distance", `${km} km`),
      prof.hasEle ? stat("Ascent", `▲ ${prof.asc} m`) : "",
      prof.hasEle ? stat("Descent", `▼ ${prof.desc} m`) : "",
      prof.hasEle ? stat("Range", `${Math.round(prof.minE)}–${Math.round(prof.maxE)} m`) : "",
      prof.maxV != null ? stat("Top speed", `${Math.round(prof.maxV)} km/h`) : "",
    ].join("")
    // Speed is off by default: on a hike it's mostly GPS jitter and it fights
    // the elevation curve for attention (OrganicMaps shows elevation alone).
    let showSpeed = false
    try { showSpeed = localStorage.getItem("dawarichTrackSpeed") === "1" } catch (_) { /* noop */ }
    this._body.innerHTML = `
      <div class="tp__head">
        <div class="tp__stats">${stats}</div>
        <div class="tp__head-actions">
          ${prof.maxV != null ? `<button type="button" class="tp__chip${showSpeed ? " tp__chip--on" : ""}" data-speed-toggle>Speed</button>` : ""}
          <button type="button" class="tp__close" aria-label="Close">✕</button>
        </div>
      </div>
      <div class="tp__chart${showSpeed ? "" : " tp--nospeed"}"></div>`
    this._body.querySelector(".tp__close").addEventListener("click", () => this.close())
    const speedBtn = this._body.querySelector("[data-speed-toggle]")
    if (speedBtn) {
      speedBtn.addEventListener("click", () => {
        const chart = this._body.querySelector(".tp__chart")
        const on = chart.classList.toggle("tp--nospeed") === false
        speedBtn.classList.toggle("tp__chip--on", on)
        try { localStorage.setItem("dawarichTrackSpeed", on ? "1" : "0") } catch (_) { /* noop */ }
      })
    }
    this._drawChart(this._body.querySelector(".tp__chart"), prof)
  }

  _drawChart(host, prof) {
    const W = Math.max(280, host.clientWidth || 320), H = 116, padB = 4, padT = 8
    const total = prof.distM || 1
    const eMin = prof.hasEle ? prof.minE : 0
    const eSpan = prof.hasEle ? Math.max(1, prof.maxE - prof.minE) : 1
    const vMax = prof.maxV || 1
    const x = (d) => (d / total) * W
    const yE = (e) => H - padB - ((e - eMin) / eSpan) * (H - padB - padT)
    const yV = (v) => H - padB - (v / vMax) * (H - padB - padT)
    // Downsample to roughly one sample per horizontal pixel — 3k+ points drawn
    // into a 300px-wide chart is just noise (and a huge DOM).
    const step = Math.max(1, Math.floor(prof.P.length / W))
    const S = prof.P.filter((_, i) => i % step === 0 || i === prof.P.length - 1)

    // elevation line + area
    let eLine = "", ePrev = false
    for (const p of S) {
      if (p.ele == null) { ePrev = false; continue }
      eLine += `${ePrev ? "L" : "M"}${x(p.d).toFixed(1)},${yE(p.ele).toFixed(1)} `
      ePrev = true
    }
    const first = S.find((p) => p.ele != null), last = [...S].reverse().find((p) => p.ele != null)
    const eArea = prof.hasEle
      ? `M${x(first.d).toFixed(1)},${(H - padB).toFixed(1)} ${eLine.replace(/^M/, "L")} L${x(last.d).toFixed(1)},${(H - padB).toFixed(1)} Z`
      : ""
    // Komoot-style grade colouring: flat → green, steeper → amber → red, drawn
    // as short coloured segments over the area.
    const gradeColor = (g) => {
      const a = Math.abs(g)
      if (a < 4) return "#16a34a"
      if (a < 8) return "#84cc16"
      if (a < 12) return "#f59e0b"
      return "#dc2626"
    }
    let gradeSegs = ""
    if (prof.hasEle) {
      for (let i = 1; i < S.length; i++) {
        const a = S[i - 1], b = S[i]
        if (a.ele == null || b.ele == null) continue
        gradeSegs += `<path d="M${x(a.d).toFixed(1)},${yE(a.ele).toFixed(1)} L${x(b.d).toFixed(1)},${yE(b.ele).toFixed(1)}" stroke="${gradeColor(b.grade)}" stroke-width="2" fill="none" stroke-linecap="round"/>`
      }
    }
    let vLine = "", vPrev = false
    for (const p of S) {
      if (p.spdS == null) { vPrev = false; continue }
      vLine += `${vPrev ? "L" : "M"}${x(p.d).toFixed(1)},${yV(p.spdS).toFixed(1)} `
      vPrev = true
    }
    host.innerHTML = `
      <svg class="tp__svg" viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none">
        <defs>
          <linearGradient id="tpEleGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#22c55e" stop-opacity="0.34"/>
            <stop offset="100%" stop-color="#22c55e" stop-opacity="0.02"/>
          </linearGradient>
        </defs>
        ${prof.hasEle ? `<path d="${eArea}" fill="url(#tpEleGrad)"></path>` : ""}
        ${gradeSegs}
        ${prof.maxV != null ? `<path class="tp__speed" d="${vLine}" fill="none" stroke="#60a5fa" stroke-width="1.1" stroke-opacity="0.55" stroke-linejoin="round"/>` : ""}
        <line class="tp__cursor" x1="0" y1="0" x2="0" y2="${H}" stroke="#e5e7eb" stroke-width="1" opacity="0"/>
      </svg>
      <div class="tp__legend">
        ${prof.hasEle ? `<span class="tp__legend-grade"><i style="background:#16a34a"></i><i style="background:#84cc16"></i><i style="background:#f59e0b"></i><i style="background:#dc2626"></i>Steepness</span>` : ""}
        ${prof.maxV != null ? `<span class="tp__speed-legend"><i style="background:#60a5fa"></i>Speed</span>` : ""}
      </div>
      <div class="tp__tip" hidden></div>`
    const svg = host.querySelector(".tp__svg")
    const cursor = host.querySelector(".tp__cursor")
    const tip = host.querySelector(".tp__tip")
    const onMove = (clientX) => {
      const rect = svg.getBoundingClientRect()
      const rel = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
      const d = rel * total
      // nearest sample
      let lo = 0, hi = prof.P.length - 1
      while (lo < hi) { const m = (lo + hi) >> 1; prof.P[m].d < d ? (lo = m + 1) : (hi = m) }
      const p = prof.P[lo]
      cursor.setAttribute("x1", (rel * W).toFixed(1))
      cursor.setAttribute("x2", (rel * W).toFixed(1))
      cursor.setAttribute("opacity", "0.8")
      tip.hidden = false
      tip.style.left = `${Math.min(Math.max(rel * rect.width, 34), rect.width - 34)}px`
      tip.innerHTML = `${(p.d / 1000).toFixed(2)} km${p.ele != null ? ` · ${Math.round(p.ele)} m` : ""}${p.spdS != null ? ` · ${Math.round(p.spdS)} km/h` : ""}`
      this._moveMarker(p.lon, p.lat)
    }
    svg.addEventListener("mousemove", (e) => onMove(e.clientX))
    svg.addEventListener("touchmove", (e) => { if (e.touches[0]) onMove(e.touches[0].clientX) }, { passive: true })
    const leave = () => { cursor.setAttribute("opacity", "0"); tip.hidden = true; this._removeMarker() }
    svg.addEventListener("mouseleave", leave)
    svg.addEventListener("touchend", leave)
  }

  // --- map marker ---
  _moveMarker(lon, lat) {
    if (!this.map) return
    if (!this._marker) {
      const el = document.createElement("div")
      el.className = "tp__mrk"
      this._marker = new maplibregl.Marker({ element: el }).setLngLat([lon, lat]).addTo(this.map)
    } else {
      this._marker.setLngLat([lon, lat])
    }
  }
  _removeMarker() { if (this._marker) { this._marker.remove(); this._marker = null } }

  // --- dom scaffold (once) ---
  _ensureDom() {
    if (this._el) return
    if (!document.getElementById("tp-style")) {
      const s = document.createElement("style")
      s.id = "tp-style"
      s.textContent = `
        .tp-panel{position:absolute;left:50%;bottom:0;transform:translate(-50%,110%);
          width:min(94vw,44rem);z-index:557;background:oklch(var(--b1));color:oklch(var(--bc));
          border:1px solid color-mix(in oklch,oklch(var(--bc)) 12%,transparent);border-bottom:none;
          border-radius:1rem 1rem 0 0;box-shadow:0 -8px 28px rgba(0,0,0,.32);
          padding:.7rem .9rem 1rem;transition:transform .24s cubic-bezier(.2,.7,.2,1);}
        .tp-panel.tp--open{transform:translate(-50%,0);}
        body.routing-active .tp-panel{display:none;}
        .tp__loading{padding:1.2rem;text-align:center;opacity:.65;font-size:.85rem;}
        .tp__head{display:flex;align-items:flex-start;gap:.6rem;}
        /* Wrap onto a second row rather than clipping a stat mid-word. */
        .tp__stats{display:flex;gap:.55rem 1.1rem;flex:1;min-width:0;flex-wrap:wrap;}
        .tp__head-actions{display:flex;align-items:center;gap:.4rem;flex:0 0 auto;}
        .tp__chip{border:1px solid color-mix(in oklch,oklch(var(--bc)) 22%,transparent);background:transparent;
          color:inherit;border-radius:999px;padding:.14rem .5rem;font-size:.68rem;font-weight:600;opacity:.6;cursor:pointer;}
        .tp__chip--on{background:#3b82f6;border-color:#3b82f6;color:#fff;opacity:1;}
        .tp--nospeed .tp__speed,.tp--nospeed .tp__speed-legend{display:none;}
        .tp__legend-grade i{margin-right:0;border-radius:0;}
        .tp__legend-grade i:first-of-type{border-radius:2px 0 0 2px;}
        .tp__legend-grade i:nth-of-type(4){border-radius:0 2px 2px 0;margin-right:.25rem;}
        .tp__stat{display:flex;flex-direction:column;line-height:1.15;white-space:nowrap;}
        .tp__stat span{font-weight:700;font-size:.92rem;}
        .tp__stat label{font-size:.66rem;letter-spacing:.03em;text-transform:uppercase;opacity:.55;}
        .tp__close{flex:0 0 auto;width:1.7rem;height:1.7rem;border-radius:50%;border:none;cursor:pointer;
          background:color-mix(in oklch,oklch(var(--bc)) 10%,transparent);color:inherit;font-size:.8rem;}
        .tp__chart{position:relative;margin-top:.5rem;}
        .tp__svg{display:block;overflow:visible;}
        .tp__legend{display:flex;gap:.9rem;margin-top:.2rem;font-size:.66rem;opacity:.6;}
        .tp__legend i{display:inline-block;width:.6rem;height:.6rem;border-radius:2px;margin-right:.25rem;vertical-align:middle;}
        .tp__tip{position:absolute;top:-1.7rem;transform:translateX(-50%);background:oklch(var(--b1));
          border:1px solid color-mix(in oklch,oklch(var(--bc)) 14%,transparent);border-radius:.5rem;
          padding:.12rem .45rem;font-size:.72rem;font-weight:600;white-space:nowrap;pointer-events:none;box-shadow:0 2px 8px rgba(0,0,0,.25);}
        .tp__mrk{width:14px;height:14px;border-radius:50%;background:#16a34a;border:2.5px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.25);}
        @media (max-width:768px){.tp-panel{width:100%;border-radius:1rem 1rem 0 0;}}`
      document.head.appendChild(s)
    }
    const el = document.createElement("div")
    el.className = "tp-panel"
    el.innerHTML = `<div class="tp__inner"></div>`
    document.body.appendChild(el)
    this._el = el
    this._body = el.querySelector(".tp__inner")
  }
}
