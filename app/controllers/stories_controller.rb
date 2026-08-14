# frozen_string_literal: true

# vicquick fork: owner-side story management — the /stories overview page,
# create-from-trip, the builder's settings PATCH, delete. The public player
# is Public::StoriesController.
class StoriesController < ApplicationController
  before_action :authenticate_user!

  CONFIG_KEYS = %w[theme accent camera duration line_style photo_size
                   show_elevation show_photos subtitle].freeze

  def index
    @stories = current_user.stories.includes(:trip).order(updated_at: :desc)
  end

  def create
    trip = current_user.trips.find(params[:trip_id])
    story = Story.find_or_create_by!(user: current_user, trip: trip) do |s|
      s.title = trip.name
    end
    redirect_to story_public_path(story.token)
  end

  def update
    story = current_user.stories.find(params[:id])
    attrs = params.require(:story).permit(:title, :published, :audio, :remove_audio, config: CONFIG_KEYS)

    story.audio.attach(attrs[:audio]) if attrs[:audio].present?
    story.audio.purge if attrs[:remove_audio] == 'true' && story.audio.attached?

    updates = attrs.except(:audio, :remove_audio, :config)
    updates[:config] = (story.config || {}).merge(attrs[:config].to_h) if attrs[:config].present?
    story.update!(updates) if updates.present?
    story.touch if updates.blank? # bust the bundle cache after audio-only changes

    redirect_back fallback_location: story_public_path(story.token)
  end

  def destroy
    current_user.stories.find(params[:id]).destroy!
    redirect_to stories_path, notice: 'Story deleted'
  end
end
