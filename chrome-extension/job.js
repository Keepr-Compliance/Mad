/**
 * Keepr — Sync job runner (BACKLOG-3620).
 *
 * Keepr's Sync opens Messages for Web with `#keepr-job=<jobId>`. This script
 * (a content script, loaded after extract.js and scan.js) picks the job up,
 * checks the page is signed in, claims the job, scans the conversation list
 * for chats whose name looks like a transaction contact, reads each one's phone
 * numbers from Details and asks Keepr whether they match. Only chats Keepr
 * matched are extracted and sent, with their images. At the end Keepr is told
 * the job finished and brings its own window forward.
 *
 * `runJob` is testable: every page, network and timing effect comes in through
 * `env`. The chrome.* glue at the bottom runs only in the browser. All traffic
 * to Keepr goes through the service worker (the content script's own requests
 * would carry the messages.google.com origin and be refused).
 */
(function (root) {
  "use strict";

  var NOT_SIGNED_IN = "Sign in to Google Messages, then click Sync in Keepr again";
  var JOB_HASH_RE = /(?:^#|&)keepr-job=([0-9a-fA-F-]{36})(?:&|$)/;
  var LIST_ITEM = "mws-conversation-list-item";

  function jobIdFromHash(hash) {
    var m = String(hash || "").match(JOB_HASH_RE);
    return m ? m[1].toLowerCase() : null;
  }

  /**
   * Wait until the page is either signed in (the list, or in a narrow window
   * an open chat's header, is there) or on a sign-in path. "not_signed_in" | "ready" | "timeout".
   */
  async function waitForPageState(env, timeoutMs) {
    var waited = 0;
    for (;;) {
      var state = env.scan.signInState(env.getLocation().pathname);
      if (state === "not_signed_in") return "not_signed_in";
      if (env.doc.querySelector(LIST_ITEM)) return "ready";
      // A narrow window with a chat open shows no list (BACKLOG-3629): the
      // chat header on a signed-in path proves the page is loaded too.
      if (state === "signed_in" && env.scan.SELECTORS && env.doc.querySelector(env.scan.SELECTORS.headerTitle)) {
        return "ready";
      }
      if (waited >= timeoutMs) return "timeout";
      await env.sleep(250);
      waited += 250;
    }
  }

  function messageOf(reply, fallback) {
    return (reply && reply.body && reply.body.message) || fallback;
  }

  var CANCELLED = "Sync cancelled in Keepr";
  var MESSAGES_NOT_LOADED = "messages_not_loaded";
  /**
   * SR (2026-10-02): the chat is ALREADY open (often the top chat in the two-
   * pane layout): clicking it re-renders nothing, so waiting for the message
   * set to change timed out as "not loaded". Then the "before" snapshot is
   * this sentinel (never a real set) and the messages on screen are read once
   * present and stable for ALREADY_OPEN_STABLE_MS.
   */
  var ALREADY_OPEN = "\u0000already-open";
  var ALREADY_OPEN_STABLE_MS = 1000;

  /** The URL AND the header already show this chat. */
  function chatAlreadyOpen(env, conv) {
    var loc = env.getLocation ? env.getLocation() : null;
    var m = loc && /^\/web\/conversations\/([^/?#]+)/.exec(loc.pathname || "");
    if (!m || m[1] !== conv.conversationId) return false;
    var header = env.doc && env.doc.querySelector ? env.doc.querySelector("[data-e2e-header-title]") : null;
    var norm = function (t) { return String(t || "").replace(/\s+/g, " ").trim().toLowerCase(); };
    return !!header && !!conv.name && norm(header.textContent) === norm(conv.name);
  }

  /** Keepr keeps at most this many named entries (RCS_NOT_REACHED_CAP). */
  var NOT_REACHED_CAP = 20;
  /** BACKLOG-3658: a cache Sync checks at most this many chats per run (the rest: not checked). */
  var CACHE_CHECK_MAX = 300;
  /** BACKLOG-3658: the list read for a cache Sync stops here when no time can be read. */
  var CACHE_LIST_MAX = 1000;
  // No longer sent (founder 2026-10-03: no pause while hidden); still rendered
  // as the paused state for an older Keepr-side stage.
  var PAUSED_TEXT = "Keep this Chrome window visible — Sync paused";
  /**
   * SR M (2026-10-02): media. Keepr says per chat whether it keeps the chat's
   * photos (keepPhotos: a transaction contact, or "Download photos from all
   * chats", on by default) and videos (keepVideos; off by default). Every
   * photo and video bubble is counted against what was saved; photos that
   * did not load are retried once at the end, within RCS_MEDIA_RETRY_POOL_MS
   * for the whole run. VIDEOS are counted but not downloaded yet (no live
   * trace of the video bubble): "couldn't download (not supported yet)".
   */
  var RCS_MAX_PHOTO_BYTES = 25 * 1024 * 1024;
  var RCS_MAX_VIDEO_BYTES = 200 * 1024 * 1024;
  var RCS_MEDIA_RETRY_POOL_MS = 5 * 60000;
  /**
   * SR (3671 P1): a chat that failed for a TRANSIENT reason (its messages did
   * not load, it could not be opened / found, Details timed out, its history
   * did not settle) gets ONE retry at the end of the run, BEFORE the photo
   * retry, within its own pool. A recovered chat leaves "not fully imported".
   */
  var RCS_TRANSIENT_RETRY_POOL_MS = 5 * 60000;
  var RETRY_OVERHEAD_MS = 1000;
  var VIDEO_FILE_RE = /\.(mp4|mov|m4v|3gp|3gpp|webm|avi)$/i;
  var NOT_LOADED_IMAGE = "image (not loaded)";
  var MEDIA_REASON_TEXT = {
    notLoaded: "didn't load", readFailed: "couldn't be read", tooLarge: "too large", failed: "Keepr couldn't save",
    notSupported: "not supported yet",
  };
  /**
   * Google's connection banner (scan.connectionBanner): the job pauses while
   * it shows and resumes when it clears; past RCS_CONNECTION_LOST_MS it ends
   * with a named reason (not a pile of per-chat failures).
   */
  var CONNECTING_TEXT = "Reconnecting to your phone…";
  var UNREACHABLE_TEXT = "Your phone isn't reachable — check it's on and connected";
  var RCS_CONNECTION_LOST_MS = 5 * 60000;
  var CONNECTION_POLL_MS = 1000;
  var CONNECTION_LOST_TEXT = {
    connection_lost: "Keepr stopped: Messages for Web could not reconnect to your phone for 5 minutes. Check your phone, then sync again from Keepr.",
    phone_unreachable: "Keepr stopped: your phone wasn't reachable for 5 minutes. Check it's on and connected, then sync again from Keepr.",
  };
  /** The paused box's line for each pause. */
  var PAUSE_BODIES = {};
  /** Step-log lines kept for the overlay's Copy. */
  var LOG_BUFFER_MAX = 500;
  var LIST_NOT_REACHABLE =
    "Couldn't show the Messages conversation list. Make the window wider or open " +
    "messages.google.com/web/conversations, then click Sync again.";

  /** Why a chat was left out, or imported only in part, for the overlay. */
  var REASON_TEXT = {
    not_opened: "could not be opened",
    no_numbers: "no phone number shown",
    short_code: "a short-code sender (no phone number)",
    business: "a named sender with no phone number (e.g. a business)",
    messages_not_loaded: "messages did not load",
    history_not_settled: "older messages did not finish loading — sync again later",
    no_messages: "no messages found",
    error: "failed",
    images_failed: "images not imported",
    history_truncated: "only the newest messages imported",
    history_gap: "some messages in the middle could not be read — sync again",
  };

  function reasonText(entry) {
    var text = REASON_TEXT[entry.reason] || entry.reason;
    return entry.count ? text + ": " + entry.count : text;
  }

  /** BACKLOG-3641 founder UX: the finished overlay is this one line + Details. */
  var DONE_LINE = "Sync done — switch back to Keepr.";
  /** A cache Sync, between the last chat and Keepr's answer to /finish. */
  var SAVING_TEXT = "Saving in Keepr…";

  /**
   * The Details lines (BACKLOG-3641). `nameOf` renders a chat or contact name:
   * the name itself on screen, a salted tag in the Copy text.
   *
   * @param {{listed: number, checked: number, matched: number, chats: number, messages: number,
   *          images: number, notChecked: number, contactsWithoutPhone: number,
   *          removedByUser: number, notReached: Array<{name: string, reason: string, count?: number}>,
   *          notReachedMore: number}} s
   * @param {function(string): string} nameOf
   */
  function summaryLines(s, nameOf) {
    var lines = [s.isCache ? cacheSavedLine(s) :
      "Scanned " + s.listed + " chats · checked " + s.checked + " · matched " + s.matched +
        " · imported " + s.messages + " messages" + (s.images > 0 ? ", " + s.images + " images" : ""),
    ];
    if (!s.isCache && s.checked > 0 && s.matched === 0) {
      lines.push("None of the checked chats matched a phone number on this transaction's contacts.");
    }
    var confirmedLine = historyConfirmedLine(s.historyConfirmed);
    if (confirmedLine) lines.push(confirmedLine);
    var depthLine = historyDepthLine(s.depth);
    if (depthLine) lines.push(depthLine);
    var extraLine = extraTimeLine(s.extraTime);
    if (extraLine) lines.push(extraLine);
    if (s.notChecked > 0) {
      lines.push("Not checked: " + s.notChecked + " chats (name didn't match a contact on this transaction)");
    }
    // A count only: Keepr-only names never go into the page (SR B1).
    if (s.contactsWithoutPhone > 0) {
      lines.push(s.contactsWithoutPhone + " contact" + (s.contactsWithoutPhone === 1 ? " has" : "s have") +
        " no phone number — see Keepr");
    }
    if (s.notSynced > 0) {
      lines.push(s.notSynced + " chat" + (s.notSynced === 1 ? "" : "s") + " not synced — switched off by you");
    }
    if (s.noMessagesYet > 0) {
      lines.push(s.noMessagesYet + " chat" + (s.noMessagesYet === 1 ? "" : "s") + " with no messages yet");
    }
    if (s.notText > 0) {
      lines.push(s.notText + " not a text conversation (e.g. an AI chat) — skipped");
    }
    if (s.retry && s.retry.retried > 0) {
      lines.push("Retried " + plural(s.retry.retried, "chat", "chats") + ", recovered " + s.retry.recovered +
        (s.retry.notRetried > 0 ? " · " + s.retry.notRetried + " not retried (time limit)" : ""));
    }
    var photoLine = mediaLine("Photos", s.media && s.media.photos);
    if (photoLine) lines.push(photoLine);
    var videoLine = mediaLine("Videos", s.media && s.media.videos);
    if (videoLine) lines.push(videoLine);
    if (s.imagesNotKept > 0) {
      lines.push(s.imagesNotKept + " images not kept (no transaction contact in the chat)");
    }
    if (s.removedByUser > 0) {
      lines.push(s.removedByUser + " messages you removed were not re-added");
    }
    if (s.notReached.length > 0) {
      lines.push("Not fully imported:");
      for (var i = 0; i < s.notReached.length; i++) {
        lines.push("• " + nameOf(s.notReached[i].name) + " (" + reasonText(s.notReached[i]) + ")");
      }
      if (s.notReachedMore > 0) lines.push("+" + s.notReachedMore + " more");
    }
    return lines;
  }

  function plural(n, one, many) {
    return n + " " + (n === 1 ? one : many);
  }

  /**
   * Founder (2026-10-01): a cache Sync's first line is what Keepr SAVED (its
   * /finish answer), not what the page sent — the commit drops texts older
   * than the months setting, and a chat left with none is not "saved".
   * `s.saved`: {chats, messages, newMessages}; null = the save failed;
   * undefined = Keepr had not answered yet.
   */
  function cacheSavedLine(s) {
    var scanned = "Scanned " + plural(s.listed, "chat", "chats");
    if (s.saved === null) return scanned + " · Keepr could not save this Sync — nothing was imported";
    if (!s.saved || typeof s.saved !== "object") return scanned + " · Keepr is still saving — see Keepr for the result";
    return scanned + " · saved " + plural(s.saved.chats, "chat", "chats") + " · " +
      plural(s.saved.messages, "message", "messages") + " (" + s.saved.newMessages + " new)" +
      (typeof s.saved.reactions === "number"
        ? " · " + plural(s.saved.reactions, "reaction", "reactions") +
          (typeof s.saved.newReactions === "number" ? " (" + s.saved.newReactions + " new)" : "")
        : "");
  }

  /**
   * SR S2: "marker" | "first_page" | "no_overflow" | "date_floor" | "none" —
   * how a chat's history coverage was confirmed. Reaching the months limit
   * (date_floor) is confirmed coverage: everything Keepr keeps is loaded.
   */
  function startConfirmedBy(hist) {
    if (hist && (hist.confirmedBy === "marker" || hist.confirmedBy === "first_page" || hist.confirmedBy === "no_overflow")) {
      return hist.confirmedBy;
    }
    return hist && hist.stopReason === "date_floor" ? "date_floor" : "none";
  }

  var DAY_MS = 864e5;

  /** History depth (3671 metrics): where a chat's history load ended. */
  function depthKind(hist) {
    if (!hist) return "partial";
    if (hist.stopReason === "date_floor") return "limit";
    if (hist.stopReason === "no_more") return "start";
    return "partial"; // not_settled, history_gap, cap
  }

  /**
   * The window as the user set it, from the floor's days (live: a 14-day run
   * read "the 1-month limit"). Whole and half months (days = months ×
   * 30.4375, ±3 days for calendar months) read as months, 12 as a year;
   * anything else as days: "14-day", "1.5-month", "3-month", "1-year".
   */
  function windowLabel(floorDays) {
    if (typeof floorDays !== "number" || !isFinite(floorDays) || floorDays <= 0) return null;
    for (var halves = 2; halves <= 24; halves++) {
      var months = halves / 2;
      if (Math.abs(floorDays - months * 30.4375) <= 3) return months === 12 ? "1-year" : months + "-month";
    }
    return Math.round(floorDays) + "-day";
  }

  /** "History depth: …" — counts only (no dates, no names). */
  function historyDepthLine(d) {
    if (!d || d.limit + d.start + d.partial === 0) return null;
    var label = windowLabel(d.floorDays);
    var limit = label ? "the " + label + " limit" : "the months limit";
    return "History depth: " + d.limit + " chats reached " + limit + " · " + d.start + " reached the chat's start · " +
      d.partial + " not fully loaded" +
      (d.gaps > 0 ? " · " + d.gaps + " gaps (" + d.gapsRecovered + " recovered)" : "");
  }

  /** SR: the run's extra-time pool, "Extra time used: N min of 30" — or null when none was used. */
  function extraTimeLine(x) {
    if (!x || !(x.usedMs > 0)) return null;
    return "Extra time used: " + Math.ceil(x.usedMs / 60000) + " min of " + Math.round(x.poolMs / 60000);
  }

  /**
   * SR M: "Photos: 12 saved · 3 couldn't download (2 didn't load, 1 too large)"
   * — counts only; null when the run saw none to keep.
   */
  function mediaLine(label, m) {
    if (!m) return null;
    var failed = 0;
    var parts = [];
    ["notLoaded", "readFailed", "tooLarge", "failed", "notSupported"].forEach(function (k) {
      if (m[k] > 0) {
        failed += m[k];
        parts.push(m[k] + " " + MEDIA_REASON_TEXT[k]);
      }
    });
    if (m.saved === 0 && failed === 0) return null;
    return label + ": " + m.saved + " saved" + (failed > 0 ? " · " + failed + " couldn't download (" + parts.join(", ") + ")" : "");
  }

  /** SR S2: the per-kind count line ("History start: …"), or null when no chat was imported. */
  function historyConfirmedLine(c) {
    if (!c || c.marker + c.first_page + (c.no_overflow || 0) + (c.date_floor || 0) + c.none === 0) return null;
    return "History start: " + c.marker + " confirmed by the start marker · " + c.first_page +
      " complete on the first page · " + (c.no_overflow || 0) + " without scrolling · " +
      (c.date_floor || 0) + " reached the months limit · " + c.none + " not confirmed";
  }

  /** A reply's quoted snippet cap (characters), as Keepr's RCS_REPLY_SNIPPET_MAX. */
  var REPLY_SNIPPET_MAX = 80;

  /**
   * Founder (2026-10-02): a quoted reply's reply-to. The quoted message's
   * msg-id ONLY when exactly one OTHER message of the same chat has that text
   * (a short "ok" quoted among several "ok"s never links); else a snippet
   * (whitespace collapsed, at most 80 characters) and who sent it ("me" |
   * "them"; never a name). null when the message quotes nothing.
   */
  function replyToFor(msg, all) {
    var q = msg && msg.quote;
    if (!q || !q.text) return null;
    var norm = function (t) { return String(t || "").replace(/\s+/g, " ").trim(); };
    var target = norm(q.text);
    var hits = [];
    for (var i = 0; i < all.length; i++) {
      if (all[i] !== msg && all[i].msgId !== msg.msgId && norm(all[i].text) === target) hits.push(all[i].msgId);
    }
    if (hits.length === 1) return { msgId: hits[0] };
    return { snippet: target.slice(0, REPLY_SNIPPET_MAX), sender: q.fromMe ? "me" : "them" };
  }

  /**
   * GAP GUARD: the messages on screen at the end merged with the ones read
   * during the history load (by msg-id), unique, oldest first. The ON-SCREEN
   * copy is listed first so it wins (its images have loaded, its reactions
   * are present). Same sentAt (minute precision): numeric msg-id order
   * (monotonic within a chat), then first-seen order.
   */
  function unionMessages(read, onScreen) {
    var byId = {};
    var out = [];
    var lists = [onScreen || [], read || []];
    for (var l = 0; l < lists.length; l++) {
      for (var i = 0; i < lists[l].length; i++) {
        var m = lists[l][i];
        if (!m || !m.msgId || byId[m.msgId]) continue;
        byId[m.msgId] = true;
        out.push({ m: m, seen: out.length });
      }
    }
    /** Numeric msg-id order: shorter first, then by digits (exact for ids of any length). */
    function cmpIds(x, y) {
      var a = String(x);
      var b = String(y);
      if (!/^\d+$/.test(a) || !/^\d+$/.test(b)) return 0;
      if (a.length !== b.length) return a.length - b.length;
      return a < b ? -1 : a > b ? 1 : 0;
    }
    out.sort(function (x, y) {
      var tx = Date.parse(x.m.sentAt);
      var ty = Date.parse(y.m.sentAt);
      tx = isFinite(tx) ? tx : 0;
      ty = isFinite(ty) ? ty : 0;
      if (tx !== ty) return tx - ty;
      var byId = cmpIds(x.m.msgId, y.m.msgId);
      if (byId !== 0) return byId;
      return x.seen - y.seen;
    });
    return out.map(function (e) { return e.m; });
  }

  /** On-screen Details: real names are fine on the user's own page. */
  function detailsText(s) {
    return summaryLines(s, function (n) { return n; }).join("\n");
  }

  /**
   * Copy text for a test user to send: counts, reasons and salted name tags,
   * then the step log (already shapes and tags). No name, number or message text.
   */
  function copyText(s, tags, logLines, version) {
    // A cache Sync's scan counts (checked / matched / sent) are diagnostics:
    // in the Copy text only, not on screen.
    var scanCounts = s.isCache
      ? ["Checked " + s.checked + " · matched " + s.matched + " · sent " + s.chats + " chats / " + s.messages + " messages" +
        " / " + (s.reactions || 0) + " reactions" + (s.images > 0 ? " / " + s.images + " images" : "")]
      : [];
    // Founder: the extension version heads the Copy text.
    return ["Keepr Sync diagnostics" + (version ? " · extension " + version : "")]
      .concat(summaryLines(s, function (n) { return "#" + (tags[n] || "??????"); }))
      .concat(scanCounts)
      .concat(["--- step log ---"], logLines)
      .join("\n");
  }

  // -------------------------------------------------------------------------
  // BACKLOG-3641: diagnostics. Step lines go to the service-worker console
  // (prefix "[Keepr Sync]"). NEVER message text, never a full phone number,
  // never a name: numbers as shapes, names as a short hash.
  // -------------------------------------------------------------------------

  var SHAPE_KEEP = "+()-. ";

  /**
   * Invisible / format characters that matter when a number fails to parse:
   * U+00A0, U+200B–U+200F, U+202A–U+202F (U+202F, the narrow no-break
   * space, is used by the page itself), U+2060–U+2069, U+FEFF.
   */
  function isFormatChar(code) {
    return code === 0xa0 ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202f) ||
      (code >= 0x2060 && code <= 0x2069) ||
      code === 0xfeff;
  }

  /**
   * "(555) 555-0199" → "(ddd) ddd-dddd". Digits → d, ASCII letters → a; only
   * `+ ( ) - . space` are kept as they are; any other ASCII → `*`. Non-ASCII:
   * the invisible/format characters above → U+XXXX, every other → `?` (a code
   * point would spell out a non-Latin name exactly). The Details number
   * selector is untraced on the live page, so a name or an email could arrive
   * here: it must never be readable.
   */
  function numberShape(s) {
    var out = "";
    var chars = Array.from(String(s === null || s === undefined ? "" : s));
    for (var i = 0; i < chars.length; i++) {
      var ch = chars[i];
      var code = ch.codePointAt(0);
      if (ch >= "0" && ch <= "9") out += "d";
      else if ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z")) out += "a";
      else if (code > 127) out += isFormatChar(code) ? "U+" + code.toString(16).toUpperCase().padStart(4, "0") : "?";
      else if (SHAPE_KEEP.indexOf(ch) !== -1) out += ch;
      else out += "*";
    }
    return out;
  }

  /** A per-job random salt for name tags: tags correlate within a run only. */
  function newSalt() {
    try {
      var bytes = new Uint8Array(4);
      root.crypto.getRandomValues(bytes);
      return Array.from(bytes, function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
    } catch (_e) {
      return Math.random().toString(16).slice(2, 10);
    }
  }

  /** FNV-1a, 6 hex: the fallback name tag when the page has no SHA-256. */
  function shortHash(s) {
    var h = 0x811c9dc5;
    var str = String(s);
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return ("00000000" + h.toString(16)).slice(-8).slice(0, 6);
  }

  /** Keepr no longer knows this job (cancelled, replaced or over). */
  function jobGone(reply) {
    return !!reply && (reply.status === 404 || reply.status === 410);
  }

  function JobGoneError() {
    var err = new Error(CANCELLED);
    err.jobGone = true;
    return err;
  }

  /**
   * Run one job to completion.
   *
   * @param {string} jobId
   * @param {object} env  { doc, getLocation, api(method, path, body), overlay:{show(text,isError)},
   *                        sleep(ms), click(el), scrollMessagesUp?(), openConversation(conv),
   *                        returnToList?() (narrow window: back to the list; never throws),
   *                        log?(line) (diagnostics, BACKLOG-3641), hashName?(text) → Promise<string>,
   *                        salt? (name-tag salt; random per job when absent),
   *                        scroll?() (tests only: replaces the page's list scroller; the browser
   *                        passes none and collectConversations scrolls the list itself),
   *                        readImage(src), extract(doc, href, now), scan, now?, pageTimeoutMs?,
   *                        messagesTimeoutMs?, messagesStableMs?, historyCap?, historyNoNewMs?,
   *                        nudgeMessages?() and historyBudgetMs? (BACKLOG-3658 #10) }
   *
   * Any job call answering 404 or 410 means Keepr cancelled or replaced this
   * job: the run ends at once — no more chats, no /finish, no /error.
   * @returns {Promise<{outcome: string, progress?: object}>}
   */
  /**
   * BACKLOG-3658: a cache Sync's chats — every chat above the cutoff, in list
   * order (no name planning). The list is newest first: the cutoff is the first
   * of two chats in a row older than `since` (SR: one older chat may be pinned
   * at the top). A single older chat above it has nothing new and is left out;
   * a chat with no readable time is kept. With no readable times the whole list
   * counts. At most CACHE_CHECK_MAX are checked; the rest are "not checked".
   */
  function cachePlan(conversations, sinceMs, pending, deal) {
    var above = conversations;
    var must = pending || {};
    var dealMust = deal || {};
    if (typeof sinceMs === "number" && isFinite(sinceMs)) {
      var older = function (c) { return !!c && typeof c.timeMs === "number" && c.timeMs < sinceMs; };
      for (var i = 0; i < conversations.length; i++) {
        if (older(conversations[i]) && older(conversations[i + 1])) {
          above = conversations.slice(0, i);
          break;
        }
      }
      above = above.filter(function (c) { return !older(c); });
    }
    // Chats switched back on are candidates however old their last message,
    // and they go FIRST: Keepr clears them only once saved, so behind a full
    // list (CACHE_CHECK_MAX) they would stay "not checked" forever.
    var pendingFirst = conversations.filter(function (c) { return must[c.conversationId]; });
    // SR (2026-10-02): then the chats on a live deal that Keepr wants read
    // further back (however old their last message), inside the cap.
    var dealNext = conversations.filter(function (c) { return !must[c.conversationId] && dealMust[c.conversationId]; });
    var rest = above.filter(function (c) { return !must[c.conversationId] && !dealMust[c.conversationId]; });
    above = pendingFirst.concat(dealNext, rest);
    var picked = above.slice(0, CACHE_CHECK_MAX);
    return {
      queue: picked.map(function (c) { return { conversation: c, reason: "cache" }; }),
      notChecked: above.length - picked.length,
    };
  }

  async function runJob(jobId, env) {
    // Founder (2026-10-03): the sync runs on in a hidden tab; Chrome must not
    // discard the tab while it runs (restored when the run ends).
    keepTab(env, true);
    try {
      return await runJobInner(jobId, env);
    } catch (err) {
      if (err && err.jobGone) {
        diag(env, "stopped: cancelled or replaced in Keepr");
        env.overlay.show(CANCELLED, true);
        return { outcome: "job_gone" };
      }
      throw err;
    } finally {
      keepTab(env, false);
    }
  }

  /** The job's tab: never auto-discarded while a run is on. Never throws. */
  function keepTab(env, keep) {
    try {
      if (env.keepTab) env.keepTab(keep);
    } catch (_e) { /* ignore */ }
  }

  /**
   * Founder (2026-10-03): no pause while the tab is hidden (another tab,
   * minimized, behind other windows). How long it was hidden, and how many
   * history batches loaded meanwhile, are counted (telemetry: counts and ms
   * only) to see whether hidden runs are slower.
   */
  function hiddenTracker(env) {
    var vis = env.visibility;
    var nowMs = function () { return (env.now ? env.now() : new Date()).getTime(); };
    var t = { ms: 0, spells: 0, chats: 0, batches: 0 };
    var since = vis && vis.hidden() ? nowMs() : null;
    if (since !== null) t.spells += 1;
    var off = vis && vis.onChange ? vis.onChange(function (hidden) {
      if (hidden && since === null) {
        since = nowMs();
        t.spells += 1;
      } else if (!hidden && since !== null) {
        t.ms += Math.max(0, nowMs() - since);
        since = null;
      }
    }) : null;
    return {
      hidden: function () { return !!(vis && vis.hidden()); },
      /** A chat's history load ended: count its batches if the tab was hidden at its start or end. */
      history: function (wasHidden, hist) {
        if (!wasHidden && !(vis && vis.hidden())) return;
        t.chats += 1;
        t.batches += (hist && hist.batches) || 0;
      },
      done: function () {
        if (since !== null) {
          t.ms += Math.max(0, nowMs() - since);
          since = nowMs();
        }
        if (typeof off === "function") off();
        return { ms: t.ms, spells: t.spells, chats: t.chats, batches: t.batches };
      },
    };
  }

  /** One diagnostics line; never throws (a log must not stop a sync). */
  function diag(env, line) {
    try {
      if (env.log) env.log(line);
    } catch (_e) { /* ignore */ }
  }

  /**
   * A name as a short salted hash: the lines of one run correlate, without the
   * name itself, and the per-job salt keeps tags from matching across runs (a
   * fixed hash of a short name list is easy to reverse).
   */
  async function nameTag(env, salt, name) {
    var text = salt + ":" + String(name || "");
    try {
      return env.hashName ? await env.hashName(text) : shortHash(text);
    } catch (_e) {
      return "??????";
    }
  }

  async function runJobInner(jobId, env) {
    var base = "/job/" + jobId;
    var skips = [];
    // The step log is also kept for the overlay's Copy (BACKLOG-3641).
    var logLines = [];
    var log = function (line) {
      if (logLines.length < LOG_BUFFER_MAX) logLines.push(line);
      diag(env, line);
    };
    var salt = typeof env.salt === "string" ? env.salt : newSalt();
    var tag = function (name) { return nameTag(env, salt, name); };
    var matchedCount = 0;
    // BACKLOG-3629: every chat left out, or imported in part, by name.
    var notReached = [];
    function leaveOut(conv, reason, count) {
      var entry = { name: conv.name || "(unnamed chat)", reason: reason };
      if (count !== undefined) entry.count = count;
      notReached.push(entry);
      (entriesByConv[conv.conversationId] = entriesByConv[conv.conversationId] || []).push(entry);
      log("  left out: " + reason + (count !== undefined ? " (" + count + ")" : ""));
      noteTransient(conv, reason);
    }

    // SR (3671 P1): the transient-failure retry (see RCS_TRANSIENT_RETRY_POOL_MS).
    var TRANSIENT_REASONS = { messages_not_loaded: true, not_opened: true, history_not_settled: true, details_timeout: true };
    var entriesByConv = {};
    var retryState = { item: null };
    var queuedRetry = {};
    var work = [];
    function noteTransient(conv, reason) {
      var item = retryState.item;
      if (!TRANSIENT_REASONS[reason] || !item || item.attempt > 0 || queuedRetry[conv.conversationId]) return;
      queuedRetry[conv.conversationId] = true;
      work.push({ cand: item.cand, attempt: 1 });
    }

    /** Every job call: a 404/410 ends the run. */
    async function call(method, path, body) {
      var reply = await env.api(method, path, body);
      if (jobGone(reply)) throw JobGoneError();
      return reply;
    }
    var progress = { listed: 0, candidates: 0, checked: 0, skipped: 0, notChecked: 0 };
    var totals = { chats: 0, messages: 0, images: 0, reactions: 0, historyConfirmed: { marker: 0, first_page: 0, no_overflow: 0, date_floor: 0, none: 0 },
      depth: { limit: 0, start: 0, partial: 0, gaps: 0, gapsRecovered: 0, floorDays: null }, removedByUser: 0, imagesNotKept: 0, notText: 0, noMessagesYet: 0, notSynced: 0, alreadySaved: 0 };
    var contactsWithoutPhone = 0;
    // SR M: every photo / video bubble against what was saved (counts only).
    var media = {
      photos: { seen: 0, saved: 0, notKept: 0, notLoaded: 0, readFailed: 0, tooLarge: 0, failed: 0, recovered: 0 },
      videos: { seen: 0, saved: 0, notKept: 0, notSupported: 0 },
    };
    /** Chats whose photos did not load: retried once at the end (bounded). */
    var mediaRetry = [];
    // SR: the per-RUN pool of extra history time, shared by every chat.
    var extraTime = {
      poolMs: typeof env.scan.RCS_HISTORY_EXTENSION_POOL_MS === "number" ? env.scan.RCS_HISTORY_EXTENSION_POOL_MS : 30 * 60000,
      usedMs: 0,
    };

    // BACKLOG-3658: progress lines carry the page's Cancel (this job only).
    var RUNNING_EXTRAS = { cancel: true };
    function stageText(n, of) {
      return (isCache ? "Chat " : "Checking chat ") + n + " of " + of;
    }
    // Founder (2026-10-03): a hidden tab no longer pauses the run (it was
    // observed to sync on fine); it is only counted.
    var hiddenStats = hiddenTracker(env);
    var pauses = 0;
    var connectionLostMs = env.connectionLostMs == null ? RCS_CONNECTION_LOST_MS : env.connectionLostMs;
    /** Telemetry (counts and ms only): each banner kind's occurrences and time. */
    var connection = {
      connecting: { count: 0, ms: 0 }, phone_unreachable: { count: 0, ms: 0 }, connection_banner: { count: 0, ms: 0 },
    };
    function bannerNow() {
      return env.scan && env.scan.connectionBanner ? env.scan.connectionBanner(env.doc) : null;
    }
    /**
     * Wait while the page cannot be worked: the connection banner (until it
     * clears, at most connectionLostMs). A hidden tab is NOT a reason.
     * → null (nothing held), {resumed: true}, or {code, message} (give up).
     */
    async function holdWhileOffline(resumeText) {
      var held = false;
      for (;;) {
        var banner = bannerNow();
        if (!banner) break;
        held = true;
        var kind = banner.kind;
        var waited = 0;
        connection[kind].count += 1;
        log("connection banner: " + kind + (kind === "connection_banner" ? " (title " + banner.titleLength + " chars)" : ""));
        pauses += 1;
        await report(kind === "phone_unreachable" ? UNREACHABLE_TEXT : CONNECTING_TEXT);
        while (banner) {
          if (waited >= connectionLostMs) {
            var code = kind === "phone_unreachable" ? "phone_unreachable" : "connection_lost";
            log("connection banner for " + Math.round(waited / 1000) + "s: " + code);
            return { code: code, message: CONNECTION_LOST_TEXT[code] };
          }
          await env.sleep(CONNECTION_POLL_MS);
          waited += CONNECTION_POLL_MS;
          connection[kind].ms += CONNECTION_POLL_MS;
          banner = bannerNow();
          if (banner && banner.kind !== kind) {
            kind = banner.kind;
            connection[kind].count += 1;
            log("connection banner: " + kind);
            await report(kind === "phone_unreachable" ? UNREACHABLE_TEXT : CONNECTING_TEXT);
          }
        }
        log("connection back after " + Math.round(waited / 1000) + "s");
      }
      if (!held) return null;
      if (resumeText) await report(resumeText);
      return { resumed: true };
    }

    /**
     * SR M: one photo → Keepr. → "saved" | "notKept" | "tooLarge" |
     * "readFailed" | "failed" (counts only; the bytes never leave for
     * anywhere but Keepr on this computer).
     */
    async function uploadPhoto(conv, msgId, index, src) {
      try {
        var img = await env.readImage(src);
        if (!img || !/^image\//.test(img.mimeType)) return "readFailed";
        if (typeof img.base64 === "string" && Math.floor(img.base64.length * 3 / 4) > RCS_MAX_PHOTO_BYTES) return "tooLarge";
        var up = await call("POST", base + "/attachment", {
          conversationId: conv.conversationId, msgId: msgId, index: index, mimeType: img.mimeType, base64: img.base64,
        });
        if (up.ok) {
          totals.images += 1;
          return "saved";
        }
        if (up.status === 413) return "tooLarge";
        if (up.status === 422 && up.body && up.body.error === "not_a_contact") {
          // An expected skip (Keepr does not keep this chat's photos): counted apart.
          totals.imagesNotKept += 1;
          return "notKept";
        }
        return "failed";
      } catch (imgErr) {
        if (imgErr && imgErr.jobGone) throw imgErr;
        return "readFailed";
      }
    }

    /**
     * SR M: the end-of-run retry for photos that did not load — each such
     * chat is opened again and its history re-read down to its oldest missing
     * photo with the image pass, all within RCS_MEDIA_RETRY_POOL_MS for the
     * run. Recovered photos move from "didn't load" to "saved".
     */
    async function retryMissingPhotos() {
      if (mediaRetry.length === 0) return;
      var poolMs = env.mediaRetryPoolMs == null ? RCS_MEDIA_RETRY_POOL_MS : env.mediaRetryPoolMs;
      var used = 0;
      var recovered = 0;
      var tried = 0;
      for (var r = 0; r < mediaRetry.length && used < poolMs; r++) {
        var item = mediaRetry[r];
        var lost = await holdWhileOffline(null);
        if (lost && lost.code) return;
        tried += 1;
        try {
          var before = env.scan.messageIdSet(env.doc);
          await env.openConversation(item.conv);
          var ready = await env.scan.waitForMessageSwap(env.doc, before, { sleep: env.sleep, timeoutMs: env.messagesTimeoutMs });
          used += 1000;
          if (!ready) continue;
          var loc = env.getLocation();
          var hist = await env.scan.loadHistory(env.doc, {
            scrollUp: env.scrollMessagesUp || function () {},
            nudge: env.nudgeMessages, nudgeDown: env.nudgeDownMessages, nudgeReturnStep: env.nudgeReturnMessages,
            stepDown: env.stepDownMessages, stepBack: env.stepBackMessages, hasScroller: env.hasMessageScroller,
            imagePass: true, sleep: env.sleep,
            floorMs: typeof item.oldestMs === "number" ? item.oldestMs - 1 : item.floorMs,
            budgetMs: Math.max(1000, Math.min(60000, poolMs - used)), extensionPoolLeftMs: 0,
            extractBatch: function () { return env.extract(env.doc, loc.href, env.now ? env.now() : new Date()).messages; },
            oldestMs: function () {
              var ex = env.extract(env.doc, loc.href, env.now ? env.now() : new Date());
              var min = null;
              for (var q = 0; q < ex.messages.length; q++) {
                var t = Date.parse(ex.messages[q].sentAt);
                if (isFinite(t) && (min === null || t < min)) min = t;
              }
              return min;
            },
          });
          used += hist.elapsedMs || 0;
          var want = {};
          item.msgIds.forEach(function (id) { want[id] = true; });
          var got = hist.messages || [];
          for (var g = 0; g < got.length; g++) {
            if (!want[got[g].msgId]) continue;
            var srcs = got[g].imageSrcs || [];
            for (var s = 0; s < srcs.length; s++) {
              var outcome = await uploadPhoto(item.conv, got[g].msgId, s, srcs[s]);
              if (outcome !== "saved") continue;
              recovered += 1;
              media.photos.saved += 1;
              if (media.photos.notLoaded > 0) media.photos.notLoaded -= 1;
            }
          }
        } catch (err) {
          if (err && err.jobGone) throw err;
        } finally {
          if (env.returnToList) await env.returnToList();
        }
      }
      media.photos.recovered = recovered;
      log("media retry: " + tried + " of " + mediaRetry.length + " chats, " + recovered + " photos recovered, " +
        Math.round(used / 1000) + "s of " + Math.round(poolMs / 1000) + "s");
    }

    async function report(stage) {
      log("stage: " + stage);
      env.overlay.show(stage, false, RUNNING_EXTRAS);
      await call("POST", base + "/progress", {
        stage: stage,
        listed: progress.listed,
        candidates: progress.candidates,
        checked: progress.checked,
        skipped: progress.skipped,
        notChecked: progress.notChecked,
      });
    }

    function summary() {
      var reported = notReached.slice(0, NOT_REACHED_CAP);
      return {
        listed: progress.listed,
        checked: progress.checked,
        matched: matchedCount,
        chats: totals.chats,
        messages: totals.messages,
        images: totals.images,
        reactions: totals.reactions,
        historyConfirmed: totals.historyConfirmed,
        depth: totals.depth,
        retry: retry,
        media: media,
        extraTime: extraTime,
        notChecked: progress.notChecked,
        contactsWithoutPhone: contactsWithoutPhone,
        removedByUser: totals.removedByUser,
        imagesNotKept: totals.imagesNotKept,
        notText: totals.notText,
        noMessagesYet: totals.noMessagesYet,
        notSynced: totals.notSynced,
        notReached: reported,
        notReachedMore: notReached.length - reported.length,
        isCache: isCache,
        saved: saved,
      };
    }
    /** A cache Sync: Keepr's /finish answer (what it saved); see cacheSavedLine. */
    var saved;

    /** Details (real names, on screen) and Copy (tags only) for the overlay. */
    async function overlayExtras() {
      var s = summary();
      var tags = {};
      var names = s.notReached.map(function (e) { return e.name; });
      for (var n = 0; n < names.length; n++) {
        if (!(names[n] in tags)) tags[names[n]] = await tag(names[n]);
      }
      var version = typeof env.extensionVersion === "string" ? env.extensionVersion : "";
      return { details: detailsText(s), copy: copyText(s, tags, logLines, version), version: version };
    }

    async function fail(code, message) {
      log("failed: " + code);
      var failExtras = await overlayExtras();
      // C5 (founder): a cache Sync that failed for real says "Sync failed"
      // and offers Try again (Keepr saved the chats it finished).
      if (isCache) failExtras.retry = true;
      env.overlay.show(message, true, failExtras);
      await env.api("POST", base + "/error", { code: code, message: message });
      return { outcome: code };
    }

    // 1. Signed in? (founder decision: no waiting for sign-in, no auto-resume)
    log("stage: job found, waiting for Messages for Web");
    var pageState = await waitForPageState(env, env.pageTimeoutMs == null ? 20000 : env.pageTimeoutMs);
    log("page: " + pageState);
    if (pageState === "not_signed_in") return fail("not_signed_in", NOT_SIGNED_IN);
    if (pageState !== "ready") {
      return fail("page_not_ready", "Messages for Web did not finish loading. Click Sync in Keepr again.");
    }

    // 2. Claim: contact names only.
    // The claim keeps its own message (already running / over) for the overlay.
    // POST (BACKLOG-3628): Chrome on Windows sends a worker GET without Origin.
    var claim = await env.api("POST", base + "/claim");
    if (!claim.ok) {
      log("claim refused: HTTP " + claim.status);
      env.overlay.show(messageOf(claim, "Keepr refused this sync."), true, await overlayExtras());
      return { outcome: "claim_refused" };
    }
    var contacts = (claim.body && claim.body.contacts) || [];
    var noPhone = claim.body && claim.body.contactsWithoutPhoneCount;
    contactsWithoutPhone = typeof noPhone === "number" && noPhone > 0 ? Math.floor(noPhone) : 0;
    var contactTags = [];
    for (var ct = 0; ct < contacts.length; ct++) contactTags.push(await tag(contacts[ct].displayName));
    log("claimed: " + contacts.length + " contacts with a phone [" + contactTags.join(", ") + "]");
    // History floor: the transaction's start date; none → no date floor.
    // BACKLOG-3658: a cache Sync — every chat, history back to `since`.
    var isCache = !!(claim.body && claim.body.kind === "cache");
    var floorSource = isCache ? claim.body.since : claim.body && claim.body.startDate;
    var floorMs = typeof floorSource === "string" ? Date.parse(floorSource) : NaN;
    if (!isFinite(floorMs)) floorMs = null;
    // Live (0.3.15): chats switched back on — read to the FULL floor even with
    // no new message (Keepr clears them once saved). Conversation ids only.
    var pendingFull = {};
    var pendingIds = isCache && claim.body && Array.isArray(claim.body.pendingConversationIds) ? claim.body.pendingConversationIds : [];
    for (var pf = 0; pf < pendingIds.length; pf++) if (typeof pendingIds[pf] === "string") pendingFull[pendingIds[pf]] = true;
    var fullFloorMs = isCache && claim.body && typeof claim.body.floor === "string" ? Date.parse(claim.body.floor) : NaN;
    if (!isFinite(fullFloorMs)) fullFloorMs = floorMs;
    // SR (2026-10-02): chats on a live deal Keepr wants read back to the deal's
    // start — the list scan looks for them past the settings floor, never past
    // the oldest deal start. Conversation ids only; each chat's own floor
    // comes from /match.
    var dealIds = [];
    var dealSet = {};
    var dealFloorMs = isCache && claim.body && typeof claim.body.dealFloor === "string" ? Date.parse(claim.body.dealFloor) : NaN;
    if (isCache && claim.body && Array.isArray(claim.body.dealConversationIds) && isFinite(dealFloorMs)) {
      for (var di = 0; di < claim.body.dealConversationIds.length; di++) {
        var did = claim.body.dealConversationIds[di];
        if (typeof did === "string" && did && !dealSet[did]) {
          dealSet[did] = true;
          dealIds.push(did);
        }
      }
    }
    if (!isFinite(dealFloorMs)) dealFloorMs = null;
    var history = [];

    // 3. Scan the list and pick candidates. A narrow window shows the list OR
    // a chat (BACKLOG-3629): make sure the list is the pane on screen first.
    env.overlay.show("Loading your conversation list…", false);
    if (env.returnToList && !(await env.returnToList())) {
      // No list, no scan: say so instead of "Done — imported 0 chats".
      return fail("list_not_reachable", LIST_NOT_REACHABLE);
    }
    log("stage: loading the conversation list");
    // No env.scroll in the browser: collectConversations drives the page's own
    // scroller (top first, then step down with scroll events).
    var lostList = await holdWhileOffline("Loading your conversation list…");
    if (lostList && lostList.code) return fail(lostList.code, lostList.message);
    var collected = await env.scan.collectConversations(env.doc, isCache
      ? {
        scroll: env.scroll, sleep: env.sleep, stopAtOlderThanMs: floorMs, maxItems: CACHE_LIST_MAX,
        mustSee: pendingIds, mustSeeFloorMs: fullFloorMs,
        mustSeeDeep: dealIds, mustSeeDeepFloorMs: dealFloorMs,
      }
      : { scroll: env.scroll, sleep: env.sleep });
    // BACKLOG-3645: the phone number is the gate, a name only orders the queue.
    // Up to CHECK_ALL_MAX chats every chat is checked; above it, plausible names
    // plus number-only chats, and the rest are reported as not checked.
    // BACKLOG-3658: a cache Sync checks every chat newer than `since` in list
    // order (no names), at most CACHE_CHECK_MAX; the rest are not checked.
    var plan = isCache
      ? cachePlan(collected.conversations, floorMs, pendingFull, dealSet)
      : env.scan.planChecks
        ? env.scan.planChecks(collected.conversations, contacts)
        : { queue: env.scan.pickCandidates(collected.conversations, contacts), notChecked: 0 };
    var candidates = plan.queue;
    progress.listed = collected.conversations.length;
    progress.candidates = candidates.length;
    progress.notChecked = plan.notChecked;
    log("listed " + progress.listed + ", stopReason " + collected.stopReason +
      ", scroll " + JSON.stringify(collected.scroll || null));
    var byReason = {};
    for (var cr = 0; cr < candidates.length; cr++) {
      byReason[candidates[cr].reason] = (byReason[candidates[cr].reason] || 0) + 1;
    }
    log("candidates " + candidates.length + " " + JSON.stringify(byReason) + ", not checked " + plan.notChecked);
    // Chats, not contacts (founder): "Checking chat i of N".
    await report(candidates.length > 0 ? stageText(1, candidates.length) : "No chats to check");

    // 4. Each candidate: open, read numbers, close Details, ask Keepr.
    work = candidates.map(function (c) { return { cand: c, attempt: 0 }; });
    var retryPoolMs = env.transientRetryPoolMs == null ? RCS_TRANSIENT_RETRY_POOL_MS : env.transientRetryPoolMs;
    var retry = { retried: 0, recovered: 0, notRetried: 0, usedMs: 0 };
    var sleptMs = 0;
    var baseSleep = env.sleep;
    env.sleep = function (ms) {
      sleptMs += typeof ms === "number" && isFinite(ms) ? ms : 0;
      return baseSleep(ms);
    };
    /** Messages already sent per chat: a retried chat is not counted twice. */
    var sentMessages = {};
    for (var wi = 0; wi < work.length; wi++) {
      var item = work[wi];
      var i = item.attempt > 0 ? candidates.length - 1 : wi;
      var conv = item.cand.conversation;
      retryState.item = item;
      var retryStart = sleptMs;
      if (item.attempt > 0) {
        if (retry.usedMs >= retryPoolMs) {
          retry.notRetried += 1;
          continue;
        }
        retry.retried += 1;
        // Its earlier "left out" entries go; failing again adds them back.
        var gone0 = entriesByConv[conv.conversationId] || [];
        notReached = notReached.filter(function (e) { return gone0.indexOf(e) < 0; });
        skips = skips.filter(function (sk) { return sk.conversationId !== conv.conversationId; });
        entriesByConv[conv.conversationId] = [];
        log("retry " + retry.retried + ": chat " + (await tag(conv.name)));
      }
      var opened = false;
      var gone = false;
      var imagesFailed = 0;
      var lostChat = await holdWhileOffline(stageText(i + 1, candidates.length));
      if (lostChat && lostChat.code) return fail(lostChat.code, lostChat.message);
      try {
        env.overlay.show(stageText(i + 1, candidates.length) + "…", false, RUNNING_EXTRAS);
        // BACKLOG-3658 #12: the conversation id as a 6-hex tag salted per job
        // (never the raw id), so two chats with the same name are told apart.
        log("#" + (i + 1) + "/" + candidates.length + " chat " + (await tag(conv.name)) +
          " id " + (await tag("conversation-id:" + conv.conversationId)) + " reason=" + item.cand.reason);
        // The messages on screen before the click: the next chat is ready only
        // once this set has been replaced (the URL and title flip first).
        var alreadyOpen = chatAlreadyOpen(env, conv);
        var before = alreadyOpen ? ALREADY_OPEN : env.scan.messageIdSet(env.doc);
        if (alreadyOpen) log("  already open: read as shown");
        await env.openConversation(conv);
        opened = true;
        var numbers = await env.scan.readParticipantsAndClose(env.doc, { click: env.click, sleep: env.sleep });
        // BACKLOG-3630: name + number rows (group senders); Keepr keys the chat
        // on the numbers its /match saw.
        var people = (numbers && numbers.rows) || (numbers || []).map(function (n) { return { name: "", number: n }; });
        // BACKLOG-3664: an AI assistant chat (Gemini) is not a text
        // conversation: counted apart, never a failure, never "not imported".
        if (numbers && numbers.kind === "not_text") {
          totals.notText += 1;
          log("  not a text conversation");
          continue;
        }
        progress.checked += 1;
        if (numbers && numbers.kind === "no_details") log("  Details did not open");
        log("  numbers " + JSON.stringify((numbers || []).map(numberShape)));
        if (!numbers || numbers.length === 0) {
          // Keepr cannot check a chat with no number on screen: report it.
          // BACKLOG-3658 #11: short codes and named senders apart.
          var why = numbers && (numbers.kind === "short_code" || numbers.kind === "business") ? numbers.kind : "no_numbers";
          if (why !== "no_numbers") log("  " + why.replace("_", " "));
          leaveOut(conv, why);
          // Details timed out: a transient failure, retried once at the end.
          if (numbers && numbers.kind === "no_details") noteTransient(conv, "details_timeout");
          continue;
        }
        var match = await call("POST", base + "/match", { conversationId: conv.conversationId, numbers: numbers });
        if (!match.ok) throw new Error(messageOf(match, "Keepr could not check this chat."));
        var isMatch = !!(match.body && match.body.matched);
        // Keepr says whether it keeps this chat's images (a cache Sync keeps
        // them only for chats with a transaction contact); a transaction
        // Sync's matched chat always keeps them.
        var keepPhotos = isCache
          ? !!(match.body && (match.body.keepPhotos !== undefined ? match.body.keepPhotos : match.body.keepImages))
          : true;
        var keepVideos = isCache ? !!(match.body && match.body.keepVideos) : false;
        // SR (2026-10-02): a chat on a live deal is read back to Keepr's floor
        // for it (/match floorMs); every other chat keeps the job's floor.
        var chatFloorMs = pendingFull[conv.conversationId] ? fullFloorMs : floorMs;
        if (isCache && match.body && typeof match.body.floorMs === "number" && isFinite(match.body.floorMs)) {
          chatFloorMs = chatFloorMs === null ? match.body.floorMs : Math.min(chatFloorMs, match.body.floorMs);
        }
        var keepImages = keepPhotos;
        if (!isMatch && match.body && match.body.excluded === true) {
          // BACKLOG-3658 P3c: the user switched this chat off — counted, never silent.
          totals.notSynced += 1;
          log("  switched off by you: not synced");
          continue;
        }
        log("  match=" + (isMatch ? "yes" : "no"));
        if (!isMatch) continue;
        matchedCount += 1;
        // 3671 P3 "Try again": the failed run already saved this chat in full.
        if (isCache && match.body && match.body.skip === true) {
          totals.alreadySaved += 1;
          log("  saved by the last run: skipped");
          continue;
        }

        var ready = await env.scan.waitForMessageSwap(env.doc, before, {
          sleep: env.sleep,
          timeoutMs: env.messagesTimeoutMs,
          stableMs: alreadyOpen ? Math.max(ALREADY_OPEN_STABLE_MS, env.messagesStableMs || 0) : env.messagesStableMs,
          reportEmpty: true,
          emptyConfirmMs: env.messagesEmptyConfirmMs,
        });
        if (ready === "empty") {
          // BACKLOG-3664: a chat with no messages yet (e.g. a new group):
          // counted quietly, never "not fully imported".
          totals.noMessagesYet += 1;
          log("  no messages yet");
          continue;
        }
        if (!ready) {
          progress.skipped += 1;
          skips.push({ conversationId: conv.conversationId, reason: MESSAGES_NOT_LOADED });
          leaveOut(conv, MESSAGES_NOT_LOADED);
          env.overlay.show("Skipped a chat: its messages did not load", false);
          continue;
        }
        // Only the latest messages render on open: load older ones back past
        // the transaction's start date, then let the set settle.
        var lostHist = await holdWhileOffline(stageText(i + 1, candidates.length));
        if (lostHist && lostHist.code) return fail(lostHist.code, lostHist.message);
        var loc = env.getLocation();
        var histIo = {
          scrollUp: env.scrollMessagesUp || function () {},
          nudge: env.nudgeMessages,
          nudgeDown: env.nudgeDownMessages,
          nudgeReturnStep: env.nudgeReturnMessages,
          stepDown: env.stepDownMessages,
          // Images mount only in view: the image pass, only for chats whose images Keepr keeps.
          imagePass: keepImages,
          hasScroller: env.hasMessageScroller,
          // GAP GUARD: messages are kept as they are read (a virtualized list
          // may drop them before the end), and a gap is stepped back over.
          extractBatch: function () {
            return env.extract(env.doc, loc.href, env.now ? env.now() : new Date()).messages;
          },
          stepBack: env.stepBackMessages,
          budgetMs: env.historyBudgetMs,
          extensionPoolLeftMs: Math.max(0, extraTime.poolMs - extraTime.usedMs),
          sleep: env.sleep,
          floorMs: chatFloorMs,
          cap: env.historyCap,
          noNewTimeoutMs: env.historyNoNewMs,
          oldestMs: function () {
            var ex = env.extract(env.doc, loc.href, env.now ? env.now() : new Date());
            var min = null;
            for (var q = 0; q < ex.messages.length; q++) {
              var t = Date.parse(ex.messages[q].sentAt);
              if (isFinite(t) && (min === null || t < min)) min = t;
            }
            return min;
          },
          onProgress: function (n) {
            env.overlay.show("Loading history… " + n + " messages", false);
          },
          // Tell Keepr after each scroll: a cancelled job answers 404/410 and
          // call() throws, so the load ends instead of running to the cap.
          checkpoint: function (n) {
            return call("POST", base + "/progress", {
              stage: "Loading history… " + n + " messages",
              listed: progress.listed,
              candidates: progress.candidates,
              checked: progress.checked,
              skipped: progress.skipped,
            });
          },
        };
        var histHidden = hiddenStats.hidden();
        var hist = await env.scan.loadHistory(env.doc, histIo);
        hiddenStats.history(histHidden, hist);
        // The banner came up while this chat loaded: what was read may stop
        // short. Once it clears, the chat's history is loaded again.
        var lostMid = await holdWhileOffline(null);
        if (lostMid && lostMid.code) return fail(lostMid.code, lostMid.message);
        if (lostMid && lostMid.resumed) {
          log("  history loaded again after the pause");
          hist = await env.scan.loadHistory(env.doc, histIo);
        }
        history.push({ conversationId: conv.conversationId, stopReason: hist.stopReason, count: hist.count });
        var settled = await env.scan.waitForMessageSwap(env.doc, "", {
          sleep: env.sleep,
          timeoutMs: env.messagesTimeoutMs,
          stableMs: env.messagesStableMs,
        });
        if (!settled) {
          // Still changing (or emptied) after the history load: do not import
          // a set that is moving under us.
          progress.skipped += 1;
          skips.push({ conversationId: conv.conversationId, reason: "history_not_settled" });
          leaveOut(conv, "history_not_settled");
          continue;
        }
        loc = env.getLocation();
        var extracted = env.extract(env.doc, loc.href, env.now ? env.now() : new Date());
        // GAP GUARD: every message read during the load (kept by msg-id) plus
        // what is on screen now — never only the final DOM.
        var readSet = unionMessages(hist.messages, extracted.messages);
        var messages = readSet.map(function (m) {
          var copy = {};
          for (var k in m) if (k !== "imageSrcs" && k !== "quote") copy[k] = m[k];
          // Founder: a quoted reply's reply-to (the quote itself is never sent).
          var replyTo = replyToFor(m, readSet);
          if (replyTo) copy.replyTo = replyTo;
          return copy;
        });
        if (messages.length === 0) {
          progress.skipped += 1;
          skips.push({ conversationId: conv.conversationId, reason: "no_messages" });
          leaveOut(conv, "no_messages");
          continue;
        }
        var sent = await call("POST", base + "/chat", {
          conversationId: conv.conversationId,
          title: extracted.title || conv.name,
          messages: messages,
          participants: people,
          // Read down to its floor (not cut by the cap, not unsettled, no gap): a boolean.
          reachedFloor: depthKind(hist) !== "partial",
        });
        if (!sent.ok) throw new Error(messageOf(sent, "Keepr could not save this chat."));
        var prevSent = sentMessages[conv.conversationId];
        if (prevSent === undefined) totals.chats += 1;
        totals.messages += Math.max(0, messages.length - (prevSent || 0));
        sentMessages[conv.conversationId] = Math.max(prevSent || 0, messages.length);
        // BACKLOG-3642: rows the user removed from this transaction are stored
        // but not linked again; Keepr says how many.
        var removed = sent.body && typeof sent.body.removedByUser === "number" ? sent.body.removedByUser : 0;
        totals.removedByUser += removed;
        if (removed > 0) log("  removed by you, not re-added: " + removed);
        // BACKLOG-3658 #14: the reactions (tapbacks) read with this chat — a count only.
        var chatReactions = 0;
        for (var rx = 0; rx < messages.length; rx++) {
          chatReactions += Array.isArray(messages[rx].reactions) ? messages[rx].reactions.length : 0;
        }
        if (prevSent === undefined) totals.reactions += chatReactions;
        // SR S2: how this chat's history start was confirmed, counted per kind.
        if (prevSent === undefined) totals.historyConfirmed[startConfirmedBy(hist)] += 1;
        extraTime.usedMs += hist.extraMs || 0;
        // History depth (3671): how far back this chat was READ, in whole days
        // (older than the floor is dropped at commit, so this is not what is kept).
        var nowMs = (env.now ? env.now() : new Date()).getTime();
        var oldestMs = null;
        for (var od = 0; od < messages.length; od++) {
          var ot = Date.parse(messages[od].sentAt);
          if (isFinite(ot) && (oldestMs === null || ot < oldestMs)) oldestMs = ot;
        }
        var floorDays = floorMs === null ? null : Math.round((nowMs - floorMs) / DAY_MS);
        if (prevSent === undefined) totals.depth[depthKind(hist)] += 1;
        totals.depth.floorDays = floorDays;
        totals.depth.gaps += hist.gapsDetected || 0;
        totals.depth.gapsRecovered += hist.gapsRecovered || 0;
        log("  oldest read: " + (oldestMs === null ? "none" : Math.floor((nowMs - oldestMs) / DAY_MS) + " days ago") +
          " (floor " + (floorDays === null ? "none" : floorDays + " days") + ")");
        log("  imported " + messages.length + " messages, " + chatReactions + " reactions (history stop: " + hist.stopReason +
          ", start confirmed by " + startConfirmedBy(hist) +
          (hist.nudges ? ", nudges " + hist.nudges : "") +
          // Per-chat load time and batches (counted load time, in seconds).
          ", load " + Math.round((hist.elapsedMs || 0) / 1000) + "s, batches " + (hist.batches || 0) +
          (hist.budgetExtensions ? ", budget extended " + hist.budgetExtensions + "×" : "") +
          (hist.poolExhausted ? ", extra time used up" : "") +
          (hist.gapsDetected ? ", gaps " + hist.gapsDetected + " detected / " + (hist.gapsRecovered || 0) + " recovered" : "") + ")");
        // Imported, but only back to the cap: older messages are missing.
        if (hist.stopReason === "cap") leaveOut(conv, "history_truncated");
        // BACKLOG-3658 #10: the start of the chat was not confirmed (nothing
        // new after every nudge, or the budget ran out): imported as far as it
        // loaded, reported, and the coverage does not reach the floor.
        if (hist.stopReason === "not_settled") leaveOut(conv, "history_not_settled");
        // GAP GUARD: a gap that could not be bridged — imported as read, reported.
        if (hist.stopReason === "history_gap") leaveOut(conv, "history_gap");

        // SR M: every photo / video bubble of the chat, counted.
        var missingIds = [];
        var missingOldest = null;
        // A retried chat already sent: its photos were counted the first time.
        for (var j = 0; j < readSet.length && prevSent === undefined; j++) {
          var msg = readSet[j];
          var srcs = msg.imageSrcs || [];
          var files = msg.files || [];
          var notLoaded = 0;
          for (var f = 0; f < files.length; f++) {
            if (files[f] && files[f].name === NOT_LOADED_IMAGE) notLoaded += 1;
            else if (files[f] && VIDEO_FILE_RE.test(files[f].name || "")) {
              media.videos.seen += 1;
              // Not downloaded yet (no live trace of the video bubble).
              if (keepVideos) media.videos.notSupported += 1;
              else media.videos.notKept += 1;
            }
          }
          media.photos.seen += srcs.length + notLoaded;
          if (!keepPhotos) {
            media.photos.notKept += srcs.length + notLoaded;
            if (srcs.length > 0) totals.imagesNotKept += srcs.length;
            continue;
          }
          if (notLoaded > 0) {
            media.photos.notLoaded += notLoaded;
            missingIds.push(msg.msgId);
            var mt = Date.parse(msg.sentAt);
            if (isFinite(mt) && (missingOldest === null || mt < missingOldest)) missingOldest = mt;
          }
          for (var n = 0; n < srcs.length; n++) {
            var outcome = await uploadPhoto(conv, msg.msgId, n, srcs[n]);
            if (outcome === "saved") media.photos.saved += 1;
            else media.photos[outcome] += 1;
            if (outcome === "readFailed" || outcome === "failed") {
              progress.skipped += 1;
              imagesFailed += 1;
            }
          }
        }
        if (missingIds.length > 0) {
          mediaRetry.push({ conv: conv, msgIds: missingIds, oldestMs: missingOldest, floorMs: chatFloorMs });
        }
      } catch (err) {
        if (err && err.jobGone) {
          gone = true;
          throw err;
        }
        if (err && err.code === "details_stuck") {
          // The Details pane is still showing an earlier chat's people; every
          // later chat would be read against it. Stop the whole job.
          return fail("details_stuck", "Keepr stopped: the Details panel did not close. Click Sync in Keepr again.");
        }
        progress.skipped += 1;
        skips.push({ conversationId: conv.conversationId, reason: "error" });
        // The error's code only: its message could quote the page.
        log("  error" + (err && err.code ? ": " + err.code : ""));
        leaveOut(conv, opened ? "error" : "not_opened");
      } finally {
        if (imagesFailed > 0) leaveOut(conv, "images_failed", imagesFailed);
        // Narrow window (BACKLOG-3629): the chat replaced the list; go back to
        // it so the next chat can be found. A no-op when both panes show.
        if (!gone && env.returnToList) await env.returnToList();
        if (item.attempt > 0) {
          retry.usedMs += sleptMs - retryStart + RETRY_OVERHEAD_MS;
          if ((entriesByConv[conv.conversationId] || []).length === 0) retry.recovered += 1;
        }
      }
      // Also the cancel check between chats: a job Keepr dropped answers 404/410.
      await report(i + 1 < candidates.length
        ? stageText(i + 2, candidates.length)
        : "Checked " + candidates.length + " of " + candidates.length + " chats");
    }

    env.sleep = baseSleep;
    if (retry.retried + retry.notRetried > 0) {
      log("retried " + retry.retried + ", recovered " + retry.recovered +
        (retry.notRetried ? ", " + retry.notRetried + " not retried (time limit)" : "") +
        ", " + Math.round(retry.usedMs / 1000) + "s of " + Math.round(retryPoolMs / 1000) + "s");
    }
    await retryMissingPhotos();
    if (extraTime.usedMs > 0) {
      log("extra time used: " + Math.ceil(extraTime.usedMs / 60000) + " min of " + Math.round(extraTime.poolMs / 60000));
    }
    // 5. Done: Keepr brings itself forward. Every chat left out (or imported
    // in part) is named here and on the page — never a silent skip.
    var reported = notReached.slice(0, NOT_REACHED_CAP);
    var more = notReached.length - reported.length;
    // A cache Sync: Keepr answers once it has saved, with what it saved.
    if (isCache) env.overlay.show(SAVING_TEXT, false);
    var hiddenNow = hiddenStats.done();
    log("hidden: " + Math.round(hiddenNow.ms / 1000) + "s in " + hiddenNow.spells + " spells; " +
      hiddenNow.batches + " history batches in " + hiddenNow.chats + " chats loaded while hidden");
    var finished = await call("POST", base + "/finish", {
      chats: totals.chats,
      messages: totals.messages,
      images: totals.images,
      notReached: reported,
      notReachedMore: more,
      notChecked: progress.notChecked,
      notText: totals.notText,
      noMessagesYet: totals.noMessagesYet,
      // 3671 P3: chats the failed run already saved (skipped on "Try again"; a count).
      alreadySaved: totals.alreadySaved,
      connection: connection,
      // SR M: photo / video counts (telemetry; counts only).
      media: media,
      // SR (3671 P1): the transient retry (counts only).
      retry: { retried: retry.retried, recovered: retry.recovered, notRetried: retry.notRetried },
      historyConfirmed: totals.historyConfirmed,
      // Founder (2026-10-03): time hidden and history loaded meanwhile (counts / ms only).
      hidden: hiddenNow,
      // L2: how the list scan stopped (Keepr records the coverage only for a normal stop).
      listStop: collected.stopReason,
    });
    if (isCache && finished && finished.body && Object.prototype.hasOwnProperty.call(finished.body, "saved")) {
      saved = finished.body.saved;
    }
    log("done: listed " + progress.listed + ", candidates " + progress.candidates + ", checked " + progress.checked +
      ", matched " + matchedCount + ", imported " + totals.chats + " chats / " + totals.messages + " messages / " +
      totals.images + " images, not fully imported " + notReached.length + ", not checked " + progress.notChecked +
      ", removed by you " + totals.removedByUser + ", images not kept " + totals.imagesNotKept + ", not text " + totals.notText + ", no messages yet " + totals.noMessagesYet + ", not synced (switched off) " + totals.notSynced + ", pauses " + pauses);
    // One line + Details / Copy (founder, BACKLOG-3641); results live in Keepr.
    env.overlay.show(DONE_LINE, false, await overlayExtras());
    return {
      outcome: "finished", progress: progress, totals: totals, skips: skips, history: history, notReached: notReached,
    };
  }

  var SEE_DETAILS = "See details ▾";
  var HIDE_DETAILS = "Hide details ▴";
  /** BACKLOG-3658 security H1: a Sync Keepr did not open in this tab asks first. */
  var ASK_TITLE = "Keepr wants to sync your texts";
  var ASK_TEXT = "Keepr asked to copy your recent Google Messages texts into the Keepr app on this computer.";
  var PAUSED_TITLE = "Sync paused";
  /** Founder (2026-10-02): the page's stop, with an inline confirm. */
  var STOP_SYNC_LABEL = "Stop sync";
  var STOP_SYNC_QUESTION = "Stop the sync? Nothing from this run will be saved.";
  /** SR: clicks on the confirm's Stop within this time after it opened are ignored (a double-click). */
  var STOP_CONFIRM_ARM_MS = 400;
  var PAUSED_BODY = "Keep this Chrome window visible — Sync continues when it's back.";
  PAUSE_BODIES[CONNECTING_TEXT] = CONNECTING_TEXT + " Sync continues when it's back.";
  PAUSE_BODIES[UNREACHABLE_TEXT] = UNREACHABLE_TEXT + ". Sync continues when it's back.";
  var SYNCING_TITLE = "Syncing your texts";
  /**
   * Founder (2026-10-01): from the first second of a Sync, not only once
   * paused. The full sentence in the expanded box; a short tail on the chip.
   */
  var SYNCING_HINT = "Keep this tab open while Keepr syncs. When it's done, you'll go back to Keepr automatically.";
  var SYNCING_CHIP_HINT = "keep this tab open";
  /**
   * Founder (2026-10-02, reverses "nothing on the page while idle"): with no
   * Sync running, the box sits on the page as its collapsed chip. Never a
   * Sync button — Keepr starts every Sync.
   */
  // C3 (UX redesign, founder 2026-10-03): idle, the page shows only a small
  // "K" tab on the right edge at mid-height (draggable up and down, its place
  // remembered); a tap opens one line + Open Keepr. Linking lives in the
  // toolbar popup now (never on the page).
  var IDLE_TAB_LINE = "Sync from Keepr";
  /** C3: an unanswered "Stop the sync?" closes itself after this long (the sync never pauses). */
  var STOP_CONFIRM_AUTO_CLOSE_MS = 10000;
  /** C5 (founder): a real failure of a cache Sync — "Sync failed · Try again". */
  var SYNC_FAILED_TITLE = "Sync failed";
  var TRY_AGAIN_LABEL = "Try again";
  var PAGE_GONE_MESSAGE = "The Google Messages tab was closed.";

  // Keepr brand (android-companion BrandMark): the indigo mark with an amber
  // dot; primary #4F46E5 (hover #4338CA); amber #F5A524 for paused/attention.
  // No green. Every text/background pair is >= 4.5:1.
  var PRIMARY = "#4F46E5";
  var PRIMARY_HOVER = "#4338CA";
  var AMBER = "#F5A524";
  var PALETTE = {
    light: {
      card: "#FFFFFF", border: "#C7D2FE", doneBorder: "#C7D2FE", text: "#111827", muted: "#374151", link: "#4F46E5",
      secondaryBg: "#FFFFFF", secondaryBorder: "#C7D2FE", secondaryText: "#374151",
      detailsBg: "#F9FAFB", detailsBorder: "#E5E7EB",
    },
    dark: {
      card: "#1F2937", border: "#374151", doneBorder: "#4F46E5", text: "#F3F4F6", muted: "#D1D5DB", link: "#A5B4FC",
      secondaryBg: "#1F2937", secondaryBorder: "#4B5563", secondaryText: "#F3F4F6",
      detailsBg: "#111827", detailsBorder: "#374151",
    },
  };

  /**
   * The theme a CSS background colour asks for: "dark" (relative luminance
   * under 0.18, i.e. darker than mid-grey), "light", or null when it says
   * nothing (transparent, or not an rgb()/rgba() colour).
   * @param {string} css
   * @returns {"dark"|"light"|null}
   */
  function themeFromColor(css) {
    var m = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/.exec(css || "");
    if (!m) return null;
    if (m[4] !== undefined && parseFloat(m[4]) === 0) return null;
    function lin(c) {
      var v = Math.min(255, Math.max(0, c)) / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    }
    var l = 0.2126 * lin(+m[1]) + 0.7152 * lin(+m[2]) + 0.0722 * lin(+m[3]);
    return l < 0.18 ? "dark" : "light";
  }

  /**
   * Auto theme (founder): Google Messages' own theme, read from the computed
   * background of the page (the first element that has one), else the
   * system's prefers-color-scheme, else light.
   * @param {Document} doc
   * @returns {"dark"|"light"}
   */
  function pageTheme(doc) {
    var win = doc.defaultView;
    var candidates = [doc.querySelector("mw-app, mws-app, main"), doc.body, doc.documentElement];
    for (var i = 0; i < candidates.length; i++) {
      var node = candidates[i];
      if (!node || !win || !win.getComputedStyle) continue;
      var t = themeFromColor(win.getComputedStyle(node).backgroundColor);
      if (t) return t;
    }
    try {
      if (win && win.matchMedia && win.matchMedia("(prefers-color-scheme: dark)").matches) return "dark";
    } catch (_e) { /* no media queries: light */ }
    return "light";
  }

  /** The box's state, from what the job shows. */
  function overlayState(text, isError, extras) {
    if (extras && extras.idle) return "idle";
    if (extras && extras.ask) return "ask";
    if (isError) return "error";
    if (extras && extras.details) return "done";
    if (text === PAUSED_TEXT || text === CONNECTING_TEXT || text === UNREACHABLE_TEXT) return "paused";
    return "syncing";
  }

  /** The collapsed chip: "Keepr · syncing 4 of 21 — keep this tab on screen". */
  function chipTitle(text) {
    var short = shortProgress(text);
    return "Keepr · " + (/^\d+ of \d+$/.test(short) ? "syncing " + short : short) + " — " + SYNCING_CHIP_HINT;
  }

  /** "Chat 8 of 21…" → "8 of 21" for the pill; other lines as they are. */
  function shortProgress(text) {
    return String(text).replace(/^(Checking chat|Chat) /, "").replace(/…$/, "");
  }

  /**
   * THE Keepr box (founder's design C, "collapsible chip"). ALL of its look is
   * here: every element and style is (re)built from (state, theme) on each
   * call; createElement + textContent only, so page text never becomes markup.
   *
   *   syncing  collapsed pill: [badge] "Keepr · 8 of 21" [▾]; ▾ expands to the
   *            progress line + Cancel.
   *   paused   expanded card, amber: "Sync paused", what to do, Cancel.
   *   done     expanded card: [✓] "Sync done — switch back to Keepr.",
   *            "See details ▾" (link, left) + "Open Keepr" (primary, right),
   *            the details card below with "Copy details" inside; ×.
   *   error    as done, amber, with the failure line; ×.
   *   ask      (security H1) "Keepr wants to sync your texts": Not now / Start.
   *
   * The round badge is the ONLY drag handle (data-keepr="drag-handle", grab
   * cursor). The keyboard Move button is visually hidden until focused.
   *
   * @param {HTMLElement} box  the fixed box (or any container, in tests)
   * @param {string} text
   * @param {boolean} isError
   * @param {{details?: string, copy?: string, version?: string, cancel?: boolean,
   *   ask?: {start: function(): void, later: function(): void}}=} extras
   * @param {{copy: function(string): Promise<boolean>, focus?: function(): Promise<boolean>,
   *   cancel?: function(): Promise<boolean>, close?: function(): void, move?: function(): void,
   *   expanded?: boolean, onExpand?: function(boolean): void, theme?: "light"|"dark"}} io
   */
  function renderOverlay(box, text, isError, extras, io) {
    var doc = box.ownerDocument;
    var theme = io.theme === "dark" || io.theme === "light" ? io.theme : pageTheme(doc);
    var p = PALETTE[theme];
    var state = overlayState(text, isError, extras);
    var collapsible = state === "syncing" || state === "idle";
    var expanded = !collapsible || !!io.expanded;
    /** Idle "Open Keepr": POST /focus (a Sync is always started from Keepr). */
    function openKeepr() {
      if (io.focus) void Promise.resolve(io.focus()).catch(function () {});
    }
    var attention = state === "paused" || state === "error";

    while (box.firstChild) box.removeChild(box.firstChild);
    box.setAttribute("data-keepr-state", state);
    box.setAttribute("data-keepr-theme", theme);
    box.setAttribute("role", "region");
    box.setAttribute("aria-label", "Keepr");
    Object.assign(box.style, {
      background: p.card,
      color: p.text,
      border: "1px solid " + (attention ? AMBER : state === "done" ? p.doneBorder : p.border),
      borderRadius: expanded ? "16px" : "999px",
      boxShadow: "0 8px 24px rgba(0,0,0,.16)",
      boxSizing: "border-box",
      width: expanded ? "300px" : "auto",
      maxWidth: "calc(100vw - 16px)",
      padding: expanded ? "12px 14px" : "5px 8px 5px 5px",
      fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
      fontSize: "14px",
      lineHeight: "1.4",
      textAlign: "left",
    });

    function el(tag, key, style, content) {
      var node = doc.createElement(tag);
      if (key) node.setAttribute("data-keepr", key);
      if (style) Object.assign(node.style, style);
      if (content !== undefined) node.textContent = content;
      return node;
    }
    function button(key, label, kind) {
      var b = el("button", key, {
        font: "inherit", cursor: "pointer", borderRadius: "8px", lineHeight: "1.2",
      }, label);
      b.type = "button";
      if (kind === "primary") {
        Object.assign(b.style, { background: PRIMARY, color: "#FFFFFF", border: "1px solid " + PRIMARY, padding: "7px 14px", fontWeight: "600" });
        b.addEventListener("mouseenter", function () { b.style.background = PRIMARY_HOVER; });
        b.addEventListener("mouseleave", function () { b.style.background = PRIMARY; });
      } else if (kind === "link") {
        Object.assign(b.style, { background: "none", border: "none", padding: "0", color: p.link, textDecoration: "none", fontWeight: "600" });
      } else if (kind === "icon") {
        Object.assign(b.style, { background: "none", border: "none", padding: "2px 6px", color: p.muted, fontSize: "16px" });
      } else {
        Object.assign(b.style, { background: p.secondaryBg, color: p.secondaryText, border: "1px solid " + p.secondaryBorder, padding: "6px 12px" });
      }
      return b;
    }

    if (state === "idle") {
      renderIdleTab();
      return;
    }

    /** C3: the idle "K" tab (collapsed), or its one line + Open Keepr (expanded). */
    function renderIdleTab() {
      Object.assign(box.style, {
        width: expanded ? "220px" : "auto",
        padding: expanded ? "10px 12px" : "4px",
        borderRadius: expanded ? "14px" : "12px",
      });
      var tab = el("div", "drag-handle", {
        width: "30px", height: "36px", borderRadius: "10px", display: "flex", alignItems: "center", justifyContent: "center",
        fontWeight: "700", fontSize: "15px", cursor: "grab", touchAction: "none", userSelect: "none",
        background: "linear-gradient(135deg, #4F46E5, #6D5DF0)", color: "#FFFFFF",
      }, "K");
      tab.setAttribute("data-keepr-tab", "1");
      tab.setAttribute("role", "button");
      tab.setAttribute("tabindex", "0");
      tab.setAttribute("aria-label", expanded ? "Hide Keepr" : "Keepr");
      tab.setAttribute("aria-expanded", expanded ? "true" : "false");
      tab.title = "Keepr — drag to move";
      // A tap (not a drag: the drag code tells) or Enter / Space opens it.
      tab.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          if (io.onExpand) io.onExpand(!expanded);
        }
      });
      if (!expanded) {
        box.appendChild(tab);
        return;
      }
      var row = el("div", "header", { display: "flex", alignItems: "center", gap: "8px" });
      row.appendChild(tab);
      row.appendChild(el("div", "line", { flex: "1 1 auto", fontWeight: "600", color: p.text }, IDLE_TAB_LINE));
      box.appendChild(row);
      var openIdle = button("open-keepr", "Open Keepr", "primary");
      openIdle.style.marginTop = "10px";
      openIdle.addEventListener("click", openKeepr);
      box.appendChild(openIdle);
      if (extras.version) {
        box.appendChild(el("div", "version", { marginTop: "8px", fontSize: "12px", color: p.muted }, "Keepr extension " + extras.version));
      }
    }

    // Header: badge (the drag handle) + title + controls.
    var header = el("div", "header", { display: "flex", alignItems: "center", gap: "8px" });
    var badge = el("div", "drag-handle", {
      position: "relative", flex: "0 0 30px", width: "30px", height: "30px", borderRadius: "50%",
      display: "flex", alignItems: "center", justifyContent: "center",
      fontWeight: "700", fontSize: "15px", cursor: "grab", touchAction: "none", userSelect: "none",
      background: attention ? AMBER : "linear-gradient(135deg, #4F46E5, #6D5DF0)",
      color: attention ? "#111827" : "#FFFFFF",
    }, state === "done" ? "✓" : state === "error" ? "!" : "K");
    badge.title = "Drag to move";
    badge.setAttribute("aria-hidden", "true");
    if (!attention) {
      badge.appendChild(el("span", null, {
        position: "absolute", top: "0", right: "0", width: "8px", height: "8px", borderRadius: "50%",
        background: AMBER, border: "1.5px solid " + p.card, boxSizing: "border-box",
      }));
    }
    header.appendChild(badge);

    var retryable = state === "error" && !!(extras && extras.retry) && !!io.retry;
    var title = retryable ? SYNC_FAILED_TITLE : state === "syncing"
      ? (expanded ? SYNCING_TITLE : chipTitle(text))
      : state === "paused" ? PAUSED_TITLE : state === "ask" ? ASK_TITLE : text;
    var line = el("div", "line", {
      flex: "1 1 auto", minWidth: "0", fontWeight: "600", color: p.text, whiteSpace: expanded ? "normal" : "nowrap",
    }, title);
    header.appendChild(line);
    if (collapsible) {
      var expand = button("expand", expanded ? "▴" : "▾", "icon");
      expand.setAttribute("aria-expanded", expanded ? "true" : "false");
      expand.setAttribute("aria-label", expanded ? "Hide Sync progress" : "Show Sync progress");
      expand.addEventListener("click", function () {
        if (io.onExpand) io.onExpand(!expanded);
      });
      header.appendChild(expand);
    }
    if (io.move) {
      // Keyboard alternative to dragging: hidden until it has focus.
      var move = button("move", "Move", "secondary");
      move.setAttribute("aria-label", "Move this box to the next corner");
      var hidden = { position: "absolute", width: "1px", height: "1px", overflow: "hidden", clip: "rect(0 0 0 0)", padding: "0", border: "0" };
      var shown = { position: "static", width: "auto", height: "auto", overflow: "visible", clip: "auto", padding: "2px 8px", border: "1px solid " + p.secondaryBorder };
      Object.assign(move.style, hidden);
      move.addEventListener("focus", function () { Object.assign(move.style, shown); });
      move.addEventListener("blur", function () { Object.assign(move.style, hidden); });
      move.addEventListener("click", function () { io.move(); });
      header.appendChild(move);
    }
    // Once the Sync is over (result, failure) the box can be closed.
    if (io.close && (state === "done" || state === "error")) {
      var close = button("close", "×", "icon");
      close.setAttribute("aria-label", "Close");
      close.addEventListener("click", function () { io.close(); });
      header.appendChild(close);
    }
    box.appendChild(header);
    if (!expanded) return;

    var bodyStyle = { marginTop: "8px", color: p.muted };
    if (retryable) {
      box.appendChild(el("div", "progress", bodyStyle, text));
      var retry = button("try-again", TRY_AGAIN_LABEL, "primary");
      retry.style.marginTop = "10px";
      retry.addEventListener("click", function () {
        retry.disabled = true;
        Promise.resolve(io.retry()).then(function (ok) {
          if (!ok) retry.disabled = false;
        }, function () { retry.disabled = false; });
      });
      box.appendChild(retry);
    }
    if (state === "syncing") {
      box.appendChild(el("div", "progress", bodyStyle, text));
      box.appendChild(el("div", "hint", { marginTop: "6px", color: p.text }, SYNCING_HINT));
    }
    if (state === "paused") box.appendChild(el("div", "progress", bodyStyle, PAUSE_BODIES[text] || PAUSED_BODY));

    if (state === "ask") {
      box.appendChild(el("div", "progress", bodyStyle, ASK_TEXT));
      var askRow = el("div", "bottom-row", {
        display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", marginTop: "12px",
      });
      var later = button("ask-later", "Not now", "secondary");
      var startButton = button("ask-start", "Start", "primary");
      later.addEventListener("click", function () { extras.ask.later(); });
      startButton.addEventListener("click", function () {
        startButton.disabled = true;
        later.disabled = true;
        extras.ask.start();
      });
      askRow.appendChild(later);
      askRow.appendChild(startButton);
      box.appendChild(askRow);
      return;
    }

    if ((state === "syncing" || state === "paused") && extras && extras.cancel) {
      // Founder (2026-10-02): "Stop sync" with an inline confirm; it cancels
      // this job only, through the bridge (a signed job call), ended by the page.
      var cancel = button("cancel", STOP_SYNC_LABEL, "secondary");
      cancel.style.marginTop = "10px";
      box.appendChild(cancel);
      var confirmBox = el("div", "stop-confirm", {
        display: "none", marginTop: "10px", padding: "8px", borderRadius: "10px",
        border: "1px solid " + AMBER, color: p.text,
      });
      confirmBox.setAttribute("role", "alert");
      confirmBox.appendChild(el("div", "stop-question", null, STOP_SYNC_QUESTION));
      var confirmRow = el("div", null, { display: "flex", gap: "8px", marginTop: "8px" });
      var stopYes = button("stop-yes", STOP_SYNC_LABEL, "primary");
      var stopNo = button("stop-no", "Keep syncing", "secondary");
      confirmRow.appendChild(stopYes);
      confirmRow.appendChild(stopNo);
      confirmBox.appendChild(confirmRow);
      box.appendChild(confirmBox);
      // SR: the box is rebuilt on every progress line, so the confirm's state
      // lives in io.stop (kept by the page across renders) until the user
      // answers or the job ends: "closed" | "open" | "stopping".
      var stop = io.stop || { state: "closed", openedAt: 0 };
      var now = function () { return io.now ? io.now() : Date.now(); };
      var paint = function () {
        confirmBox.style.display = stop.state === "closed" ? "none" : "block";
        cancel.style.display = stop.state === "closed" ? "" : "none";
        stopYes.disabled = stop.state === "stopping";
        stopNo.disabled = stop.state === "stopping";
        stopYes.textContent = stop.state === "stopping" ? "Stopping…" : STOP_SYNC_LABEL;
      };
      paint();
      cancel.addEventListener("click", function () {
        stop.state = "open";
        stop.openedAt = now();
        paint();
        // C3 (founder): unanswered, it closes itself — the sync never paused.
        var openedAt = stop.openedAt;
        var later = io.setTimeout || setTimeout;
        later(function () {
          if (stop.state === "open" && stop.openedAt === openedAt) {
            stop.state = "closed";
            paint();
            if (io.rerender) io.rerender();
          }
        }, STOP_CONFIRM_AUTO_CLOSE_MS);
      });
      stopNo.addEventListener("click", function () {
        stop.state = "closed";
        paint();
      });
      stopYes.addEventListener("click", function () {
        if (!io.cancel || stop.state !== "open") return;
        // SR: an accidental double-click on "Stop sync" is not a confirm.
        if (now() - stop.openedAt < STOP_CONFIRM_ARM_MS) return;
        stop.state = "stopping";
        paint();
        var undo = function () {
          stop.state = "open";
          paint();
        };
        Promise.resolve(io.cancel()).then(function (ok) {
          if (!ok) undo();
        }, undo);
      });
      return;
    }
    if (!extras || !extras.details) return;

    // Bottom row: the details link LEFT, Open Keepr RIGHT.
    var row = el("div", "bottom-row", {
      display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", marginTop: "12px",
    });
    var toggle = button("details-toggle", SEE_DETAILS, "link");
    toggle.setAttribute("aria-expanded", "false");
    var open = button("open-keepr", "Open Keepr", "primary");
    row.appendChild(toggle);
    row.appendChild(open);
    box.appendChild(row);

    // The details card, BELOW the row, collapsed by default.
    var card = el("div", "details-card", {
      display: "none", marginTop: "10px", padding: "10px", borderRadius: "10px",
      background: p.detailsBg, color: p.text, border: "1px solid " + p.detailsBorder,
    });
    var details = el("pre", "details", { whiteSpace: "pre-wrap", margin: "0", font: "inherit", fontSize: "13px" }, extras.details);
    var copyButton = button("copy", "Copy details", "secondary");
    copyButton.style.marginTop = "8px";
    card.appendChild(details);
    card.appendChild(copyButton);
    // Founder: the extension version, a muted footer of the details.
    if (extras.version) {
      card.appendChild(el("div", "version", { marginTop: "8px", fontSize: "12px", color: p.muted }, "Keepr extension " + extras.version));
    }
    box.appendChild(card);

    toggle.addEventListener("click", function () {
      var opening = card.style.display === "none";
      card.style.display = opening ? "block" : "none";
      toggle.textContent = opening ? HIDE_DETAILS : SEE_DETAILS;
      toggle.setAttribute("aria-expanded", opening ? "true" : "false");
    });
    copyButton.addEventListener("click", function () {
      Promise.resolve(io.copy(extras.copy)).then(function (ok) {
        copyButton.textContent = ok ? "Copied" : "Copy failed";
      }, function () {
        copyButton.textContent = "Copy failed";
      });
    });
    open.addEventListener("click", function () {
      if (!io.focus) return;
      Promise.resolve(io.focus()).then(function (ok) {
        if (!ok) open.textContent = "Open Keepr from the taskbar";
      }, function () {
        open.textContent = "Open Keepr from the taskbar";
      });
    });
  }

  // ---------------------------------------------------------------------------
  // BACKLOG-3641 (founder): the overlay box can be moved — dragged with the
  // pointer, or sent corner to corner with its Move button (keyboard). It
  // always stays on screen; its place is remembered for this tab's session.
  // ---------------------------------------------------------------------------
  var OVERLAY_MARGIN = 8;
  /**
   * C3 (founder): the box lives on the RIGHT edge, at mid-height by default,
   * kept off the header (top) and the compose box (bottom) and a little in
   * from the edge so it never covers the messages' scrollbar.
   */
  var RIGHT_GAP = 18;
  var SAFE_TOP = 72;
  var SAFE_BOTTOM = 104;

  /** Where the box goes: right edge; `topFrac` (0..1, default 0.5) of the safe band. */
  function tabPosition(topFrac, size, view) {
    var frac = typeof topFrac === "number" && isFinite(topFrac) ? Math.min(1, Math.max(0, topFrac)) : 0.5;
    var minTop = SAFE_TOP;
    var maxTop = Math.max(minTop, view.height - SAFE_BOTTOM - size.height);
    return {
      left: Math.round(Math.max(OVERLAY_MARGIN, view.width - size.width - RIGHT_GAP)),
      top: Math.round(minTop + (maxTop - minTop) * frac),
    };
  }

  /**
   * SR (2026-10-03): the remembered place, read back from storage, is
   * UNTRUSTED: only {topFrac: a finite number}, clamped to 0..1.
   */
  function sanitizeTabPosition(raw) {
    if (!raw || typeof raw !== "object" || typeof raw.topFrac !== "number" || !isFinite(raw.topFrac)) return null;
    return { topFrac: Math.min(1, Math.max(0, raw.topFrac)) };
  }

  /** The band fraction of a top position (what is remembered). */
  function tabFraction(top, size, view) {
    var minTop = SAFE_TOP;
    var maxTop = Math.max(minTop, view.height - SAFE_BOTTOM - size.height);
    return maxTop === minTop ? 0.5 : Math.min(1, Math.max(0, (top - minTop) / (maxTop - minTop)));
  }
  var CORNER_GAP = 16;
  var CORNERS = ["top-right", "bottom-right", "bottom-left", "top-left"];

  /** pos clamped so the whole box ({width, height}) stays inside the view. */
  function clampPosition(pos, size, view) {
    var maxLeft = Math.max(OVERLAY_MARGIN, view.width - size.width - OVERLAY_MARGIN);
    var maxTop = Math.max(OVERLAY_MARGIN, view.height - size.height - OVERLAY_MARGIN);
    var left = isFinite(pos.left) ? pos.left : OVERLAY_MARGIN;
    var top = isFinite(pos.top) ? pos.top : OVERLAY_MARGIN;
    return {
      left: Math.round(Math.min(Math.max(left, OVERLAY_MARGIN), maxLeft)),
      top: Math.round(Math.min(Math.max(top, OVERLAY_MARGIN), maxTop)),
    };
  }

  function cornerPosition(corner, size, view) {
    var right = corner.indexOf("right") >= 0;
    var bottom = corner.indexOf("bottom") >= 0;
    return clampPosition({
      left: right ? view.width - size.width - CORNER_GAP : CORNER_GAP,
      top: bottom ? view.height - size.height - CORNER_GAP : CORNER_GAP,
    }, size, view);
  }

  function nextCorner(corner) {
    return CORNERS[(CORNERS.indexOf(corner) + 1) % CORNERS.length];
  }

  /**
   * Make a fixed box draggable by pointer. With `io.handle` (founder: the
   * grip), ONLY the handle starts a drag - the rest of the box keeps the normal
   * cursor, selectable text and clickable buttons. Without one, anywhere but
   * its buttons and text blocks. Returns the keyboard moves.
   * @param {HTMLElement} box
   * @param {{view: function(): {width: number, height: number}, size: function(): {width: number, height: number},
   *   load: function(): ({left: number, top: number}|null), save: function({left: number, top: number}): void,
   *   handle?: HTMLElement, handleSelector?: string}} io
   */
  function attachDrag(box, io) {
    var grip = io.handle || box;
    var drag = null;
    var corner = CORNERS[0];
    var edge = io.rightEdge === true;
    var frac = 0.5;
    function place(p) {
      box.style.left = p.left + "px";
      box.style.top = p.top + "px";
      box.style.right = "auto";
      box.style.bottom = "auto";
      return p;
    }
    function settle(pos) {
      if (edge) {
        // C3: up and down the right edge only, inside the safe band.
        frac = tabFraction(pos.top, io.size(), io.view());
        return place(tabPosition(frac, io.size(), io.view()));
      }
      return place(clampPosition(pos, io.size(), io.view()));
    }
    function current() {
      return { left: parseFloat(box.style.left) || 0, top: parseFloat(box.style.top) || 0 };
    }
    var saved = io.load();
    if (edge) {
      frac = saved && typeof saved.topFrac === "number" ? saved.topFrac : 0.5;
      place(tabPosition(frac, io.size(), io.view()));
    } else if (saved && typeof saved.left === "number" && typeof saved.top === "number") settle(saved);

    grip.addEventListener("pointerdown", function (e) {
      if (typeof e.button === "number" && e.button !== 0) return;
      var target = e.target;
      if (io.handleSelector) {
        // Only the handle (rebuilt on every render) starts a drag.
        if (!target || !target.closest || !target.closest(io.handleSelector)) return;
      } else if (grip === box && target && target.closest && target.closest("button, a, input, textarea, pre")) {
        return;
      }
      var rect = box.getBoundingClientRect();
      var from = box.style.left ? current() : { left: rect.left, top: rect.top };
      drag = { dx: e.clientX - from.left, dy: e.clientY - from.top, x0: e.clientX, y0: e.clientY, moved: false };
      if (grip !== box) grip.style.cursor = "grabbing";
      if (typeof e.pointerId === "number" && grip.setPointerCapture) {
        try { grip.setPointerCapture(e.pointerId); } catch (_e) { /* capture is a nicety */ }
      }
      if (e.preventDefault) e.preventDefault();
    });
    grip.addEventListener("pointermove", function (e) {
      if (!drag) return;
      if (Math.abs(e.clientX - drag.x0) + Math.abs(e.clientY - drag.y0) > 4) drag.moved = true;
      if (drag.moved) settle({ left: e.clientX - drag.dx, top: e.clientY - drag.dy });
    });
    function end() {
      if (!drag) return;
      var moved = drag.moved;
      drag = null;
      if (grip !== box) grip.style.cursor = "grab";
      // C3: a tap (no move) on the tab opens / closes it.
      if (!moved) {
        if (io.onTap) io.onTap();
        return;
      }
      io.save(edge ? { topFrac: frac } : current());
    }
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);

    return {
      /** Keyboard alternative: the next corner, clockwise from top-right. */
      moveToNextCorner: function () {
        if (edge) {
          // C3: the keyboard moves it along the edge: top, middle, bottom.
          frac = frac < 0.25 ? 0.5 : frac < 0.75 ? 1 : 0;
          place(tabPosition(frac, io.size(), io.view()));
          io.save({ topFrac: frac });
          return frac;
        }
        corner = nextCorner(corner);
        io.save(place(cornerPosition(corner, io.size(), io.view())));
        return corner;
      },
      /** SR: the remembered place arrived (async storage): go there. */
      restore: function (saved) {
        if (edge && saved && typeof saved.topFrac === "number") {
          frac = saved.topFrac;
          place(tabPosition(frac, io.size(), io.view()));
        }
      },
      /** After a resize (or a taller / wider box): back to its place. */
      keepOnScreen: function () {
        if (edge) place(tabPosition(frac, io.size(), io.view()));
        else if (box.style.left) settle(current());
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Founder: never two Keepr boxes. A reloaded extension leaves its old content
  // scripts running in an open tab (another isolated world, so window flags do
  // not see each other). The page's DOM is shared: the newest instance writes
  // its token on <html>; an older one sees a different token and steps aside;
  // a stale box of an older instance is removed when a newer one starts.
  // ---------------------------------------------------------------------------
  var OVERLAY_ID = "keepr-job-overlay";
  var OWNER_ATTR = "data-keepr-job-owner";

  /** Become the page's Keepr box owner; remove a stale box. */
  function claimPage(doc, token) {
    if (doc.documentElement) doc.documentElement.setAttribute(OWNER_ATTR, token);
    var stale = doc.getElementById(OVERLAY_ID);
    if (stale && stale.parentNode) stale.parentNode.removeChild(stale);
  }

  /** Still the page's owner? (False once a newer instance claimed it.) */
  function ownsPage(doc, token) {
    return !!doc.documentElement && doc.documentElement.getAttribute(OWNER_ATTR) === token;
  }

  /**
   * The Keepr box's fixed frame: where it sits and how it scrolls. Its look
   * (founder's design C) is entirely renderOverlay's.
   * @param {Document} doc
   * @returns {HTMLElement}
   */
  function buildBox(doc) {
    var box = doc.createElement("div");
    box.id = OVERLAY_ID;
    Object.assign(box.style, {
      position: "fixed", top: "16px", right: "16px", zIndex: "2147483647",
      maxHeight: "70vh", overflowY: "auto",
    });
    return box;
  }

  /**
   * Security review H1 (stopgap): which job this page load runs, and whether
   * it must ASK first. A job Keepr itself opened this tab for (the
   * #keepr-job hash, or the copy of it kept for this tab) may run at once. A
   * job only found pending on page load (POST /job/pending) runs only after
   * the user clicks Start in the Keepr box.
   * @param {{hashJob: (string|null), storedJob: (string|null), pendingJob: (string|null)}} found
   * @returns {{jobId: (string|null), ask: boolean, idle?: boolean}}
   */
  function bootPlan(found) {
    if (found.hashJob) return { jobId: found.hashJob, ask: false };
    if (found.storedJob) return { jobId: found.storedJob, ask: false };
    if (found.pendingJob) return { jobId: found.pendingJob, ask: true };
    // No Sync: the idle chip (founder, 2026-10-02).
    return { jobId: null, ask: false, idle: true };
  }

  /** The drag handle inside the box (renderOverlay's badge). */
  var DRAG_HANDLE = '[data-keepr="drag-handle"]';

  var api = {
    bootPlan: bootPlan,
    buildBox: buildBox,
    themeFromColor: themeFromColor,
    pageTheme: pageTheme,
    overlayState: overlayState,
    PALETTE: PALETTE,
    ASK_TITLE: ASK_TITLE,
    STOP_SYNC_QUESTION: STOP_SYNC_QUESTION,
    STOP_CONFIRM_ARM_MS: STOP_CONFIRM_ARM_MS,
    IDLE_TAB_LINE: IDLE_TAB_LINE,
    STOP_CONFIRM_AUTO_CLOSE_MS: STOP_CONFIRM_AUTO_CLOSE_MS,
    SYNC_FAILED_TITLE: SYNC_FAILED_TITLE,
    TRY_AGAIN_LABEL: TRY_AGAIN_LABEL,
    PAGE_GONE_MESSAGE: PAGE_GONE_MESSAGE,
    tabPosition: tabPosition,
    sanitizeTabPosition: sanitizeTabPosition,
    windowLabel: windowLabel,
    mediaLine: mediaLine,
    chatAlreadyOpen: chatAlreadyOpen,
    ALREADY_OPEN_STABLE_MS: ALREADY_OPEN_STABLE_MS,
    RCS_MAX_PHOTO_BYTES: RCS_MAX_PHOTO_BYTES,
    RCS_MAX_VIDEO_BYTES: RCS_MAX_VIDEO_BYTES,
    RCS_MEDIA_RETRY_POOL_MS: RCS_MEDIA_RETRY_POOL_MS,
    RCS_TRANSIENT_RETRY_POOL_MS: RCS_TRANSIENT_RETRY_POOL_MS,
    DRAG_HANDLE: DRAG_HANDLE,
    claimPage: claimPage,
    ownsPage: ownsPage,
    OVERLAY_ID: OVERLAY_ID,
    renderOverlay: renderOverlay,
    attachDrag: attachDrag,
    clampPosition: clampPosition,
    cornerPosition: cornerPosition,
    nextCorner: nextCorner,
    runJob: runJob,
    jobIdFromHash: jobIdFromHash,
    waitForPageState: waitForPageState,
    NOT_SIGNED_IN: NOT_SIGNED_IN,
    DONE_LINE: DONE_LINE,
    SYNCING_HINT: SYNCING_HINT,
    LIST_NOT_REACHABLE: LIST_NOT_REACHABLE,
    detailsText: detailsText,
    unionMessages: unionMessages,
    replyToFor: replyToFor,
    copyText: copyText,
    numberShape: numberShape,
    shortHash: shortHash,
    cachePlan: cachePlan,
    PAUSED_TEXT: PAUSED_TEXT,
    CONNECTING_TEXT: CONNECTING_TEXT,
    UNREACHABLE_TEXT: UNREACHABLE_TEXT,
    CONNECTION_LOST_TEXT: CONNECTION_LOST_TEXT,
    RCS_CONNECTION_LOST_MS: RCS_CONNECTION_LOST_MS,
    CACHE_CHECK_MAX: CACHE_CHECK_MAX,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
    return;
  }
  root.KeeprJob = api;

  // ---------------------------------------------------------------------------
  // Browser glue (not run under jest)
  // ---------------------------------------------------------------------------
  if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.id) return;
  if (root.__keeprJobInstalled) return;
  root.__keeprJobInstalled = true;

  var STORAGE_KEY = "keepr-job";
  // This instance's token (see claimPage): the newest instance owns the page.
  var INSTANCE = String(Date.now()) + "-" + Math.random().toString(36).slice(2);
  claimPage(document, INSTANCE);
  var running = false;
  function setRunning(value) {
    running = value;
  }

  // Read the hash at document_start, before the app's router runs; keep it for
  // this tab in case a redirect (e.g. to the sign-in page) drops it.
  var hashJob = jobIdFromHash(location.hash);
  try {
    if (hashJob) sessionStorage.setItem(STORAGE_KEY, hashJob);
  } catch (_e) { /* storage blocked: the hash is still in hand */ }
  var storedJob = null;
  try {
    storedJob = sessionStorage.getItem(STORAGE_KEY);
  } catch (_e) { storedJob = null; }

  function toWorker(message) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(message, function (response) {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, status: 0, body: { message: chrome.runtime.lastError.message } });
            return;
          }
          resolve(response || { ok: false, status: 0, body: { message: "No response from the extension." } });
        });
      } catch (err) {
        resolve({ ok: false, status: 0, body: { message: String((err && err.message) || err) } });
      }
    });
  }

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  // Overlay ------------------------------------------------------------------
  var box = null;
  var mover = null;
  var POSITION_KEY = "keepr-overlay-pos";
  /** The box's remembered place (chrome.storage.local), once read. */
  var savedPosition = null;
  /** SR: read the place from the extension's storage; drop what an older build left in the page's. */
  var positionLoaded = (function () {
    try { localStorage.removeItem(POSITION_KEY); } catch (_e) { /* nothing left */ }
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get(POSITION_KEY, function (got) {
          void chrome.runtime.lastError;
          savedPosition = sanitizeTabPosition(got && got[POSITION_KEY]);
          if (savedPosition && mover && mover.restore) mover.restore(savedPosition);
          resolve(savedPosition);
        });
      } catch (_e) {
        resolve(null);
      }
    });
  })();
  // The pill's ▾/▴ (kept across progress lines); the last thing shown, to redraw it.
  var syncExpanded = false;
  var idleExpanded = false;
  /** SR: the "Stop the sync?" confirm, kept across re-renders until answered or the job ends. */
  var stopConfirm = { state: "closed", openedAt: 0 };
  var lastShown = null;
  function showOverlay(text, isError, extras) {
    if (!document.body) return;
    // A newer extension instance owns the page: this one shows nothing.
    if (!ownsPage(document, INSTANCE)) {
      closeOverlay();
      return;
    }
    if (!box) {
      // One box per page: anything left by an older instance goes first.
      claimPage(document, INSTANCE);
      box = buildBox(document);
      document.body.appendChild(box);
      mover = attachDrag(box, {
        handleSelector: DRAG_HANDLE,
        // C3: the right edge, its place remembered on this computer.
        rightEdge: true,
        onTap: function () {
          if (lastShown && lastShown.extras && lastShown.extras.idle) {
            idleExpanded = !idleExpanded;
            showOverlay(lastShown.text, lastShown.isError, lastShown.extras);
          }
        },
        view: function () { return { width: root.innerWidth, height: root.innerHeight }; },
        size: function () { var r = box.getBoundingClientRect(); return { width: r.width, height: r.height }; },
        // SR (2026-10-03): the extension's own storage, never the page's
        // (Google's scripts could read it and see Keepr is in use).
        load: function () { return savedPosition; },
        save: function (pos) {
          savedPosition = sanitizeTabPosition(pos);
          if (!savedPosition) return;
          try {
            var item = {};
            item[POSITION_KEY] = savedPosition;
            void chrome.storage.local.set(item);
          } catch (_e) { /* not kept: fine */ }
        },
      });
      root.addEventListener("resize", function () { if (mover) mover.keepOnScreen(); });
    }
    lastShown = { text: text, isError: isError, extras: extras };
    // The job is no longer running (done, failed, idle): the confirm is over.
    if (!(extras && extras.cancel)) stopConfirm = { state: "closed", openedAt: 0 };
    renderOverlay(box, text, isError, extras, {
      copy: copyToClipboard, focus: focusKeepr, cancel: cancelJob, close: dismiss, stop: stopConfirm,
      rerender: function () { if (lastShown) showOverlay(lastShown.text, lastShown.isError, lastShown.extras); },
      // C5: "Try again" — Keepr starts a new Sync (signed; only after a failed
      // one); this tab runs it (the chats the failed one saved are skipped).
      retry: retrySync,
      move: function () { if (mover) mover.moveToNextCorner(); },
      expanded: extras && extras.idle ? idleExpanded : syncExpanded,
      onExpand: function (open) {
        if (extras && extras.idle) idleExpanded = open;
        else syncExpanded = open;
        if (lastShown) showOverlay(lastShown.text, lastShown.isError, lastShown.extras);
      },
    });
    // A taller (expanded) box is kept on screen.
    mover.keepOnScreen();
  }

  /** Close (×): the box goes; the next Sync makes a new one where it was. */
  function closeOverlay() {
    if (box && box.parentNode) box.parentNode.removeChild(box);
    box = null;
    mover = null;
    lastShown = null;
  }

  // Idle (founder, 2026-10-02): with no Sync running and nothing asked, the
  // box is the collapsed chip. Reachability comes from an existing route
  // (POST /exclusions/list, ids only); the last sync time is this extension's
  // own record (the worker notes when a /finish succeeded). No new data.
  var asking = false;
  function idleOnScreen() {
    return !lastShown || !!(lastShown.extras && lastShown.extras.idle);
  }
  function showIdle() {
    if (running || asking || !idleOnScreen()) return;
    showOverlay("", false, { idle: {}, version: manifestVersion() });
  }
  /** C3: idle, the page shows only the K tab (status and linking: the toolbar popup). */
  async function refreshIdle() {
    if (running || asking || !idleOnScreen()) return;
    if (!document.body) {
      await new Promise(function (r) { document.addEventListener("DOMContentLoaded", r, { once: true }); });
    }
    showIdle();
  }
  /** × on a finished Sync, or "Not now": the box goes back to the idle chip. */
  function dismiss() {
    asking = false;
    closeOverlay();
    void refreshIdle();
  }

  /** C5: Try again after a failed Sync. Resolves true once the new run started here. */
  function retrySync() {
    return toWorker({ type: "keepr-retry" }).then(function (r) {
      var jobId = r && r.ok && r.body && typeof r.body.jobId === "string" ? r.body.jobId : null;
      if (!jobId || running) return false;
      idleExpanded = false;
      void start(jobId);
      return true;
    });
  }

  // C5 (founder): the tab closed (or navigated away) during a Sync is a real
  // failure — Keepr is told at once (it saves the chats already finished),
  // instead of waiting on a time limit.
  root.addEventListener("pagehide", function () {
    if (!currentJobId || !running) return;
    void toWorker({
      type: "keepr-job-api", method: "POST", path: "/job/" + currentJobId + "/error",
      body: { code: "page_gone", message: PAGE_GONE_MESSAGE },
    });
  });

  /** The page's Cancel: POST /job/<this job>/cancel through the worker. */
  var currentJobId = null;
  function cancelJob() {
    if (!currentJobId) return Promise.resolve(false);
    // Signed (a job call); Keepr records who ended it.
    return toWorker({ type: "keepr-job-api", method: "POST", path: "/job/" + currentJobId + "/cancel", body: { endedBy: "user_page" } })
      .then(function (r) { return !!(r && r.ok); });
  }

  // Founder (2026-10-03): the run goes on while the tab is hidden; this only
  // tells the job when it is (for the hidden-time telemetry).
  var visibility = {
    hidden: function () { return document.visibilityState === "hidden"; },
    onChange: function (cb) {
      function onChange() { cb(document.visibilityState === "hidden"); }
      document.addEventListener("visibilitychange", onChange);
      return function () { document.removeEventListener("visibilitychange", onChange); };
    },
  };

  /** "Open Keepr": the worker asks the bridge (POST /focus) to bring Keepr forward. */
  function focusKeepr() {
    return toWorker({ type: "keepr-focus" }).then(function (r) { return !!(r && r.ok); });
  }

  /** navigator.clipboard, else a hidden textarea + execCommand("copy"). */
  function copyToClipboard(text) {
    if (root.navigator && root.navigator.clipboard && root.navigator.clipboard.writeText) {
      return root.navigator.clipboard.writeText(text).then(function () { return true; }, fallback);
    }
    return Promise.resolve(fallback());
    function fallback() {
      try {
        var area = document.createElement("textarea");
        area.value = text;
        area.setAttribute("readonly", "");
        area.style.position = "fixed";
        area.style.left = "-9999px";
        document.body.appendChild(area);
        area.select();
        var ok = document.execCommand("copy");
        area.remove();
        return ok;
      } catch (_e) {
        return false;
      }
    }
  }

  // Page actions -------------------------------------------------------------
  function click(el) {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    el.click();
  }

  // The conversation list is scrolled by scan.collectConversations itself
  // (top first, then steps with scroll events): no env.scroll here.

  // BACKLOG-3641: one diagnostics line to the service-worker console.
  function sendLog(line) {
    try {
      var runtime = root.chrome.runtime;
      runtime.sendMessage({ type: "keepr-log", line: String(line) }, function () {
        void runtime.lastError; // the worker may be asleep: a lost line is fine
      });
    } catch (_e) { /* ignore */ }
  }

  /** First 6 hex of SHA-256(name): correlates a run without the name. */
  async function hashName(name) {
    var subtle = root.crypto && root.crypto.subtle;
    if (!subtle) return "??????";
    var digest = await subtle.digest("SHA-256", new TextEncoder().encode(String(name)));
    var bytes = new Uint8Array(digest);
    var hex = "";
    for (var i = 0; i < 3; i++) hex += ("0" + bytes[i].toString(16)).slice(-2);
    return hex;
  }

  // The open chat's message list: scrolling to its top asks the page for
  // older messages. The element is picked by computed style (UNTRACED).
  async function scrollMessagesUp() {
    var el = root.KeeprScan.findMessageScroller(document);
    if (!el) return;
    el.scrollTop = 0;
    el.dispatchEvent(new el.ownerDocument.defaultView.Event("scroll", { bubbles: true }));
  }

  /** GAP GUARD: half a screen back down, to re-read across a gap. */
  async function stepBackMessages() {
    var el = root.KeeprScan.findMessageScroller(document);
    if (!el) return;
    el.scrollTop = Math.min(el.scrollHeight, el.scrollTop + Math.floor(el.clientHeight / 2));
    el.dispatchEvent(new el.ownerDocument.defaultView.Event("scroll"));
  }

  /** BACKLOG-3658 #10: a small scroll down and back to the top, so the page's loader fires again. */
  async function nudgeMessages() {
    var el = root.KeeprScan.findMessageScroller(document);
    if (!el) return;
    var Ev = el.ownerDocument.defaultView.Event;
    el.scrollTop = Math.min(200, el.scrollHeight);
    el.dispatchEvent(new Ev("scroll", { bubbles: true }));
    await sleep(150);
    el.scrollTop = 0;
    el.dispatchEvent(new Ev("scroll", { bubbles: true }));
  }

  /** History v2 nudge: half a viewport down (a bubbling scroll event). */
  var nudgeFrom = 0;
  async function nudgeDownMessages() {
    var el = root.KeeprScan.findMessageScroller(document);
    if (!el) return;
    nudgeFrom = Math.min(el.scrollHeight, el.scrollTop + Math.floor(el.clientHeight / 2));
    el.scrollTop = nudgeFrom;
    el.dispatchEvent(new el.ownerDocument.defaultView.Event("scroll", { bubbles: true }));
  }

  /** History v2 nudge: step i of n back to the top, eased (each a scroll event). */
  async function nudgeReturnMessages(i, n) {
    var el = root.KeeprScan.findMessageScroller(document);
    if (!el) return;
    var t = (i + 1) / n;
    var eased = 1 - Math.pow(1 - t, 3); // ease-out: big steps first, gentle at the top
    el.scrollTop = Math.round(nudgeFrom * (1 - eased));
    el.dispatchEvent(new el.ownerDocument.defaultView.Event("scroll", { bubbles: true }));
  }

  /** Image pass: a fraction of a viewport down; false at the bottom. */
  async function stepDownMessages(fraction) {
    var el = root.KeeprScan.findMessageScroller(document);
    if (!el) return false;
    var before = el.scrollTop;
    el.scrollTop = Math.min(el.scrollHeight, el.scrollTop + Math.floor(el.clientHeight * fraction));
    el.dispatchEvent(new el.ownerDocument.defaultView.Event("scroll", { bubbles: true }));
    return el.scrollTop > before;
  }

  // BACKLOG-3629: both layouts (list + chat side by side, or list OR chat in a
  // narrow window) go through scan.js, where jest drives them on fixtures.
  var layoutIo = {
    click: click,
    sleep: sleep,
    back: function () { root.history.back(); },
    getPathname: function () { return location.pathname; },
  };

  function openConversation(conv) {
    return root.KeeprScan.openFromList(document, conv, layoutIo);
  }

  function returnToList() {
    return root.KeeprScan.returnToList(document, layoutIo);
  }

  async function readImage(src) {
    var res = await fetch(src);
    var blob = await res.blob();
    var dataUrl = await new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result || "")); };
      r.onerror = function () { reject(r.error || new Error("read failed")); };
      r.readAsDataURL(blob);
    });
    var comma = dataUrl.indexOf(",");
    return { mimeType: blob.type || "application/octet-stream", base64: comma >= 0 ? dataUrl.slice(comma + 1) : "" };
  }

  /** This extension's version (manifest.json), or "" when it cannot be read. */
  function manifestVersion() {
    try {
      return chrome.runtime.getManifest().version || "";
    } catch (_e) {
      return "";
    }
  }

  function env() {
    return {
      doc: document,
      getLocation: function () { return { pathname: location.pathname, href: location.href }; },
      api: function (method, path, body) {
        return toWorker({ type: "keepr-job-api", method: method, path: path, body: body });
      },
      overlay: { show: showOverlay },
      sleep: sleep,
      click: click,
      log: sendLog,
      hashName: hashName,
      scrollMessagesUp: scrollMessagesUp,
      nudgeMessages: nudgeMessages,
      nudgeDownMessages: nudgeDownMessages,
      nudgeReturnMessages: nudgeReturnMessages,
      stepDownMessages: stepDownMessages,
      stepBackMessages: stepBackMessages,
      extensionVersion: manifestVersion(),
      openConversation: openConversation,
      returnToList: returnToList,
      readImage: readImage,
      extract: root.KeeprExtract.extractConversation,
      scan: root.KeeprScan,
      visibility: visibility,
      // Not discarded by Chrome while the run is on (the worker sets it on this tab).
      keepTab: function (keep) { void toWorker({ type: "keepr-keep-tab", keep: keep === true }); },
    };
  }

  async function start(jobId) {
    if (running) return;
    setRunning(true);
    currentJobId = jobId;
    try { sessionStorage.removeItem(STORAGE_KEY); } catch (_e) { /* ignore */ }
    if (!document.body) {
      await new Promise(function (r) { document.addEventListener("DOMContentLoaded", r, { once: true }); });
    }
    try {
      await runJob(jobId, env());
    } catch (err) {
      var stopped = "The sync stopped: " + String((err && err.message) || err);
      // Copy carries no error text (it could quote the page).
      showOverlay(stopped, true, { details: stopped, copy: "Keepr Sync diagnostics: the sync stopped with an error." });
      await toWorker({
        type: "keepr-job-api", method: "POST", path: "/job/" + jobId + "/error",
        body: { code: "scan_failed", message: String((err && err.message) || err) },
      });
    } finally {
      currentJobId = null;
      setRunning(false);
    }
  }

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || sender.id !== chrome.runtime.id) return false;
    if (message.type === "keepr-ping") {
      sendResponse({
        signedIn: root.KeeprScan.signInState(location.pathname) === "signed_in" &&
          !!(document.querySelector(LIST_ITEM) || document.querySelector(root.KeeprScan.SELECTORS.headerTitle)),
        running: running,
      });
      return false;
    }
    if (message.type === "keepr-run-job" && typeof message.jobId === "string") {
      // Busy with another job: refuse, so the worker does not hand it here.
      if (running) {
        sendResponse({ ok: false, running: true });
        return false;
      }
      void start(message.jobId);
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  // Hand the job to the worker: it may pass it to an already signed-in tab.
  async function routeAndStart(jobId) {
    var route = await toWorker({ type: "keepr-job-found", jobId: jobId });
    if (route && route.handedOff) return;
    void start(jobId);
  }

  (async function boot() {
    var pendingJob = null;
    if (!hashJob && !storedJob) {
      var pending = await toWorker({ type: "keepr-check-pending" });
      pendingJob = pending && pending.ok && pending.body && pending.body.jobId ? pending.body.jobId : null;
    }
    var plan = bootPlan({ hashJob: hashJob, storedJob: storedJob, pendingJob: pendingJob });
    if (plan.idle) {
      void refreshIdle();
      return;
    }
    if (!plan.ask) {
      await routeAndStart(plan.jobId);
      return;
    }
    // Security H1: a Sync Keepr did not open this tab for runs only on Start.
    var askedJob = plan.jobId;
    asking = true;
    showOverlay(ASK_TITLE, false, {
      ask: {
        start: function () { asking = false; void routeAndStart(askedJob); },
        later: function () { dismiss(); },
      },
    });
  })();
})(typeof globalThis !== "undefined" ? globalThis : this);
