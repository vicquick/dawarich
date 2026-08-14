# frozen_string_literal: true

# Sweep unmatched tracks into the matching pipeline in gentle batches
# (vicquick fork). Valhalla is local and fast (~100 ms/track), but thousands
# of one-off jobs at once would crowd the tracks queue — so this enqueues a
# batch, then re-schedules itself until nothing is left.
class Tracks::MapMatchBackfillJob < ApplicationJob
  queue_as :tracks

  BATCH = 200

  def perform(user_id = nil)
    scope = Track.where(matched_at: nil)
    scope = scope.where(user_id: user_id) if user_id
    scope = scope.where.not(dominant_mode: Track.dominant_modes.values_at(*%w[train flying boat stationary]))

    ids = scope.order(created_at: :desc).limit(BATCH).pluck(:id)
    return if ids.empty?

    ids.each { |id| Tracks::MapMatchJob.perform_later(id) }
    # More waiting? Come back after this batch has had time to drain.
    self.class.set(wait: 5.minutes).perform_later(user_id) if scope.count > ids.length
  end
end
