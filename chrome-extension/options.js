/**
 * Keepr — the extension's first-run page (BACKLOG-3658 P3b).
 *
 * Informational only. The user's consent is recorded in Keepr (the only
 * gate for a Sync); this page keeps a LOCAL acknowledgement that it was read
 * (localStorage of the extension's own origin), so it is not opened again.
 */
(function () {
  "use strict";

  var ACK_KEY = "keepr-ack-version";
  var ACK_VERSION = "1";

  function acknowledged() {
    try {
      return localStorage.getItem(ACK_KEY) === ACK_VERSION;
    } catch (_e) {
      return false;
    }
  }

  // BACKLOG-3666: pair with the code Keepr shows (the worker runs the exchange).
  // Live (E): wired ONCE — it sat inside render(), which runs again on "Got
  // it", so every Pair click then sent the code twice (two tries a click).
  var pairState = document.getElementById("keepr-pair-state");
  function showPaired() {
    try {
      chrome.runtime.sendMessage({ type: "keepr-pair-status" }, function (r) {
        void chrome.runtime.lastError;
        if (pairState) pairState.textContent = r && r.paired ? "Paired with Keepr." : "Not paired yet.";
      });
    } catch (_e) { /* not in an extension page */ }
  }
  var pairButton = document.getElementById("keepr-pair");
  var pairInput = document.getElementById("keepr-pair-code");
  if (pairButton && pairInput) {
    pairButton.addEventListener("click", function () {
      pairButton.disabled = true;
      if (pairState) pairState.textContent = "Pairing…";
      chrome.runtime.sendMessage({ type: "keepr-pair", code: pairInput.value }, function (r) {
        void chrome.runtime.lastError;
        pairButton.disabled = false;
        if (pairState) pairState.textContent = r && r.ok ? "Paired with Keepr." : (r && r.error) || "Pairing failed. Show a new code in Keepr and try again.";
        if (r && r.ok) pairInput.value = "";
      });
    });
  }
  showPaired();

  function render() {
    var state = document.getElementById("keepr-ack-state");
    var button = document.getElementById("keepr-ack");
    if (!state || !button) return;
    if (acknowledged()) {
      state.textContent = "Thanks. You can close this tab and go back to Keepr.";
      state.className = "done";
      button.style.display = "none";
    } else {
      state.textContent = "";
      button.style.display = "";
    }
  }

  // Founder: which extension build this is.
  var versionLine = document.getElementById("keepr-version");
  if (versionLine) {
    var version = "";
    try {
      version = chrome.runtime.getManifest().version || "";
    } catch (_e) { /* not in an extension page */ }
    versionLine.textContent = version ? "Keepr extension " + version : "";
  }

  var button = document.getElementById("keepr-ack");
  if (button) {
    button.addEventListener("click", function () {
      try {
        localStorage.setItem(ACK_KEY, ACK_VERSION);
      } catch (_e) { /* not kept: the page simply shows again next install */ }
      render();
    });
  }
  render();
})();
