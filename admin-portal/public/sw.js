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
 *   - activate also enables navigation preload where the browser has it.
 *   - fetch: only top-level page navigations (mode 'navigate', GET) are
 *     handled; they always go to the network (the preload response when
 *     there is one, else fetch). Everything else — API calls,
 *     Supabase, RSC requests, Sentry, static chunks — is not intercepted.
 *   - offline navigation: an inline page, built here, never read from a cache.
 *     It re-checks the connection on a countdown and reloads when it is back.
 *
 * There is no cache.put / cache.add / cache.addAll anywhere in this file.
 * Kill switch: replace this file with one that calls
 * self.registration.unregister() in activate.
 */

// Script for the offline screen. It probes a same-origin URL that the
// middleware skips (HEAD /manifest.webmanifest, not cached) and reloads the
// page as soon as any HTTP answer comes back. Probe schedule: 5s, 10s, 20s,
// then every 30s; also on the browser's `online` event and on "Retry now".
// It is a non-navigation request, so this worker does not intercept it.
// Allowed by the response's own CSP via OFFLINE_SCRIPT_HASH below. If you
// change one character of OFFLINE_SCRIPT, the hash must change too:
// __tests__/pwa-3797/sw.test.ts recomputes it from the served page, fails on
// a mismatch and prints the value to paste here.
var OFFLINE_SCRIPT =
  '(function(){' +
  "var P='/manifest.webmanifest',D=[5,10,20,30],n=0,left=0,t=null,busy=false;" +
  "var st=document.getElementById('status'),b=document.getElementById('retry');" +
  'function schedule(){left=D[Math.min(n,D.length-1)];n++;tick();}' +
  "function tick(){if(busy)return;if(left<=0){check();return;}st.textContent='Retrying in '+left+'s';left--;t=setTimeout(tick,1000);}" +
  'function check(){if(busy)return;busy=true;clearTimeout(t);' +
  "b.className='busy';b.setAttribute('aria-busy','true');b.textContent='Checking\\u2026';st.textContent='Checking connection\\u2026';" +
  "fetch(P+'?probe='+Date.now(),{method:'HEAD',cache:'no-store'}).then(function(){" +
  "st.textContent='Back online. Reloading\\u2026';location.reload();" +
  "},function(){busy=false;b.className='';b.removeAttribute('aria-busy');b.textContent='Retry now';schedule();});}" +
  "b.addEventListener('click',function(e){e.preventDefault();check();});" +
  "window.addEventListener('online',check);" +
  'schedule();' +
  '})();';
var OFFLINE_SCRIPT_HASH = 'sha256-9js96y3LeS23DtaUohBnEktB0rlatpbgRvBt2u9d7Ng=';

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
  '#status{font-size:14px;color:#6b7280;margin:16px 0 0;min-height:21px}' +
  'a{display:inline-flex;align-items:center;gap:8px;background:#111827;color:#fff;text-decoration:none;font-size:16px;padding:12px 24px;border-radius:8px}' +
  'a.busy{opacity:.8;pointer-events:none}' +
  'a.busy::before{content:"";width:14px;height:14px;border:2px solid rgba(255,255,255,.4);border-top-color:#fff;border-radius:50%;animation:s .8s linear infinite}' +
  '@keyframes s{to{transform:rotate(360deg)}}' +
  '</style></head><body><main>' +
  "<h1>You're offline</h1>" +
  '<p>Keepr Admin needs an internet connection. This page reloads by itself when the connection is back.</p>' +
  // Empty href = the current document URL: without script it is still a
  // plain same-URL navigation back through this worker to the network.
  '<a id="retry" href="">Retry now</a>' +
  '<p id="status" role="status" aria-live="polite"></p>' +
  '<script>' + OFFLINE_SCRIPT + '</script>' +
  '</main></body></html>';

function offlineResponse() {
  return new Response(OFFLINE_HTML, {
    status: 503,
    statusText: 'Offline',
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      // Only the one hashed script may run, and it may only talk to this
      // origin (the probe). No inline handlers, no other script.
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; script-src '" +
        OFFLINE_SCRIPT_HASH +
        "'; connect-src 'self'; base-uri 'none'; form-action 'none'",
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
        // Navigation preload: the browser starts the page request while this
        // worker is still booting, instead of after it. Not in every browser.
        if (self.registration && self.registration.navigationPreload) {
          return self.registration.navigationPreload.enable();
        }
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
  // Use the preload response when the browser made one; otherwise fetch.
  // Either way the network answer is returned unchanged (redirects, 500s);
  // only a network failure becomes the offline screen.
  event.respondWith(
    Promise.resolve(event.preloadResponse)
      .then(function (preloaded) {
        return preloaded || fetch(request);
      })
      .catch(function () {
        return offlineResponse();
      })
  );
});
