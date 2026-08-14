# frozen_string_literal: true

# vicquick fork: the public story page (/s/:token). No auth, no session use —
# a published story is viewable by anyone holding the token link; an
# unpublished one only renders for its signed-in owner (preview). Everything
# the page needs ships inline as one bundle; photos stream through the signed
# proxy below, so neither Immich nor any API is ever exposed.
class Public::StoriesController < ApplicationController
  skip_before_action :unread_notifications, raise: false

  before_action :set_story
  before_action :require_viewable!

  layout false

  def show
    response.set_header('X-Robots-Tag', 'noindex, nofollow')
    @bundle = Rails.cache.fetch(bundle_cache_key, expires_in: 10.minutes) do
      Stories::BundleBuilder.new(@story).call
    end
    @owner = owner?
  end

  # Photo proxy: only URLs this app signed (per asset) are fetchable, streamed
  # server-side with the OWNER's integration credentials — the viewer's
  # browser never talks to Immich/Photoprism.
  def photo
    asset_id, source = Rails.application.message_verifier(:story_photo).verified(params[:sig].to_s)
    return head :forbidden if asset_id.blank?

    upstream = Photos::Thumbnail.new(@story.user, source, asset_id).call
    return head :bad_gateway unless upstream.success?

    response.set_header('Cache-Control', 'public, max-age=604800')
    send_data upstream.body, type: 'image/jpeg', disposition: 'inline'
  rescue StandardError
    head :bad_gateway
  end

  private

  def set_story
    @story = Story.find_by(token: params[:token])
    head :not_found if @story.nil?
  end

  def require_viewable!
    return if @story.published? || owner?

    head :not_found
  end

  def owner?
    current_user.present? && current_user.id == @story.user_id
  end

  def bundle_cache_key
    "story_bundle/#{@story.id}/#{@story.updated_at.to_i}"
  end
end
