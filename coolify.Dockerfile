# vicquick/dawarich overlay: base = upstream image, + routing/directions + date-range default.
FROM freikin/dawarich:latest
COPY app/controllers/api/v1/routing_controller.rb /var/app/app/controllers/api/v1/routing_controller.rb
COPY config/routes.rb /var/app/config/routes.rb
COPY app/controllers/map/maplibre_controller.rb /var/app/app/controllers/map/maplibre_controller.rb
COPY app/javascript/controllers/maps/maplibre/directions_manager.js /var/app/app/javascript/controllers/maps/maplibre/directions_manager.js
COPY app/javascript/controllers/maps/maplibre_controller.js /var/app/app/javascript/controllers/maps/maplibre_controller.js
COPY app/views/map/maplibre/_directions_panel.html.erb /var/app/app/views/map/maplibre/_directions_panel.html.erb
COPY app/views/map/maplibre/index.html.erb /var/app/app/views/map/maplibre/index.html.erb
COPY app/assets/svg/icons/lucide/outline/route.svg /var/app/app/assets/svg/icons/lucide/outline/route.svg
RUN rm -rf /var/app/tmp/cache/bootsnap* && \
    cd /var/app && SECRET_KEY_BASE_DUMMY=1 RAILS_ENV=production bin/rails assets:precompile 2>&1 | tail -3 || echo "precompile note"
ENTRYPOINT ["web-entrypoint.sh"]
CMD ["bin/rails","server","-p","3000","-b","::"]
