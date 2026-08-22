# frozen_string_literal: true

require 'rails_helper'

# Execution verification: the navbar version-indicator renders the correct
# state for each changelog_consent value on a real authenticated HTML page.
RSpec.describe 'Navbar changelog indicator', type: :request do
  let(:user) { create(:user, admin: true) }

  before do
    allow(DawarichSettings).to receive(:self_hosted?).and_return(true)
    sign_in user
  end

  # vicquick fork: self-hosted never loads the external chibichange widget or its
  # consent prompt — no third-party request, no popup. changelog_indicator_state
  # returns :badge for every consent value here, so the upstream expectations
  # below (prompt when pending, widget when granted) do not apply to this fork.
  context 'when consent is pending (nil)' do
    it 'shows neither the opt-in prompt nor the chibichange script' do
      get '/settings/users'

      expect(response).to have_http_status(:success)
      expect(response.body).not_to include('Stay up to date?')
      expect(response.body).not_to include('/w/v1/loader.js')
    end
  end

  context 'when consent is granted' do
    it 'still mounts no widget on self-hosted, even once granted' do
      user.update!(changelog_consent: :granted)

      get '/settings/users'

      expect(response.body).not_to include('/w/v1/loader.js')
      expect(response.body).not_to include('Stay up to date?')
    end

    it 'still renders the visible Dawarich version number in the navbar' do
      user.update!(changelog_consent: :granted)

      get '/settings/users'

      indicator = Nokogiri::HTML(response.body).at_css('#version-indicator')
      expect(indicator).to be_present
      expect(indicator.text).to include(APP_VERSION)
    end

    it 'renders no widget mount point on self-hosted' do
      user.update!(changelog_consent: :granted)

      get '/settings/users'

      expect(Nokogiri::HTML(response.body).at_css('#chgtool-mount')).to be_nil
    end
  end

  context 'on cloud (not self-hosted), consent granted' do
    before do
      allow(DawarichSettings).to receive(:self_hosted?).and_return(false)
      user.update!(changelog_consent: :granted)
    end

    it 'mounts the widget with the cloud slug' do
      get '/'
      follow_redirect! while response.redirect?

      mount = Nokogiri::HTML(response.body).at_css('#chgtool-mount')
      expect(mount['data-changelog-widget-slug-value']).to eq(CHIBICHANGE_CLOUD_SLUG)
    end
  end

  context 'when consent is declined' do
    it 'shows neither the prompt nor the script' do
      user.update!(changelog_consent: :declined)

      get '/settings/users'

      expect(response.body).not_to include('Stay up to date?')
      expect(response.body).not_to include('/w/v1/loader.js')
    end
  end
end
