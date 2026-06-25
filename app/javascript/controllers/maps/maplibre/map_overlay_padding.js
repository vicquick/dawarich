// Shared sheet-aware camera padding (vicquick fork).
//
// Any overlay that floats OVER the map (a bottom sheet, a mobile panel, the
// right-edge place drawer) registers the screen edge and the pixel size it
// occupies. We keep `map.setPadding()` in sync so every camera operation —
// marker focus, recenter, geolocate, fitBounds — keeps its subject in the
// VISIBLE map area instead of hiding it behind the overlay.
//
// This is the Google-Maps behaviour: when a sheet rises, the map gently
// shifts so the focused place stays in the open space above it. Overlays that
// RESIZE the map container (the desktop push-panel) need nothing here —
// MapLibre's own resize handles those.
//
// Usage:
//   window.dawarichMapPadding.set("place-sheet", "bottom", 320)  // 320px tall
//   window.dawarichMapPadding.clear("place-sheet")               // dismissed
export function installMapPadding(map) {
  const occupancy = new Map() // id -> { edge, size }
  let raf = null

  const compute = () => {
    const el = map.getContainer()
    const W = el.clientWidth
    const H = el.clientHeight
    const pad = { top: 0, right: 0, bottom: 0, left: 0 }
    for (const { edge, size } of occupancy.values()) {
      pad[edge] = Math.max(pad[edge], size || 0)
    }
    // Never pad more than 70% of an axis — always leave a usable map.
    pad.top = Math.min(pad.top, H * 0.7)
    pad.bottom = Math.min(pad.bottom, H * 0.7)
    pad.left = Math.min(pad.left, W * 0.7)
    pad.right = Math.min(pad.right, W * 0.7)
    return pad
  }

  const apply = () => {
    raf = null
    if (!map || !map.getContainer) return
    const pad = compute()
    try {
      // Ease so the shift reads as intentional, like Google Maps.
      map.easeTo({ padding: pad, duration: 220 })
    } catch (_) {
      try { map.setPadding(pad) } catch (_) { /* style not ready — non-fatal */ }
    }
  }

  const schedule = () => {
    if (raf == null) raf = requestAnimationFrame(apply)
  }

  const api = {
    set(id, edge, size) {
      if (!id || !edge) return
      occupancy.set(id, { edge, size: Math.max(0, size || 0) })
      schedule()
    },
    clear(id) {
      if (occupancy.delete(id)) schedule()
    },
  }

  window.dawarichMapPadding = api
  return api
}
