# frozen_string_literal: true

class Photos::Search
  attr_reader :user, :start_date, :end_date, :errors

  def self.cached(user, start_date: '1970-01-01', end_date: nil, expires_in: 1.minute)
    key = "photos_search/#{user.id}/#{start_date}/#{end_date}"
    cached = Rails.cache.read(key)
    return cached if cached.present?

    result = new(user, start_date: start_date, end_date: end_date).call
    Rails.cache.write(key, result, expires_in: expires_in) if result.present?
    result
  end

  def initialize(user, start_date: '1970-01-01', end_date: nil)
    @user = user
    @start_date = start_date
    @end_date = end_date
    @errors = []
  end

  def call
    photos = []

    immich_photos = request_immich if user.immich_integration_configured?
    photoprism_photos = request_photoprism if user.photoprism_integration_configured?

    photos << immich_photos if immich_photos.present?
    photos << photoprism_photos if photoprism_photos.present?

    photos.flatten.map { |photo| Api::PhotoSerializer.new(photo, photo[:source]).call }
  end

  private

  def request_immich
    assets = Immich::RequestPhotos.new(
      user,
      start_date: start_date,
      end_date: end_date
    ).call
    if assets.nil?
      errors << :immich
      return nil
    end

    assets.map { |asset| transform_asset(asset, 'immich') }.compact
  end

  def request_photoprism
    service = Photoprism::RequestPhotos.new(user, start_date: start_date, end_date: end_date)
    assets = service.call
    errors << :photoprism if service.connection_failed?

    assets.map { |asset| transform_asset(asset, 'photoprism') }.compact
  end

  # vicquick fork: videos are kept. They used to be dropped outright, which
  # silently shrank a trip's gallery (the Sweden trip showed 201 of 202 assets).
  # Immich serves a poster frame for a video on the same thumbnail endpoint, so
  # it renders like any other tile — the view marks it with a play badge.
  def transform_asset(asset, source)
    asset.merge(source: source)
  end
end
