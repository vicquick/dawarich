# frozen_string_literal: true

# vicquick fork: cinematic shareable trip stories. A Story wraps a Trip in a
# public, tokened animation page (/s/:token) — camera follows the route, the
# line draws itself, photos pop at their timestamps, elevation runs synced,
# optional music. Unpublished stories are visible only to their owner.
class CreateStories < ActiveRecord::Migration[8.0]
  def change
    create_table :stories do |t|
      t.references :user, null: false, foreign_key: true
      t.references :trip, null: false, foreign_key: true
      t.string :token, null: false
      t.string :title
      t.boolean :published, null: false, default: false
      t.jsonb :config, null: false, default: {}
      t.timestamps
    end
    add_index :stories, :token, unique: true
  end
end
