# frozen_string_literal: true

if User.none?
  Rails.logger.debug 'Creating user...'

  email = 'demo@dawarich.app'

  User.create!(
    email:,
    password: 'safepassword',
    password_confirmation: 'safepassword',
    admin: true,
    status: :active,
    active_until: 100.years.from_now
  )

  Rails.logger.debug "User created: '#{email}' / password: 'safepassword'"
end

if Country.none?
  Rails.logger.debug 'Creating countries...'

  countries_json = Oj.load(File.read(Rails.root.join('lib/assets/countries.geojson')))

  factory = RGeo::Geos.factory(srid: 4326)
  countries_multi_polygon = RGeo::GeoJSON.decode(countries_json.to_json, geo_factory: factory)

  ActiveRecord::Base.transaction do
    countries_multi_polygon.each do |country|
      Rails.logger.debug "Creating #{country.properties['name']}..."

      Country.create!(
        name: country.properties['name'],
        iso_a2: country.properties['ISO3166-1-Alpha-2'],
        iso_a3: country.properties['ISO3166-1-Alpha-3'],
        geom: country.geometry
      )
    end
  end
end

# vicquick fork: do NOT seed Dawarich's default tags (Home/Work/Favorite/Travel
# Plans). We organise places Google-style (Starred / Want to go / Favourite),
# and the empty defaults were just clutter. Leaving tags entirely user-defined.
