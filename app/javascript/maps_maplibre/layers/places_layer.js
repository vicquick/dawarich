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
      // promoteId lets us drive the per-pin selection ring via feature-state
      // (keyed on the place id) — see event_handlers#handlePlaceClick.
      promoteId: "id",
      data: this.data || {
        type: "FeatureCollection",
        features: [],
      },
    }
  }

  getLayerConfigs() {
    // Minimal pins: flat filled dots in the tag colour, NO stroke. The white
    // ring only appears on the SELECTED pin and animates in with a little
    // "press" overshoot (feature-state selected/pop → stroke transitions).
    const dotRadius = [
      "interpolate", ["linear"], ["zoom"],
      8, 3.5, 12, 5, 15, 6.5, 18, 8.5,
    ]
    const ringRadius = [
      "interpolate", ["linear"], ["zoom"],
      8, 5, 12, 6.5, 15, 8, 18, 10,
    ]
    const selected = ["boolean", ["feature-state", "selected"], false]
    const pop = ["boolean", ["feature-state", "pop"], false]

    return [
      // The dot — flat, tag-coloured, strokeless. That's the whole pin at rest.
      {
        id: this.id,
        type: "circle",
        source: this.sourceId,
        filter: ["to-boolean", ["get", "color"]],
        paint: {
          "circle-radius": dotRadius,
          "circle-color": ["coalesce", ["get", "color"], "#22c55e"],
          "circle-opacity": 1,
        },
      },

      // Selection ring — invisible until its pin is selected, then the BLUE
      // ring springs in (0 → 4.5 overshoot → 2.5) for a tactile "button press".
      // Blue is the selection signal, so the sheet's separate highlight circle
      // is suppressed for saved pins (it made a three-ring bullseye).
      {
        id: `${this.id}-ring`,
        type: "circle",
        source: this.sourceId,
        filter: ["to-boolean", ["get", "color"]],
        paint: {
          "circle-radius": ringRadius,
          "circle-color": "rgba(0,0,0,0)",
          "circle-stroke-color": "#1a73e8",
          "circle-stroke-width": ["case", pop, 4.5, ["case", selected, 2.5, 0]],
          "circle-stroke-opacity": ["case", selected, 1, 0],
          "circle-stroke-width-transition": { duration: 170, delay: 0 },
          "circle-stroke-opacity-transition": { duration: 150, delay: 0 },
        },
      },

      // Place labels (tagged only). Deliberately LATE and sparse: with hundreds
      // of saved places, labelling every one from city zoom turned the map into
      // a wall of text. Dots carry the information until you're close enough
      // for names to matter, and generous padding means crowded names drop out
      // rather than stack — the Google behaviour.
      {
        id: `${this.id}-labels`,
        type: "symbol",
        source: this.sourceId,
        filter: ["to-boolean", ["get", "color"]],
        minzoom: 15,
        layout: {
          "text-field": ["get", "name"],
          // Basemap glyph source only serves Noto Sans — using a font it lacks
          // renders boxes/garbage. Match it.
          "text-font": ["Noto Sans Regular"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 15, 10, 18, 12.5],
          "text-offset": [0, 1.1],
          "text-anchor": "top",
          "text-optional": true,
          "text-allow-overlap": false,
          "text-padding": 8,
          "text-max-width": 7,
          // Anchors first, then starred/favourite — so when labels collide the
          // meaningful ones survive.
          "symbol-sort-key": [
            "match", ["get", "state"],
            "home", 0, "work", 1, "favourite", 2, "starred", 3, "want_to_go", 4,
            5,
          ],
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
    return [this.id, `${this.id}-ring`, `${this.id}-labels`]
  }
}
