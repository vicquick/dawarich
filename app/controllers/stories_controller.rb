# frozen_string_literal: true

# vicquick fork: owner-side story management — create a story for a trip,
# rename it, attach music, flip the publish switch. The public page itself is
# Public::StoriesController.
class StoriesController < ApplicationController
  before_action :authenticate_user!

  def create
    trip = current_user.trips.find(params[:trip_id])
    story = Story.find_or_create_by!(user: current_user, trip: trip) do |s|
      s.title = trip.name
    end
    redirect_to story_public_path(story.token)
  end

  def update
    story = current_user.stories.find(params[:id])
    attrs = params.require(:story).permit(:title, :published, :audio)
    story.audio.attach(attrs[:audio]) if attrs[:audio].present?
    story.update!(attrs.except(:audio))
    redirect_to story_public_path(story.token)
  end
end
