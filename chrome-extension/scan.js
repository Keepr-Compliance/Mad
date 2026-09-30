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

  /**
   * Load the whole (lazily rendered) list: scroll to the bottom, wait, re-read.
   * Stops when the count is unchanged for `stableRounds` scrolls in a row, or
   * at `maxItems`, or after `maxMs`.
   *
   * @param {Document} doc
   * @param {{scroll: function(): (void|Promise<void>), sleep: function(number): Promise<void>,
   *          now?: function(): number, waitMs?: number, stableRounds?: number,
   *          maxItems?: number, maxMs?: number}} opts
   */
  async function collectConversations(doc, opts) {
    var now = opts.now || function () { return Date.now(); };
    var waitMs = opts.waitMs == null ? 800 : opts.waitMs;
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

    absorb();
    while (stable < stableRounds) {
      if (order.length >= maxItems) { stopReason = "max_items"; break; }
      if (now() - started >= maxMs) { stopReason = "max_time"; break; }
      var before = order.length;
      await opts.scroll();
      await opts.sleep(waitMs);
      absorb();
      stable = order.length === before ? stable + 1 : 0;
    }
    return {
      conversations: order.slice(0, maxItems).map(function (id) { return byId[id]; }),
      stopReason: stopReason,
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
    waitFor: waitFor,
    readParticipantsAndClose: readParticipantsAndClose,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.KeeprScan = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
