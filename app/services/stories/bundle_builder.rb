# frozen_string_literal: true

# vicquick fork: composes everything the public story player needs into one
# static JSON bundle — no API access from the public page, so a story leaks
# exactly its own data and nothing else.
#
# SOURCE STITCHING: when GPX-type imports overlap the trip window, the story
# rides on THEM (Garmin activities, OrganicMaps recordings) instead of the
# raw phone-point soup. Where several recordings overlap in time (the same
# hike captured by two devices), each hour of the journey is taken from the
# source with the densest coverage in that hour — one coherent line, no
# double-drawn trails.
#
# One array remains the single source of truth for the whole timeline: line,
# camera, elevation, photo placement, day colours and the scrubber all key
# off indexes into it.
module Stories
  class BundleBuilder
    MAX_POINTS = 2_500
    GPX_SOURCES = %w[gpx kml kmz tcx fit].freeze
    DAY_PALETTE = %w[#f97316 #3b82f6 #10b981 #ec4899 #eab308 #a855f7 #06b6d4 #ef4444 #84cc16 #f43f5e].freeze

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
        tz_offset: 7200, # journey-local clock for the day/night cycle
        points: pts.map { |p| [p[:lon].round(6), p[:lat].round(6), p[:ele].to_i, p[:t]] },
        dist_km: dist.map { |d| d.round(3) },
        days: day_segments(pts),
        photos: photo_entries(pts),
        stats: stats(pts, dist),
        audio_url: audio_url,
        config: @story.config || {}
      }
    end

    private

    def empty_bundle
      { title: @story.display_title, points: [], dist_km: [], days: [], photos: [],
        stats: {}, audio_url: nil, tz_offset: 7200, config: @story.config || {} }
    end

    # ---- source selection + stitching ----

    def timeline_points
      rows = gpx_rows.presence || all_rows
      return [] if rows.empty?

      rows = stitch(rows)
      downsample(rows).map { |ll, ele, t, _src| { lon: ll.x, lat: ll.y, ele: ele, t: t } }
    end

    def gpx_import_ids
      @gpx_import_ids ||= @user.imports.where(source: GPX_SOURCES).pluck(:id)
    end

    def gpx_rows
      return [] if gpx_import_ids.empty?

      @user.points
           .where(import_id: gpx_import_ids)
           .where(timestamp: @trip.started_at.to_i..@trip.ended_at.to_i)
           .order(:timestamp)
           .pluck(:lonlat, :altitude, :timestamp, :import_id)
    end

    def all_rows
      @user.points
           .where(timestamp: @trip.started_at.to_i..@trip.ended_at.to_i)
           .order(:timestamp)
           .pluck(:lonlat, :altitude, :timestamp, Arel.sql('0'))
    end

    # Per hour-bucket, keep only the densest source — overlapping recordings
    # of the same hike collapse into one clean line.
    def stitch(rows)
      buckets = rows.group_by { |r| r[2] / 3600 }
      buckets.keys.sort.flat_map do |hour|
        in_bucket = buckets[hour]
        best_src = in_bucket.group_by(&:last).max_by { |_, v| v.length }.first
        in_bucket.select { |r| r.last == best_src }
      end
    end

    def downsample(rows)
      step = [(rows.length.to_f / MAX_POINTS).ceil, 1].max
      sampled = rows.each_slice(step).map(&:first)
      sampled << rows.last if sampled.last != rows.last
      sampled
    end

    # ---- derived data ----

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

    # Day boundaries (journey-local) with a colour each — the line renders as
    # a vivid per-day rainbow, matching how the map colours imported tracks.
    def day_segments(pts)
      segs = []
      last_day = nil
      pts.each_with_index do |p, i|
        day = (p[:t] + 7200) / 86_400
        next if day == last_day

        last_day = day
        segs << {
          i: i,
          color: DAY_PALETTE[segs.length % DAY_PALETTE.length],
          label: Time.at(p[:t]).utc.strftime('%a %-d %b')
        }
      end
      segs
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
      end.sort_by { |p| p[:t] }.first(160)
    end

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
        gain += d if d.positive? && d < 50
      end
      {
        distance_km: dist.last.round(1),
        days: ((@trip.ended_at - @trip.started_at) / 86_400).ceil,
        elevation_gain_m: gain
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
