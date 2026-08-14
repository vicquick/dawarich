// Shared iOS-feel bottom-sheet drag (vicquick fork).
//
// One physics implementation for every sheet on the map — timeline panel,
// place drawer, routing sheet — so they all move identically:
//
//   • the sheet tracks the finger 1:1 while dragging (no transition fighting)
//   • move samples are batched through requestAnimationFrame
//   • release uses PROJECTED position — height + velocity * momentum — so a
//     flick lands where the gesture was headed, not where the finger stopped
//     (this is the single biggest "feels like iOS" ingredient)
//   • pulling past the top detent rubber-bands with diminishing resistance
//   • a firm downward flick (or release below the lowest detent) DISMISSES
//     the sheet — the drag bar doubles as a closing affordance
//   • snapping animates on Apple's sheet curve, cubic-bezier(0.32, 0.72, 0, 1)
//
// The host element's height is the animated property (the padding-sync
// machinery reads offsetHeight), with detents supplied by the caller.
//
// attachSheetDrag(el, handle, {
//   detents: () => [px, px, ...],   // ascending; last = fully raised
//   onHeight: (px) => {},           // fires as the sheet resizes (pad sync)
//   onDismiss: () => {},            // firm flick down / dropped below minimum
//   enabled: () => bool,            // e.g. mobile-only
// }) -> detach()

const CURVE = "cubic-bezier(0.32, 0.72, 0, 1)"
const SNAP_MS = 340
const DISMISS_VELOCITY = 0.9 // px/ms downward — a deliberate flick, not a wobble
const PROJECTION_MS = 160 // how far ahead a flick "carries" the sheet
const RUBBER = 0.45 // resistance factor past the top detent

export function attachSheetDrag(el, handle, opts = {}) {
  const detents = opts.detents || (() => [window.innerHeight * 0.4, window.innerHeight * 0.85])
  const enabled = opts.enabled || (() => true)
  const onHeight = opts.onHeight || (() => {})
  const onDismiss = opts.onDismiss || null

  let dragging = false
  let moved = false
  let startY = 0
  let startH = 0
  let curH = 0
  let raf = 0
  let samples = [] // [t, y] ring for velocity

  const setH = (px) => {
    el.style.height = `${px}px`
    onHeight(px)
  }

  const animateTo = (px, after) => {
    el.style.transition = `height ${SNAP_MS}ms ${CURVE}`
    // Next frame so the transition applies to the change.
    requestAnimationFrame(() => {
      setH(px)
      // Run-once guard: BOTH transitionend and the fallback timeout land here.
      // Without it, `after` fired twice — a dismiss would toggle the panel
      // closed and then straight back open.
      let finished = false
      const done = (e) => {
        // Ignore bubbled transitions from children / other properties.
        if (e && (e.target !== el || e.propertyName !== "height")) return
        if (finished) return
        finished = true
        el.style.transition = ""
        el.removeEventListener("transitionend", done)
        if (after) after()
      }
      el.addEventListener("transitionend", done)
      // Fallback if the transition never fires (reduced motion / no change).
      setTimeout(done, SNAP_MS + 60)
    })
  }

  const down = (e) => {
    if (!enabled()) return
    dragging = true
    moved = false
    startY = e.clientY ?? e.touches?.[0]?.clientY ?? 0
    startH = el.offsetHeight
    curH = startH
    samples = [[performance.now(), startY]]
    el.style.transition = "none"
    try { handle.setPointerCapture(e.pointerId) } catch (_) { /* touch */ }
  }

  const move = (e) => {
    if (!dragging) return
    const y = e.clientY ?? e.touches?.[0]?.clientY ?? 0
    const now = performance.now()
    samples.push([now, y])
    // Keep ~100ms of history — enough for a stable release velocity.
    while (samples.length > 2 && now - samples[0][0] > 100) samples.shift()

    const dy = y - startY
    if (Math.abs(dy) > 4) moved = true

    const stops = detents()
    const top = stops[stops.length - 1]
    let h = startH - dy
    // Rubber-band past the top: excess counts at diminishing value.
    if (h > top) h = top + (h - top) * RUBBER
    // Below zero never — but allow going under the lowest detent so a slow
    // drag can still reach the dismiss zone.
    h = Math.max(0, h)
    curH = h
    if (!raf) {
      raf = requestAnimationFrame(() => {
        raf = 0
        setH(curH)
      })
    }
  }

  const up = () => {
    if (!dragging) return
    dragging = false
    if (raf) { cancelAnimationFrame(raf); raf = 0 }
    el.style.transition = ""

    const stops = detents()
    const top = stops[stops.length - 1]
    const low = stops[0]

    if (!moved) {
      // Tap on the bar toggles between mid and full — matches the old feel.
      const target = el.offsetHeight > top * 0.72 ? (stops[Math.floor((stops.length - 1) / 2)] ?? low) : top
      animateTo(target)
      return
    }

    // Signed velocity from the sample ring: positive = finger moving DOWN.
    let v = 0
    if (samples.length >= 2) {
      const [t0, y0] = samples[0]
      const [t1, y1] = samples[samples.length - 1]
      if (t1 > t0) v = (y1 - y0) / (t1 - t0)
    }

    // Deliberate downward flick → dismiss, from any height.
    if (onDismiss && v > DISMISS_VELOCITY) {
      animateTo(0, onDismiss)
      return
    }

    // Project the gesture forward and snap to the nearest detent.
    const projected = curH - v * PROJECTION_MS
    if (onDismiss && projected < low * 0.62) {
      animateTo(0, onDismiss)
      return
    }
    const target = stops.reduce((a, b) => (Math.abs(b - projected) < Math.abs(a - projected) ? b : a))
    animateTo(Math.min(target, top))
  }

  handle.addEventListener("pointerdown", down)
  window.addEventListener("pointermove", move)
  window.addEventListener("pointerup", up)
  window.addEventListener("pointercancel", up)

  return () => {
    handle.removeEventListener("pointerdown", down)
    window.removeEventListener("pointermove", move)
    window.removeEventListener("pointerup", up)
    window.removeEventListener("pointercancel", up)
    if (raf) cancelAnimationFrame(raf)
  }
}
