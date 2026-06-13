# frozen_string_literal: true

require 'resolv'

# Directions/routing proxy to a self-hosted Valhalla engine.
# Added in the vicquick/dawarich fork to bring turn-by-turn routing into
# Dawarich's own map (synthesizing Dawarich + Atlas). Geometry is decoded
# server-side to GeoJSON so the MapLibre frontend can render it directly.
class Api::V1::RoutingController < ApiController
  VALID_COSTINGS = %w[auto bicycle pedestrian bus truck motor_scooter].freeze

  def directions
    locations = parse_locations
    return render_error('Need at least 2 valid locations (lat,lon)') if locations.size < 2

    costing = params[:costing].to_s
    costing = 'auto' unless VALID_COSTINGS.include?(costing)

    body = {
      locations: locations,
      costing: costing,
      directions_options: { units: 'kilometers' }
    }

    response = valhalla_post('/route', body)
    return render_error("Routing engine error: #{response.code}", :bad_gateway) unless response.success?

    trip = Oj.load(response.body)['trip']
    return render_error('No route found') if trip.nil? || trip['legs'].blank?

    render json: build_geojson(trip), status: :ok
  rescue Faraday::Error, Net::OpenTimeout, Net::ReadTimeout => e
    render_error("Routing engine unreachable: #{e.message}", :service_unavailable)
  end

  private

  def parse_locations
    raw = params[:locations]
    raw = JSON.parse(raw) if raw.is_a?(String)
    Array(raw).filter_map do |loc|
      lat = loc['lat'] || loc[:lat]
      lon = loc['lon'] || loc[:lon]
      next if lat.nil? || lon.nil?

      { lat: lat.to_f, lon: lon.to_f }
    end
  end

  def valhalla_base
    url = ENV['VALHALLA_URL'].presence || 'http://localhost:8002'
    uri = URI(url)
    # Docker assigns both A and AAAA records; Valhalla binds IPv4 only, and Ruby's
    # resolver may prefer the IPv6 address → "connection refused". Pin to IPv4.
    begin
      ipv4 = Resolv.getaddresses(uri.host).find { |a| a.match?(/\A\d{1,3}(\.\d{1,3}){3}\z/) }
      uri.host = ipv4 if ipv4
    rescue StandardError
      # fall back to the original host
    end
    uri.to_s
  end

  def valhalla_post(path, body)
    Faraday.post("#{valhalla_base}#{path}") do |req|
      req.headers['Content-Type'] = 'application/json'
      req.body = body.to_json
      req.options.timeout = 20
      req.options.open_timeout = 5
    end
  end

  # Valhalla returns an encoded polyline (precision 6) per leg + maneuvers.
  def build_geojson(trip)
    legs = trip['legs']
    coords = legs.flat_map { |leg| decode_polyline6(leg['shape']) }
    maneuvers = legs.flat_map { |leg| leg.dig('maneuvers') || [] }.map do |m|
      { instruction: m['instruction'], length_km: m['length'], time_s: m['time'], type: m['type'] }
    end
    summary = trip['summary'] || {}

    {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: coords },
      properties: {
        distance_km: summary['length'],
        duration_s: summary['time'],
        costing: trip['status_message'],
        maneuvers: maneuvers
      }
    }
  end

  # Valhalla polyline, precision 1e6. Returns [[lon,lat], ...] for GeoJSON.
  def decode_polyline6(str)
    return [] if str.blank?

    index = 0
    lat = 0
    lng = 0
    coordinates = []
    factor = 1e6
    while index < str.length
      shift = 0
      result = 0
      loop do
        b = str[index].ord - 63
        index += 1
        result |= (b & 0x1f) << shift
        shift += 5
        break if b < 0x20
      end
      lat += ((result & 1) ? ~(result >> 1) : (result >> 1))

      shift = 0
      result = 0
      loop do
        b = str[index].ord - 63
        index += 1
        result |= (b & 0x1f) << shift
        shift += 5
        break if b < 0x20
      end
      lng += ((result & 1) ? ~(result >> 1) : (result >> 1))

      coordinates << [lng / factor, lat / factor]
    end
    coordinates
  end

  def render_error(message, status = :unprocessable_content)
    render json: { error: message }, status: status
  end
end
