/**
 * Keepr — the extension's options page (BACKLOG-3658 P3b; UX redesign C4):
 * information and the version only. Linking and status live in the toolbar
 * popup; the first-run page is welcome.html (opened on install).
 */
(function () {
  "use strict";
  var versionLine = document.getElementById("keepr-version");
  if (versionLine) {
    var version = "";
    try {
      version = chrome.runtime.getManifest().version || "";
    } catch (_e) { /* not in an extension page */ }
    versionLine.textContent = version ? "Keepr extension " + version : "";
  }
})();
