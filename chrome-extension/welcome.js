/**
 * Keepr — the welcome page, opened on install only (UX redesign C4, founder
 * 2026-10-03): 1 Pin Keepr · 2 Link with Keepr · 3 Sync from Keepr. Step 2
 * links here, like the toolbar popup: the worker makes the 6-digit code
 * (never sent anywhere); the user types it in Keepr. One line + a button.
 */
(function () {
  "use strict";

  var COPY = {
    notLinked: "Link this browser with your Keepr app.",
    linking: "Type this code in Keepr",
    linked: "Linked with Keepr ✓",
    keeprDown: "Start the Keepr app first, then Link.",
  };

  function spaced(code) {
    return typeof code === "string" && code.length === 6 ? code.slice(0, 3) + " " + code.slice(3) : String(code || "");
  }

  /** Draw step 2 for a popup-style state ({state, link}). io: {link, openApp}. */
  function renderLinkStep(doc, box, view, io) {
    while (box.firstChild) box.removeChild(box.firstChild);
    var line = function (cls, text) {
      var p = doc.createElement("p");
      if (cls) p.className = cls;
      p.textContent = text;
      box.appendChild(p);
      return p;
    };
    var button = function (key, label, cls, fn) {
      var b = doc.createElement("button");
      b.type = "button";
      if (cls) b.className = cls;
      b.setAttribute("data-keepr", key);
      b.textContent = label;
      b.addEventListener("click", fn);
      box.appendChild(b);
      return b;
    };
    var state = view && view.state;
    if (state === "linked") {
      line("ok", COPY.linked);
      return;
    }
    if (state === "linking") {
      var code = doc.createElement("div");
      code.className = "code";
      code.textContent = spaced(view.link && view.link.code);
      box.appendChild(code);
      line(null, COPY.linking);
      button("open-app", "Open Keepr", null, io.openApp);
      return;
    }
    if (state === "keepr_down") {
      line(null, COPY.keeprDown);
      button("open-app", "Open Keepr", null, io.openApp);
      button("link", "Link", "secondary", io.link);
      return;
    }
    line(null, COPY.notLinked);
    if (view && view.link && view.link.status === "failed" && view.link.error) line("error", view.link.error);
    button("link", "Link", null, io.link);
  }

  function start(doc, chromeApi) {
    var box = doc.getElementById("keepr-welcome-link");
    var timer = null;
    var ask = function (message) {
      return new Promise(function (resolve) {
        try {
          chromeApi.runtime.sendMessage(message, function (r) {
            void chromeApi.runtime.lastError;
            resolve(r || null);
          });
        } catch (_e) {
          resolve(null);
        }
      });
    };
    var io = {
      link: function () { ask({ type: "keepr-link-start" }).then(refresh); },
      openApp: function () { ask({ type: "keepr-open-app" }); },
    };
    function refresh() {
      return ask({ type: "keepr-popup-state" }).then(function (view) {
        renderLinkStep(doc, box, view, io);
        if (timer) clearTimeout(timer);
        if (view && view.state === "linking") timer = setTimeout(refresh, 1000);
      });
    }
    var versionLine = doc.getElementById("keepr-version");
    if (versionLine) {
      try {
        versionLine.textContent = "Keepr extension " + (chromeApi.runtime.getManifest().version || "");
      } catch (_e) { /* not in an extension page */ }
    }
    return refresh();
  }

  var api = { renderLinkStep: renderLinkStep, start: start, COPY: COPY };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else if (typeof document !== "undefined" && typeof chrome !== "undefined") {
    start(document, chrome);
  }
})();
