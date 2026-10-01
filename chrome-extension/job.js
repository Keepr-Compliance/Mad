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
  /** Step-log lines kept for the overlay's Copy. */
  var LOG_BUFFER_MAX = 500;
  var LIST_NOT_REACHABLE =
    "Couldn't show the Messages conversation list. Make the window wider or open " +
    "messages.google.com/web/conversations, then click Sync again.";

  /** Why a chat was left out, or imported only in part, for the overlay. */
  var REASON_TEXT = {
    not_opened: "could not be opened",
    no_numbers: "no phone number shown",
    messages_not_loaded: "messages did not load",
    history_not_settled: "messages kept changing",
    no_messages: "no messages found",
    error: "failed",
    images_failed: "images not imported",
    history_truncated: "only the newest messages imported",
  };

  function reasonText(entry) {
    var text = REASON_TEXT[entry.reason] || entry.reason;
    return entry.count ? text + ": " + entry.count : text;
  }

  /** BACKLOG-3641 founder UX: the finished overlay is this one line + Details. */
  var DONE_LINE = "Sync done — switch back to Keepr.";

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
    var lines = [
      "Scanned " + s.listed + " chats · checked " + s.checked + " · matched " + s.matched +
        " · imported " + s.messages + " messages" + (s.images > 0 ? ", " + s.images + " images" : ""),
    ];
    if (s.checked > 0 && s.matched === 0) {
      lines.push("None of the checked chats matched a phone number on this transaction's contacts.");
    }
    if (s.notChecked > 0) {
      lines.push("Not checked: " + s.notChecked + " chats (name didn't match a contact on this transaction)");
    }
    // A count only: Keepr-only names never go into the page (SR B1).
    if (s.contactsWithoutPhone > 0) {
      lines.push(s.contactsWithoutPhone + " contact" + (s.contactsWithoutPhone === 1 ? " has" : "s have") +
        " no phone number — see Keepr");
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

  /** On-screen Details: real names are fine on the user's own page. */
  function detailsText(s) {
    return summaryLines(s, function (n) { return n; }).join("\n");
  }

  /**
   * Copy text for a test user to send: counts, reasons and salted name tags,
   * then the step log (already shapes and tags). No name, number or message text.
   */
  function copyText(s, tags, logLines) {
    return ["Keepr Sync diagnostics"]
      .concat(summaryLines(s, function (n) { return "#" + (tags[n] || "??????"); }))
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
   *                        messagesTimeoutMs?, messagesStableMs?, historyCap?, historyNoNewMs? }
   *
   * Any job call answering 404 or 410 means Keepr cancelled or replaced this
   * job: the run ends at once — no more chats, no /finish, no /error.
   * @returns {Promise<{outcome: string, progress?: object}>}
   */
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
    var totals = { chats: 0, messages: 0, images: 0, removedByUser: 0 };
    var contactsWithoutPhone = 0;

    async function report(stage) {
      log("stage: " + stage);
      env.overlay.show(stage, false);
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
        notChecked: progress.notChecked,
        contactsWithoutPhone: contactsWithoutPhone,
        removedByUser: totals.removedByUser,
        notReached: reported,
        notReachedMore: notReached.length - reported.length,
      };
    }

    /** Details (real names, on screen) and Copy (tags only) for the overlay. */
    async function overlayExtras() {
      var s = summary();
      var tags = {};
      var names = s.notReached.map(function (e) { return e.name; });
      for (var n = 0; n < names.length; n++) {
        if (!(names[n] in tags)) tags[names[n]] = await tag(names[n]);
      }
      return { details: detailsText(s), copy: copyText(s, tags, logLines) };
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
    var floorMs = claim.body && typeof claim.body.startDate === "string" ? Date.parse(claim.body.startDate) : NaN;
    if (!isFinite(floorMs)) floorMs = null;
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
    var collected = await env.scan.collectConversations(env.doc, { scroll: env.scroll, sleep: env.sleep });
    // BACKLOG-3645: the phone number is the gate, a name only orders the queue.
    // Up to CHECK_ALL_MAX chats every chat is checked; above it, plausible names
    // plus number-only chats, and the rest are reported as not checked.
    var plan = env.scan.planChecks
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
    await report(candidates.length > 0 ? "Checking chat 1 of " + candidates.length : "No chats to check");

    // 4. Each candidate: open, read numbers, close Details, ask Keepr.
    for (var i = 0; i < candidates.length; i++) {
      var conv = candidates[i].conversation;
      var opened = false;
      var gone = false;
      var imagesFailed = 0;
      try {
        env.overlay.show("Checking chat " + (i + 1) + " of " + candidates.length + "…", false);
        log("#" + (i + 1) + "/" + candidates.length + " chat " + (await tag(conv.name)) +
          " reason=" + candidates[i].reason);
        // The messages on screen before the click: the next chat is ready only
        // once this set has been replaced (the URL and title flip first).
        var before = env.scan.messageIdSet(env.doc);
        await env.openConversation(conv);
        opened = true;
        var numbers = await env.scan.readParticipantsAndClose(env.doc, { click: env.click, sleep: env.sleep });
        progress.checked += 1;
        log("  numbers " + JSON.stringify((numbers || []).map(numberShape)));
        if (!numbers || numbers.length === 0) {
          // Keepr cannot check a chat with no number on screen: report it.
          leaveOut(conv, "no_numbers");
          continue;
        }
        var match = await call("POST", base + "/match", { conversationId: conv.conversationId, numbers: numbers });
        if (!match.ok) throw new Error(messageOf(match, "Keepr could not check this chat."));
        var isMatch = !!(match.body && match.body.matched);
        log("  match=" + (isMatch ? "yes" : "no"));
        if (!isMatch) continue;
        matchedCount += 1;

        var ready = await env.scan.waitForMessageSwap(env.doc, before, {
          sleep: env.sleep,
          timeoutMs: env.messagesTimeoutMs,
          stableMs: env.messagesStableMs,
        });
        if (!ready) {
          progress.skipped += 1;
          skips.push({ conversationId: conv.conversationId, reason: MESSAGES_NOT_LOADED });
          leaveOut(conv, MESSAGES_NOT_LOADED);
          env.overlay.show("Skipped a chat: its messages did not load", false);
          continue;
        }
        // Only the latest messages render on open: load older ones back past
        // the transaction's start date, then let the set settle.
        var loc = env.getLocation();
        var hist = await env.scan.loadHistory(env.doc, {
          scrollUp: env.scrollMessagesUp || function () {},
          sleep: env.sleep,
          floorMs: floorMs,
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
        var messages = extracted.messages.map(function (m) {
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
        });
        if (!sent.ok) throw new Error(messageOf(sent, "Keepr could not save this chat."));
        totals.chats += 1;
        totals.messages += messages.length;
        // BACKLOG-3642: rows the user removed from this transaction are stored
        // but not linked again; Keepr says how many.
        var removed = sent.body && typeof sent.body.removedByUser === "number" ? sent.body.removedByUser : 0;
        totals.removedByUser += removed;
        if (removed > 0) log("  removed by you, not re-added: " + removed);
        log("  imported " + messages.length + " messages (history stop: " + hist.stopReason + ")");
        // Imported, but only back to the cap: older messages are missing.
        if (hist.stopReason === "cap") leaveOut(conv, "history_truncated");

        for (var j = 0; j < extracted.messages.length; j++) {
          var msg = extracted.messages[j];
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
              else {
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
        ? "Checking chat " + (i + 2) + " of " + candidates.length
        : "Checked " + candidates.length + " of " + candidates.length + " chats");
    }

    // 5. Done: Keepr brings itself forward. Every chat left out (or imported
    // in part) is named here and on the page — never a silent skip.
    var reported = notReached.slice(0, NOT_REACHED_CAP);
    var more = notReached.length - reported.length;
    await call("POST", base + "/finish", {
      chats: totals.chats,
      messages: totals.messages,
      images: totals.images,
      notReached: reported,
      notReachedMore: more,
      notChecked: progress.notChecked,
    });
    log("done: listed " + progress.listed + ", candidates " + progress.candidates + ", checked " + progress.checked +
      ", matched " + matchedCount + ", imported " + totals.chats + " chats / " + totals.messages + " messages / " +
      totals.images + " images, not fully imported " + notReached.length + ", not checked " + progress.notChecked +
      ", removed by you " + totals.removedByUser);
    // One line + Details / Copy (founder, BACKLOG-3641); results live in Keepr.
    env.overlay.show(DONE_LINE, false, await overlayExtras());
    return {
      outcome: "finished", progress: progress, totals: totals, skips: skips, history: history, notReached: notReached,
    };
  }

  var SEE_DETAILS = "See details ▾";
  var HIDE_DETAILS = "Hide details ▴";

  /**
   * Fill the overlay panel (BACKLOG-3641, founder's final layout, mockup screen 4):
   *
   *   [headline: "Sync done — switch back to Keepr." or the failure line]
   *   [See details ▾ (link, bottom-LEFT)]          [Open Keepr (primary, RIGHT)]
   *   [details card — below the row, collapsed: the summary + "Copy details"]
   *
   * The link reads "Hide details ▴" while the card is open. "Open Keepr" asks
   * Keepr (through the extension's worker and the bridge's POST /focus) to bring
   * itself to the front — the backup when Windows blocks the focus change.
   * Progress lines (no `extras`) are just the headline. createElement and
   * textContent only: page text never becomes markup.
   *
   * @param {HTMLElement} panel
   * @param {string} text
   * @param {boolean} isError
   * @param {{details: string, copy: string}=} extras
   * @param {{copy: function(string): Promise<boolean>, focus?: function(): Promise<boolean>}} io
   */
  function renderOverlay(panel, text, isError, extras, io) {
    var doc = panel.ownerDocument;
    while (panel.firstChild) panel.removeChild(panel.firstChild);
    panel.style.background = isError ? "#fee2e2" : "#eef2ff";
    panel.style.color = isError ? "#991b1b" : "#1e1b4b";
    var line = doc.createElement("div");
    line.setAttribute("data-keepr", "line");
    line.textContent = "Keepr: " + text;
    Object.assign(line.style, { fontWeight: "600" });
    panel.appendChild(line);
    if (!extras) return;

    // Bottom row: the details link LEFT, Open Keepr RIGHT.
    var row = doc.createElement("div");
    row.setAttribute("data-keepr", "bottom-row");
    Object.assign(row.style, {
      display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", marginTop: "10px",
    });
    var toggle = doc.createElement("button");
    toggle.type = "button";
    toggle.setAttribute("data-keepr", "details-toggle");
    toggle.setAttribute("aria-expanded", "false");
    toggle.textContent = SEE_DETAILS;
    Object.assign(toggle.style, {
      background: "none", border: "none", padding: "0", cursor: "pointer",
      color: "inherit", textDecoration: "underline", font: "inherit",
    });
    var open = doc.createElement("button");
    open.type = "button";
    open.setAttribute("data-keepr", "open-keepr");
    open.textContent = "Open Keepr";
    Object.assign(open.style, {
      background: "#4f46e5", color: "#fff", border: "none", borderRadius: "8px",
      padding: "8px 14px", fontWeight: "600", cursor: "pointer", font: "inherit",
    });
    row.appendChild(toggle);
    row.appendChild(open);
    panel.appendChild(row);

    // The details card, BELOW the row, collapsed by default.
    var card = doc.createElement("div");
    card.setAttribute("data-keepr", "details-card");
    Object.assign(card.style, {
      display: "none", marginTop: "10px", padding: "10px", borderRadius: "8px",
      background: "#ffffff", color: "#1f2937", border: "1px solid #e5e7eb",
    });
    var details = doc.createElement("pre");
    details.setAttribute("data-keepr", "details");
    details.textContent = extras.details;
    Object.assign(details.style, { whiteSpace: "pre-wrap", margin: "0", font: "inherit" });
    var copyButton = doc.createElement("button");
    copyButton.type = "button";
    copyButton.setAttribute("data-keepr", "copy");
    copyButton.textContent = "Copy details";
    Object.assign(copyButton.style, { marginTop: "8px", cursor: "pointer", font: "inherit" });
    card.appendChild(details);
    card.appendChild(copyButton);
    panel.appendChild(card);

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

  var api = {
    renderOverlay: renderOverlay,
    runJob: runJob,
    jobIdFromHash: jobIdFromHash,
    waitForPageState: waitForPageState,
    NOT_SIGNED_IN: NOT_SIGNED_IN,
    DONE_LINE: DONE_LINE,
    LIST_NOT_REACHABLE: LIST_NOT_REACHABLE,
    detailsText: detailsText,
    copyText: copyText,
    numberShape: numberShape,
    shortHash: shortHash,
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
  var running = false;
  // BACKLOG-3661: the page's Send button (content.js) is disabled while a Sync
  // runs in this tab; Keepr refuses a manual Send during any Sync as well.
  root.KeeprSyncState = { running: false };
  function setRunning(value) {
    running = value;
    root.KeeprSyncState.running = value;
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
  var panel = null;
  function showOverlay(text, isError, extras) {
    if (!document.body) return;
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "keepr-job-overlay";
      Object.assign(panel.style, {
        position: "fixed", top: "16px", right: "16px", zIndex: "2147483647",
        maxWidth: "360px", padding: "10px 14px", borderRadius: "10px",
        fontFamily: "system-ui, -apple-system, sans-serif", fontSize: "14px",
        boxShadow: "0 2px 10px rgba(0,0,0,0.25)",
        maxHeight: "60vh", overflowY: "auto",
      });
      document.body.appendChild(panel);
    }
    renderOverlay(panel, text, isError, extras, { copy: copyToClipboard, focus: focusKeepr });
  }

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
    el.dispatchEvent(new el.ownerDocument.defaultView.Event("scroll"));
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
      openConversation: openConversation,
      returnToList: returnToList,
      readImage: readImage,
      extract: root.KeeprExtract.extractConversation,
      scan: root.KeeprScan,
    };
  }

  async function start(jobId) {
    if (running) return;
    setRunning(true);
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
  (async function boot() {
    var jobId = hashJob || storedJob;
    if (!jobId) {
      var pending = await toWorker({ type: "keepr-check-pending" });
      jobId = pending && pending.ok && pending.body && pending.body.jobId ? pending.body.jobId : null;
    }
    if (!jobId) return;
    var route = await toWorker({ type: "keepr-job-found", jobId: jobId });
    if (route && route.handedOff) return;
    void start(jobId);
  })();
})(typeof globalThis !== "undefined" ? globalThis : this);
