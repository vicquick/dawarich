# frozen_string_literal: true

# Map-match one track against OSM ways via self-hosted Valhalla, then refine
# its transport mode from the way-type evidence (vicquick fork). Enqueued
# after track creation and by the backfill sweep; safe to re-run (idempotent
# update of the matched_* columns).
class Tracks::MapMatchJob < ApplicationJob
  queue_as :tracks

  def perform(track_id)
    track = Track.find_by(id: track_id)
    return if track.nil?

    result = Tracks::MapMatcher.new(track).call
    Tracks::ModeRefiner.new(track.reload).call if result == :matched
  end
end
