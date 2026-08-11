import maplibregl from "maplibre-gl"

// Immich photos as a NATIVE clustered map layer (vicquick fork).
//
// Exposed as window.dawarichImmich by maplibre_controller; toggled from the
// Layers control (like Street View / Traffic). Loads lazily on first enable
// (all geotagged assets → /api/v1/immich/markers), clusters client-side, and
// opens a preview popup on tap. Thumbnails go through the Rails proxy so the
// Immich API key never reaches the browser.
export class ImmichManager {
  constructor(controller) {
    this.controller = controller
    this.map = controller.map
    this.apiKey = controller.apiKeyValue
    this._on = false
    this._loaded = false
    this._popup = null
  }

  isOn() { return this._on }

  async toggle() {
    this._on = !this._on
    if (this._on) { await this._show() } else { this._hide() }
    return this._on
  }

  async _ensure() {
    if (this._loaded || !this.map) return

    let geojson = { type: "FeatureCollection", features: [] }
    try {
      const res = await fetch(`/api/v1/immich/markers?api_key=${encodeURIComponent(this.apiKey)}`)
      if (res.ok) geojson = await res.json()
    } catch (_) { /* noop — layer stays empty, never breaks the map */ }

    const map = this.map
    if (map.getSource("immich-photos")) {
      map.getSource("immich-photos").setData(geojson)
    } else {
      map.addSource("immich-photos", {
        type: "geojson", data: geojson,
        cluster: true, clusterRadius: 46, clusterMaxZoom: 15,
      })

      // Cluster bubbles — teal, sized by count.
      map.addLayer({
        id: "immich-clusters", type: "circle", source: "immich-photos",
        filter: ["has", "point_count"],
        paint: {
          "circle-color": "#0d9488", "circle-opacity": 0.9,
          "circle-radius": ["step", ["get", "point_count"], 13, 25, 17, 100, 22, 500, 28],
          "circle-stroke-width": 2, "circle-stroke-color": "#ffffff",
        },
      })
      map.addLayer({
        id: "immich-cluster-count", type: "symbol", source: "immich-photos",
        filter: ["has", "point_count"],
        layout: {
          "text-field": ["get", "point_count_abbreviated"],
          "text-font": ["Noto Sans Regular"], "text-size": 12,
        },
        paint: { "text-color": "#ffffff" },
      })

      // Unclustered photo — minimal teal dot.
      map.addLayer({
        id: "immich-photo", type: "circle", source: "immich-photos",
        filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 3, 14, 5, 17, 7],
          "circle-color": "#14b8a6", "circle-opacity": 0.92,
          "circle-stroke-width": 1.5, "circle-stroke-color": "#ffffff",
        },
      })

      map.on("click", "immich-clusters", (e) => this._expandCluster(e))
      map.on("click", "immich-photo", (e) => this._openPhoto(e.features && e.features[0]))
      const cursor = (v) => () => { map.getCanvas().style.cursor = v }
      map.on("mouseenter", "immich-photo", cursor("pointer"))
      map.on("mouseleave", "immich-photo", cursor(""))
      map.on("mouseenter", "immich-clusters", cursor("pointer"))
      map.on("mouseleave", "immich-clusters", cursor(""))
    }
    this._loaded = true
  }

  async _show() { await this._ensure(); this._vis("visible") }

  _hide() {
    this._vis("none")
    if (this._popup) { this._popup.remove(); this._popup = null }
  }

  _vis(v) {
    const m = this.map
    if (!m) return
    for (const id of ["immich-clusters", "immich-cluster-count", "immich-photo"]) {
      if (m.getLayer(id)) m.setLayoutProperty(id, "visibility", v)
    }
  }

  _expandCluster(e) {
    const map = this.map
    const f = map.queryRenderedFeatures(e.point, { layers: ["immich-clusters"] })[0]
    if (!f) return
    map.getSource("immich-photos")
      .getClusterExpansionZoom(f.properties.cluster_id)
      .then((zoom) => map.easeTo({ center: f.geometry.coordinates, zoom }))
      .catch(() => {})
  }

  _openPhoto(f) {
    if (!f) return
    const id = f.properties.id
    const coords = f.geometry.coordinates.slice()
    const city = f.properties.city || ""
    const src = `/api/v1/immich/thumb/${encodeURIComponent(id)}?size=preview&api_key=${encodeURIComponent(this.apiKey)}`
    const html = `<div class="immich-pop"><img class="immich-pop__img" src="${src}" alt="" loading="lazy"/>${
      city ? `<div class="immich-pop__meta">📍 ${city}</div>` : ""
    }</div>`
    if (this._popup) this._popup.remove()
    this._popup = new maplibregl.Popup({ closeButton: true, maxWidth: "270px", offset: 14, className: "immich-popup" })
      .setLngLat(coords).setHTML(html).addTo(this.map)
  }
}
