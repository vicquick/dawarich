#!/usr/bin/env python3
"""Normalize POI rendering across all MapLibre basemap styles (vicquick fork).

The Protomaps planet tiles (tyles.dwri.xyz) ship a `pois` source-layer with
`kind`, `name`, `min_zoom`. Upstream only renders it on some themes (the
default `white` omits it entirely -> "no places showing"). This injects a
consistent, Magic-Earth-density treatment into every style:

  * `poi_circles` — colored dot per POI, category-coloured, white halo
  * `pois`        — sprite icon + label, category-coloured text

Idempotent: removes any prior `poi_circles`/`pois` layer before re-adding.
Run from repo root:  python3 bin/inject_pois.py
"""
import json
import os
import glob

STYLE_DIR = "public/maps_maplibre/styles"

# POI categories we surface, grouped by colour (Google/Magic-Earth-ish palette).
GROUPS = {
    "food":      (["restaurant", "fast_food", "cafe", "bar"], "#E8710A"),       # orange
    "shop":      (["supermarket", "convenience", "books", "beauty",
                   "electronics", "clothes", "pharmacy", "mall"], "#1A73C0"),   # blue
    "transit":   (["aerodrome", "station", "bus_stop", "ferry_terminal"], "#3B5BD9"),  # indigo
    "leisure":   (["beach", "forest", "marina", "park", "peak", "zoo",
                   "garden", "stadium", "attraction"], "#1E8E4E"),             # green
    "culture":   (["museum", "theatre", "artwork", "library", "university"], "#C5347E"),  # pink
    "civic":     (["school", "post_office", "townhall", "hospital",
                   "police", "fire_station"], "#7A5BA8"),                       # purple
}

ALL_KINDS = [k for kinds, _ in GROUPS.values() for k in kinds]

# circle-color "match" expression keyed on `kind`
def circle_color():
    expr = ["match", ["get", "kind"]]
    for kinds, color in GROUPS.values():
        expr.append(kinds)
        expr.append(color)
    expr.append("#8A8A8A")  # fallback grey
    return expr

# text-color reuses the same palette
TEXT_COLOR = circle_color  # identical mapping

# Density: show a POI one zoom level earlier than its natural min_zoom.
DENSITY_FILTER = [
    "all",
    ["in", ["get", "kind"], ["literal", ALL_KINDS]],
    [">=", ["zoom"], ["-", ["coalesce", ["get", "min_zoom"], 15], 1]],
]

NAME = ["coalesce", ["get", "name:en"], ["get", "pgf:name"], ["get", "name"]]


def poi_circles_layer():
    return {
        "id": "poi_circles",
        "type": "circle",
        "source": "protomaps",
        "source-layer": "pois",
        "filter": DENSITY_FILTER,
        "paint": {
            "circle-color": circle_color(),
            "circle-radius": [
                "interpolate", ["linear"], ["zoom"],
                13, 2.2, 16, 4.5, 19, 7.5,
            ],
            "circle-stroke-color": "#ffffff",
            "circle-stroke-width": 1.4,
            "circle-opacity": 0.95,
        },
    }


def pois_layer():
    return {
        "id": "pois",
        "type": "symbol",
        "source": "protomaps",
        "source-layer": "pois",
        "filter": DENSITY_FILTER,
        "layout": {
            "icon-image": [
                "match", ["get", "kind"],
                "station", "train_station",
                ["get", "kind"],
            ],
            "icon-size": [
                "interpolate", ["linear"], ["zoom"], 14, 0.55, 18, 0.9,
            ],
            "icon-optional": True,
            "icon-anchor": "center",
            "text-optional": True,
            "text-font": ["Noto Sans Regular"],
            "text-field": NAME,
            "text-size": [
                "interpolate", ["linear"], ["zoom"], 15, 10, 19, 14,
            ],
            "text-max-width": 8,
            "text-offset": [0, 1.0],
            "text-anchor": "top",
            "text-variable-anchor": ["top", "bottom", "left", "right"],
        },
        "paint": {
            "text-color": TEXT_COLOR(),
            "text-halo-color": "#ffffff",
            "text-halo-width": 1.4,
            "text-halo-blur": 0.4,
        },
    }


def insertion_index(layers):
    """Insert just before the place (city/town) label layers so those stay on top."""
    for i, l in enumerate(layers):
        if l.get("source-layer") == "places" or str(l.get("id", "")).startswith("places_"):
            return i
    return len(layers)


def normalize(path):
    with open(path) as f:
        style = json.load(f)
    layers = [l for l in style["layers"] if l.get("id") not in ("pois", "poi_circles")]
    idx = insertion_index(layers)
    layers[idx:idx] = [poi_circles_layer(), pois_layer()]
    style["layers"] = layers
    with open(path, "w") as f:
        json.dump(style, f, indent=2)
    print(f"  {os.path.basename(path)}: {len(layers)} layers (pois injected at {idx})")


def main():
    files = sorted(glob.glob(os.path.join(STYLE_DIR, "*.json")))
    print(f"Normalizing POI layers in {len(files)} styles:")
    for p in files:
        normalize(p)


if __name__ == "__main__":
    main()
