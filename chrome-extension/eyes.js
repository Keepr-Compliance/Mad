/**
 * Keepr — the per-chat eye on Google Messages' conversation list (BACKLOG-3658 P3c).
 *
 * One small eye on EACH conversation row: open (the default) = this chat is
 * synced to Keepr; crossed out = "Don't sync", and the whole row is dimmed by
 * a gray overlay (founder design, 2026-10-01; "Not synced" is in the eye's
 * aria-label and tooltip, no text label on the row).
 * New messages from a switched-off chat are not synced; texts already in
 * Keepr stay (founder). Keepr holds the list; this page sends and reads
 * conversation ids only — never names or numbers.
 *
 * Placement (live DOM trace, 2026-10-01): each row is
 * <mws-conversation-list-item> → ONE <a data-e2e-conversation href> (the whole
 * row is a link). The eye is a SIBLING of that link inside the row, absolutely
 * positioned, vertically centred, and LEFT of the row's right column — its
 * offset is measured from the actual left edge of the timestamp / Google's
 * icons (live 2026-10-01: a fixed offset covered "3:38 PM"). No change to the
 * row's layout. No pointer, mouse, focus or key event of the eye reaches the
 * row or the list (live: a real click opened the FIRST chat — the list's
 * key navigation reacted to focus moving into it), and pointerdown/mousedown
 * are prevented so focus never moves. tabindex=-1 keeps it out of the list's
 * arrow-key navigation (keyboard alternative: Keepr's Settings → Google
 * Messages → chats not synced).
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
  var LABEL_OFF = "Not synced: this chat is not synced to Keepr";
  var OVERLAY = "data-keepr-eye-overlay";
  /** The row's right column (timestamp, Google's icons): the eye stays left of it. */
  var RIGHT_COLUMN = [
    "[data-e2e-conversation-timestamp]", "mws-relative-timestamp", "[data-e2e-timestamp]",
    "button", "mat-icon", '[role="button"]',
  ];
  var GAP_PX = 8;
  /** When nothing can be measured (no layout yet). */
  var FALLBACK_RIGHT_PX = 72;
  /** Every event of the eye that must never reach the row or the list. */
  var STOPPED_EVENTS = [
    "pointerdown", "pointerup", "mousedown", "mouseup", "touchstart", "touchend",
    "focus", "focusin", "keydown", "keyup", "dblclick", "auxclick", "contextmenu",
  ];
  var COPY = "New messages from this chat won't be synced. Texts already in Keepr stay.";
  var SVG_NS = "http://www.w3.org/2000/svg";
  var COLORS = {
    light: { on: "#4F46E5", off: "#4B5563", overlay: "rgba(107, 114, 128, 0.28)" },
    dark: { on: "#A5B4FC", off: "#D1D5DB", overlay: "rgba(0, 0, 0, 0.40)" },
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

  /**
   * How far from the row's right edge the eye goes: left of the leftmost
   * element of the right column (timestamp, icons), plus a gap.
   */
  function rightOffset(row) {
    var rr = row.getBoundingClientRect ? row.getBoundingClientRect() : null;
    if (!rr || !rr.width) return FALLBACK_RIGHT_PX;
    var els = row.querySelectorAll(RIGHT_COLUMN.join(","));
    var minLeft = null;
    for (var i = 0; i < els.length; i++) {
      if (els[i].closest("[" + MARK + "]")) continue; // our own eye
      var r = els[i].getBoundingClientRect();
      if (!r.width || r.left < rr.left + rr.width / 2) continue;
      if (minLeft === null || r.left < minLeft) minLeft = r.left;
    }
    return minLeft === null ? FALLBACK_RIGHT_PX : Math.round(rr.right - minLeft + GAP_PX);
  }

  /** The gray layer over a switched-off row (pointer-events none: the row still opens). */
  function setOverlay(row, on, theme) {
    var layer = null;
    for (var i = 0; i < row.children.length; i++) {
      if (row.children[i].hasAttribute && row.children[i].hasAttribute(OVERLAY)) layer = row.children[i];
    }
    if (!on) {
      if (layer) row.removeChild(layer);
      return;
    }
    if (!layer) {
      layer = row.ownerDocument.createElement("div");
      layer.setAttribute(OVERLAY, "");
      layer.setAttribute("aria-hidden", "true");
      row.appendChild(layer);
    }
    Object.assign(layer.style, {
      position: "absolute", top: "0", right: "0", bottom: "0", left: "0", zIndex: "1",
      pointerEvents: "none", borderRadius: "inherit", background: (COLORS[theme] || COLORS.light).overlay,
    });
  }

  /** Paint the eye for its state (open / crossed out). */
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
    var label = excluded ? LABEL_OFF : LABEL_ON;
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-pressed", excluded ? "true" : "false");
    button.title = excluded ? "Not synced — click to sync this chat again" : LABEL_ON + ". Click to stop: " + COPY;
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
        setOverlay(row, false);
        return;
      }
      if (!button) {
        button = doc.createElement("button");
        button.type = "button";
        button.setAttribute("tabindex", "-1");
        Object.assign(button.style, {
          position: "absolute", top: "50%", transform: "translateY(-50%)", zIndex: "2",
          minWidth: "24px", minHeight: "24px", padding: "3px", display: "flex", alignItems: "center",
          justifyContent: "center", background: "transparent", border: "none", borderRadius: "6px",
          cursor: "pointer", font: "inherit", fontFamily: "inherit",
        });
        STOPPED_EVENTS.forEach(function (t) {
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
      button.style.right = rightOffset(row) + "px";
      var off = io.isExcluded(id);
      var theme = io.theme();
      paint(button, off, theme);
      setOverlay(row, off, theme);
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
            if (n.nodeType !== 1 || (n.hasAttribute && (n.hasAttribute(MARK) || n.hasAttribute(OVERLAY)))) continue;
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
      var eyes = doc.querySelectorAll("[" + MARK + "], [" + OVERLAY + "]");
      for (var i = 0; i < eyes.length; i++) if (eyes[i].parentNode) eyes[i].parentNode.removeChild(eyes[i]);
    }

    return { scan: scan, observe: observe, refresh: refresh, disconnect: disconnect, decorate: decorate };
  }

  var api = {
    createEyes: createEyes,
    conversationIdOf: conversationIdOf,
    paint: paint,
    MARK: MARK,
    OVERLAY: OVERLAY,
    STOPPED_EVENTS: STOPPED_EVENTS,
    rightOffset: rightOffset,
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
  // The timestamp column moves with the window width: place the eyes again.
  window.addEventListener("resize", function () {
    if (started) eyes.refresh();
  });
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
