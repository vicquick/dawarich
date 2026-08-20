# frozen_string_literal: true

# vicquick fork: map-matched track geometry (Valhalla trace_route).
# Raw GPS tracks connect points with straight lines — through buildings.
# matched_path stores the same journey snapped to real OSM ways;
# matched_uses stores metres-per-way-type (footway/rail/road…) from
# trace_attributes, which feeds transport-mode refinement.
class AddMatchedPathToTracks < ActiveRecord::Migration[8.0]
  def change
    # Same column shape as original_path: geometry(LineString, 4326).
    add_column :tracks, :matched_path, :line_string, srid: 4326
    add_column :tracks, :matched_confidence, :float
    add_column :tracks, :matched_at, :datetime
    add_column :tracks, :matched_uses, :jsonb
  end
end
