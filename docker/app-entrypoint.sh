#!/bin/sh
# vicquick fork: single image, role picked at runtime.
#
# The dawarich-app and dawarich-sidekiq Coolify resources build the SAME
# Dockerfile from the same repo/branch — this dispatcher starts the web
# server or the Sidekiq worker depending on CONTAINER_ROLE. Before this,
# the sidekiq resource wrapped the UPSTREAM freikin/dawarich image and
# never ran a line of fork code (every fork-added job class raised
# "uninitialized constant" in the worker).
set -e

if [ "$CONTAINER_ROLE" = "sidekiq" ]; then
  exec sidekiq-entrypoint.sh sidekiq
fi

exec web-entrypoint.sh "$@"
