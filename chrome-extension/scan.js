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
 *   leaves the DOM or is only hidden, and the header back button's selector
 *   (see BACK_BUTTON_SELECTORS; history.back() is the fallback).
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
  function readConversationList(doc) {
    var items = doc.querySelectorAll(SELECTORS.listItem);
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var nameEl = items[i].querySelector(SELECTORS.listName);
      var link = items[i].querySelector(SELECTORS.listLink);
      var href = link ? link.getAttribute("href") || "" : "";
      var id = conversationIdFromHref(href);
      if (!id || id === "new") continue;
      out.push({ conversationId: id, name: normalizeSpace(nameEl ? nameEl.textContent : ""), href: href });
    }
    return out;
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

    function absorb() {
      var list = readConversationList(doc);
      for (var i = 0; i < list.length; i++) {
        if (!byId[list[i].conversationId]) {
          byId[list[i].conversationId] = list[i];
          order.push(list[i].conversationId);
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
      if (words[0] === tokens[0]) return true;
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
   * Open Details for the open chat, read every participant's number, close
   * Details with Done and confirm the participant rows are gone.
   *
   * @param {Document} doc
   * @param {{click: function(Element): void, sleep: function(number): Promise<void>, timeoutMs?: number}} io
   * @returns {Promise<string[]>} the numbers as shown
   */
  async function readParticipantsAndClose(doc, io) {
    var t = io.timeoutMs || 10000;
    // Rows already on screen belong to an earlier chat whose Details did not
    // close. Reading them would check this chat against the wrong numbers.
    if (doc.querySelector(SELECTORS.participant)) {
      var stuck = new Error("The Details panel from an earlier chat is still open");
      stuck.code = "details_stuck";
      throw stuck;
    }
    var menu = await waitFor(function () { return doc.querySelector(SELECTORS.menuButton); }, io.sleep, t, 100, "the conversation menu");
    io.click(menu);
    var details = await waitFor(function () { return doc.querySelector(SELECTORS.detailsButton); }, io.sleep, t, 100, "the Details item");
    io.click(details);
    await waitFor(function () { return doc.querySelector(SELECTORS.participant); }, io.sleep, t, 100, "the participant list");
    var rows = doc.querySelectorAll(SELECTORS.participant);
    var numbers = [];
    for (var i = 0; i < rows.length; i++) {
      var num = rows[i].querySelector(SELECTORS.participantNumber);
      var v = normalizeSpace(num ? num.textContent : "");
      if (!v) {
        // An unsaved contact: the number span is empty and the number itself
        // is shown where a saved contact's name would be.
        var nm = rows[i].querySelector(SELECTORS.participantName);
        var t = normalizeSpace(nm ? nm.textContent : "");
        if (looksLikePhone(t)) v = t;
      }
      if (v) numbers.push(v);
    }
    var done = await waitFor(function () { return doc.querySelector(SELECTORS.detailsDone); }, io.sleep, t, 100, "the Done button");
    io.click(done);
    await waitFor(function () { return !doc.querySelector(SELECTORS.participant); }, io.sleep, t, 100, "Details to close");
    return numbers;
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
   * @param {{sleep: function(number): Promise<void>, timeoutMs?: number, stableMs?: number, intervalMs?: number}} io
   * @returns {Promise<boolean>}
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
      if (waited >= timeoutMs) return false;
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
   * Load older messages of the open chat (live, 2026-09-29: only the latest
   * 25 render on open). Repeats: scroll up, then wait for a message with a
   * msg-id not seen before. Stops at the first of:
   *   - "date_floor": the oldest loaded message is EARLIER than `floorMs`
   *     (checked before every scroll, so no scroll when already there);
   *   - "cap": `cap` distinct messages seen (default 2000);
   *   - "no_more": a scroll brought no new message within `noNewTimeoutMs`
   *     (default 3000), measured in `sleep` steps.
   * "New" is counted over every msg-id seen so far, not the number on screen,
   * so a list that drops its newest rows while scrolling still counts loads.
   *
   * @param {Document} doc
   * @param {{scrollUp: function(): (void|Promise<void>), sleep: function(number): Promise<void>,
   *          oldestMs: function(): (number|null), floorMs?: (number|null), cap?: number,
   *          noNewTimeoutMs?: number, intervalMs?: number, onProgress?: function(number): void,
   *          checkpoint?: function(number): Promise<void>}} io
   * @returns {Promise<{stopReason: string, count: number, scrolls: number}>}
   */
  async function loadHistory(doc, io) {
    var cap = typeof io.cap === "number" ? io.cap : 2000;
    var noNewMs = typeof io.noNewTimeoutMs === "number" ? io.noNewTimeoutMs : 3000;
    var step = io.intervalMs || 250;
    var floorMs = typeof io.floorMs === "number" && isFinite(io.floorMs) ? io.floorMs : null;
    var seen = {};
    var count = 0;
    var scrolls = 0;

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

    absorb();
    for (;;) {
      if (io.onProgress) io.onProgress(count);
      if (count >= cap) return { stopReason: "cap", count: count, scrolls: scrolls };
      if (floorMs !== null) {
        var oldest = io.oldestMs();
        if (typeof oldest === "number" && oldest < floorMs) {
          return { stopReason: "date_floor", count: count, scrolls: scrolls };
        }
      }
      await io.scrollUp();
      scrolls += 1;
      var waited = 0;
      var added = 0;
      while (waited < noNewMs) {
        await io.sleep(step);
        waited += step;
        added = absorb();
        if (added > 0) break;
      }
      if (added === 0) return { stopReason: "no_more", count: count, scrolls: scrolls };
      // Awaited after every scroll that loaded something, so a caller can end
      // the load (by throwing) as soon as it learns the job was cancelled.
      if (io.checkpoint) await io.checkpoint(count);
    }
  }

  // -------------------------------------------------------------------------
  // BACKLOG-3629: two-pane and single-pane layouts
  // -------------------------------------------------------------------------

  /**
   * The header's back button in the single-pane layout, most specific first.
   * UNTRACED on the live page; the header is `mws-header` with `.left-content`
   * holding the back button and the title (observed 2026-09-30).
   */
  /** An open chat's path: the only place history.back() is used from. */
  var CHAT_PATH_RE = /^\/web\/conversations\/[^/?#]+/;

  var BACK_BUTTON_SELECTORS = [
    "mws-header [data-e2e-back-button]",
    'mws-header button[aria-label="Back"]',
    "mws-header .left-content button",
    'button[aria-label="Back"]',
  ];

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
      var button = findBackButton(doc);
      if (button) {
        io.click(button);
        if (await waitList()) return true;
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
    isShown: isShown,
    listShown: listShown,
    returnToList: returnToList,
    openFromList: openFromList,
    findMessageScroller: findMessageScroller,
    loadHistory: loadHistory,
    messageIdSet: messageIdSet,
    waitForMessageSwap: waitForMessageSwap,
    signInState: signInState,
    conversationIdFromHref: conversationIdFromHref,
    readConversationList: readConversationList,
    findListScroller: findListScroller,
    collectConversations: collectConversations,
    normalizeName: normalizeName,
    looksLikePhone: looksLikePhone,
    pickCandidates: pickCandidates,
    planChecks: planChecks,
    CHECK_ALL_MAX: CHECK_ALL_MAX,
    waitFor: waitFor,
    readParticipantsAndClose: readParticipantsAndClose,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.KeeprScan = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
