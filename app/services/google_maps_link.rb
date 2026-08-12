# frozen_string_literal: true

require 'net/http'
require 'uri'
require 'cgi'

# Resolve a shared Google Maps link into a plain {lat, lon, name} (vicquick
# fork). Used by the paste-a-link search path and by the Android share target.
#
# Short links (maps.app.goo.gl / goo.gl) are followed server-side, which also
# keeps Google away from the user's browser — no cookies, no client IP.
class GoogleMapsLink
  HOST_RE = %r{\Ahttps?://[\w.-]*(google\.[\w.]+|goo\.gl)/}i
  URL_IN_TEXT_RE = %r{https?://\S+}

  class << self
    # Pull the first URL out of shared text ("Look at this <url>") and resolve it.
    def from_shared_text(*candidates)
      url = candidates.compact.flat_map { |c| c.to_s.scan(URL_IN_TEXT_RE) }
                      .find { |u| supported?(u) }
      url && resolve(url)
    end

    def supported?(url)
      url.to_s.match?(HOST_RE)
    end

    def resolve(url)
      return nil unless supported?(url)

      final_url, body = follow_redirects(url)
      # Short links usually 302 to the long URL, but Google sometimes answers
      # with an HTML interstitial instead — then the real maps URL is only in
      # the markup (og:url / a canonical link), so fall back to scraping it.
      parse(final_url) || parse(maps_url_in(body))
    rescue StandardError
      nil
    end

    private

    def follow_redirects(url, hops = 5)
      body = nil
      hops.times do
        uri = URI(url)
        http = Net::HTTP.new(uri.host, uri.port)
        http.use_ssl = uri.scheme == 'https'
        http.open_timeout = 4
        http.read_timeout = 6
        req = Net::HTTP::Get.new(uri)
        # A browser UA matters: Google serves a different (redirect-less) page
        # to unknown clients.
        req['User-Agent'] =
          'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Mobile Safari/537.36'
        req['Accept-Language'] = 'en'
        resp = http.request(req)
        unless resp.is_a?(Net::HTTPRedirection) && resp['location'].present?
          body = resp.body.to_s
          return [url, body]
        end

        url = URI.join(url, resp['location']).to_s
      end
      [url, body]
    end

    # Dig the real maps URL out of an HTML interstitial.
    def maps_url_in(html)
      return nil if html.blank?

      html[%r{<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']}i, 1] ||
        html[%r{https://www\.google\.[\w.]+/maps/[^"'\\ <]+}i]
    end

    # Google encodes the authoritative place coords as !3d<lat>!4d<lon>; the
    # @lat,lon in the path is only the camera, so prefer the former.
    def parse(url)
      return nil if url.blank?

      decoded = CGI.unescape(url.to_s)
      lat = lon = nil
      if (m = decoded.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/))
        lat, lon = m[1], m[2]
      elsif (m = decoded.match(/[?&](?:q|query|daddr)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/))
        lat, lon = m[1], m[2]
      elsif (m = decoded.match(%r{/@(-?\d+\.\d+),(-?\d+\.\d+)}))
        lat, lon = m[1], m[2]
      end
      return nil if lat.nil?

      name = decoded[%r{/place/([^/@]+)}, 1].to_s.tr('+', ' ').strip.presence
      { lat: lat.to_f, lon: lon.to_f, name: name }
    end
  end
end
