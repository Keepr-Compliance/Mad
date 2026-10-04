/**
 * Keepr — the welcome page, opened on install only (UX redesign C4, founder
 * 2026-10-03), laid out as the approved mockup (Welcome.dc.html):
 * 1 Pin Keepr · 2 Link with Keepr · 3 Sync from Keepr, then the link area.
 * It links here like the toolbar popup: the worker makes the 6-digit code
 * (never sent anywhere); the user types it in Keepr.
 */
(function () {
  "use strict";

  var COPY = {
    linking: "Type this code in Keepr",
    linked: "Linked with Keepr",
    keeprDown: "Keepr isn't running",
  };

  function spaced(code) {
    return typeof code === "string" && code.length === 6 ? code.slice(0, 3) + " " + code.slice(3) : String(code || "");
  }

  /** Draw the link area for a popup-style state ({state, link}). io: {link, openApp}. */
  function renderLinkStep(doc, box, view, io) {
    while (box.firstChild) box.removeChild(box.firstChild);
    var add = function (parent, tag, cls, text) {
      var n = doc.createElement(tag);
      if (cls) n.className = cls;
      if (text !== undefined) n.textContent = text;
      parent.appendChild(n);
      return n;
    };
    var button = function (parent, key, label, cls, fn) {
      var b = add(parent, "button", cls, label);
      b.type = "button";
      b.setAttribute("data-keepr", key);
      b.addEventListener("click", fn);
      return b;
    };
    var status = function (cls, text) {
      var s = add(box, "div", "status " + cls);
      add(s, "span", "dot");
      add(s, "span", null, text);
    };
    var state = view && view.state;
    if (state === "linked") {
      status("ok", COPY.linked);
      return;
    }
    if (state === "linking") {
      add(box, "div", "ask", COPY.linking);
      var code = add(box, "div", "code", spaced(view.link && view.link.code));
      code.setAttribute("data-keepr", "code");
      button(box, "open-app", "Open Keepr", "primary", io.openApp);
      return;
    }
    if (state === "keepr_down") {
      status("warn", COPY.keeprDown);
      var row = add(box, "div", "row");
      button(row, "open-app", "Open Keepr", "primary", io.openApp);
      button(row, "link", "Link with Keepr", "secondary", io.link);
      return;
    }
    if (view && view.link && view.link.status === "failed" && view.link.error) add(box, "div", "error", view.link.error);
    button(box, "link", "Link with Keepr", "primary", io.link);
  }

  /**
   * Live (founder 2026-10-03): start / bring forward Keepr through its
   * keepr:// link, WITHOUT a new tab — a link clicked in this page: Chrome
   * hands an external protocol to the OS (asking the user once) and the page
   * stays as it is. Only these two links (Keepr ignores any parameter).
   */
  function launchKeepr(doc, url) {
    if (url !== "keepr://open" && url !== "keepr://link") return false;
    try {
      var a = doc.createElement("a");
      a.setAttribute("href", url);
      a.setAttribute("rel", "noopener");
      a.style.display = "none";
      (doc.body || doc.documentElement).appendChild(a);
      a.click();
      a.parentNode.removeChild(a);
      return true;
    } catch (_e) {
      return false;
    }
  }

  function start(doc, chromeApi) {
    var box = doc.getElementById("keepr-welcome-link");
    var timer = null;
    var lastState = null;
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
      // Live (founder): from this page, never a new tab — linking: its code screen.
      openApp: function () { launchKeepr(doc, lastState === "linking" ? "keepr://link" : "keepr://open"); },
    };
    function refresh() {
      return ask({ type: "keepr-popup-state" }).then(function (view) {
        lastState = view && view.state;
        renderLinkStep(doc, box, view, io);
        if (timer) clearTimeout(timer);
        if (view && view.state === "linking") timer = setTimeout(refresh, 1000);
      });
    }
    return refresh();
  }

  var api = { launchKeepr: launchKeepr, renderLinkStep: renderLinkStep, start: start, COPY: COPY };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else if (typeof document !== "undefined" && typeof chrome !== "undefined") {
    start(document, chrome);
  }
})();
