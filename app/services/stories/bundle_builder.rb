# frozen_string_literal: true

# vicquick fork: composes everything the public story player needs into one
# static JSON bundle — no API access from the public page, so a story leaks
# exactly its own data and nothing else.
#
# One array is the single source of truth for the whole timeline: the
# downsampled point polyline. Line drawing, camera path, elevation profile,
# photo placement and the scrubber all key off indexes into it, so they can
# never drift apart.
module Stories
  class BundleBuilder
    MAX_POINTS = 2_500

    def initialize(story)
      @story = story
      @trip = story.trip
      @user = story.user
    end

    def call
      pts = timeline_points
      return empty_bundle if pts.length < 2

      dist = cumulative_distance(pts)

      {
        title: @story.display_title,
        started_at: @trip.started_at.to_i,
        ended_at: @trip.ended_at.to_i,
        date_label: date_label,
        # [ [lon, lat, ele_m, unix_ts], ... ]
        points: pts.map { |p| [p[:lon].round(6), p[:lat].round(6), p[:ele].to_i, p[:t]] },
        # cumulative km, same indexing as points
        dist_km: dist.map { |d| d.round(3) },
        photos: photo_entries(pts),
        stats: stats(pts, dist),
        audio_url: audio_url,
        config: @story.config || {}
      }
    end

    private

    def empty_bundle
      { title: @story.display_title, points: [], dist_km: [], photos: [],
        stats: {}, audio_url: nil, config: @story.config || {} }
    end

    def timeline_points
      rows = @user.points
                  .where(timestamp: @trip.started_at.to_i..@trip.ended_at.to_i)
                  .order(:timestamp)
                  .pluck(:lonlat, :altitude, :timestamp)
      return [] if rows.empty?

      step = [(rows.length.to_f / MAX_POINTS).ceil, 1].max
      sampled = rows.each_slice(step).map(&:first)
      sampled << rows.last if sampled.last != rows.last
      sampled.map { |ll, ele, t| { lon: ll.x, lat: ll.y, ele: ele, t: t } }
    end

    def cumulative_distance(pts)
      total = 0.0
      [0.0].tap do |acc|
        pts.each_cons(2) do |a, b|
          total += haversine_km(a, b)
          acc << total
        end
      end
    end

    def haversine_km(a, b)
      rad = Math::PI / 180
      dlat = (b[:lat] - a[:lat]) * rad
      dlon = (b[:lon] - a[:lon]) * rad
      h = Math.sin(dlat / 2)**2 +
          Math.cos(a[:lat] * rad) * Math.cos(b[:lat] * rad) * Math.sin(dlon / 2)**2
      2 * 6371.0 * Math.asin(Math.sqrt(h))
    end

    def photo_entries(pts)
      assets = Photos::Search.new(@user,
                                  start_date: @trip.started_at.iso8601,
                                  end_date: @trip.ended_at.iso8601).call
      verifier = Rails.application.message_verifier(:story_photo)

      assets.filter_map do |a|
        t = begin
          Time.parse(a[:localDateTime].to_s).to_i
        rescue StandardError
          nil
        end
        next if t.nil?

        idx = nearest_index(pts, t)
        {
          idx: idx,
          t: t,
          type: a[:type],
          orientation: a[:orientation],
          url: "/s/#{@story.token}/photo/#{CGI.escape(verifier.generate([a[:id], a[:source]]))}"
        }
      end.sort_by { |p| p[:t] }.first(120)
    end

    # Binary search for the point closest in time.
    def nearest_index(pts, t)
      lo = 0
      hi = pts.length - 1
      while lo < hi
        mid = (lo + hi) / 2
        pts[mid][:t] < t ? lo = mid + 1 : hi = mid
      end
      lo
    end

    def stats(pts, dist)
      gain = 0
      pts.each_cons(2) do |a, b|
        d = b[:ele].to_i - a[:ele].to_i
        gain += d if d.positive? && d < 50 # spike guard
      end
      {
        distance_km: dist.last.round(1),
        days: ((@trip.ended_at - @trip.started_at) / 86_400).ceil,
        elevation_gain_m: gain,
        photos: nil # filled client-side from photos.length
      }
    end

    def date_label
      s = @trip.started_at
      e = @trip.ended_at
      if s.year == e.year && s.month == e.month
        "#{s.strftime('%-d.')}–#{e.strftime('%-d. %B %Y')}"
      else
        "#{s.strftime('%-d. %b')} – #{e.strftime('%-d. %b %Y')}"
      end
    end

    def audio_url
      return nil unless @story.audio.attached?

      Rails.application.routes.url_helpers.rails_blob_path(@story.audio, disposition: 'inline', only_path: true)
    end
  end
end
