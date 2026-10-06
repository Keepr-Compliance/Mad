/**
 * Keepr — the toolbar popup: the extension's HOME (UX redesign C2, founder
 * 2026-10-03), laid out as the approved mockups (Popup*.dc.html): a header
 * (brand mark + title), a centred status, the buttons at the bottom, a footer.
 *
 *   keepr_down    "Keepr isn't running"                  [Open Keepr]
 *                 footer: Don't have Keepr? · Extension x
 *   out_of_date   "Update the Keepr extension"           (what Keepr needs)
 *   not_linked    (Not linked) "Link once to sync your texts."
 *                 [Link with Keepr]  Go to Google Messages
 *                 footer: Extension x · Help
 *   linking       title "Link with Keepr"; "Type this code in Keepr",
 *                 the code, "Expires in m:ss"   [Copy code and open Keepr]  Cancel
 *   linked        "Linked to Keepr", the masked email, last sync
 *                 [Go to Google Messages] [Open Keepr]
 *                 footer: Unlink (→ confirm) · Extension x
 *
 * The state is asked of the worker each time the popup opens (the worker
 * sleeps); while linking it is asked again every second. The code is made by
 * the worker and never sent anywhere. The email is masked by Keepr.
 */
(function (root) {
  "use strict";

  var COPY = {
    title: "Keepr for Google Messages",
    linkingTitle: "Link with Keepr",
    keepr_down: "Keepr isn't running",
    out_of_date: "Update the Keepr extension",
    not_linked: "Not linked",
    notLinkedLine: "Link once to sync your texts.",
    linked: "Linked to Keepr",
    unlinkAsk: "Unlink from Keepr? You'll need to link again to sync",
  };
  /** Where "Don't have Keepr?" goes. */
  var KEEPR_SITE = "https://www.keeprcompliance.com/";

  function el(doc, tag, cls, text) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function lastSyncText(atMs, nowMs) {
    if (typeof atMs !== "number") return "No sync yet";
    var min = Math.max(0, Math.floor((nowMs - atMs) / 60000));
    if (min < 1) return "Last sync just now";
    if (min < 60) return "Last sync " + min + " min ago";
    if (min < 24 * 60) return "Last sync " + Math.floor(min / 60) + " h ago";
    return "Last sync " + Math.floor(min / (24 * 60)) + " d ago";
  }

  /** The shared code area (linkcode.js): countdown, expiry, copy and open. */
  var LinkCode = root.KeeprLinkCode || (typeof require === "function" ? require("./linkcode.js") : null);
  Object.keys(LinkCode.COPY).forEach(function (k) { COPY[k] = LinkCode.COPY[k]; });

  /**
   * Draw one state into `box`. io: { link, cancel, openKeepr, openApp,
   * openMessages, unlink, help, getKeepr, now, confirmUnlink (bool), setConfirm }.
   */
  /** SR C7: Keepr's privacy policy (the Chrome Web Store listing names the same page). */
  var PRIVACY_URL = "https://keeprcompliance.com/privacy";

  function renderPopup(doc, box, view, io) {
    var state = view && view.state;
    // Live (founder, 0.3.80): re-drawn every second while linking — the same
    // code area is only updated in place (its selection survives Ctrl+C).
    var drawn = box.querySelector('.middle[data-drawn]');
    var key = LinkCode.drawKey(view, io.now ? io.now() : Date.now());
    if (drawn && key && drawn.getAttribute("data-drawn") === key && !io.confirmUnlink) {
      LinkCode.render(doc, drawn, view, io, {});
      return;
    }
    while (box.firstChild) box.removeChild(box.firstChild);
    var version = view && view.version ? "Extension " + view.version : "";

    var head = el(doc, "div", "head");
    var mark = el(doc, "img", "mark");
    mark.setAttribute("src", "icons/keepr-mark.svg");
    mark.setAttribute("alt", "");
    mark.setAttribute("data-keepr", "brand-mark");
    head.appendChild(mark);
    head.appendChild(el(doc, "div", "title", state === "linking" ? COPY.linkingTitle : COPY.title));
    box.appendChild(head);

    var middle = el(doc, "div", "middle");
    box.appendChild(middle);
    var actions = el(doc, "div", "actions");
    var button = function (key, label, cls, fn) {
      var b = el(doc, "button", cls, label);
      b.type = "button";
      b.setAttribute("data-keepr", key);
      b.addEventListener("click", fn);
      actions.appendChild(b);
      return b;
    };
    var anchor = function (parent, key, label, cls, fn) {
      var a = el(doc, "a", cls || null, label);
      a.setAttribute("href", "#");
      a.setAttribute("data-keepr", key);
      a.addEventListener("click", function (e) {
        if (e && e.preventDefault) e.preventDefault();
        fn();
      });
      parent.appendChild(a);
      return a;
    };
    var status = function (cls, text) {
      var s = el(doc, "div", "status " + cls);
      s.appendChild(el(doc, "span", "dot"));
      s.appendChild(el(doc, "span", null, text));
      middle.appendChild(s);
      return s;
    };
    var foot = null;
    var footer = function () {
      foot = el(doc, "div", "foot");
      return foot;
    };
    /** SR C7: Keepr's privacy policy, in every footer (a new tab). */
    var privacy = function () {
      var a = el(doc, "a", null, "Privacy");
      a.setAttribute("href", PRIVACY_URL);
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer");
      a.setAttribute("data-keepr", "privacy");
      foot.appendChild(a);
    };
    var now = io.now ? io.now() : Date.now();

    if (state === "keepr_down") {
      status("warn", COPY.keepr_down);
      button("open-app", "Open Keepr", "primary", io.openApp);
      footer();
      anchor(foot, "get-keepr", "Don't have Keepr?", null, io.getKeepr || function () {});
      privacy();
      foot.appendChild(el(doc, "span", null, version));
    } else if (state === "out_of_date") {
      status("warn", COPY.out_of_date);
      middle.appendChild(el(doc, "div", "sub", "This is " + (view.version || "?") + "; Keepr needs " + (view.minVersion || "a newer one") + "."));
    } else if (LinkCode.drawKey(view, now)) {
      // Linking, or (E01) "Code expired" + Get a new code — the old digits never.
      head.lastChild.textContent = COPY.linkingTitle;
      middle.className = "middle code-gap";
      LinkCode.render(doc, middle, view, io, {
        actions: actions,
        button: function (_parent, key, label, cls, fn) { return button(key, label, cls, fn); },
      });
      if (state === "linking" && !LinkCode.isExpired(view, now)) anchor(actions, "cancel", "Cancel", "action", io.cancel);
    } else if (state === "linked") {
      if (io.confirmUnlink) {
        middle.appendChild(el(doc, "div", "line", COPY.unlinkAsk));
        button("unlink-yes", "Unlink", "primary", io.unlink);
        anchor(actions, "unlink-no", "Cancel", "action", function () { io.setConfirm(false); });
      } else {
        status("ok", COPY.linked);
        if (view.email) middle.appendChild(el(doc, "div", "sub", view.email));
        middle.appendChild(el(doc, "div", "sub", lastSyncText(view.lastSyncAt, now)));
        button("open-messages", "Go to Google Messages", "primary", io.openMessages);
        button("open-keepr", "Open Keepr", "secondary", io.openKeepr);
        footer();
        anchor(foot, "unlink", "Unlink", null, function () { io.setConfirm(true); });
        privacy();
        foot.appendChild(el(doc, "span", null, version));
      }
    } else {
      // not_linked (and a link that failed: its reason)
      middle.className = "middle pill-gap";
      var pill = el(doc, "div", "pill");
      pill.appendChild(el(doc, "span", "dot"));
      pill.appendChild(el(doc, "span", null, COPY.not_linked));
      middle.appendChild(pill);
      middle.appendChild(el(doc, "div", "line", COPY.notLinkedLine));
      var failed = view && view.link && view.link.status === "failed" && view.link.error;
      if (failed) middle.appendChild(el(doc, "div", "error", failed));
      button("link", "Link with Keepr", "primary", io.link);
      anchor(actions, "open-messages", "Go to Google Messages", "action", io.openMessages);
      footer();
      foot.appendChild(el(doc, "span", null, version));
      privacy();
      anchor(foot, "help", "Help", null, io.help || function () {});
    }
    if (actions.firstChild) box.appendChild(actions);
    if (foot) box.appendChild(foot);
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
    var openTab = function (url) {
      try {
        chromeApi.tabs.create({ url: url });
      } catch (_e) { /* no tabs API */ }
    };
    var draw = function () {
      renderPopup(doc, box, view || { state: "keepr_down" }, io);
    };
    // popup.html?autolink=1 (the page card's "Link with Keepr" window; SR:
    // no copy of the page): the link starts HERE, in the extension's own
    // window, once — never from the page.
    var search = doc.location && typeof doc.location.search === "string" ? doc.location.search : "";
    var autoLink = /[?&]autolink=1(?:&|$)/.test(search) || !!(box && box.getAttribute("data-autolink") === "1");
    if (autoLink) doc.title = "Link with Keepr";
    var refresh = function () {
      return ask({ type: "keepr-popup-state" }).then(function (r) {
        view = r;
        if (autoLink && view && view.state === "not_linked") {
          autoLink = false;
          return ask({ type: "keepr-link-start" }).then(refresh);
        }
        if (view && view.state !== "keepr_down") autoLink = false;
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
      // Live (founder): the code to the clipboard — a write, on the user's click.
      copyCode: function (text) { LinkCode.copyCode(text); },
      // Linked: signed /focus only (no tab); refused or unreachable → keepr://open.
      openKeepr: function () {
        ask({ type: "keepr-focus" }).then(function (r) {
          // SR: keepr://open only when Keepr is unreachable.
          if (!r || (!r.ok && r.launch)) launchKeepr(doc, "keepr://open");
        });
      },
      openMessages: function () { ask({ type: "keepr-open-messages" }); },
      help: function () { openTab(chromeApi.runtime.getURL("welcome.html")); },
      getKeepr: function () { openTab(KEEPR_SITE); },
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

  var api = { launchKeepr: launchKeepr, renderPopup: renderPopup, start: start, COPY: COPY, lastSyncText: lastSyncText, KEEPR_SITE: KEEPR_SITE };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else if (typeof document !== "undefined" && typeof chrome !== "undefined") {
    start(document, chrome);
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
