/**
 * Keepr — content script (BACKLOG-3619; BACKLOG-3658).
 *
 * Founder decisions: a Sync is always started from Keepr, and the extension
 * shows NOTHING on the page when idle — no Sync button, and no manual "Send
 * to Keepr" button any more. During a Sync the one Keepr box is job.js's.
 *
 * What this script still does: a signed-in Messages page tells Keepr it is
 * paired (POST /hello {paired:true}, through the worker, which throttles it;
 * no user data), once per page load.
 *
 * An older extension instance (still running in an open tab after the
 * extension was reloaded) may show the old "Send to Keepr" box: this
 * instance takes the page over — writes its token on <html>, which the old
 * one checks every second and then removes its box — and removes a stale box
 * itself.
 *
 * This script never contacts Keepr itself.
 */
(function () {
  "use strict";

  if (window.__keeprSendInstalled) return;
  window.__keeprSendInstalled = true;

  var LEGACY_CONTAINER_ID = "keepr-send-container";
  var OWNER_ATTR = "data-keepr-send-owner";
  var INSTANCE = String(Date.now()) + "-" + Math.random().toString(36).slice(2);

  function claimPage() {
    if (document.documentElement) document.documentElement.setAttribute(OWNER_ATTR, INSTANCE);
    var stale = document.getElementById(LEGACY_CONTAINER_ID);
    if (stale && stale.parentNode) stale.parentNode.removeChild(stale);
  }
  function ownsPage() {
    return !!document.documentElement && document.documentElement.getAttribute(OWNER_ATTR) === INSTANCE;
  }

  var pairedSent = false;
  function sayPaired() {
    if (pairedSent) return;
    if (!globalThis.KeeprScan || globalThis.KeeprScan.signInState(location.pathname) !== "signed_in") return;
    pairedSent = true;
    try {
      chrome.runtime.sendMessage({ type: "keepr-hello", paired: true }, function () {
        void chrome.runtime.lastError; // Keepr or the worker may be asleep: fine
      });
    } catch (_err) {
      // ignore
    }
  }

  // Loaded at document_start (BACKLOG-3620): the single-page app signs in
  // later, so re-check every second; a stale box is removed on each check.
  claimPage();
  var tick = setInterval(function () {
    if (!ownsPage()) {
      // A newer instance owns the page.
      clearInterval(tick);
      return;
    }
    claimPage();
    sayPaired();
  }, 1000);
})();
