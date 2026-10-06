/**
 * Keepr — conversation-list scan and Details reading (BACKLOG-3620).
 *
 * Pure over an injected document plus callbacks (click, sleep, scroll), so jest
 * runs it against a fixture exactly as the content script runs it against the
 * page. Never touches chrome.* and never contacts Keepr.
 *
 * PAGE STRUCTURE (live-page notes, 2026-09-29):
 *   - list item `mws-conversation-list-item`, name `[data-e2e-conversation-name]`,
 *     link `a[data-e2e-conversation]` (href `/web/conversations/<id>`);
 *   - Details: `[data-e2e-conversation-menu-button]` → `[data-e2e-details-button]`
 *     → `mw-conversation-details li[data-e2e-details-participant]` →
 *     `span[data-e2e-details-participant-number]` "(999) 999-9999";
 *   - Details closes with `button[aria-label="Done"]` (not inside
 *     mw-conversation-details); the participant rows then leave the page;
 *   - not signed in: path `/web/welcome` or `/web/authentication`.
 * UNVERIFIED: which element scrolls the list (see findListScroller).
 * UNTRACED: which element scrolls a chat's messages (see findMessageScroller),
 *   and whether scrolling up removes the newest wrappers from the page.
 * NARROW WINDOW (BACKLOG-3629, founder observation 2026-09-30): the page shows
 *   the list OR the open chat, not both. UNTRACED: whether the hidden list
 *   leaves the DOM or is only hidden. The header back control was TRACED on
 *   2026-10-01 (see BACK_BUTTON_SELECTORS); history.back() is used only when
 *   no back control is on screen.
 */
