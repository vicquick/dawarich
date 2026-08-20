# frozen_string_literal: true

module Tracks
  # Correct the speed-only transport classification with map evidence
  # (vicquick fork). The classifier guesses from speed/acceleration alone, so
  # a 90 km/h regional train reads as "driving". After map matching we know
  # WHAT the track ran along — metres per OSM way-type — and can fix the
  # obvious confusions. Conservative on purpose: only flips a mode when the
  # way-type evidence is overwhelming, and never touches manually-edited
  # segments (it only adjusts the track-level dominant_mode).
  class ModeRefiner
    RAIL_USES = %w[rail tram].freeze
    FOOT_USES = %w[footway path steps pedestrian pedestrian_crossing sidewalk].freeze
    CYCLE_USES = %w[cycleway mountain_bike].freeze

    def initialize(track)
      @track = track
    end

    def call
      uses = @track.matched_uses
      return :skipped if uses.blank?

      total = uses.values.sum.to_f
      return :skipped if total <= 0

      share = ->(keys) { uses.slice(*keys).values.sum / total }
      speed = @track.avg_speed.to_f
      mode = @track.dominant_mode.to_s

      new_mode = nil
      # Driving-speed movement overwhelmingly on rail = train, not car.
      new_mode = 'train' if %w[driving unknown].include?(mode) && share.call(RAIL_USES) > 0.7 && speed > 25
      # Slow movement almost entirely on foot infrastructure = walking.
      new_mode = 'walking' if mode == 'unknown' && share.call(FOOT_USES) > 0.7 && speed <= 8
      # Mid-speed movement mostly on cycle infrastructure = cycling.
      new_mode = 'cycling' if %w[unknown driving].include?(mode) && share.call(CYCLE_USES) > 0.6 && speed.between?(8, 30)

      return :unchanged if new_mode.nil? || new_mode == mode

      @track.update_columns(dominant_mode: Track.dominant_modes[new_mode])
      :refined
    rescue StandardError => e
      Rails.logger.warn("Tracks::ModeRefiner track=#{@track.id}: #{e.class}: #{e.message}")
      :error
    end
  end
end
