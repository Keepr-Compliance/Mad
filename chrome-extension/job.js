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

  /** Keepr keeps at most this many named entries (RCS_NOT_REACHED_CAP). */
  var NOT_REACHED_CAP = 20;
  /** BACKLOG-3658: a cache Sync checks at most this many chats per run (the rest: not checked). */
  var CACHE_CHECK_MAX = 300;
  /** BACKLOG-3658: the list read for a cache Sync stops here when no time can be read. */
  var CACHE_LIST_MAX = 1000;
  var PAUSED_TEXT = "Keep this Chrome window visible — Sync paused";
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
      (typeof s.saved.reactions === "number" ? " · " + plural(s.saved.reactions, "reaction", "reactions") : "");
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

  /** "History depth: …" — counts only (no dates, no names). */
  function historyDepthLine(d) {
    if (!d || d.limit + d.start + d.partial === 0) return null;
    var limit = d.floorDays !== null && d.floorDays !== undefined
      ? "the " + Math.max(1, Math.round(d.floorDays / 30.44)) + "-month limit"
      : "the months limit";
    return "History depth: " + d.limit + " chats reached " + limit + " · " + d.start + " reached the chat's start · " +
      d.partial + " not fully loaded" +
      (d.gaps > 0 ? " · " + d.gaps + " gaps (" + d.gapsRecovered + " recovered)" : "");
  }

  /** SR: the run's extra-time pool, "Extra time used: N min of 30" — or null when none was used. */
  function extraTimeLine(x) {
    if (!x || !(x.usedMs > 0)) return null;
    return "Extra time used: " + Math.ceil(x.usedMs / 60000) + " min of " + Math.round(x.poolMs / 60000);
  }

  /** SR S2: the per-kind count line ("History start: …"), or null when no chat was imported. */
  function historyConfirmedLine(c) {
    if (!c || c.marker + c.first_page + (c.no_overflow || 0) + (c.date_floor || 0) + c.none === 0) return null;
    return "History start: " + c.marker + " confirmed by the start marker · " + c.first_page +
      " complete on the first page · " + (c.no_overflow || 0) + " without scrolling · " +
      (c.date_floor || 0) + " reached the months limit · " + c.none + " not confirmed";
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
  function cachePlan(conversations, sinceMs, pending) {
    var above = conversations;
    var must = pending || {};
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
    var rest = above.filter(function (c) { return !must[c.conversationId]; });
    above = pendingFirst.concat(rest);
    var picked = above.slice(0, CACHE_CHECK_MAX);
    return {
      queue: picked.map(function (c) { return { conversation: c, reason: "cache" }; }),
      notChecked: above.length - picked.length,
    };
  }

  async function runJob(jobId, env) {
    try {
      return await runJobInner(jobId, env);
    } catch (err) {
      if (err && err.jobGone) {
        diag(env, "stopped: cancelled or replaced in Keepr");
        env.overlay.show(CANCELLED, true);
        return { outcome: "job_gone" };
      }
      throw err;
    }
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
      log("  left out: " + reason + (count !== undefined ? " (" + count + ")" : ""));
    }

    /** Every job call: a 404/410 ends the run. */
    async function call(method, path, body) {
      var reply = await env.api(method, path, body);
      if (jobGone(reply)) throw JobGoneError();
      return reply;
    }
    var progress = { listed: 0, candidates: 0, checked: 0, skipped: 0, notChecked: 0 };
    var totals = { chats: 0, messages: 0, images: 0, reactions: 0, historyConfirmed: { marker: 0, first_page: 0, no_overflow: 0, date_floor: 0, none: 0 },
      depth: { limit: 0, start: 0, partial: 0, gaps: 0, gapsRecovered: 0, floorDays: null }, removedByUser: 0, imagesNotKept: 0, notText: 0, noMessagesYet: 0, notSynced: 0 };
    var contactsWithoutPhone = 0;
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
    /**
     * BACKLOG-3658: a hidden tab is throttled by Chrome (timers slowed, the
     * list may not render), so the steps stop while the page is hidden and
     * resume once it is visible again. Keepr hears the pause as a stage.
     */
    var pauses = 0;
    async function holdWhileHidden(resumeText) {
      if (!env.visibility || !env.visibility.hidden()) return;
      pauses += 1;
      await report(PAUSED_TEXT);
      await env.visibility.whenVisible();
      log("resumed");
      if (resumeText) await report(resumeText);
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
      env.overlay.show(message, true, await overlayExtras());
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
    await holdWhileHidden("Loading your conversation list…");
    var collected = await env.scan.collectConversations(env.doc, isCache
      ? {
        scroll: env.scroll, sleep: env.sleep, stopAtOlderThanMs: floorMs, maxItems: CACHE_LIST_MAX,
        mustSee: pendingIds, mustSeeFloorMs: fullFloorMs,
      }
      : { scroll: env.scroll, sleep: env.sleep });
    // BACKLOG-3645: the phone number is the gate, a name only orders the queue.
    // Up to CHECK_ALL_MAX chats every chat is checked; above it, plausible names
    // plus number-only chats, and the rest are reported as not checked.
    // BACKLOG-3658: a cache Sync checks every chat newer than `since` in list
    // order (no names), at most CACHE_CHECK_MAX; the rest are not checked.
    var plan = isCache
      ? cachePlan(collected.conversations, floorMs, pendingFull)
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
    for (var i = 0; i < candidates.length; i++) {
      var conv = candidates[i].conversation;
      var opened = false;
      var gone = false;
      var imagesFailed = 0;
      await holdWhileHidden(stageText(i + 1, candidates.length));
      try {
        env.overlay.show(stageText(i + 1, candidates.length) + "…", false, RUNNING_EXTRAS);
        // BACKLOG-3658 #12: the conversation id as a 6-hex tag salted per job
        // (never the raw id), so two chats with the same name are told apart.
        log("#" + (i + 1) + "/" + candidates.length + " chat " + (await tag(conv.name)) +
          " id " + (await tag("conversation-id:" + conv.conversationId)) + " reason=" + candidates[i].reason);
        // The messages on screen before the click: the next chat is ready only
        // once this set has been replaced (the URL and title flip first).
        var before = env.scan.messageIdSet(env.doc);
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
          continue;
        }
        var match = await call("POST", base + "/match", { conversationId: conv.conversationId, numbers: numbers });
        if (!match.ok) throw new Error(messageOf(match, "Keepr could not check this chat."));
        var isMatch = !!(match.body && match.body.matched);
        // Keepr says whether it keeps this chat's images (a cache Sync keeps
        // them only for chats with a transaction contact); a transaction
        // Sync's matched chat always keeps them.
        var keepImages = isCache ? !!(match.body && match.body.keepImages) : true;
        if (!isMatch && match.body && match.body.excluded === true) {
          // BACKLOG-3658 P3c: the user switched this chat off — counted, never silent.
          totals.notSynced += 1;
          log("  switched off by you: not synced");
          continue;
        }
        log("  match=" + (isMatch ? "yes" : "no"));
        if (!isMatch) continue;
        matchedCount += 1;

        var ready = await env.scan.waitForMessageSwap(env.doc, before, {
          sleep: env.sleep,
          timeoutMs: env.messagesTimeoutMs,
          stableMs: env.messagesStableMs,
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
        await holdWhileHidden(stageText(i + 1, candidates.length));
        var loc = env.getLocation();
        var hist = await env.scan.loadHistory(env.doc, {
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
          floorMs: pendingFull[conv.conversationId] ? fullFloorMs : floorMs,
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
        });
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
          for (var k in m) if (k !== "imageSrcs") copy[k] = m[k];
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
        });
        if (!sent.ok) throw new Error(messageOf(sent, "Keepr could not save this chat."));
        totals.chats += 1;
        totals.messages += messages.length;
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
        totals.reactions += chatReactions;
        // SR S2: how this chat's history start was confirmed, counted per kind.
        totals.historyConfirmed[startConfirmedBy(hist)] += 1;
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
        totals.depth[depthKind(hist)] += 1;
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

        for (var j = 0; j < readSet.length; j++) {
          var msg = readSet[j];
          var srcs = msg.imageSrcs || [];
          for (var n = 0; n < srcs.length; n++) {
            try {
              var img = await env.readImage(srcs[n]);
              if (!img || !/^image\//.test(img.mimeType)) {
                progress.skipped += 1;
                imagesFailed += 1;
                continue;
              }
              var up = await call("POST", base + "/attachment", {
                conversationId: conv.conversationId,
                msgId: msg.msgId,
                index: n,
                mimeType: img.mimeType,
                base64: img.base64,
              });
              if (up.ok) totals.images += 1;
              else if (up.status === 422 && up.body && up.body.error === "not_a_contact") {
                // BACKLOG-3658: an expected skip in a cache Sync (no transaction
                // contact in the chat): counted on its own, never "not imported".
                totals.imagesNotKept += 1;
              } else {
                progress.skipped += 1;
                imagesFailed += 1;
              }
            } catch (imgErr) {
              if (imgErr && imgErr.jobGone) throw imgErr;
              progress.skipped += 1;
              imagesFailed += 1;
            }
          }
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
      }
      // Also the cancel check between chats: a job Keepr dropped answers 404/410.
      await report(i + 1 < candidates.length
        ? stageText(i + 2, candidates.length)
        : "Checked " + candidates.length + " of " + candidates.length + " chats");
    }

    if (extraTime.usedMs > 0) {
      log("extra time used: " + Math.ceil(extraTime.usedMs / 60000) + " min of " + Math.round(extraTime.poolMs / 60000));
    }
    // 5. Done: Keepr brings itself forward. Every chat left out (or imported
    // in part) is named here and on the page — never a silent skip.
    var reported = notReached.slice(0, NOT_REACHED_CAP);
    var more = notReached.length - reported.length;
    // A cache Sync: Keepr answers once it has saved, with what it saved.
    if (isCache) env.overlay.show(SAVING_TEXT, false);
    var finished = await call("POST", base + "/finish", {
      chats: totals.chats,
      messages: totals.messages,
      images: totals.images,
      notReached: reported,
      notReachedMore: more,
      notChecked: progress.notChecked,
      notText: totals.notText,
      noMessagesYet: totals.noMessagesYet,
      historyConfirmed: totals.historyConfirmed,
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
  var PAUSED_BODY = "Keep this Chrome window visible — Sync continues when it's back.";
  var SYNCING_TITLE = "Syncing your texts";
  /**
   * Founder (2026-10-01): from the first second of a Sync, not only once
   * paused. The full sentence in the expanded box; a short tail on the chip.
   */
  var SYNCING_HINT = "Keep this tab open and on screen while Keepr syncs. When it's done, you'll go back to Keepr automatically.";
  var SYNCING_CHIP_HINT = "keep this tab on screen";

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
    if (extras && extras.ask) return "ask";
    if (isError) return "error";
    if (extras && extras.details) return "done";
    if (text === PAUSED_TEXT) return "paused";
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
    var expanded = state !== "syncing" || !!io.expanded;
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

    var title = state === "syncing"
      ? (expanded ? SYNCING_TITLE : chipTitle(text))
      : state === "paused" ? PAUSED_TITLE : state === "ask" ? ASK_TITLE : text;
    header.appendChild(el("div", "line", {
      flex: "1 1 auto", minWidth: "0", fontWeight: "600", color: p.text, whiteSpace: expanded ? "normal" : "nowrap",
    }, title));

    if (state === "syncing") {
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
    if (state === "syncing") {
      box.appendChild(el("div", "progress", bodyStyle, text));
      box.appendChild(el("div", "hint", { marginTop: "6px", color: p.text }, SYNCING_HINT));
    }
    if (state === "paused") box.appendChild(el("div", "progress", bodyStyle, PAUSED_BODY));

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
      // BACKLOG-3658: a running Sync's Cancel (this job only, via the bridge).
      var cancel = button("cancel", "Cancel", "secondary");
      cancel.style.marginTop = "10px";
      box.appendChild(cancel);
      cancel.addEventListener("click", function () {
        if (!io.cancel) return;
        cancel.disabled = true;
        cancel.textContent = "Cancelling…";
        Promise.resolve(io.cancel()).then(function (ok) {
          if (!ok) {
            cancel.disabled = false;
            cancel.textContent = "Cancel";
          }
        }, function () {
          cancel.disabled = false;
          cancel.textContent = "Cancel";
        });
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
    function place(p) {
      box.style.left = p.left + "px";
      box.style.top = p.top + "px";
      box.style.right = "auto";
      box.style.bottom = "auto";
      return p;
    }
    function settle(pos) {
      return place(clampPosition(pos, io.size(), io.view()));
    }
    function current() {
      return { left: parseFloat(box.style.left) || 0, top: parseFloat(box.style.top) || 0 };
    }
    var saved = io.load();
    if (saved && typeof saved.left === "number" && typeof saved.top === "number") settle(saved);

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
      drag = { dx: e.clientX - from.left, dy: e.clientY - from.top };
      if (grip !== box) grip.style.cursor = "grabbing";
      if (typeof e.pointerId === "number" && grip.setPointerCapture) {
        try { grip.setPointerCapture(e.pointerId); } catch (_e) { /* capture is a nicety */ }
      }
      if (e.preventDefault) e.preventDefault();
    });
    grip.addEventListener("pointermove", function (e) {
      if (!drag) return;
      settle({ left: e.clientX - drag.dx, top: e.clientY - drag.dy });
    });
    function end() {
      if (!drag) return;
      drag = null;
      if (grip !== box) grip.style.cursor = "grab";
      io.save(current());
    }
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);

    return {
      /** Keyboard alternative: the next corner, clockwise from top-right. */
      moveToNextCorner: function () {
        corner = nextCorner(corner);
        io.save(place(cornerPosition(corner, io.size(), io.view())));
        return corner;
      },
      /** After a resize (or a taller box): back inside the view. */
      keepOnScreen: function () {
        if (box.style.left) settle(current());
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
   * @returns {{jobId: (string|null), ask: boolean}}
   */
  function bootPlan(found) {
    if (found.hashJob) return { jobId: found.hashJob, ask: false };
    if (found.storedJob) return { jobId: found.storedJob, ask: false };
    if (found.pendingJob) return { jobId: found.pendingJob, ask: true };
    return { jobId: null, ask: false };
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
    copyText: copyText,
    numberShape: numberShape,
    shortHash: shortHash,
    cachePlan: cachePlan,
    PAUSED_TEXT: PAUSED_TEXT,
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
  // The pill's ▾/▴ (kept across progress lines); the last thing shown, to redraw it.
  var syncExpanded = false;
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
        view: function () { return { width: root.innerWidth, height: root.innerHeight }; },
        size: function () { var r = box.getBoundingClientRect(); return { width: r.width, height: r.height }; },
        load: function () {
          try {
            var raw = sessionStorage.getItem(POSITION_KEY);
            return raw ? JSON.parse(raw) : null;
          } catch (_e) {
            return null;
          }
        },
        save: function (pos) {
          try { sessionStorage.setItem(POSITION_KEY, JSON.stringify(pos)); } catch (_e) { /* not kept: fine */ }
        },
      });
      root.addEventListener("resize", function () { if (mover) mover.keepOnScreen(); });
    }
    lastShown = { text: text, isError: isError, extras: extras };
    renderOverlay(box, text, isError, extras, {
      copy: copyToClipboard, focus: focusKeepr, cancel: cancelJob, close: closeOverlay,
      move: function () { if (mover) mover.moveToNextCorner(); },
      expanded: syncExpanded,
      onExpand: function (open) {
        syncExpanded = open;
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

  /** The page's Cancel: POST /job/<this job>/cancel through the worker. */
  var currentJobId = null;
  function cancelJob() {
    if (!currentJobId) return Promise.resolve(false);
    return toWorker({ type: "keepr-job-api", method: "POST", path: "/job/" + currentJobId + "/cancel", body: {} })
      .then(function (r) { return !!(r && r.ok); });
  }

  // BACKLOG-3658: the steps wait while the tab is hidden (Chrome throttles it).
  var visibility = {
    hidden: function () { return document.visibilityState === "hidden"; },
    whenVisible: function () {
      return new Promise(function (resolve) {
        if (document.visibilityState !== "hidden") return resolve();
        function onChange() {
          if (document.visibilityState === "hidden") return;
          document.removeEventListener("visibilitychange", onChange);
          resolve();
        }
        document.addEventListener("visibilitychange", onChange);
      });
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
    if (!plan.jobId) return;
    if (!plan.ask) {
      await routeAndStart(plan.jobId);
      return;
    }
    // Security H1: a Sync Keepr did not open this tab for runs only on Start.
    var askedJob = plan.jobId;
    showOverlay(ASK_TITLE, false, {
      ask: {
        start: function () { void routeAndStart(askedJob); },
        later: function () { closeOverlay(); },
      },
    });
  })();
})(typeof globalThis !== "undefined" ? globalThis : this);
