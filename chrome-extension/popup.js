/**
 * Keepr — the toolbar popup: the extension's HOME (UX redesign C2, founder
 * 2026-10-03). One short line + a button per state:
 *
 *   keepr_down    "Keepr isn't running"            [Open Keepr]  (keepr://link)
 *   out_of_date   "Update the Keepr extension"     version line
 *   not_linked    "Not linked to Keepr"            [Link]
 *   linking       the 6-digit code, "Type this code in Keepr", m:ss  [Open Keepr] (Cancel)
 *   linked        "Linked to a***@example.com", last sync
 *                 [Go to Google Messages] [Open Keepr] (Unlink → confirm)
 *
 * The state is asked of the worker each time the popup opens (the worker
 * sleeps); while linking it is asked again every second. The code is made by
 * the worker and never sent anywhere. The email is masked by Keepr.
 */
(function (root) {
  "use strict";

  var COPY = {
    keepr_down: "Keepr isn't running",
    out_of_date: "Update the Keepr extension",
    not_linked: "Not linked to Keepr",
    linking: "Type this code in Keepr",
    linked: "Linked to Keepr",
    unlinkAsk: "Unlink from Keepr? You'll need to link again to sync",
  };

  function el(doc, tag, cls, text) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function lastSyncText(atMs, nowMs) {
    if (typeof atMs !== "number") return "No sync yet";
    var min = Math.max(0, Math.floor((nowMs - atMs) / 60000));
    if (min < 1) return "Last sync: just now";
    if (min < 60) return "Last sync: " + min + " min ago";
    if (min < 24 * 60) return "Last sync: " + Math.floor(min / 60) + " h ago";
    return "Last sync: " + Math.floor(min / (24 * 60)) + " d ago";
  }

  function countdown(ms) {
    var s = Math.max(0, Math.ceil(ms / 1000));
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }

  /** "123456" → "123 456" (easier to read and type). */
  function spaced(code) {
    return typeof code === "string" && code.length === 6 ? code.slice(0, 3) + " " + code.slice(3) : String(code || "");
  }

  /**
   * Draw one state into `box`. io: { link, cancel, openKeepr, openApp,
   * openMessages, unlink, now, confirmUnlink (bool), setConfirm }.
   */
  function renderPopup(doc, box, view, io) {
    while (box.firstChild) box.removeChild(box.firstChild);
    var state = view && view.state;
    var head = el(doc, "div", "head");
    var dot = el(doc, "span", "dot" + (state === "linked" ? " ok" : state === "keepr_down" || state === "out_of_date" ? " bad" : ""));
    head.appendChild(dot);
    head.appendChild(el(doc, "span", null, "Keepr"));
    box.appendChild(head);
    var buttons = el(doc, "div", "buttons");
    var button = function (key, label, cls, fn) {
      var b = el(doc, "button", cls || null, label);
      b.type = "button";
      b.setAttribute("data-keepr", key);
      b.addEventListener("click", fn);
      buttons.appendChild(b);
      return b;
    };
    var now = io.now ? io.now() : Date.now();

    if (state === "keepr_down") {
      box.appendChild(el(doc, "div", "line", COPY.keepr_down));
      button("open-app", "Open Keepr", "primary", io.openApp);
    } else if (state === "out_of_date") {
      box.appendChild(el(doc, "div", "line", COPY.out_of_date));
      box.appendChild(el(doc, "div", "muted", "This is " + (view.version || "?") + "; Keepr needs " + (view.minVersion || "a newer one") + "."));
    } else if (state === "linking") {
      var link = view.link || {};
      box.appendChild(el(doc, "div", "code", spaced(link.code)));
      box.appendChild(el(doc, "div", "line", COPY.linking));
      if (typeof link.expiresAt === "number") box.appendChild(el(doc, "div", "muted", countdown(link.expiresAt - now)));
      button("open-app", "Open Keepr", "primary", io.openApp);
      button("cancel", "Cancel", "link", io.cancel);
    } else if (state === "linked") {
      box.appendChild(el(doc, "div", "line", view.email ? "Linked to " + view.email : COPY.linked));
      box.appendChild(el(doc, "div", "muted", lastSyncText(view.lastSyncAt, now)));
      if (io.confirmUnlink) {
        box.appendChild(el(doc, "div", "line", COPY.unlinkAsk));
        button("unlink-yes", "Unlink", "primary", io.unlink);
        button("unlink-no", "Cancel", "link", function () { io.setConfirm(false); });
      } else {
        button("open-messages", "Go to Google Messages", "primary", io.openMessages);
        button("open-keepr", "Open Keepr", null, io.openKeepr);
        button("unlink", "Unlink", "link", function () { io.setConfirm(true); });
      }
    } else {
      // not_linked (and a link that failed: its reason)
      box.appendChild(el(doc, "div", "line", COPY.not_linked));
      var failed = view && view.link && view.link.status === "failed" && view.link.error;
      if (failed) box.appendChild(el(doc, "div", "error", failed));
      button("link", "Link", "primary", io.link);
    }
    box.appendChild(buttons);
    if (view && view.version && state !== "out_of_date") box.appendChild(el(doc, "div", "muted", "Keepr extension " + view.version));
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
    var box = doc.getElementById("keepr-popup");
    var view = null;
    var confirmUnlink = false;
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
    var draw = function () {
      renderPopup(doc, box, view || { state: "keepr_down" }, io);
    };
    var refresh = function () {
      return ask({ type: "keepr-popup-state" }).then(function (r) {
        view = r;
        draw();
        // Linking: ask again every second (the code is typed in Keepr).
        if (timer) clearTimeout(timer);
        if (view && view.state === "linking") timer = setTimeout(refresh, 1000);
      });
    };
    var io = {
      now: function () { return Date.now(); },
      link: function () { ask({ type: "keepr-link-start" }).then(refresh); },
      cancel: function () { ask({ type: "keepr-link-cancel" }).then(refresh); },
      // Live (founder): Keepr not running → keepr://open; linking → keepr://link
      // (its code screen) — from this popup, never a new tab.
      openApp: function () { launchKeepr(doc, view && view.state === "linking" ? "keepr://link" : "keepr://open"); },
      // Linked: signed /focus only (no tab); refused or unreachable → keepr://open.
      openKeepr: function () {
        ask({ type: "keepr-focus" }).then(function (r) {
          // SR: keepr://open only when Keepr is unreachable.
          if (!r || (!r.ok && r.launch)) launchKeepr(doc, "keepr://open");
        });
      },
      openMessages: function () { ask({ type: "keepr-open-messages" }); },
      unlink: function () {
        confirmUnlink = false;
        io.confirmUnlink = false;
        ask({ type: "keepr-unlink" }).then(refresh);
      },
      setConfirm: function (on) {
        confirmUnlink = on;
        io.confirmUnlink = on;
        draw();
      },
      confirmUnlink: confirmUnlink,
    };
    draw();
    return refresh();
  }

  var api = { launchKeepr: launchKeepr, renderPopup: renderPopup, start: start, COPY: COPY, lastSyncText: lastSyncText, spaced: spaced };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else if (typeof document !== "undefined" && typeof chrome !== "undefined") {
    start(document, chrome);
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