(function (root) {
  "use strict";

  var SELECTORS = {
    listItem: "mws-conversation-list-item",
    listName: "[data-e2e-conversation-name]",
    listLink: "a[data-e2e-conversation]",
    menuButton: "[data-e2e-conversation-menu-button]",
    detailsButton: "[data-e2e-details-button]",
    participant: "li[data-e2e-details-participant]",
    participantNumber: "span[data-e2e-details-participant-number]",
    participantName: "h3[data-e2e-details-participant-name]",
    detailsDone: 'button[aria-label="Done"]',
    headerTitle: "[data-e2e-header-title]",
    message: "mws-message-wrapper[msg-id]",
  };

  // The one definition (text.js): required under Node, else the page's KeeprText.
  var normalizeSpace = typeof module !== "undefined" && module.exports
    ? require("./text.js").normalizeSpace
    : root.KeeprText.normalizeSpace;

  /** "signed_in" | "not_signed_in" | "unknown" from the page path. */
  function signInState(pathname) {
    var p = String(pathname || "");
    if (/^\/web\/(welcome|authentication)\b/.test(p)) return "not_signed_in";
    if (/^\/web\/conversations\b/.test(p)) return "signed_in";
    return "unknown";
  }

  function conversationIdFromHref(href) {
    var m = String(href || "").match(/\/web\/conversations\/([^/?#]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  /** The list items currently in the DOM. */
  function readConversationList(doc, now, dateOrder) {
    var items = doc.querySelectorAll(SELECTORS.listItem);
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var nameEl = items[i].querySelector(SELECTORS.listName);
      var link = items[i].querySelector(SELECTORS.listLink);
      var href = link ? link.getAttribute("href") || "" : "";
      var id = conversationIdFromHref(href);
      if (!id || id === "new") continue;
      out.push({
        conversationId: id,
        name: normalizeSpace(nameEl ? nameEl.textContent : ""),
        href: href,
        // BACKLOG-3658: the list's last-message time (null when unreadable).
        timeMs: listItemTimeMs(items[i], now ? now() : Date.now(), dateOrder),
      });
    }
    return out;
  }

  /**
   * BACKLOG-3658: where the list shows a chat's last-message time. UNTRACED on
   * the live page: trace with the read-only snippet in the P2 report before
   * relying on it. No match → null → the cache job reads the full list (capped).
   */
  var LIST_TIME_SELECTORS = ["[data-e2e-conversation-timestamp]", "mws-relative-timestamp", "[data-e2e-timestamp]"];

  /** Older-than-since chats in a row that end a cache Sync's list read. */
  var SINCE_STOP_RUN = 2;

  var MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  var WEEKDAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

  /**
   * The order of a numeric date ("9/2/25") on this page: "mdy" or "dmy".
   * Google Messages writes it in the browser's locale; this asks the same
   * locale (Intl). An order the page itself proves (a part over 12) wins: see
   * DateOrder in collectConversations.
   */
  function localeDateOrder() {
    try {
      var parts = new Intl.DateTimeFormat(undefined, { year: "2-digit", month: "numeric", day: "numeric" })
        .formatToParts(new Date(2001, 10, 22));
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].type === "month") return "mdy";
        if (parts[i].type === "day") return "dmy";
      }
    } catch (_e) { /* no Intl: month first (en-US) */ }
    return "mdy";
  }

  /**
   * A list time as epoch ms, at day precision (the cache only needs "older
   * than since"). Today's "3:45 PM" → now; "Yesterday"; a weekday → the most
   * recent such day; "Sep 20" (this year, or last year if that is in the
   * future); "Sep 20, 2025"; numeric "9/2/25" / "9/2/2025".
   *
   * LIVE (0.3.18): Google shows chats from before this year as "M/D/YY". A
   * numeric date with both parts 12 or less ("9/2/25") used to be null, so
   * the list read never saw two older chats in a row and ran on to its cap,
   * past the floor. Now: a part over 12 settles the order (and is recorded in
   * `dateOrder`, an object {order} shared across one list read); otherwise the
   * order recorded, else the locale's. Anything else → null.
   * @param {string} text
   * @param {number} nowMs
   * @param {{order: ("mdy"|"dmy"), proven?: boolean}=} dateOrder
   */
  function parseListTime(text, nowMs, dateOrder) {
    var t = normalizeSpace(text).toLowerCase();
    if (!t) return null;
    var now = new Date(nowMs);
    var day = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (/^\d{1,2}:\d{2}(\s?[ap]\.?m\.?)?$/.test(t) || /^now$|min/.test(t)) return nowMs;
    if (t === "yesterday") return day - 864e5;
    var wd = WEEKDAYS[t.slice(0, 3)];
    if (wd !== undefined && /^[a-z]+$/.test(t)) {
      var back = (now.getDay() - wd + 7) % 7 || 7;
      return day - back * 864e5;
    }
    var md = t.match(/^([a-z]{3})[a-z]*\.? (\d{1,2})(?:, (\d{4}))?$/);
    if (md && MONTHS[md[1]] !== undefined) {
      var y = md[3] ? Number(md[3]) : now.getFullYear();
      var d = new Date(y, MONTHS[md[1]], Number(md[2])).getTime();
      if (!md[3] && d > nowMs) d = new Date(y - 1, MONTHS[md[1]], Number(md[2])).getTime();
      return d;
    }
    var nd = t.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{2}|\d{4})$/);
    if (nd) {
      var a = Number(nd[1]);
      var b = Number(nd[2]);
      var yy = Number(nd[3]);
      if (yy < 100) yy += 2000;
      var monthFirst;
      if (a > 12 && b > 12) return null;
      if (a > 12 || b > 12) {
        monthFirst = b > 12;
        if (dateOrder) {
          dateOrder.order = monthFirst ? "mdy" : "dmy";
          dateOrder.proven = true;
        }
      } else {
        monthFirst = ((dateOrder && dateOrder.order) || localeDateOrder()) !== "dmy";
      }
      var month = monthFirst ? a : b;
      var dom = monthFirst ? b : a;
      if (month < 1 || dom < 1 || dom > 31) return null;
      var ts = new Date(yy, month - 1, dom).getTime();
      return isFinite(ts) ? ts : null;
    }
    return null;
  }

  function listItemTimeMs(item, nowMs, dateOrder) {
    for (var i = 0; i < LIST_TIME_SELECTORS.length; i++) {
      var el = item.querySelector(LIST_TIME_SELECTORS[i]);
      if (el) return parseListTime(el.textContent, nowMs, dateOrder);
    }
    return null;
  }

  /**
   * The element that scrolls the conversation list: the nearest ancestor of a
   * list item whose content overflows it. UNVERIFIED on the live page.
   */
  function findListScroller(doc) {
    var item = doc.querySelector(SELECTORS.listItem);
    var cur = item ? item.parentElement : null;
    while (cur && cur !== doc.body) {
      if (cur.scrollHeight > cur.clientHeight + 4) return cur;
      cur = cur.parentElement;
    }
    return item ? item.parentElement : null;
  }

  /** The next scrollable ancestor above `el` (a re-pick when `el` is stuck). */
  function nextScroller(doc, el) {
    var cur = el ? el.parentElement : null;
    while (cur && cur !== doc.body && cur !== doc.documentElement) {
      if (cur.scrollHeight > cur.clientHeight + 4) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  /** Set the list's scroll position and tell the page, which renders on 'scroll'. */
  function setScrollTop(el, top) {
    el.scrollTop = top;
    var view = el.ownerDocument && el.ownerDocument.defaultView;
    if (view) el.dispatchEvent(new view.Event("scroll"));
  }

  function atBottom(el) {
    return el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
  }

  /**
   * Load the whole (virtualized, lazily fetched) conversation list.
   *
   * BACKLOG-3620 live fix (Windows, 2026-09-30): the page renders ~19 items at
   * a time and only re-renders on a 'scroll' event, and the tab may open
   * scrolled part-way down. So, with the page's own scroller:
   *   1. scroll to the TOP first (scroll event, wait), so the scan starts at
   *      the most recent chats;
   *   2. step down by ~90% of the visible height (not a jump to the end), with
   *      a scroll event each time, so every intermediate window renders;
   *   3. read the items at every step (the list unmounts items it scrolls past);
   *   4. after each step wait up to `settleRetries` x `waitMs` (~2 s) for new
   *      items or a taller list (more chats fetched over the network);
   *   5. stop as "stable" only when the scroller is AT THE BOTTOM and nothing
   *      grew for `stableRounds` rounds in a row. A scroller that will not move
   *      is re-picked (its scrollable parent) before it counts as stable.
   * `maxItems` and `maxMs` still bound the scan.
   *
   * `opts.scroll` (tests of the stop rule only) replaces the page scroller
   * with a callback; the list then counts as at the bottom every round.
   *
   * @param {Document} doc
   * @param {{scroll?: function(): (void|Promise<void>), sleep: function(number): Promise<void>,
   *          now?: function(): number, waitMs?: number, settleRetries?: number,
   *          stableRounds?: number, maxItems?: number, maxMs?: number}} opts
   * @returns {Promise<{conversations: Array, stopReason: string, scroll: object}>}
   */
  async function collectConversations(doc, opts) {
    var now = opts.now || function () { return Date.now(); };
    var waitMs = opts.waitMs == null ? 700 : opts.waitMs;
    var settleRetries = opts.settleRetries || 3;
    var stableRounds = opts.stableRounds || 3;
    var maxItems = opts.maxItems || 1000;
    var maxMs = opts.maxMs || 90000;
    var started = now();
    var byId = {};
    var order = [];
    var stable = 0;
    var stopReason = "stable";

    var stopAt = typeof opts.stopAtOlderThanMs === "number" ? opts.stopAtOlderThanMs : null;
    // Live (0.3.15): chats switched back on must be read even with no new
    // message: the list scan goes on past `since` until it has seen every
    // one of them (opts.mustSee) — but never past the floor (opts.mustSeeFloorMs).
    var mustSee = {};
    var mustSeeLeft = 0;
    (opts.mustSee || []).forEach(function (id) {
      if (id && !mustSee[id]) {
        mustSee[id] = true;
        mustSeeLeft += 1;
      }
    });
    var mustSeeFloor = typeof opts.mustSeeFloorMs === "number" ? opts.mustSeeFloorMs : null;
    // SR (2026-10-02): chats on a live deal (opts.mustSeeDeep) may lie past the
    // settings floor: while any is unseen the scan goes on down to
    // opts.mustSeeDeepFloorMs (the oldest deal start) — never further.
    var deep = {};
    var deepLeft = 0;
    var deepFloor = typeof opts.mustSeeDeepFloorMs === "number" && isFinite(opts.mustSeeDeepFloorMs) ? opts.mustSeeDeepFloorMs : null;
    if (deepFloor !== null) {
      (opts.mustSeeDeep || []).forEach(function (id) {
        if (id && !deep[id] && !mustSee[id]) {
          deep[id] = true;
          deepLeft += 1;
        }
      });
    }
    // The floor is a HARD stop (founder: never past it, for any reason — not
    // for chats switched back on, not without a since): two chats older than
    // the floor in a row end the read. Without a floor of its own, since is it.
    var baseFloor = mustSeeFloor !== null ? mustSeeFloor : stopAt;
    function hardFloorNow() {
      if (deepLeft > 0 && deepFloor !== null) return baseFloor === null ? deepFloor : Math.min(baseFloor, deepFloor);
      return baseFloor;
    }
    // One numeric-date order for the whole read: the locale's until the page proves one.
    var dateOrder = { order: opts.dateOrder === "dmy" || opts.dateOrder === "mdy" ? opts.dateOrder : localeDateOrder() };
    var timesRead = 0;
    var timesUnread = 0;
    var olderThanFloorInARow = 0;
    var reachedSince = false;
    // SR: two older chats IN A ROW end the list (a single older one may be a
    // pinned chat at the top); a newer or unreadable one starts over.
    var olderInARow = 0;
    function absorb() {
      var list = readConversationList(doc, now, dateOrder);
      // Live (0.3.18, 14-day run: "Scanned 273 chats", steps 0): rows still
      // mounted from an earlier scroll position were all read in one pass.
      // The read ends AT the stop: no row after it is taken.
      for (var i = 0; i < list.length && !reachedSince; i++) {
        if (!byId[list[i].conversationId]) {
          byId[list[i].conversationId] = list[i];
          order.push(list[i].conversationId);
          // Founder (P01): "Finding your chats · N so far" — a count only.
          if (opts.onFound) {
            try {
              opts.onFound(order.length);
            } catch (_e) { /* the card only */ }
          }
          // BACKLOG-3658: newest first — a chat older than `since` ends the list.
          if (mustSee[list[i].conversationId]) {
            mustSee[list[i].conversationId] = false;
            mustSeeLeft -= 1;
          }
          if (deep[list[i].conversationId]) {
            deep[list[i].conversationId] = false;
            deepLeft -= 1;
          }
          var hardFloor = hardFloorNow();
          if (list[i].timeMs === null) timesUnread += 1;
          else timesRead += 1;
          if (hardFloor !== null) {
            olderThanFloorInARow = list[i].timeMs !== null && list[i].timeMs < hardFloor ? olderThanFloorInARow + 1 : 0;
            if (olderThanFloorInARow >= SINCE_STOP_RUN) reachedSince = true;
          }
          if (stopAt !== null) {
            olderInARow = list[i].timeMs !== null && list[i].timeMs < stopAt ? olderInARow + 1 : 0;
            if (olderInARow >= SINCE_STOP_RUN && mustSeeLeft <= 0 && deepLeft <= 0) reachedSince = true;
          }
        }
      }
    }

    var el = opts.scroll ? null : findListScroller(doc);
    var stats = {
      scroller: !!el,
      startTop: el ? el.scrollTop : null,
      clientHeight: el ? el.clientHeight : null,
      scrollHeightBefore: el ? el.scrollHeight : null,
      steps: 0,
      repicks: 0,
    };

    if (el) {
      // 1. Top first: the newest chats are at the top.
      setScrollTop(el, 0);
      await opts.sleep(waitMs);
    }
    absorb();

    while (stable < stableRounds) {
      if (reachedSince) { stopReason = "since"; break; }
      if (order.length >= maxItems) { stopReason = "max_items"; break; }
      if (now() - started >= maxMs) { stopReason = "max_time"; break; }
      var before = order.length;
      var heightBefore = el ? el.scrollHeight : 0;
      var topBefore = el ? el.scrollTop : 0;
      if (opts.scroll) {
        await opts.scroll();
      } else if (el) {
        // 2. One step down, so the virtual list renders the next window.
        setScrollTop(el, el.scrollTop + Math.max(50, Math.floor(el.clientHeight * 0.9)));
        stats.steps += 1;
      }
      // 3 + 4. Read at every wait; stop waiting once something new arrived.
      var grew = false;
      for (var r = 0; r < settleRetries && !grew; r++) {
        await opts.sleep(waitMs);
        absorb();
        grew = order.length > before || (!!el && el.scrollHeight > heightBefore);
      }
      if (grew) {
        stable = 0;
        continue;
      }
      if (!el || atBottom(el)) {
        // 5. At the bottom and nothing came: one stable round.
        stable += 1;
      } else if (el.scrollTop === topBefore) {
        // Not at the bottom, yet it did not move: the wrong element. Try the
        // scrollable parent; with none left, count it as stable.
        var parent = nextScroller(doc, el);
        if (parent) {
          el = parent;
          stats.repicks += 1;
        } else {
          stable += 1;
        }
      }
      // Moved but not at the bottom yet: keep stepping (no stable round).
    }
    stats.endTop = el ? el.scrollTop : null;
    stats.scrollHeightAfter = el ? el.scrollHeight : null;
    stats.atBottom = el ? atBottom(el) : null;
    // Diagnostics (counts only): how many list times could be read.
    stats.timesRead = timesRead;
    stats.timesUnread = timesUnread;
    stats.dateOrder = dateOrder.order + (dateOrder.proven ? "" : "?");
    return {
      conversations: order.slice(0, maxItems).map(function (id) { return byId[id]; }),
      stopReason: stopReason,
      scroll: stats,
    };
  }

  /**
   * Poll until `predicate()` is truthy; resolve its value. Rejects on timeout.
   */
  async function waitFor(predicate, sleep, timeoutMs, intervalMs, label) {
    var waited = 0;
    var step = intervalMs || 100;
    for (;;) {
      var v = predicate();
      if (v) return v;
      if (waited >= timeoutMs) throw new Error("Timed out waiting for " + (label || "the page"));
      await sleep(step);
      waited += step;
    }
  }

  /**
   * BACKLOG-3664: an AI assistant chat (Gemini) sits in the conversation list
   * but is not a text conversation. Founder, live: its Details button is
   * greyed out. A disabled (or aria-disabled) menu or Details button is the
   * marker.
   */
  function isDisabled(el) {
    return !!el && (el.disabled === true || el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true");
  }

  /** Close an open menu or dialog the way a user would: Escape. */
  function pressEscape(doc, io) {
    if (io.escape) {
      io.escape();
      return;
    }
    var view = doc.defaultView;
    var target = doc.activeElement || doc.body;
    if (!view || !target || typeof view.KeyboardEvent !== "function") return;
    var init = { key: "Escape", code: "Escape", keyCode: 27, bubbles: true, cancelable: true };
    target.dispatchEvent(new view.KeyboardEvent("keydown", init));
    target.dispatchEvent(new view.KeyboardEvent("keyup", init));
  }

  /** How long a stuck Details panel gets to close after Escape / Done. */
  var RECOVER_MS = 5000;

  /**
   * SR: close a Details panel that is still open — Escape, then Done if it is
   * still there, then wait up to timeoutMs. True when the rows are gone.
   */
  async function recoverDetails(doc, io, timeoutMs) {
    var gone = function () { return !doc.querySelector(SELECTORS.participant); };
    if (gone()) return true;
    pressEscape(doc, io);
    var done = doc.querySelector(SELECTORS.detailsDone);
    if (done && !gone()) io.click(done);
    return !!(await waitForOrNull(gone, io.sleep, timeoutMs));
  }

  /** Waits up to timeoutMs; null instead of throwing. */
  async function waitForOrNull(predicate, sleep, timeoutMs) {
    try {
      return await waitFor(predicate, sleep, timeoutMs, 100, "");
    } catch (_e) {
      return null;
    }
  }

  /**
   * An empty result with why: "not_text" (skip, not a failure), "short_code"
   * or "business" (BACKLOG-3658 #11: a sender with no phone number), or
   * "no_details" (→ no_numbers).
   */
  function noNumbers(kind) {
    var none = [];
    Object.defineProperty(none, "rows", { value: [], enumerable: false });
    Object.defineProperty(none, "kind", { value: kind, enumerable: false });
    return none;
  }

  /**
   * Open Details for the open chat, read every participant's number, close
   * Details with Done and confirm the participant rows are gone.
   *
   * BACKLOG-3664: a disabled menu or Details button → "not_text" at once (an
   * AI chat: skipped quietly, no waits). Otherwise every wait is bounded: no
   * menu, no Details item, or Details without participant rows → "no_details"
   * (the caller reports no_numbers), after closing what was opened. Only a
   * Details panel that will not close still throws (the next chat would be
   * read against it).
   *
   * @param {Document} doc
   * @param {{click: function(Element): void, sleep: function(number): Promise<void>, timeoutMs?: number,
   *   escape?: function(): void}} io
   * @returns {Promise<string[]>} the numbers as shown; non-enumerable `rows`, and `kind` when empty for a reason
   */
  async function readParticipantsAndClose(doc, io) {
    var t = io.timeoutMs || 5000;
    // Rows already on screen belong to an earlier chat whose Details did not
    // close. Reading them would check this chat against the wrong numbers.
    // SR: one stuck panel must not end a 300-chat run — try to close it first.
    if (doc.querySelector(SELECTORS.participant) && !(await recoverDetails(doc, io, RECOVER_MS))) {
      var stuck = new Error("The Details panel from an earlier chat is still open");
      stuck.code = "details_stuck";
      throw stuck;
    }
    var menu = await waitForOrNull(function () { return doc.querySelector(SELECTORS.menuButton); }, io.sleep, t);
    if (!menu) return noNumbers("no_details");
    if (isDisabled(menu)) return noNumbers("not_text");
    io.click(menu);
    var details = await waitForOrNull(function () { return doc.querySelector(SELECTORS.detailsButton); }, io.sleep, t);
    if (!details || isDisabled(details)) {
      pressEscape(doc, io);
      return noNumbers(details ? "not_text" : "no_details");
    }
    io.click(details);
    var listed = await waitForOrNull(function () { return doc.querySelector(SELECTORS.participant); }, io.sleep, t);
    if (!listed) {
      var doneEarly = doc.querySelector(SELECTORS.detailsDone);
      if (doneEarly) {
        io.click(doneEarly);
        // Still open after the wait: Escape as well.
        var shut = await waitForOrNull(function () { return !doc.querySelector(SELECTORS.detailsDone); }, io.sleep, t);
        if (!shut) pressEscape(doc, io);
      } else {
        pressEscape(doc, io);
      }
      return noNumbers("no_details");
    }
    var rows = doc.querySelectorAll(SELECTORS.participant);
    var numbers = [];
    // BACKLOG-3630: each number with the name shown beside it (group senders
    // are resolved by name), and never the user's own row: the chat's key is
    // its OTHER participants, whether or not Details lists "You".
    // BACKLOG-3658 #11: only a PHONE-SHAPED value is a number (the number span
    // can hold other text, e.g. a label). A short code (all digits, 3-8) and a
    // named sender with no number are classified apart — a chat is never keyed
    // on a name.
    var people = [];
    var shortCodes = 0;
    var namedOnly = 0;
    for (var i = 0; i < rows.length; i++) {
      var nmEl = rows[i].querySelector(SELECTORS.participantName);
      var shownName = normalizeSpace(nmEl ? nmEl.textContent : "");
      if (isSelfName(shownName)) continue;
      var num = rows[i].querySelector(SELECTORS.participantNumber);
      var spanText = normalizeSpace(num ? num.textContent : "");
      // An unsaved contact: the number span is empty and the number itself
      // is shown where a saved contact's name would be.
      var candidate = spanText || shownName;
      if (looksLikePhone(candidate)) {
        numbers.push(candidate);
        people.push({ name: candidate === shownName ? "" : shownName, number: candidate });
      } else if (isShortCode(spanText) || (!spanText && isShortCode(shownName))) {
        shortCodes += 1;
      } else if (shownName) {
        namedOnly += 1;
      }
    }
    // Not enumerable: callers that only want the numbers see a plain list.
    if (numbers.length === 0) {
      numbers = noNumbers(shortCodes > 0 ? "short_code" : namedOnly > 0 ? "business" : "no_details");
    } else {
      Object.defineProperty(numbers, "rows", { value: people, enumerable: false });
    }

    var done = await waitForOrNull(function () { return doc.querySelector(SELECTORS.detailsDone); }, io.sleep, t);
    if (done) io.click(done);
    var closed = await waitForOrNull(function () { return !doc.querySelector(SELECTORS.participant); }, io.sleep, t);
    if (!closed && !(await recoverDetails(doc, io, RECOVER_MS))) throw new Error("Timed out waiting for Details to close");
    return numbers;
  }

  /** The user's own Details row. UNTRACED label; "You" seen in other Google UIs. */
  function isSelfName(name) {
    return /^(you|me)$/i.test(String(name || "").trim());
  }

  /** BACKLOG-3658 #11: a short-code sender — digits only (spaces allowed), 3 to 8 of them. */
  function isShortCode(text) {
    var t = String(text || "").replace(/ /g, "");
    return /^[0-9]{3,8}$/.test(t);
  }

  /** Digits, +, (, ), - and spaces only, with at least 10 digits. */
  function looksLikePhone(text) {
    if (!/^[\d+()\-\s]+$/.test(text)) return false;
    return text.replace(/\D/g, "").length >= 10;
  }

  /** The msg-ids of the messages currently on screen, sorted, as one key. */
  function messageIdSet(doc) {
    var wrappers = doc.querySelectorAll(SELECTORS.message);
    var ids = [];
    for (var i = 0; i < wrappers.length; i++) ids.push(wrappers[i].getAttribute("msg-id") || "");
    ids.sort();
    return ids.join("\n");
  }

  /**
   * Wait until the chat just opened is showing its own messages.
   *
   * Live measurement (2026-09-29): after a list click the URL and header title
   * change within ~53 ms, but the previous chat's messages stay on screen for
   * up to ~1.5 s (one chat rendered none within 6 s). Ready means: the set of
   * msg-ids differs from `before` (the set on screen before the click), is not
   * empty, and has not changed for `stableMs`. Resolves true when ready, false
   * on timeout — never import a stale or empty set.
   *
   * Two chats with identical msg-id sets (ids are not unique across chats)
   * never look ready and are skipped: the safe direction.
   *
   * @param {Document} doc
   * @param {string} before  messageIdSet(doc) taken before the click
   * @param {{sleep: function(number): Promise<void>, timeoutMs?: number, stableMs?: number, intervalMs?: number,
   *   reportEmpty?: boolean, emptyConfirmMs?: number}} io
   * @returns {Promise<boolean|"empty">}  "empty" only with io.reportEmpty (BACKLOG-3664)
   */
  async function waitForMessageSwap(doc, before, io) {
    var timeoutMs = typeof io.timeoutMs !== "number" ? 8000 : io.timeoutMs;
    var stableMs = typeof io.stableMs !== "number" ? 500 : io.stableMs;
    var step = io.intervalMs || 100;
    var waited = 0;
    var last = null;
    var sameFor = 0;
    for (;;) {
      var cur = messageIdSet(doc);
      if (cur === last) sameFor += step;
      else sameFor = 0;
      last = cur;
      if (cur !== "" && cur !== before && sameFor >= stableMs) return true;
      if (waited >= timeoutMs) {
        // BACKLOG-3664: with io.reportEmpty, a chat that shows NO message at
        // all (the earlier chat's are gone too) gets a further wait; still none
        // → "empty" (a chat with no messages yet), not a load failure. The
        // earlier chat's messages still on screen stay a failure (false).
        if (io.reportEmpty && cur === "") {
          var extra = typeof io.emptyConfirmMs !== "number" ? 3000 : io.emptyConfirmMs;
          for (var w = 0; w < extra; w += step) {
            await io.sleep(step);
            if (messageIdSet(doc) !== "") return waitForMessageSwap(doc, before, { sleep: io.sleep, timeoutMs: timeoutMs, stableMs: stableMs, intervalMs: step });
          }
          return "empty";
        }
        return false;
      }
      await io.sleep(step);
      waited += step;
    }
  }

  /**
   * The element that scrolls the open chat's messages: the nearest ancestor of
   * a message whose computed overflow-y is auto / scroll / overlay and whose
   * content overflows it. Chosen by computed style, not by tag or class.
   * UNTRACED on the live page (tags seen there: mws-messages-list,
   * mws-bottom-anchored). Null when none qualifies.
   */
  function findMessageScroller(doc) {
    var first = doc.querySelector(SELECTORS.message);
    var view = doc.defaultView;
    var cur = first ? first.parentElement : null;
    while (cur && cur !== doc.documentElement) {
      var oy = view ? view.getComputedStyle(cur).overflowY : "";
      if ((oy === "auto" || oy === "scroll" || oy === "overlay") && cur.scrollHeight > cur.clientHeight) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  /**
   * BACKLOG-3658 #10: a chat's whole history gets at most this long (scrolls,
   * waits and nudges together). Past it the load stops UNCONFIRMED. The
   * founder may change it.
   */
  var RCS_HISTORY_BUDGET_MS = 60000;
  /**
   * The budget follows progress (real phone, 2026-10-02: the biggest, most
   * active chats ran out at 60 s still loading): when it runs out while
   * messages arrived in the last HISTORY_BUDGET_GROWTH_WINDOW_MS, it grows by
   * HISTORY_BUDGET_EXTEND_MS, up to HISTORY_BUDGET_CAP_MS for the chat. A chat
   * stops on the budget only after a whole window with NO growth.
   */
  var HISTORY_BUDGET_EXTEND_MS = 30000;
  var HISTORY_BUDGET_GROWTH_WINDOW_MS = 10000;
  /**
   * Live (2026-10-05): a chat whose history has not grown for this long ends
   * (not_settled → "not fully imported") — Google's backend may have stopped
   * answering. Counted on the wall clock too (see tick()).
   */
  var HISTORY_NO_PROGRESS_MS = 75000;
  /**
   * SR F2: under throttling a minute of wall time can be ONE poll — the wall
   * clock counts towards the budgets (and the no-progress end) only after
   * this many real polls, so a slowly growing hidden chat is not cut after
   * one or two attempts.
   */
  var HISTORY_MIN_POLLS_FOR_WALL = 30;
  /**
   * SR (2026-10-05): an absolute wall-clock ceiling per chat, whatever the
   * poll count — a heavily throttled hidden tab (1 min per poll) cannot
   * spend ~30 min on one stuck chat. Ends the chat not_settled.
   */
  var HISTORY_WALL_CEILING_MS = 10 * 60000;
  var HISTORY_BUDGET_CAP_MS = 300000;
  /**
   * SR: the extra time is a per-RUN pool, shared by every chat of a Sync.
   * Once it is spent, the remaining chats get only the base budget (a chat
   * still loading then ends not_settled: reported, coverage not marked, read
   * in full next time). The job passes what is left (extensionPoolLeftMs).
   */
  var RCS_HISTORY_EXTENSION_POOL_MS = 30 * 60000;

  /**
   * History loading v2 (2026-10-02). A batch request polls every
   * HISTORY_POLL_MS for the FIRST growth (new msg-ids) up to
   * HISTORY_FIRST_GROWTH_MS, then waits for HISTORY_QUIET_MS of no change
   * (capped at HISTORY_QUIET_CAP_MS) and asks for the next batch at once —
   * fast chats are no longer held by fixed waits. No growth → the scroll
   * nudge: half a screen down, HISTORY_NUDGE_WAKE_MS for the phone sync path
   * to wake, HISTORY_NUDGE_RETURN_STEPS eased steps back to the top
   * (HISTORY_NUDGE_STEP_MS apart, each a scroll event), then a
   * HISTORY_NUDGE_WATCH_MS watch. A batch AND a nudge that both bring
   * nothing is a stall: a small chat (under HISTORY_SMALL_CHAT messages, no
   * visible loading indicator) is at its start after ONE stall (about 10 s),
   * a larger one after TWO. The 60 s budget stays the outer bound.
   */
  var HISTORY_POLL_MS = 75;
  var HISTORY_FIRST_GROWTH_MS = 4275;
  var HISTORY_QUIET_MS = 190;
  var HISTORY_QUIET_CAP_MS = 950;
  var HISTORY_NUDGE_WAKE_MS = 1050;
  var HISTORY_NUDGE_RETURN_STEPS = 10;
  var HISTORY_NUDGE_STEP_MS = 150;
  var HISTORY_NUDGE_WATCH_MS = 3000;
  var HISTORY_SMALL_CHAT = 100;
  /** The image pass (kept-image chats only): its time bound, stop rule and step. */
  var HISTORY_IMAGE_PASS_MS = 3000;
  var HISTORY_IMAGE_STAGNANT = 4;
  var HISTORY_IMAGE_STEP_FRACTION = 0.5;

  /** GAP GUARD: step-backs tried to bridge a gap before the chat ends "history_gap". */
  var GAP_RECOVERY_ATTEMPTS = 8;

  /** Google renders at most this many messages when a chat opens (live, 2026-09-29). */
  var HISTORY_FIRST_PAGE = 25;

  /**
   * SR S2: a short first page confirms the start only when the message set
   * has been stable this long, with no loading indicator, immediately before.
   */
  var HISTORY_FIRST_PAGE_STABLE_MS = 1000;
  /** At most this long is spent waiting for that stability (then: scroll as usual). */
  var HISTORY_FIRST_PAGE_MAX_WAIT_MS = 3000;


  /**
   * TODO(BACKLOG-3658 #10, SR to trace live): the element Google Messages
   * shows at the TRUE start of a conversation (above the oldest message).
   * UNTRACED — empty until traced, so a stop is "confirmed" only by
   * HISTORY_FIRST_PAGE (the whole chat fit on the first page). Add the traced
   * selector(s) here; loadHistory uses them as they are.
   */
  var HISTORY_START_MARKER_SELECTORS = [];

  /**
   * A "loading older messages" indicator in the chat pane: while one shows,
   * the load keeps waiting (within the budget). UNTRACED: generic progress
   * elements, looked for inside the message scroller (else the document).
   */
  var HISTORY_LOADING_SELECTORS = ['[role="progressbar"]', "mat-progress-spinner", "mat-spinner", "mws-loading-spinner"];

  /**
   * Google's connection banner (TRACED live, 0.3.18): `div.information-banner`
   * with an `mws-spinner > mat-progress-spinner[role=progressbar]` and
   * `div.content-container > h2.title` ("Connecting", or "Trying to reach your
   * phone" with a "Check that your phone is on…" content line). The banner
   * container is the match; its title text only tells the states apart.
   */
  var CONNECTION_BANNER_SELECTORS = [".information-banner"];
  /** Google's offline banner title (live 2026-10-04: "No internet connection"). */
  var OFFLINE_TITLE = /^no internet connection/i;
  /** UNTRACED: where else an offline banner may sit (alert / status / banner elements). */
  var OFFLINE_BANNER_FALLBACK_SELECTORS = '[role="alert"], [role="status"], mws-banner, .banner, [class*="offline"]';
  /** Never a banner: the conversation list and the messages. */
  var OFFLINE_NOT_IN = "mws-conversations-list, mws-conversation-list-item, mws-messages-list, mws-message-wrapper, mws-text-message-part";
  /** A banner's title + line is short; a longer text is something else. */
  var OFFLINE_TEXT_MAX = 80;

  /**
   * The connection banner on screen, or null:
   *   {kind: "connecting" | "phone_unreachable" | "connection_banner", titleLength}
   * Any other banner title is the generic kind; only its length is reported.
   */
  function connectionBanner(doc) {
    /*
     * Live (2026-10-04): with the computer's network off, Google Messages
     * showed "No internet connection / Make sure your device is connected to
     * the internet." and the run went on reading what was on screen, then
     * finished "Sync done" — a false complete. That banner was NOT matched
     * (its markup is UNTRACED). So, in order: the browser's own offline flag
     * (navigator.onLine === false, language-independent); the traced banner
     * with an offline title; any visible alert / status / banner element whose
     * text says so. All three are the kind "pc_offline".
     */
    var view = doc.defaultView;
    if (view && view.navigator && view.navigator.onLine === false) return { kind: "pc_offline", titleLength: 0 };
    for (var s = 0; s < CONNECTION_BANNER_SELECTORS.length; s++) {
      var banners = doc.querySelectorAll(CONNECTION_BANNER_SELECTORS[s]);
      for (var i = 0; i < banners.length; i++) {
        if (!isShown(banners[i])) continue;
        var titleEl = banners[i].querySelector("h2.title, .title");
        var title = normalizeSpace(titleEl ? titleEl.textContent : "");
        var kind = /^connecting\b/i.test(title) ? "connecting"
          : /trying to reach your phone/i.test(title) ? "phone_unreachable"
          : OFFLINE_TITLE.test(title) ? "pc_offline"
          : "connection_banner";
        return { kind: kind, titleLength: title.length };
      }
    }
    var others = doc.querySelectorAll(OFFLINE_BANNER_FALLBACK_SELECTORS);
    for (var o = 0; o < others.length; o++) {
      if (!isShown(others[o])) continue;
      // SR: banner-scoped — never anything in the conversation list or the
      // messages (a text saying "No internet connection…" is not a banner),
      // and a banner's text is short.
      if (others[o].closest && others[o].closest(OFFLINE_NOT_IN)) continue;
      var text = normalizeSpace(others[o].textContent || "");
      if (text.length > OFFLINE_TEXT_MAX) continue;
      if (OFFLINE_TITLE.test(text)) return { kind: "pc_offline", titleLength: text.length };
    }
    return null;
  }

  /** Inside the connection banner (its spinner is never "history loading"). */
  function inConnectionBanner(el) {
    for (var s = 0; s < CONNECTION_BANNER_SELECTORS.length; s++) {
      if (el.closest && el.closest(CONNECTION_BANNER_SELECTORS[s])) return true;
    }
    return false;
  }

  function anyMatch(scope, selectors) {
    for (var i = 0; i < selectors.length; i++) {
      if (scope.querySelector(selectors[i])) return true;
    }
    return false;
  }

  /**
   * L1 (live, 2026-10-02): the open chat's MESSAGES PANE — the message
   * scroller, else the messages list holding the wrappers, else their
   * container. Never the document: every conversation-list row carries a
   * spinner, so a document-wide search read "loading" forever and every short
   * chat burned its whole budget. Null when no message is on screen.
   */
  function messagesPane(doc) {
    var first = doc.querySelector(SELECTORS.message);
    if (!first) return null;
    return findMessageScroller(doc) || (first.closest && first.closest("mws-messages-list")) || first.parentElement;
  }

  /** A loading indicator in the messages pane that is actually VISIBLE (on screen, non-zero size). */
  function loadingVisible(doc, selectors) {
    var pane = messagesPane(doc);
    if (!pane) return false;
    for (var i = 0; i < selectors.length; i++) {
      var els = pane.querySelectorAll(selectors[i]);
      for (var j = 0; j < els.length; j++) {
        if (inConnectionBanner(els[j])) continue;
        var r = els[j].getBoundingClientRect ? els[j].getBoundingClientRect() : null;
        if (r && r.width > 0 && r.height > 0 && isShown(els[j])) return true;
      }
    }
    return false;
  }

  /**
   * Load older messages of the open chat (live, 2026-09-29: only the latest
   * 25 render on open), in batches (v2, see HISTORY_POLL_MS). Stops at the
   * first of:
   *   - "date_floor": the oldest loaded message is EARLIER than `floorMs`
   *     (checked before every batch: no more requests once it is reached);
   *   - "cap": `cap` distinct messages seen (default 2000);
   *   - "no_more" (confirmedBy): a start marker ("marker"); the whole chat on
   *     the first page, settled ("first_page"); no message scroller, settled
   *     ("no_overflow"); one stall for a small chat ("one_stall"), two for a
   *     larger one ("two_stalls");
   *   - "history_gap": a batch that grew does not overlap what was read
   *     before and could not be bridged (gap guard);
   *   - "not_settled": the budget (RCS_HISTORY_BUDGET_MS, extended while the
   *     chat keeps growing, up to HISTORY_BUDGET_CAP_MS) ran out.
   * Every poll collects the messages on screen (io.extractBatch, by msg-id,
   * freshest copy wins); `messages` in the result is that union. With
   * io.imagePass, a bounded pass down the chat mounts lazy images first.
   * Time is measured in `sleep` steps.
   *
   * @param {Document} doc
   * @param {{scrollUp: function(): (void|Promise<void>), sleep: function(number): Promise<void>,
   *          nudgeDown?: function(): (void|Promise<void>), nudgeReturnStep?: function(number, number): (void|Promise<void>),
   *          nudge?: function(): (void|Promise<void>), stepDown?: function(number): (boolean|Promise<boolean>),
   *          oldestMs: function(): (number|null), floorMs?: (number|null), cap?: number, budgetMs?: number, budgetCapMs?: number, extensionPoolLeftMs?: number,
   *          startMarkerSelectors?: string[], loadingSelectors?: string[], hasScroller?: function(): boolean,
   *          extractBatch?: function(): Array<{msgId: string, sentAt: string}>, stepBack?: function(): (void|Promise<void>),
   *          imagePass?: boolean, pollMs?: number, intervalMs?: number, onProgress?: function(number): void,
   *          checkpoint?: function(number): Promise<void>}} io
   * @returns {Promise<{stopReason: string, count: number, scrolls: number, nudges: number, confirmedBy?: string}>}
   */
  async function loadHistory(doc, io) {
    var cap = typeof io.cap === "number" ? io.cap : 2000;
    var budgetMs = typeof io.budgetMs === "number" ? io.budgetMs : RCS_HISTORY_BUDGET_MS;
    var budgetCapMs = Math.max(budgetMs, typeof io.budgetCapMs === "number" ? io.budgetCapMs : HISTORY_BUDGET_CAP_MS);
    var budgetExtensions = 0;
    var baseBudgetMs = budgetMs;
    var poolLeftMs = typeof io.extensionPoolLeftMs === "number" ? Math.max(0, io.extensionPoolLeftMs) : RCS_HISTORY_EXTENSION_POOL_MS;
    var chatCapMs = Math.min(budgetCapMs, baseBudgetMs + poolLeftMs);
    var poolExhausted = false;
    /** Live (2026-10-05): the chat ended because its history stopped growing. */
    var noProgress = false;
    var lastGrowthAt = -Infinity;
    var batches = 0;
    var startSelectors = io.startMarkerSelectors || HISTORY_START_MARKER_SELECTORS;
    var loadingSelectors = io.loadingSelectors || HISTORY_LOADING_SELECTORS;
    var step = io.intervalMs || 250;
    var floorMs = typeof io.floorMs === "number" && isFinite(io.floorMs) ? io.floorMs : null;
    var seen = {};
    var count = 0;
    var scrolls = 0;
    var nudges = 0;
    var spent = 0;
    // Live (2026-10-05): `spent` counted only the nominal sleeps; a hidden
    // tab's throttled timers (≈ a minute per 250 ms poll) made every budget
    // last hours. It now follows the wall clock whenever that is further on.
    var clockNow = typeof io.now === "function" ? io.now : function () { return Date.now(); };
    var startedAt = clockNow();
    var nominal = 0;
    var wallCeiling = false;
    var polls = 0;
    function tick(ms) {
      nominal += ms;
      polls += 1;
      // SR F2: the wall clock only after a minimum of real polls.
      spent = Math.max(spent, polls >= HISTORY_MIN_POLLS_FOR_WALL ? Math.max(nominal, clockNow() - startedAt) : nominal);
    }

    function absorb() {
      var wrappers = doc.querySelectorAll(SELECTORS.message);
      var added = 0;
      for (var i = 0; i < wrappers.length; i++) {
        var id = wrappers[i].getAttribute("msg-id") || "";
        if (id && !seen[id]) {
          seen[id] = true;
          count += 1;
          added += 1;
        }
      }
      if (added > 0) lastGrowthAt = spent;
      return added;
    }
    /** Budget left? Out of it while still growing → extended (up to the cap). */
    function inBudget() {
      if (clockNow() - startedAt >= HISTORY_WALL_CEILING_MS) {
        wallCeiling = true;
        return false;
      }
      // Live (2026-10-05): no growth for HISTORY_NO_PROGRESS_MS ends the chat.
      if (spent - Math.max(lastGrowthAt, 0) > HISTORY_NO_PROGRESS_MS) {
        noProgress = true;
        return false;
      }
      if (spent < budgetMs) return true;
      if (spent - lastGrowthAt <= HISTORY_BUDGET_GROWTH_WINDOW_MS) {
        if (budgetMs < chatCapMs) {
          budgetMs = Math.min(chatCapMs, budgetMs + HISTORY_BUDGET_EXTEND_MS);
          budgetExtensions += 1;
        } else if (chatCapMs < budgetCapMs) {
          poolExhausted = true; // still growing, but the run's extra time is spent
        }
      }
      return spent < budgetMs;
    }
    function atStart() {
      return startSelectors.length > 0 && anyMatch(doc, startSelectors);
    }
    // GAP GUARD (founder, 2026-10-02): every message inside the window, no
    // gap in the middle. The list may be virtualized (rows dropped/recycled
    // while scrolling), so (a) each step's messages are extracted AS THEY
    // ARE READ and kept by msg-id (io.extractBatch) — the end-of-load DOM is
    // not trusted to still hold them; (b) each newly read batch must share at
    // least one msg-id with what was read before (contiguity). No overlap → a
    // gap: step back (io.stepBack) and re-read until a read bridges the two
    // sides; unrecovered → "history_gap".
    var collected = {};
    var gapsDetected = 0;
    var gapsRecovered = 0;
    function onScreenIds() {
      var wrappers = doc.querySelectorAll(SELECTORS.message);
      var out = [];
      for (var i = 0; i < wrappers.length; i++) {
        var id = wrappers[i].getAttribute("msg-id") || "";
        if (id) out.push(id);
      }
      return out;
    }
    function collect() {
      if (!io.extractBatch) return;
      var batch = io.extractBatch() || [];
      for (var i = 0; i < batch.length; i++) {
        var m = batch[i];
        if (!m || !m.msgId) continue;
        var had = collected[m.msgId];
        // The freshest copy wins: one whose images have loaded / reactions arrived.
        if (!had || (m.imageSrcs || []).length > (had.imageSrcs || []).length ||
            (m.reactions || []).length > (had.reactions || []).length) collected[m.msgId] = m;
      }
    }
    /**
     * Walk back down from the far side of a gap in steps that each overlap the
     * previous read (contiguity), until a read reaches what was read before
     * the gap. Every message on the way is absorbed and collected.
     */
    async function recoverGap(before, after) {
      if (!io.stepBack) return false;
      var prev = after;
      for (var attempt = 0; attempt < GAP_RECOVERY_ATTEMPTS && inBudget(); attempt++) {
        await io.stepBack();
        await io.sleep(step);
        tick(step);
        absorb();
        collect();
        var ids = onScreenIds();
        var touchesPrev = false;
        var reachesBefore = false;
        var next = {};
        for (var i = 0; i < ids.length; i++) {
          if (prev[ids[i]]) touchesPrev = true;
          if (before[ids[i]]) reachesBefore = true;
          next[ids[i]] = true;
        }
        if (!touchesPrev) return false; // the step itself skipped messages
        if (reachesBefore) return true;
        prev = next;
      }
      return false;
    }
    function result(stopReason, confirmedBy) {
      collect();
      var r = { stopReason: stopReason, count: count, scrolls: scrolls, nudges: nudges, batches: batches, elapsedMs: spent };
      if (budgetExtensions > 0) r.budgetExtensions = budgetExtensions;
      // Extra time actually used from the run's pool (not what was granted).
      var extraMs = Math.max(0, Math.min(spent, budgetMs) - baseBudgetMs);
      if (extraMs > 0) r.extraMs = extraMs;
      if (poolExhausted) r.poolExhausted = true;
      // Live (2026-10-05): how long the history had not grown when it ended (ms).
      r.idleMs = Math.max(0, spent - Math.max(lastGrowthAt, 0));
      if (noProgress) r.noProgress = true;
      if (wallCeiling) r.wallCeiling = true;
      if (confirmedBy) r.confirmedBy = confirmedBy;
      if (gapsDetected > 0) {
        r.gapsDetected = gapsDetected;
        r.gapsRecovered = gapsRecovered;
      }
      if (io.extractBatch) {
        // Final consistency pass: unique ids, sorted by time.
        var all = [];
        for (var id in collected) all.push(collected[id]);
        all.sort(function (a, b) {
          var ta = Date.parse(a.sentAt);
          var tb = Date.parse(b.sentAt);
          return (isFinite(ta) ? ta : 0) - (isFinite(tb) ? tb : 0);
        });
        r.messages = all;
      }
      return r;
    }
    function loadingShown() {
      return loadingVisible(doc, loadingSelectors);
    }
    var hasScroller = io.hasScroller || function () { return !!findMessageScroller(doc); };
    /**
     * SR S2: the first page is short AND settled — no loading indicator and
     * the same message set for HISTORY_FIRST_PAGE_STABLE_MS, right now.
     */
    async function firstPageSettled(shortOnly) {
      var last = messageIdSet(doc);
      var stableFor = 0;
      var waited = 0;
      while (waited < HISTORY_FIRST_PAGE_MAX_WAIT_MS && inBudget()) {
        await io.sleep(step);
        tick(step);
        waited += step;
        absorb();
        if (shortOnly && count >= HISTORY_FIRST_PAGE) return false;
        var cur = messageIdSet(doc);
        if (cur !== last || loadingShown()) {
          last = cur;
          stableFor = 0;
          continue;
        }
        stableFor += step;
        if (stableFor >= HISTORY_FIRST_PAGE_STABLE_MS) return true;
      }
      return false;
    }
    // ---------------------------------------------------------------------
    // History loading v2: adaptive batches, a scroll nudge, stall counting.
    // ---------------------------------------------------------------------
    var poll = io.pollMs || HISTORY_POLL_MS;
    var nudgeDown = io.nudgeDown || function () {};
    var nudgeReturnStep = io.nudgeReturnStep || function (i, n) {
      // Without a real scroller (tests, old callers): the last return step
      // re-requests history, as reaching the top again does on the page.
      if (i === n - 1) return (io.nudge || io.scrollUp)();
    };
    function copySeen() {
      var out = {};
      for (var sid in seen) out[sid] = true;
      return out;
    }
    /** Poll for `ms`, collecting every step (the union) — no growth decision. */
    async function pollFor(ms) {
      var waited = 0;
      while (waited < ms && inBudget()) {
        await io.sleep(poll);
        tick(poll);
        waited += poll;
        absorb();
        collect();
      }
    }
    /**
     * Wait up to `ms` for the FIRST growth (new msg-ids beyond `fromCount`),
     * polling every `poll` ms; a visible loading indicator stops the clock
     * (the budget still runs).
     */
    async function waitGrowth(ms, fromCount) {
      var waited = 0;
      while (waited < ms && inBudget()) {
        await io.sleep(poll);
        tick(poll);
        absorb();
        collect();
        if (count > fromCount) return true;
        if (!loadingShown()) waited += poll;
      }
      return false;
    }
    /** After the first growth: wait for HISTORY_QUIET_MS of no change, capped at HISTORY_QUIET_CAP_MS. */
    async function quietPeriod() {
      var quiet = 0;
      var total = 0;
      while (quiet < HISTORY_QUIET_MS && total < HISTORY_QUIET_CAP_MS && inBudget()) {
        await io.sleep(poll);
        tick(poll);
        total += poll;
        if (absorb() > 0) quiet = 0;
        else quiet += poll;
        collect();
      }
    }
    /** GAP GUARD on a batch that GREW: it must overlap what was read before it. */
    async function contiguous(before) {
      var screen = onScreenIds();
      var overlap = false;
      var fresh = {};
      for (var q = 0; q < screen.length; q++) {
        if (before[screen[q]]) overlap = true;
        else fresh[screen[q]] = true;
      }
      if (overlap) return true;
      gapsDetected += 1;
      if (await recoverGap(before, fresh)) {
        gapsRecovered += 1;
        return true;
      }
      return false;
    }
    /** One batch request: to the top, first growth, quiet period. → "grew" | "none" | "gap". */
    async function requestBatch() {
      var before = copySeen();
      var c0 = count;
      await io.scrollUp();
      scrolls += 1;
      if (!(await waitGrowth(HISTORY_FIRST_GROWTH_MS, c0))) return "none";
      await quietPeriod();
      return (await contiguous(before)) ? "grew" : "gap";
    }
    /**
     * The scroll nudge: half a screen down, a short wait for the phone sync
     * path to wake, then back to the top in eased steps (each a scroll event,
     * so the page asks for history again), then a watch. The down/return
     * steps are COLLECTED but never judged — only the whole nudge's growth
     * counts, and only a nudge that grew is checked for contiguity.
     */
    async function scrollNudge() {
      var before = copySeen();
      var c0 = count;
      nudges += 1;
      await nudgeDown();
      await pollFor(HISTORY_NUDGE_WAKE_MS);
      for (var i = 0; i < HISTORY_NUDGE_RETURN_STEPS && inBudget(); i++) {
        await nudgeReturnStep(i, HISTORY_NUDGE_RETURN_STEPS);
        await pollFor(HISTORY_NUDGE_STEP_MS);
      }
      var grew = count > c0 || (await waitGrowth(HISTORY_NUDGE_WATCH_MS, c0));
      if (!grew) return "none";
      await quietPeriod();
      return (await contiguous(before)) ? "grew" : "gap";
    }

    absorb();
    collect();
    var firstPage = count;
    var stalls = 0;
    var finish = async function (stopReason, confirmedBy) {
      // Live (founder, 0.3.84 hidden run): a chat read back PAST its floor
      // (88 days for a 30-day floor) ended not_settled — the page never
      // settled, though everything this Sync wants was read. Read past the
      // floor = complete for this Sync: the same "date_floor" stop as when
      // the loop sees it.
      if (stopReason === "not_settled" && floorMs !== null && readPastFloor()) {
        stopReason = "date_floor";
        noProgress = false;
      }
      if (stopReason !== "history_gap" && io.imagePass) await imagePass();
      return result(stopReason, confirmedBy);
    };
    /**
     * Images mount only in the viewport: a bounded pass DOWN the chat
     * (HISTORY_IMAGE_PASS_MS), collecting as it goes; it stops after
     * HISTORY_IMAGE_STAGNANT steps that mounted no new image, then one retry
     * pass. Only for chats whose images Keepr keeps (io.imagePass).
     */
    async function imagePass() {
      var deadline = spent + HISTORY_IMAGE_PASS_MS;
      for (var pass = 0; pass < 2 && spent < deadline; pass++) {
        if (pass > 0) await io.scrollUp();
        var stagnant = 0;
        var known = imagesCollected();
        while (stagnant < HISTORY_IMAGE_STAGNANT && spent < deadline) {
          if (!io.stepDown) return;
          var moved = await io.stepDown(HISTORY_IMAGE_STEP_FRACTION);
          await io.sleep(poll);
          tick(poll);
          absorb();
          collect();
          var now = imagesCollected();
          if (now > known) {
            known = now;
            stagnant = 0;
          } else {
            stagnant += 1;
          }
          if (moved === false) break; // at the bottom
        }
      }
    }
    /** The oldest message read so far (kept or on screen) is older than the floor. */
    function readPastFloor() {
      var oldest = typeof io.oldestMs === "function" ? io.oldestMs() : null;
      for (var id in collected) {
        var t = Date.parse(collected[id].sentAt);
        if (isFinite(t) && (oldest === null || t < oldest)) oldest = t;
      }
      return typeof oldest === "number" && oldest < floorMs;
    }
    function imagesCollected() {
      var n = 0;
      for (var id in collected) n += (collected[id].imageSrcs || []).length;
      return n;
    }

    for (;;) {
      if (io.onProgress) io.onProgress(count);
      if (count >= cap) return finish("cap");
      if (floorMs !== null) {
        var oldest = io.oldestMs();
        // Date-range stop: a message older than the floor is loaded — no more requests.
        if (typeof oldest === "number" && oldest < floorMs) return finish("date_floor");
      }
      if (atStart()) return finish("no_more", "marker");
      // L1: a chat that does not overflow has nothing to scroll — its whole
      // history is on screen once it is settled.
      if (scrolls === 0 && !hasScroller() && (await firstPageSettled(false))) return finish("no_more", "no_overflow");
      if (scrolls === 0 && firstPage < HISTORY_FIRST_PAGE && (await firstPageSettled(true))) return finish("no_more", "first_page");
      if (!inBudget()) return finish("not_settled");
      var outcome = await requestBatch();
      if (outcome === "none") {
        if (atStart()) return finish("no_more", "marker");
        outcome = await scrollNudge();
      }
      if (outcome === "gap") return finish("history_gap");
      if (outcome === "grew") {
        stalls = 0;
        batches += 1;
        // Awaited after every batch that loaded something, so a caller can
        // end the load (by throwing) as soon as it learns the job was cancelled.
        if (io.checkpoint) await io.checkpoint(count);
        continue;
      }
      // A stall: a batch request AND a nudge brought nothing.
      if (!inBudget()) return finish("not_settled");
      stalls += 1;
      var small = count < HISTORY_SMALL_CHAT && !loadingShown();
      if (small && stalls >= 1) return finish("no_more", "one_stall");
      if (stalls >= 2) return finish("no_more", "two_stalls");
    }
  }

  // -------------------------------------------------------------------------
  // BACKLOG-3629: two-pane and single-pane layouts
  // -------------------------------------------------------------------------

  /** An open chat's path: the only place history.back() is used from. */
  var CHAT_PATH_RE = /^\/web\/conversations\/[^/?#]+/;

  /**
   * The header's back control in the single-pane layout, most specific first.
   * TRACED on the live page 2026-10-01: an ANCHOR, not a button —
   * `<a aria-label="Back" data-e2e-header-back-button class="mdc-icon-button
   * mat-mdc-icon-button …">` inside `mws-header`. (The old
   * "[data-e2e-back-button]" was the wrong attribute and the rest required a
   * `button`, so the job fell to history.back(), which landed on a previous
   * chat: list_not_reachable.)
   */
  var BACK_BUTTON_SELECTORS = [
    "mws-header [data-e2e-header-back-button]",
    'mws-header a[aria-label="Back"]',
    'mws-header button[aria-label="Back"]',
    "mws-header [data-e2e-back-button]",
    "mws-header .left-content button",
    'button[aria-label="Back"]',
  ];

  /** Clicks of the back control before returnToList gives up (no history.back then). */
  var BACK_CLICK_ATTEMPTS = 3;

  /**
   * True unless the element or an ancestor is hidden by `hidden`, display:none
   * or visibility:hidden. Computed style, not a width constant: it reads the
   * layout the page chose, at any window size or zoom.
   */
  function isShown(el) {
    var view = el.ownerDocument && el.ownerDocument.defaultView;
    for (var cur = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
      if (cur.hasAttribute("hidden")) return false;
      if (view) {
        var style = view.getComputedStyle(cur);
        if (style.display === "none" || style.visibility === "hidden") return false;
      }
    }
    return true;
  }

  /** The conversation list is on screen (either layout). */
  function listShown(doc) {
    var items = doc.querySelectorAll(SELECTORS.listItem);
    for (var i = 0; i < items.length; i++) {
      if (isShown(items[i])) return true;
    }
    return false;
  }

  function findBackButton(doc) {
    for (var i = 0; i < BACK_BUTTON_SELECTORS.length; i++) {
      var els = doc.querySelectorAll(BACK_BUTTON_SELECTORS[i]);
      for (var j = 0; j < els.length; j++) {
        if (isShown(els[j])) return els[j];
      }
    }
    return null;
  }

  /**
   * Make the conversation list the pane on screen. Two-pane: it already is,
   * nothing is clicked. Single-pane with a chat open: click the header's back
   * button, else `io.back()` (history.back, only while `io.getPathname()` is
   * an open chat's path), and wait for the list items.
   * Never throws: false means the list could not be brought back (the next
   * open then fails and that chat is reported as not opened).
   *
   * @param {Document} doc
   * @param {{click: function(Element): void, sleep: function(number): Promise<void>,
   *          back?: function(): void, getPathname?: function(): string, timeoutMs?: number}} io
   * @returns {Promise<boolean>}
   */
  async function returnToList(doc, io) {
    try {
      if (listShown(doc)) return true;
      var t = io.timeoutMs || 5000;
      var waitList = function () {
        return waitFor(function () { return listShown(doc); }, io.sleep, t, 100, "the conversation list").then(
          function () { return true; },
          function () { return false; },
        );
      };
      // The back control, up to BACK_CLICK_ATTEMPTS clicks (found again each
      // time). While it is on screen, history.back() is never used: it lands
      // on a previous chat, not the list.
      var button = findBackButton(doc);
      if (button) {
        for (var attempt = 0; attempt < BACK_CLICK_ATTEMPTS && button; attempt++) {
          io.click(button);
          if (await waitList()) return true;
          button = findBackButton(doc);
        }
        return false;
      }
      // history.back() only from an open chat inside Messages: from anywhere
      // else (a reused tab, a chat opened by direct URL as the first entry) it
      // could leave messages.google.com and strand the job.
      if (io.back && io.getPathname && CHAT_PATH_RE.test(io.getPathname())) {
        io.back();
        if (await waitList()) return true;
      }
      return false;
    } catch (_e) {
      return false;
    }
  }

  function findLink(doc, conversationId) {
    var links = doc.querySelectorAll(SELECTORS.listLink);
    for (var i = 0; i < links.length; i++) {
      if (conversationIdFromHref(links[i].getAttribute("href")) === conversationId) return links[i];
    }
    return null;
  }

  /**
   * Open one chat from the list, in either layout: bring the list back first
   * (single-pane), find the item (walking a virtualized list from the top),
   * click it and wait for the chat's header.
   *
   * Rejects with `code: "not_reachable"` when the list cannot be brought back
   * and `code: "not_found"` when the item is not in the list.
   *
   * @param {Document} doc
   * @param {{conversationId: string}} conv
   * @param {{click: function(Element): void, sleep: function(number): Promise<void>,
   *          back?: function(): void, getPathname: function(): string, timeoutMs?: number}} io
   */
  async function openFromList(doc, conv, io) {
    if (!(await returnToList(doc, io))) {
      var unreachable = new Error("The conversation list is not on screen");
      unreachable.code = "not_reachable";
      throw unreachable;
    }
    var link = findLink(doc, conv.conversationId);
    if (!link) {
      // The list is virtualized: walk it from the top until the item appears.
      var el = findListScroller(doc);
      if (el) el.scrollTop = 0;
      for (var i = 0; i < 40 && !link; i++) {
        await io.sleep(300);
        link = findLink(doc, conv.conversationId);
        if (!link && el) el.scrollTop += Math.max(200, el.clientHeight - 50);
      }
    }
    if (!link) {
      var missing = new Error("Chat not found in the list");
      missing.code = "not_found";
      throw missing;
    }
    io.click(link);
    await waitFor(function () {
      return io.getPathname().indexOf("/" + conv.conversationId) !== -1 &&
        doc.querySelector(SELECTORS.headerTitle);
    }, io.sleep, io.timeoutMs || 10000, 100, "the chat to open");
  }

  var api = {
    SELECTORS: SELECTORS,
    BACK_BUTTON_SELECTORS: BACK_BUTTON_SELECTORS,
    BACK_CLICK_ATTEMPTS: BACK_CLICK_ATTEMPTS,
    isShown: isShown,
    listShown: listShown,
    returnToList: returnToList,
    openFromList: openFromList,
    findMessageScroller: findMessageScroller,
    loadHistory: loadHistory,
    RCS_HISTORY_BUDGET_MS: RCS_HISTORY_BUDGET_MS,
    HISTORY_BUDGET_EXTEND_MS: HISTORY_BUDGET_EXTEND_MS,
    HISTORY_BUDGET_GROWTH_WINDOW_MS: HISTORY_BUDGET_GROWTH_WINDOW_MS,
    HISTORY_BUDGET_CAP_MS: HISTORY_BUDGET_CAP_MS,
    RCS_HISTORY_EXTENSION_POOL_MS: RCS_HISTORY_EXTENSION_POOL_MS,
    HISTORY_NO_PROGRESS_MS: HISTORY_NO_PROGRESS_MS,
    HISTORY_MIN_POLLS_FOR_WALL: HISTORY_MIN_POLLS_FOR_WALL,
    HISTORY_WALL_CEILING_MS: HISTORY_WALL_CEILING_MS,
    HISTORY_SMALL_CHAT: HISTORY_SMALL_CHAT,
    HISTORY_FIRST_GROWTH_MS: HISTORY_FIRST_GROWTH_MS,
    HISTORY_NUDGE_WATCH_MS: HISTORY_NUDGE_WATCH_MS,
    HISTORY_START_MARKER_SELECTORS: HISTORY_START_MARKER_SELECTORS,
    HISTORY_LOADING_SELECTORS: HISTORY_LOADING_SELECTORS,
    messageIdSet: messageIdSet,
    waitForMessageSwap: waitForMessageSwap,
    signInState: signInState,
    conversationIdFromHref: conversationIdFromHref,
    readConversationList: readConversationList,
    findListScroller: findListScroller,
    collectConversations: collectConversations,
    looksLikePhone: looksLikePhone,
    isShortCode: isShortCode,
    parseListTime: parseListTime,
    connectionBanner: connectionBanner,
    CONNECTION_BANNER_SELECTORS: CONNECTION_BANNER_SELECTORS,
    loadingVisible: loadingVisible,
    localeDateOrder: localeDateOrder,
    waitFor: waitFor,
    readParticipantsAndClose: readParticipantsAndClose,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.KeeprScan = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
