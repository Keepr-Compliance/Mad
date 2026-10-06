/**
 * Keepr — the welcome page, opened on install only (UX redesign C4, founder
 * 2026-10-03), laid out as the approved mockup (Welcome.dc.html):
 * 1 Pin Keepr · 2 Link with Keepr · 3 Sync from Keepr, then the link area.
 * It links here like the toolbar popup: the worker makes the 6-digit code
 * (never sent anywhere); the user types or pastes it in Keepr. The code area
 * (countdown, "Code expired", Copy code and open Keepr) is the popup's own
 * (linkcode.js) — one copy.
 */
(function (root) {
  "use strict";

  /** The shared code area (linkcode.js). */
  var LinkCode = root.KeeprLinkCode || (typeof require === "function" ? require("./linkcode.js") : null);

  var COPY = {
    linking: LinkCode.COPY.linking,
    linked: "Linked with Keepr",
    keeprDown: "Keepr isn't running",
  };

  /** Draw the link area for a popup-style state ({state, link}). io: {now, link, openApp, copyCode}. */
  function renderLinkStep(doc, box, view, io) {
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
    // Linking / expired: the shared code area (updated in place each second).
    if (LinkCode.render(doc, box, view, io, { button: button })) return;
    while (box.firstChild) box.removeChild(box.firstChild);
    var state = view && view.state;
    if (state === "linked") {
      status("ok", COPY.linked);
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
      now: function () { return Date.now(); },
      link: function () { ask({ type: "keepr-link-start" }).then(refresh); },
      // Live (founder): the code to the clipboard — a write, on the user's click.
      copyCode: function (text) { LinkCode.copyCode(text); },
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
})(typeof globalThis !== "undefined" ? globalThis : this);
