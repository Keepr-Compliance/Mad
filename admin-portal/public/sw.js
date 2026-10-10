/*
 * Keepr admin portal service worker — BACKLOG-3797 (copy of the broker
 * portal worker, BACKLOG-3796; only the offline wording differs).
 *
 * This worker CACHES NOTHING. It exists so the portal can be installed to a
 * phone home screen and show a plain "You're offline" screen instead of the
 * browser's error page when there is no connection.
 *
 * Rules (each one guarded by __tests__/pwa-3797/sw.test.ts):
 *   - install: no precache.
 *   - activate: delete EVERY Cache Storage entry, whatever its name, then
 *     claim open pages. Defensive against any earlier or future cache.
 *   - fetch: only top-level page navigations (mode 'navigate', GET) are
 *     handled; they always go to the network. Everything else — API calls,
 *     Supabase, RSC requests, Sentry, static chunks — is not intercepted.
 *   - offline navigation: an inline page, built here, never read from a cache.
 *
 * There is no cache.put / cache.add / cache.addAll anywhere in this file.
 * Kill switch: replace this file with one that calls
 * self.registration.unregister() in activate.
 */

var OFFLINE_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">' +
  '<title>Keepr Admin - offline</title>' +
  '<style>' +
  'body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
  'background:#f9fafb;color:#111827;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px;box-sizing:border-box}' +
  'main{max-width:360px;text-align:center}' +
  'h1{font-size:20px;margin:0 0 8px}' +
  'p{font-size:16px;line-height:1.5;color:#4b5563;margin:0 0 24px}' +
  'a{display:inline-block;background:#111827;color:#fff;text-decoration:none;font-size:16px;padding:12px 24px;border-radius:8px}' +
  '</style></head><body><main>' +
  "<h1>You're offline</h1>" +
  '<p>Keepr Admin needs an internet connection. Reconnect and tap Retry.</p>' +
  // Empty href = the current document URL: a plain same-URL navigation that
  // goes back through this worker to the network. No script on this page.
  '<a href="">Retry</a>' +
  '</main></body></html>';

function offlineResponse() {
  return new Response(OFFLINE_HTML, {
    status: 503,
    statusText: 'Offline',
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    },
  });
}

self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (keys) {
        return Promise.all(
          keys.map(function (key) {
            return caches.delete(key);
          })
        );
      })
      .then(function () {
        return self.clients.claim();
      })
  );
});

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.mode !== 'navigate' || request.method !== 'GET') {
    // Not handled: the browser fetches it from the network as if no worker
    // were installed.
    return;
  }
  event.respondWith(
    fetch(request).catch(function () {
      return offlineResponse();
    })
  );
});
