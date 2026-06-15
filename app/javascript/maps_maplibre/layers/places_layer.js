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
    return [
      // Place circles — only tagged places (untagged auto-visit places are
      // noise; a tagged place always has a color from its tag).
      {
        id: this.id,
        type: "circle",
        source: this.sourceId,
        filter: ["to-boolean", ["get", "color"]],
        paint: {
          // Smaller dots when zoomed out, larger up close — less clutter.
          "circle-radius": [
            "interpolate", ["linear"], ["zoom"],
            8, 4, 12, 6, 15, 9, 18, 12,
          ],
          "circle-color": [
            "coalesce",
            ["get", "color"], //  Use tag color if available
            "#6366f1", // Default indigo color
          ],
          "circle-stroke-width": 2,
          "circle-stroke-color": "#ffffff",
          "circle-opacity": 0.9,
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
    return [this.id, `${this.id}-labels`]
  }
}
