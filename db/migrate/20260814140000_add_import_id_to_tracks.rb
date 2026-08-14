# frozen_string_literal: true

# vicquick fork: attribute each track to the import it came from (nil = live
# Dawarich tracking). Lets the map filter tracks by source — "my tracking" vs
# individual GPX files — instead of a separate overlay system.
class AddImportIdToTracks < ActiveRecord::Migration[8.0]
  def up
    add_column :tracks, :import_id, :bigint
    add_index :tracks, :import_id

    # Backfill: a track counts as imported when its points carry an import id.
    execute <<~SQL
      UPDATE tracks SET import_id = sub.import_id
      FROM (
        SELECT track_id, MIN(import_id) AS import_id
        FROM points
        WHERE track_id IS NOT NULL AND import_id IS NOT NULL
        GROUP BY track_id
      ) sub
      WHERE tracks.id = sub.track_id
    SQL
  end

  def down
    remove_column :tracks, :import_id
  end
end
