# frozen_string_literal: true

# vicquick fork: a shareable cinematic animation of a Trip (/s/:token).
# `published` gates public access — the token link 404s for strangers until
# the owner flips it; the owner always sees a preview. Audio is an optional
# soundtrack played in sync with the animation.
class Story < ApplicationRecord
  belongs_to :user
  belongs_to :trip

  has_one_attached :audio

  before_validation :ensure_token, on: :create

  validates :token, presence: true, uniqueness: true

  def display_title
    title.presence || trip.name.presence || 'A journey'
  end

  private

  def ensure_token
    self.token ||= SecureRandom.urlsafe_base64(16)
  end
end
