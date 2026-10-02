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

  function normalizeSpace(s) {
    return String(s || "").replace(/[\s\u00a0\u202f]+/g, " ").trim();
  }

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
  function readConversationList(doc, now) {
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
        timeMs: listItemTimeMs(items[i], now ? now() : Date.now()),
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
   * A list time as epoch ms, at day precision (the cache only needs "older
   * than since"). Today's "3:45 PM" → now; "Yesterday"; a weekday → the most
   * recent such day; "Sep 20" (this year, or last year if that is in the
   * future); "Sep 20, 2025"; "9/20/25" (month first). A numeric date whose
   * first two parts are both 12 or less ("3/4/25") could be either order: null
   * (SR). Anything else → null.
   */
  function parseListTime(text, nowMs) {
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
    var nd = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
    if (nd) {
      if (Number(nd[1]) <= 12 && Number(nd[2]) <= 12) return null;
      var yy = Number(nd[3]);
      if (yy < 100) yy += 2000;
      return new Date(yy, Number(nd[1]) - 1, Number(nd[2])).getTime();
    }
    return null;
  }

  function listItemTimeMs(item, nowMs) {
    for (var i = 0; i < LIST_TIME_SELECTORS.length; i++) {
      var el = item.querySelector(LIST_TIME_SELECTORS[i]);
      if (el) return parseListTime(el.textContent, nowMs);
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
    var reachedSince = false;
    // SR: two older chats IN A ROW end the list (a single older one may be a
    // pinned chat at the top); a newer or unreadable one starts over.
    var olderInARow = 0;
    function absorb() {
      var list = readConversationList(doc, now);
      for (var i = 0; i < list.length; i++) {
        if (!byId[list[i].conversationId]) {
          byId[list[i].conversationId] = list[i];
          order.push(list[i].conversationId);
          // BACKLOG-3658: newest first — a chat older than `since` ends the list.
          if (stopAt !== null) {
            olderInARow = list[i].timeMs !== null && list[i].timeMs < stopAt ? olderInARow + 1 : 0;
            if (olderInARow >= SINCE_STOP_RUN) reachedSince = true;
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
    return {
      conversations: order.slice(0, maxItems).map(function (id) { return byId[id]; }),
      stopReason: stopReason,
      scroll: stats,
    };
  }

  /** Lower case, emoji and punctuation removed, spaces collapsed. */
  function normalizeName(s) {
    return normalizeSpace(
      String(s || "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
    );
  }

  function looksLikePhone(s) {
    var digits = String(s || "").replace(/\D/g, "");
    return digits.length >= 7 && /^[\d\s()+.\-]+$/.test(String(s || "").trim());
  }

  /**
   * Chats worth opening. Loose on purpose — the phone check in Keepr is the
   * gate. A chat is a candidate when its name equals a contact's name, contains
   * all of a contact's name words, shares first and last word with it, or (a
   * group chat) contains a contact's first word; and every chat whose "name"
   * is a phone number. Contacts named "Unknown" never drive a match.
   */
  function pickCandidates(conversations, contacts) {
    var named = [];
    for (var i = 0; i < contacts.length; i++) {
      var n = normalizeName(contacts[i].displayName);
      if (!n || n === "unknown") continue;
      named.push({ contactId: contacts[i].contactId, tokens: n.split(" "), full: n });
    }
    var out = [];
    for (var j = 0; j < conversations.length; j++) {
      var conv = conversations[j];
      if (looksLikePhone(conv.name)) {
        out.push({ conversation: conv, reason: "phone_name" });
        continue;
      }
      var name = normalizeName(conv.name);
      if (!name) continue;
      var words = name.split(" ");
      var isGroup = /,| and \d+ others?| & /i.test(conv.name);
      for (var k = 0; k < named.length; k++) {
        var c = named[k];
        var all = c.tokens.every(function (t) { return words.indexOf(t) !== -1; });
        var firstLast =
          c.tokens.length > 1 &&
          words[0] === c.tokens[0] &&
          words[words.length - 1] === c.tokens[c.tokens.length - 1];
        var groupFirst = isGroup && words.indexOf(c.tokens[0]) !== -1;
        if (name === c.full || all || firstLast || groupFirst) {
          out.push({ conversation: conv, reason: name === c.full ? "name" : "name_loose" });
          break;
        }
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // BACKLOG-3645: a contact's name never hides a chat
  // -------------------------------------------------------------------------

  /**
   * Up to this many chats in the list, EVERY chat's Details number is checked
   * (about 1.5–2.5 s each); names only order the queue. Above it, only chats a
   * name could plausibly belong to, plus number-only chats, are checked and the
   * rest are reported as not checked.
   */
  var CHECK_ALL_MAX = 50;
  /** Over the cap, at most this many chats are checked; the rest count as notChecked. */
  var OVER_CAP_QUEUE_MAX = 100;

  /** Lower case, accents removed, punctuation → space. */
  function foldName(s) {
    return normalizeName(String(s || "").normalize("NFD").replace(/\p{M}+/gu, ""));
  }

  /**
   * Over the cap: a chat whose name shares any word of 3+ letters with a
   * contact's name, or starts with the contact's first name. Case- and
   * accent-insensitive.
   */
  function looseNameMatch(convName, contacts) {
    var words = foldName(convName).split(" ").filter(Boolean);
    if (words.length === 0) return false;
    for (var i = 0; i < contacts.length; i++) {
      var tokens = foldName(contacts[i].displayName).split(" ").filter(Boolean);
      if (tokens.length === 0 || tokens.join(" ") === "unknown") continue;
      // First name: at least 3 letters, so "Al" or "Jo" does not pull in every chat.
      if (tokens[0].length >= 3 && words[0] === tokens[0]) return true;
      for (var t = 0; t < tokens.length; t++) {
        if (tokens[t].length >= 3 && words.indexOf(tokens[t]) !== -1) return true;
      }
    }
    return false;
  }

  var QUEUE_ORDER = { name: 0, name_loose: 1, name_token: 1, phone_name: 2, unmatched_name: 3 };

  /**
   * Which chats to check, in what order.
   *
   * @param {Array<{conversationId: string, name: string}>} conversations the whole list
   * @param {Array<{displayName: string}>} contacts
   * @param {{checkAllMax?: number}} [opts]
   * @returns {{queue: Array<{conversation: object, reason: string}>, notChecked: number, checkAll: boolean}}
   *   reason: name | name_loose | phone_name (pickCandidates), name_token (over
   *   the cap only) or unmatched_name (checked only because the list is small).
   */
  function planChecks(conversations, contacts, opts) {
    var max = (opts && opts.checkAllMax) || CHECK_ALL_MAX;
    var ranked = pickCandidates(conversations, contacts);
    var reasonById = {};
    for (var i = 0; i < ranked.length; i++) reasonById[ranked[i].conversation.conversationId] = ranked[i].reason;
    var checkAll = conversations.length <= max;
    var queue = [];
    for (var j = 0; j < conversations.length; j++) {
      var conv = conversations[j];
      var reason = reasonById[conv.conversationId];
      if (!reason) {
        if (checkAll) reason = "unmatched_name";
        else if (looseNameMatch(conv.name, contacts)) reason = "name_token";
        else continue;
      }
      queue.push({ conversation: conv, reason: reason, at: j });
    }
    // Stable: by reason group, then list order.
    queue.sort(function (a, b) {
      return QUEUE_ORDER[a.reason] - QUEUE_ORDER[b.reason] || a.at - b.at;
    });
    // Over the cap the queue itself is bounded: the best-ranked first.
    if (!checkAll && queue.length > OVER_CAP_QUEUE_MAX) queue = queue.slice(0, OVER_CAP_QUEUE_MAX);
    return {
      queue: queue.map(function (q) { return { conversation: q.conversation, reason: q.reason }; }),
      notChecked: conversations.length - queue.length,
      checkAll: checkAll,
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
   * Waits after a scroll brought nothing: each nudge (a small scroll down and
   * back to the top, so the page's loader fires again) gets the next, longer
   * wait. Real-phone run 2026-10-01: dozens of chats stopped at ~41-50 with
   * "no_more" after ONE 3 s wait — the next page had not arrived yet.
   */
  var HISTORY_NUDGE_WAITS_MS = [3000, 6000, 10000];

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

  function anyMatch(scope, selectors) {
    for (var i = 0; i < selectors.length; i++) {
      if (scope.querySelector(selectors[i])) return true;
    }
    return false;
  }

  /**
   * Load older messages of the open chat (live, 2026-09-29: only the latest
   * 25 render on open). Repeats: scroll up, then wait for a message with a
   * msg-id not seen before. Stops at the first of:
   *   - "date_floor": the oldest loaded message is EARLIER than `floorMs`
   *     (checked before every scroll, so no scroll when already there);
   *   - "cap": `cap` distinct messages seen (default 2000);
   *   - "no_more": CONFIRMED at the start of the chat (confirmedBy) — a start
   *     marker (HISTORY_START_MARKER_SELECTORS) is on screen ("marker"), or
   *     the whole chat fit on the first page (fewer than HISTORY_FIRST_PAGE,
   *     settled: no loading indicator and stable for
   *     HISTORY_FIRST_PAGE_STABLE_MS — "first_page");
   *   - "not_settled": UNCONFIRMED — nothing new after every nudge
   *     (HISTORY_NUDGE_WAITS_MS), or the budget (RCS_HISTORY_BUDGET_MS) ran
   *     out. The caller reports it (history_not_settled); never silent.
   * While a loading indicator shows, waiting goes on (within the budget).
   * "New" is counted over every msg-id seen so far, not the number on screen,
   * so a list that drops its newest rows while scrolling still counts loads.
   * Time is measured in `sleep` steps.
   *
   * @param {Document} doc
   * @param {{scrollUp: function(): (void|Promise<void>), nudge?: function(): (void|Promise<void>),
   *          sleep: function(number): Promise<void>,
   *          oldestMs: function(): (number|null), floorMs?: (number|null), cap?: number,
   *          noNewTimeoutMs?: number, budgetMs?: number, nudgeWaitsMs?: number[],
   *          startMarkerSelectors?: string[], loadingSelectors?: string[],
   *          intervalMs?: number, onProgress?: function(number): void,
   *          checkpoint?: function(number): Promise<void>}} io
   * @returns {Promise<{stopReason: string, count: number, scrolls: number, nudges: number, confirmedBy?: string}>}
   */
  async function loadHistory(doc, io) {
    var cap = typeof io.cap === "number" ? io.cap : 2000;
    var noNewMs = typeof io.noNewTimeoutMs === "number" ? io.noNewTimeoutMs : 3000;
    var budgetMs = typeof io.budgetMs === "number" ? io.budgetMs : RCS_HISTORY_BUDGET_MS;
    var nudgeWaits = io.nudgeWaitsMs || HISTORY_NUDGE_WAITS_MS;
    var startSelectors = io.startMarkerSelectors || HISTORY_START_MARKER_SELECTORS;
    var loadingSelectors = io.loadingSelectors || HISTORY_LOADING_SELECTORS;
    var nudge = io.nudge || io.scrollUp;
    var step = io.intervalMs || 250;
    var floorMs = typeof io.floorMs === "number" && isFinite(io.floorMs) ? io.floorMs : null;
    var seen = {};
    var count = 0;
    var scrolls = 0;
    var nudges = 0;
    var spent = 0;

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
      return added;
    }
    function atStart() {
      return startSelectors.length > 0 && anyMatch(doc, startSelectors);
    }
    function result(stopReason, confirmedBy) {
      var r = { stopReason: stopReason, count: count, scrolls: scrolls, nudges: nudges };
      if (confirmedBy) r.confirmedBy = confirmedBy;
      return r;
    }
    function loadingShown() {
      return anyMatch(findMessageScroller(doc) || doc, loadingSelectors);
    }
    /**
     * SR S2: the first page is short AND settled — no loading indicator and
     * the same message set for HISTORY_FIRST_PAGE_STABLE_MS, right now.
     */
    async function firstPageSettled() {
      var last = messageIdSet(doc);
      var stableFor = 0;
      var waited = 0;
      while (waited < HISTORY_FIRST_PAGE_MAX_WAIT_MS && spent < budgetMs) {
        await io.sleep(step);
        spent += step;
        waited += step;
        absorb();
        if (count >= HISTORY_FIRST_PAGE) return false;
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
    /** Wait up to `ms` for a new message; longer while loading shows. Budget-bounded. */
    async function waitForNew(ms) {
      var waited = 0;
      while (waited < ms && spent < budgetMs) {
        await io.sleep(step);
        spent += step;
        if (absorb() > 0) return true;
        // A loading indicator: this wait does not run down (the budget does).
        if (!loadingShown()) waited += step;
      }
      return false;
    }

    absorb();
    var firstPage = count;
    for (;;) {
      if (io.onProgress) io.onProgress(count);
      if (count >= cap) return result("cap");
      if (floorMs !== null) {
        var oldest = io.oldestMs();
        if (typeof oldest === "number" && oldest < floorMs) return result("date_floor");
      }
      if (atStart()) return result("no_more", "marker");
      if (scrolls === 0 && firstPage < HISTORY_FIRST_PAGE && (await firstPageSettled())) return result("no_more", "first_page");
      if (spent >= budgetMs) return result("not_settled");
      await io.scrollUp();
      scrolls += 1;
      var added = await waitForNew(noNewMs);
      for (var k = 0; !added && k < nudgeWaits.length && spent < budgetMs; k++) {
        if (atStart()) return result("no_more", "marker");
        await nudge();
        nudges += 1;
        added = await waitForNew(nudgeWaits[k]);
      }
      if (!added) return atStart() ? result("no_more", "marker") : result("not_settled");
      // Awaited after every scroll that loaded something, so a caller can end
      // the load (by throwing) as soon as it learns the job was cancelled.
      if (io.checkpoint) await io.checkpoint(count);
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
    HISTORY_NUDGE_WAITS_MS: HISTORY_NUDGE_WAITS_MS,
    HISTORY_START_MARKER_SELECTORS: HISTORY_START_MARKER_SELECTORS,
    HISTORY_LOADING_SELECTORS: HISTORY_LOADING_SELECTORS,
    messageIdSet: messageIdSet,
    waitForMessageSwap: waitForMessageSwap,
    signInState: signInState,
    conversationIdFromHref: conversationIdFromHref,
    readConversationList: readConversationList,
    findListScroller: findListScroller,
    collectConversations: collectConversations,
    normalizeName: normalizeName,
    looksLikePhone: looksLikePhone,
    isShortCode: isShortCode,
    pickCandidates: pickCandidates,
    parseListTime: parseListTime,
    planChecks: planChecks,
    CHECK_ALL_MAX: CHECK_ALL_MAX,
    OVER_CAP_QUEUE_MAX: OVER_CAP_QUEUE_MAX,
    waitFor: waitFor,
    readParticipantsAndClose: readParticipantsAndClose,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.KeeprScan = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
