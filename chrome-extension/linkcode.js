/**
 * Keepr — the link code area, shared by the toolbar popup, its link window
 * (popup.html?autolink=1) and the welcome page: one copy of
 *
 *   "Type this code in Keepr", the code, "Expires in m:ss",
 *   [Copy code and open Keepr]                       (linking)
 *   "Code expired", [Get a new code]                 (storyboard E01)
 *
 * Live (founder, 0.3.80): the pages ask the worker every second while
 * linking; a full re-draw dropped a selection of the code before Ctrl+C. The
 * same code is now drawn ONCE — later calls change only the countdown — and
 * its two halves are spaced by CSS, so a selection copies the 6 digits.
 * The copy is a clipboard WRITE on the user's click; nothing reads it.
 */
(function (root) {
  "use strict";

  var COPY = {
    linking: "Type this code in Keepr",
    expired: "Code expired",
    newCode: "Get a new code",
    copyAndOpen: "Copy code and open Keepr",
  };

  function countdown(ms) {
    var s = Math.max(0, Math.ceil(ms / 1000));
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }

  /** E01: the code ran out (the countdown reached 0, or the worker said expired). */
  function isExpired(view, nowMs) {
    var l = view && view.link;
    if (!l) return false;
    if (view.state === "linking" && typeof l.expiresAt === "number" && nowMs >= l.expiresAt) return true;
    return view.state === "not_linked" && l.status === "failed" && l.expired === true;
  }

  /** The code to the clipboard — a write, on the user's click. Never throws. */
  function copyCode(text, nav) {
    try {
      var n = nav || root.navigator;
      if (n && n.clipboard && typeof n.clipboard.writeText === "function") {
        n.clipboard.writeText(String(text)).catch(function () { /* the code stays on screen */ });
        return true;
      }
    } catch (_e) { /* the code stays on screen */ }
    return false;
  }

  /**
   * The key a drawn code area is kept under: the same key → only the
   * countdown changes. null = not a code area (linking or expired).
   */
  function drawKey(view, nowMs) {
    if (isExpired(view, nowMs)) return "expired";
    var l = view && view.state === "linking" ? view.link : null;
    return l && typeof l.code === "string" ? "linking:" + l.code : null;
  }

  /**
   * Draw (or update in place) the code area into `area`. io: { now, link
   * (a new code), copyCode(text), openApp }. Returns true when the view is a
   * code area (linking or expired); false → the caller draws its own state.
   * `opts.button(parent, key, label, cls, fn)` makes a button in the page's style.
   */
  function render(doc, area, view, io, opts) {
    var nowMs = io && io.now ? io.now() : Date.now();
    var key = drawKey(view, nowMs);
    if (!key) {
      area.removeAttribute("data-drawn");
      return false;
    }
    if (area.getAttribute("data-drawn") === key) {
      var left = area.querySelector('[data-keepr="expires"]');
      if (left && view.link && typeof view.link.expiresAt === "number") left.textContent = "Expires in " + countdown(view.link.expiresAt - nowMs);
      return true;
    }
    while (area.firstChild) area.removeChild(area.firstChild);
    area.setAttribute("data-drawn", key);
    var add = function (parent, tag, cls, text) {
      var n = doc.createElement(tag);
      if (cls) n.className = cls;
      if (text !== undefined) n.textContent = text;
      parent.appendChild(n);
      return n;
    };
    var actions = (opts && opts.actions) || area;
    if (key === "expired") {
      add(area, "div", "expired", COPY.expired).setAttribute("data-keepr", "expired");
      opts.button(actions, "new-code", COPY.newCode, "primary", io.link);
      return true;
    }
    var link = view.link;
    var digits = link.code;
    add(area, "div", "ask", COPY.linking);
    var code = add(area, "div", "code");
    if (digits.length === 6) {
      add(code, "span", null, digits.slice(0, 3));
      add(code, "span", null, digits.slice(3));
    } else {
      code.textContent = digits;
    }
    code.setAttribute("data-keepr", "code");
    if (typeof link.expiresAt === "number") {
      add(area, "div", "sub", "Expires in " + countdown(link.expiresAt - nowMs)).setAttribute("data-keepr", "expires");
    }
    // Founder (live): ONE action — copy, then Keepr's link step (a pasted
    // code submits by itself there).
    opts.button(actions, "copy-open", COPY.copyAndOpen, "primary", function () {
      io.copyCode(digits);
      io.openApp();
    });
    return true;
  }

  var api = { COPY: COPY, countdown: countdown, isExpired: isExpired, copyCode: copyCode, drawKey: drawKey, render: render };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.KeeprLinkCode = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
