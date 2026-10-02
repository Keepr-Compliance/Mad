/**
 * Keepr — the per-chat eye on Google Messages' conversation list (BACKLOG-3658 P3c).
 *
 * One small eye on EACH conversation row: open (the default) = this chat is
 * synced to Keepr; crossed out = "Don't sync" (+ a subtle "Not synced" mark).
 * New messages from a switched-off chat are not synced; texts already in
 * Keepr stay (founder). Keepr holds the list; this page sends and reads
 * conversation ids only — never names or numbers.
 *
 * Placement (live DOM trace, 2026-10-01): each row is
 * <mws-conversation-list-item> → ONE <a data-e2e-conversation href> (the whole
 * row is a link). The eye is a SIBLING of that link inside the row, absolutely
 * positioned at the right column next to the timestamp and clear of Google's
 * own hover ⋮ menu — no change to the row's layout. Its clicks never reach
 * the link (the chat does not open), and tabindex=-1 keeps it out of the
 * list's arrow-key navigation (keyboard alternative: Keepr's Settings →
 * Google Messages → chats not synced).
 *
 * The list is virtualized (Angular re-renders rows on scroll): a
 * MutationObserver on the list re-attaches eyes, at most BATCH rows per tick,
 * one per row (data-keepr-eye), and re-reads a recycled row's address.
 * createElement / createElementNS / textContent only.
 */
