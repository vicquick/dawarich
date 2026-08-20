# frozen_string_literal: true

module PointsHelper
  COORDINATE_PRECISION = 6

  # The map popup renders the same string from the feature properties, so both
  # surfaces have to agree character for character — otherwise the coordinates
  # shown on the map can't be found in the list.
  def point_coordinates(point)
    format(
      "%<lat>.#{COORDINATE_PRECISION}f, %<lon>.#{COORDINATE_PRECISION}f",
      lat: point.lat, lon: point.lon
    )
  end

  def link_to_date(timestamp)
    datetime = Time.zone.at(timestamp)

    # vicquick fork: map_v2_path, not map_path — the :map namespace owns the
    # map_* name prefix, so our canonical /map route is named :map_v2 and a bare
    # `map_path` raises UrlGenerationError here.
    link_to map_v2_path(start_at: datetime.beginning_of_day, end_at: datetime.end_of_day), \
            class: 'underline hover:no-underline' do
      datetime.strftime('%d.%m.%Y')
    end
  end
end
