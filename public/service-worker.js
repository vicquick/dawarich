// Minimal service worker (vicquick fork).
//
// Its ONLY job is to satisfy the PWA installability criteria so Dawarich can be
// installed to the home screen and therefore appear in Android's share sheet
// (see share_target in site.webmanifest). It deliberately does NOT cache: this
// is a live map with authenticated API calls, and a stale-asset cache would be
// a debugging nightmare for zero benefit. Every request goes to the network.
self.addEventListener("install", () => self.skipWaiting())
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()))
self.addEventListener("fetch", () => {
  // Intentionally no respondWith(): the browser handles the request normally.
})