(function (root) {
  "use strict";

  var ROW = "mws-conversation-list-item";
  var LINK = "a[data-e2e-conversation][href]";
  var LIST = "div[mwskeynavigation]";
  var MARK = "data-keepr-eye";
  var BATCH = 50;
  var LABEL_ON = "Sync this chat to Keepr";
  var LABEL_OFF = "Not syncing this chat";
  var COPY = "New messages from this chat won't be synced. Texts already in Keepr stay.";
  var SVG_NS = "http://www.w3.org/2000/svg";
  var COLORS = {
    light: { on: "#4F46E5", off: "#4B5563", markBg: "#F3F4F6" },
    dark: { on: "#A5B4FC", off: "#D1D5DB", markBg: "#374151" },
  };

  /** The conversation id in a row's address (/web/conversations/<id>), or null. */
  function conversationIdOf(row) {
    var a = row.querySelector(LINK);
    if (!a) return null;
    var m = /\/web\/conversations\/([A-Za-z0-9_-]{1,200})(?:[/?#]|$)/.exec(a.getAttribute("href") || "");
    return m ? m[1] : null;
  }

  function svgEl(doc, tag, attrs) {
    var el = doc.createElementNS(SVG_NS, tag);
    for (var k in attrs) el.setAttribute(k, attrs[k]);
    return el;
  }

  /** Paint the eye for its state (open / crossed out + "Not synced"). */
  function paint(button, excluded, theme) {
    var doc = button.ownerDocument;
    var c = COLORS[theme] || COLORS.light;
    while (button.firstChild) button.removeChild(button.firstChild);
    var svg = svgEl(doc, "svg", { width: "18", height: "18", viewBox: "0 0 24 24", fill: "none", "aria-hidden": "true" });
    svg.setAttribute("stroke", excluded ? c.off : c.on);
    svg.setAttribute("stroke-width", "2");
    svg.appendChild(svgEl(doc, "path", { d: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" }));
    svg.appendChild(svgEl(doc, "circle", { cx: "12", cy: "12", r: "3" }));
    if (excluded) svg.appendChild(svgEl(doc, "path", { d: "M3 3l18 18" }));
    button.appendChild(svg);
    if (excluded) {
      var mark = doc.createElement("span");
      mark.setAttribute("data-keepr", "not-synced");
      mark.textContent = "Not synced";
      Object.assign(mark.style, {
        fontSize: "11px", lineHeight: "1", marginLeft: "4px", padding: "2px 4px", borderRadius: "4px",
        background: c.markBg, color: c.off, whiteSpace: "nowrap",
      });
      button.appendChild(mark);
    }
    var label = excluded ? LABEL_OFF : LABEL_ON;
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-pressed", excluded ? "true" : "false");
    button.title = excluded ? LABEL_OFF + " — click to sync it again" : LABEL_ON + ". Click to stop: " + COPY;
  }

  /**
   * The eyes on a document.
   * @param {Document} doc
   * @param {{isExcluded: function(string): boolean, toggle: function(string, boolean): void, theme: function(): string,
   *   schedule?: function(function(): void): void}} io
   */
  function createEyes(doc, io) {
    var schedule = io.schedule || function (fn) { setTimeout(fn, 0); };
    var queue = [];
    var queued = false;

    function stop(e) {
      e.stopPropagation();
      if (e.type !== "keydown" || e.key === "Enter" || e.key === " ") e.preventDefault();
    }

    function decorate(row) {
      var id = conversationIdOf(row);
      var button = null;
      for (var i = 0; i < row.children.length; i++) {
        if (row.children[i].hasAttribute && row.children[i].hasAttribute(MARK)) {
          button = row.children[i];
          break;
        }
      }
      if (!id) {
        if (button) row.removeChild(button);
        return;
      }
      if (!button) {
        button = doc.createElement("button");
        button.type = "button";
        button.setAttribute("tabindex", "-1");
        Object.assign(button.style, {
          position: "absolute", top: "8px", right: "48px", zIndex: "2",
          minWidth: "24px", minHeight: "24px", padding: "3px", display: "flex", alignItems: "center",
          background: "transparent", border: "none", borderRadius: "6px", cursor: "pointer", font: "inherit",
        });
        ["pointerdown", "mousedown", "mouseup", "touchstart", "keydown"].forEach(function (t) {
          button.addEventListener(t, stop);
        });
        button.addEventListener("click", function (e) {
          stop(e);
          var current = button.getAttribute(MARK);
          if (current) io.toggle(current, !io.isExcluded(current));
        });
        var view = doc.defaultView;
        if (view && view.getComputedStyle && view.getComputedStyle(row).position === "static") row.style.position = "relative";
        row.appendChild(button); // a SIBLING of the row's link
      }
      button.setAttribute(MARK, id); // a recycled row gets its new chat's id
      paint(button, io.isExcluded(id), io.theme());
    }

    function drain() {
      queued = false;
      var batch = queue.splice(0, BATCH);
      for (var i = 0; i < batch.length; i++) if (batch[i].isConnected) decorate(batch[i]);
      if (queue.length > 0 && !queued) {
        queued = true;
        schedule(drain);
      }
    }

    function enqueue(row) {
      if (queue.indexOf(row) < 0) queue.push(row);
      if (!queued) {
        queued = true;
        schedule(drain);
      }
    }

    function scan(scope) {
      var rows = (scope || doc).querySelectorAll(ROW);
      for (var i = 0; i < rows.length; i++) enqueue(rows[i]);
    }

    function rowOf(node) {
      var el = node && node.nodeType === 1 ? node : node && node.parentElement;
      return el && el.closest ? el.closest(ROW) : null;
    }

    var observer = null;
    function observe(container) {
      if (observer || !doc.defaultView || !doc.defaultView.MutationObserver) return;
      observer = new doc.defaultView.MutationObserver(function (records) {
        for (var i = 0; i < records.length; i++) {
          var r = records[i];
          // Our own eye (and what paint() puts in it) is not a row change.
          var t = r.target && r.target.nodeType === 1 ? r.target : null;
          if (t && t.closest && t.closest("[" + MARK + "]")) continue;
          if (r.type === "attributes") {
            var row = rowOf(r.target);
            if (row) enqueue(row);
            continue;
          }
          for (var j = 0; j < r.addedNodes.length; j++) {
            var n = r.addedNodes[j];
            if (n.nodeType !== 1 || (n.hasAttribute && n.hasAttribute(MARK))) continue;
            var own = rowOf(n);
            if (own) enqueue(own);
            else if (n.querySelectorAll) scan(n);
          }
        }
      });
      observer.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ["href"] });
    }

    /** Repaint every eye (after the list of switched-off chats changed). */
    function refresh() {
      scan(doc);
    }

    function disconnect() {
      if (observer) observer.disconnect();
      observer = null;
      var eyes = doc.querySelectorAll("[" + MARK + "]");
      for (var i = 0; i < eyes.length; i++) if (eyes[i].parentNode) eyes[i].parentNode.removeChild(eyes[i]);
    }

    return { scan: scan, observe: observe, refresh: refresh, disconnect: disconnect, decorate: decorate };
  }

  var api = {
    createEyes: createEyes,
    conversationIdOf: conversationIdOf,
    paint: paint,
    MARK: MARK,
    BATCH: BATCH,
    LABEL_ON: LABEL_ON,
    LABEL_OFF: LABEL_OFF,
    COPY: COPY,
  };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
    return;
  }
  root.KeeprEyes = api;

  // ---------------------------------------------------------------------------
  // Browser glue (not run under jest)
  // ---------------------------------------------------------------------------
  if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.id) return;
  if (root.__keeprEyesInstalled) return;
  root.__keeprEyesInstalled = true;

  // Never two sets of eyes: the newest extension instance owns the page.
  var OWNER = "data-keepr-eyes-owner";
  var INSTANCE = String(Date.now()) + "-" + Math.random().toString(36).slice(2);
  if (document.documentElement) document.documentElement.setAttribute(OWNER, INSTANCE);
  var stale = document.querySelectorAll("[" + MARK + "]");
  for (var s = 0; s < stale.length; s++) if (stale[s].parentNode) stale[s].parentNode.removeChild(stale[s]);

  function ownsPage() {
    return !!document.documentElement && document.documentElement.getAttribute(OWNER) === INSTANCE;
  }

  function toWorker(message) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(message, function (response) {
          if (chrome.runtime.lastError) return resolve(null);
          resolve(response || null);
        });
      } catch (_e) {
        resolve(null);
      }
    });
  }

  var excluded = {};
  var eyes = createEyes(document, {
    isExcluded: function (id) { return excluded[id] === true; },
    theme: function () {
      return root.KeeprJob && root.KeeprJob.pageTheme ? root.KeeprJob.pageTheme(document) : "light";
    },
    toggle: function (id, off) {
      // Shown at once; put back if Keepr did not save it.
      if (off) excluded[id] = true;
      else delete excluded[id];
      eyes.refresh();
      void toWorker({ type: "keepr-exclusions-set", conversationId: id, excluded: off }).then(function (r) {
        if (r && r.ok) return;
        if (off) delete excluded[id];
        else excluded[id] = true;
        eyes.refresh();
      });
    },
  });

  var started = false;
  async function start() {
    if (started || !ownsPage()) return;
    var list = document.querySelector(LIST);
    if (!list) return;
    // Only when Keepr answers for a signed-in user: no eyes that cannot save.
    var r = await toWorker({ type: "keepr-exclusions-list" });
    if (!r || !r.ok || !r.body || !Array.isArray(r.body.conversationIds)) return;
    started = true;
    excluded = {};
    r.body.conversationIds.forEach(function (id) {
      if (typeof id === "string") excluded[id] = true;
    });
    eyes.observe(list);
    eyes.scan(list);
  }

  var tick = setInterval(function () {
    if (!ownsPage()) {
      clearInterval(tick);
      eyes.disconnect();
      return;
    }
    if (!started) void start();
  }, 2000);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState !== "visible" || !started) return;
    // Keepr's Settings may have switched chats back on meanwhile.
    void toWorker({ type: "keepr-exclusions-list" }).then(function (r) {
      if (!r || !r.ok || !r.body || !Array.isArray(r.body.conversationIds)) return;
      excluded = {};
      r.body.conversationIds.forEach(function (id) {
        if (typeof id === "string") excluded[id] = true;
      });
      eyes.refresh();
    });
  });
})(typeof globalThis !== "undefined" ? globalThis : this);
