import { BaseLayer } from "./base_layer"

/**
 * Places layer showing user-created places with tags
 * Different colors based on tags
 */
export class PlacesLayer extends BaseLayer {
  constructor(map, options = {}) {
    super(map, { id: "places", ...options })
  }

  getSourceConfig() {
    return {
      type: "geojson",
      data: this.data || {
        type: "FeatureCollection",
        features: [],
      },
    }
  }

  getLayerConfigs() {
    // Pin radii — smaller when zoomed out, larger up close. MapLibre forbids a
    // zoom expression nested inside arithmetic or a case, so the glow and dot
    // each carry their own top-level interpolate (glow ≈ dot + 5).
    const dotRadius = [
      "interpolate", ["linear"], ["zoom"],
      8, 3.5, 12, 5, 15, 7, 18, 9.5,
    ]
    const glowRadius = [
      "interpolate", ["linear"], ["zoom"],
      8, 8.5, 12, 10, 15, 12, 18, 14.5,
    ]
    const strokeWidth = [
      "interpolate", ["linear"], ["zoom"],
      8, 1.6, 15, 2.4,
    ]
    const isWishlist = ["==", ["get", "state"], "want_to_go"]
    const isStarred = ["==", ["get", "state"], "starred"]

    return [
      // Soft amber halo under starred pins only — the one place we let a pin
      // "glow", so the eye lands on favourites first without any icon clutter.
      {
        id: `${this.id}-glow`,
        type: "circle",
        source: this.sourceId,
        filter: ["all", ["to-boolean", ["get", "color"]], isStarred],
        paint: {
          "circle-radius": glowRadius,
          "circle-color": "#eab308",
          "circle-opacity": 0.18,
          "circle-blur": 0.7,
        },
      },

      // Place dots — only tagged places (untagged auto-visit places are noise).
      // Shape language: wishlist ("Want to go") reads as a HOLLOW ring — white
      // centre, coloured stroke — like a spot you haven't filled in yet. Every
      // other saved state is a FILLED dot in its tag hue. Starred sits a hair
      // larger over its glow.
      {
        id: this.id,
        type: "circle",
        source: this.sourceId,
        filter: ["to-boolean", ["get", "color"]],
        paint: {
          "circle-radius": dotRadius,
          "circle-color": [
            "case",
            isWishlist, "#ffffff",
            ["coalesce", ["get", "color"], "#64748b"],
          ],
          "circle-stroke-color": [
            "case",
            isWishlist, ["coalesce", ["get", "color"], "#22c55e"],
            "#ffffff",
          ],
          "circle-stroke-width": strokeWidth,
          "circle-opacity": 1,
        },
      },

      // Place labels (tagged only) — only from street zoom, with collision
      // declutter so a zoomed-out view shows dots, not a wall of text.
      {
        id: `${this.id}-labels`,
        type: "symbol",
        source: this.sourceId,
        filter: ["to-boolean", ["get", "color"]],
        minzoom: 13,
        layout: {
          "text-field": ["get", "name"],
          // Basemap glyph source only serves Noto Sans — using a font it lacks
          // renders boxes/garbage. Match it.
          "text-font": ["Noto Sans Regular"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 13, 10, 17, 13],
          "text-offset": [0, 1.2],
          "text-anchor": "top",
          "text-optional": true,
          "text-allow-overlap": false,
          "text-max-width": 8,
        },
        paint: {
          "text-color": "#111827",
          "text-halo-color": "#ffffff",
          "text-halo-width": 2,
        },
      },
    ]
  }

  getLayerIds() {
    return [`${this.id}-glow`, this.id, `${this.id}-labels`]
  }
}
