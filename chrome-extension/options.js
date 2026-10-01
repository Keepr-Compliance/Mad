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
