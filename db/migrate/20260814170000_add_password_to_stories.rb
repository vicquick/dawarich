# frozen_string_literal: true

# vicquick fork: Immich-style protected share links — a published story can
# additionally require a password (bcrypt digest; viewers get a signed cookie
# after unlocking).
class AddPasswordToStories < ActiveRecord::Migration[8.0]
  def change
    add_column :stories, :password_digest, :string
  end
end
