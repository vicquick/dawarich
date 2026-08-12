# frozen_string_literal: true

# Android/PWA share target (vicquick fork). Share a place from Google Maps →
# pick Dawarich → it lands here, gets resolved to coordinates server-side, and
# opens as a place on the map (the ?p= link the map already understands).
class ShareController < ApplicationController
  before_action :authenticate_user!

  def receive
    place = GoogleMapsLink.from_shared_text(params[:url], params[:text], params[:title])

    if place.nil?
      redirect_to map_v2_path, alert: "Couldn't read that shared link."
      return
    end

    redirect_to map_v2_path(
      p: "#{place[:lon]},#{place[:lat]}",
      pname: place[:name].presence
    )
  end
end
