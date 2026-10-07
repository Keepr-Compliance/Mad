/**
 * Keepr — Sync job runner (BACKLOG-3620).
 *
 * Keepr's Sync opens Messages for Web with `#keepr-job=<jobId>`. This script
 * (a content script, loaded after extract.js and scan.js) picks the job up,
 * checks the page is signed in, claims the job (a cache Sync — the only kind
 * since 2026-10-05), lists the chats newer than its floor, reads each one's
 * phone numbers from Details and asks Keepr whether to keep it. Kept chats are
 * extracted and sent, with their images; Keepr saves them when the job ends.
 *
 * `runJob` is testable: every page, network and timing effect comes in through
 * `env`. The chrome.* glue at the bottom runs only in the browser. All traffic
 * to Keepr goes through the service worker (the content script's own requests
 * would carry the messages.google.com origin and be refused).
 */
(function (root) {
  "use strict";

  var NOT_SIGNED_IN = "Sign in to Google Messages, then click Sync in Keepr again";
  /** Storyboard I01: the page box when Google Messages is not signed in. */
  var SIGN_IN_TITLE = "Sign in to Google Messages";
  var SIGN_IN_BEFORE = "Sign in or scan the QR code, then ";
  var SIGN_IN_AFTER = " in Keepr.";
  var JOB_HASH_RE = /(?:^#|&)keepr-job=([0-9a-fA-F-]{36})(?:&|$)/;
  /** Keepr's "Open Google Messages" on its link screen (see background.js routeLink). */
  var LINK_HASH_RE = /(?:^#|&)keepr-link(?:&|$)/;
  /** The hash without the keepr-link token ("" when nothing is left). */
  function withoutLinkHash(hash) {
    var rest = String(hash || "").replace(/^#/, "").split("&").filter(function (p) { return p && p !== "keepr-link"; });
    return rest.length ? "#" + rest.join("&") : "";
  }
  /** BACKLOG-3668 L1: the hash without the keepr-job token ("" when nothing is left). */
  function withoutJobHash(hash) {
    var rest = String(hash || "").replace(/^#/, "").split("&").filter(function (p) { return p && !/^keepr-job=/.test(p); });
    return rest.length ? "#" + rest.join("&") : "";
  }
  /** How long this tab waits to be signed in before it opens the link window itself. */
  var LINK_SIGNED_IN_WAIT_MS = 60000;
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
  /**
   * Live (founder 2026-10-03, 3671 P1): Keepr went away mid-run (closed or
   * restarted) and the page read on chat after chat, each one "error". Now a
   * lost Keepr ends the run at once with its reason (and Try again).
   */
  var KEEPR_LOST_MESSAGES = {
    unreachable: "Keepr closed.",
    unknown_job: "Keepr closed or restarted.",
    refused: "Not linked. Click the Keepr icon in Chrome's toolbar to link.",
    keepr_error: "Keepr could not save the chats.",
  };
  /**
   * SR U1 (storyboards H01 / H02): the ONE short line (≤ 45 chars) for each
   * failure code — the box's "Sync failed" card says this; the long text goes
   * to See details / Copy details. Keepr's bubble uses the same table
   * (src/components/settings/android/syncFailureLines.ts; a test keeps the
   * two identical).
   */
  var FAILURE_LINES = {
    connection_lost: "Lost the connection to your phone.",
    phone_unreachable: "Your phone isn't connected.",
    not_signed_in: "Google Messages isn't signed in.",
    page_gone: "The Messages tab was closed.",
    page_not_ready: "Google Messages didn't finish loading.",
    not_opened: "Google Messages didn't open.",
    list_not_reachable: "Couldn't open your conversation list.",
    details_stuck: "A chat's details panel didn't close.",
    all_failed: "None of the chats could be read.",
    keepr_error: "Keepr couldn't save the chats.",
    keepr_unreachable: "Keepr closed or restarted.",
    keepr_unknown_job: "Keepr closed or restarted.",
    keepr_refused: "This browser isn't linked.",
    finish_refused: "Keepr couldn't finish the Sync.",
    claim_refused: "Keepr couldn't start this Sync.",
    save_failed: "Keepr couldn't save this Sync.",
    scan_failed: "The Sync stopped unexpectedly.",
    pc_offline: "This computer is offline.",
    keepr_busy: "Keepr is busy. Try again.",
    google_unresponsive: "Google Messages stopped responding.",
  };
  var FAILURE_FALLBACK = "The Sync stopped unexpectedly.";
  /**
   * Live A/B (visible vs hidden tab): one compact timing line per chat —
   * milliseconds only, no names, numbers or text.
   */
  function timingLine(t, totalMs, hiddenMs) {
    var commitMs = t.commit || 0;
    return "  timing: total " + Math.round(totalMs) + "ms · details " + Math.round(t.details) + " · history " + Math.round(t.history) +
      " · settle " + Math.round(t.settle) + " · commit " + Math.round(commitMs) + " · hidden " + Math.round(Math.max(0, hiddenMs));
  }
  /** The chat's photos: count, total / max / p50 for reading and uploading (ms). */
  function photoTimingLine(t) {
    function stats(xs) {
      var sorted = xs.slice().sort(function (a, b) { return a - b; });
      var total = 0;
      for (var i = 0; i < sorted.length; i++) total += sorted[i];
      var p50 = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : 0;
      return "total " + Math.round(total) + " max " + Math.round(sorted.length ? sorted[sorted.length - 1] : 0) + " p50 " + Math.round(p50);
    }
    return "  photos: " + t.photoRead.length + " · read " + stats(t.photoRead) + " · upload " + stats(t.photoUpload);
  }
  /** An older Keepr asked for a per-transaction Sync (removed 2026-10-05). */
  var OLD_KEEPR_CLAIM = "Update Keepr, then Sync again.";
  function failureLine(code) {
    return (code && Object.prototype.hasOwnProperty.call(FAILURE_LINES, code) && FAILURE_LINES[code]) || FAILURE_FALLBACK;
  }

  /** A localhost blip: one more try after this long before Keepr counts as gone. */
  /** SR C5: on 429, wait (Keepr's retryAfterMs, at most a minute) and resend — up to this many times. */
  var RATE_LIMIT_MAX_WAITS = 30;
  var RATE_LIMIT_DEFAULT_WAIT_MS = 60000;
  /** SR (C5 review): all the 429 waits of ONE run together; past this the run fails as keepr_busy. */
  var RATE_LIMIT_RUN_BUDGET_MS = 5 * 60000;
  var KEEPR_BUSY_MESSAGE = "Keepr stopped: Keepr was too busy to take this Sync for 5 minutes. Sync again from Keepr in a moment.";
  /** SR: Keepr kept answering 429 past the run's wait budget. */
  function KeeprBusyError() {
    var err = new Error(KEEPR_BUSY_MESSAGE);
    err.keeprBusy = true;
    return err;
  }
  var TRANSPORT_RETRY_MS = 1500;
  /** Circuit breaker: this many chats IN A ROW refused by Keepr end the run. */
  var KEEPR_ERROR_CHATS_MAX = 3;
  /** Reasons a chat was not read because something failed (not a choice / an empty chat). */
  var FAILED_REASONS = { error: true, not_opened: true, messages_not_loaded: true, history_not_settled: true, details_timeout: true, phone_not_connected: true };

  /** The kind of transport failure a bridge reply is, or null. 410 (over / cancelled) is not one. */
  function transportKind(reply) {
    if (!reply || reply.status === 0) return "unreachable";
    if (reply.status === 401) return "refused";
    if (reply.status === 404 && reply.body && reply.body.error === "no_job") return "unknown_job";
    return null;
  }

  function KeeprLostError(kind) {
    var err = new Error(KEEPR_LOST_MESSAGES[kind] || KEEPR_LOST_MESSAGES.unreachable);
    err.keeprLost = kind;
    return err;
  }
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
   * BACKLOG-3668 L2: where a photo may be read from. Messages for Web shows a
   * message's images as blob: URLs of its own origin (extract.js
   * messageImages; the fixtures); Google's image host is allowed as well.
   * Anything else (another site, data:, http:) is never fetched.
   */
  var IMAGE_SRC_ALLOWED = [
    /^blob:https:\/\/messages\.google\.com\//i,
    /^https:\/\/(?:[a-z0-9-]+\.)*googleusercontent\.com\//i,
  ];
  function imageSrcAllowed(src) {
    var s = String(src || "");
    for (var i = 0; i < IMAGE_SRC_ALLOWED.length; i++) if (IMAGE_SRC_ALLOWED[i].test(s)) return true;
    return false;
  }

  /**
   * BACKLOG-3668 L2: read one photo, never more than `maxBytes` (default
   * RCS_MAX_PHOTO_BYTES): a Content-Length over it, or a body that grows past
   * it, stops the read → { tooLarge: true } (counted like any oversize photo).
   * An src off the allow-list or a failed response → null ("didn't load").
   * io: { fetch(src), toBase64(blob), maxBytes? }.
   */
  async function readImageCapped(src, io) {
    var max = typeof io.maxBytes === "number" ? io.maxBytes : RCS_MAX_PHOTO_BYTES;
    if (!imageSrcAllowed(src)) return null;
    var res = await io.fetch(src);
    if (!res || res.ok === false) return null;
    var header = function (name) {
      return res.headers && typeof res.headers.get === "function" ? res.headers.get(name) : null;
    };
    var declared = Number(header("content-length"));
    if (header("content-length") !== null && isFinite(declared) && declared > max) {
      try { if (res.body && typeof res.body.cancel === "function") await res.body.cancel(); } catch (_e) { /* dropped anyway */ }
      return { tooLarge: true };
    }
    var type = String(header("content-type") || "").split(";")[0].trim();
    var blob;
    if (res.body && typeof res.body.getReader === "function") {
      var reader = res.body.getReader();
      var chunks = [];
      var total = 0;
      for (;;) {
        var step = await reader.read();
        if (step.done) break;
        total += step.value ? step.value.byteLength : 0;
        if (total > max) {
          try { await reader.cancel(); } catch (_e) { /* dropped anyway */ }
          return { tooLarge: true };
        }
        chunks.push(step.value);
      }
      blob = new Blob(chunks, { type: type });
    } else {
      blob = await res.blob();
      if (blob.size > max) return { tooLarge: true };
    }
    return { mimeType: blob.type || type || "application/octet-stream", base64: await io.toBase64(blob) };
  }
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
  /** Live: the computer's own network is off (Google's "No internet connection"). */
  var OFFLINE_TEXT = "This computer is offline — waiting for the connection";
  var RCS_CONNECTION_LOST_MS = 5 * 60000;
  var CONNECTION_POLL_MS = 1000;
  /** Live: at least this many chats, all empty, nothing saved → the phone is not connected. */
  var EMPTY_RUN_MIN_CHATS = 2;
  var PHONE_EMPTY_TEXT = "Keepr stopped: Google Messages showed no messages in any chat — your phone isn't connected. Open Messages on your phone, then Try again.";
  var CONNECTION_LOST_TEXT = {
    connection_lost: "Keepr stopped: Messages for Web could not reconnect to your phone for 5 minutes. Check your phone, then sync again from Keepr.",
    phone_unreachable: "Keepr stopped: your phone wasn't reachable for 5 minutes. Open Messages on your phone, then Try again.",
    pc_offline: "Keepr stopped: this computer was offline for 5 minutes. Connect to the internet, then sync again from Keepr.",
  };
  /**
   * Live (2026-10-05): chats whose history stopped growing, back to back, for
   * this long in all — Google's backend stopped answering (no banner shown):
   * the run fails as google_unresponsive instead of waiting forever.
   */
  var RUN_NO_PROGRESS_MS = 5 * 60000;

  /**
   * Live A/B (2026-10-05): in a hidden tab Chrome clamps the page's timers to
   * about once a minute, so every 250 ms wait of a Sync took a minute. While a
   * user-started Sync runs, each wait is instead ONE message to the service
   * worker ("wake me in N ms"), answered from the worker's own timer — the
   * worker's timers are not throttled by the tab being hidden.
   *
   * Within Chrome's service-worker rules (developer.chrome.com/docs/
   * extensions/develop/concepts/service-workers/lifecycle; the MV3 migration
   * guide): a message keeps the worker alive only for the operation; each
   * request is short (≤ PACED_MAX_WAIT_MS, far under the 5-minute cap); no
   * port, no heartbeat; nothing at all when no Sync runs (the pacer exists
   * only inside a run and is stopped when it ends).
   *
   * The worker can be stopped at any time: a wait whose answer does not come
   * within 2 × N (+ PACED_GRACE_MS) — or whose message fails — ends on the
   * page's own timer instead; after PACED_MAX_FAILURES failures in a row the
   * run stops asking. A run longer than PACED_RUN_MAX_MS goes back to the
   * page's timers.
   */
  var PACED_MAX_WAIT_MS = 60000;
  var PACED_GRACE_MS = 1000;
  var PACED_MAX_FAILURES = 3;
  var PACED_RUN_MAX_MS = 3 * 60 * 60000;

  /**
   * io: { send(ms) → Promise<boolean> (true = the worker answered),
   *       localSleep(ms) → Promise, now() → ms }.
   * Returns { sleep(ms), stop(), stats() }.
   */
  function makePacedSleep(io) {
    var startedAt = io.now();
    var stopped = false;
    var failuresInRow = 0;
    var st = { paced: 0, fallbacks: 0, askedMs: 0, tookMs: 0 };
    function useWorker() {
      return !stopped && failuresInRow < PACED_MAX_FAILURES && io.now() - startedAt < PACED_RUN_MAX_MS;
    }
    function sleep(ms) {
      var wait = typeof ms === "number" && isFinite(ms) && ms > 0 ? ms : 0;
      if (!useWorker()) return io.localSleep(wait);
      var askMs = Math.min(wait, PACED_MAX_WAIT_MS);
      var askedAt = io.now();
      return new Promise(function (resolve) {
        var done = false;
        function finish(ok) {
          if (done) return;
          done = true;
          if (ok) {
            failuresInRow = 0;
            st.paced += 1;
            // The tick rate actually seen (SR: measured before relied on).
            st.askedMs += askMs;
            st.tookMs += Math.max(0, io.now() - askedAt);
            // A wait longer than one request: the rest, the same way.
            if (wait > askMs) { sleep(wait - askMs).then(resolve); return; }
            resolve();
          } else {
            failuresInRow += 1;
            st.fallbacks += 1;
            resolve();
          }
        }
        // The worker may be gone: the page's own timer ends this wait.
        io.localSleep(2 * askMs + PACED_GRACE_MS).then(function () { finish(false); });
        var asked;
        try { asked = io.send(askMs); } catch (_e) { asked = Promise.resolve(false); }
        Promise.resolve(asked).then(function (ok) {
          if (ok) finish(true);
          // A failed message: wait the time out locally (never a busy loop).
          else io.localSleep(askMs).then(function () { finish(false); });
        }, function () {
          io.localSleep(askMs).then(function () { finish(false); });
        });
      });
    }
    return {
      sleep: sleep,
      stop: function () { stopped = true; },
      stats: function () { return { paced: st.paced, fallbacks: st.fallbacks, askedMs: st.askedMs, tookMs: st.tookMs }; },
    };
  }
  var GOOGLE_UNRESPONSIVE_MESSAGE =
    "Keepr stopped: Google Messages stopped loading messages for 5 minutes. Check your connection, then sync again from Keepr.";
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
    phone_not_connected: "messages did not load — your phone wasn't connected",
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
  /** Founder: the Done box's one line for chats not fully synced ("" when none). */
  function notFullySyncedLine(n) {
    return n > 0 ? n + " chat" + (n === 1 ? "" : "s") + " not fully synced. Sync again to finish." : "";
  }
  /** The done box's title (the mockup); the counts go on the line below. */
  var DONE_TITLE = "Sync done";
  /** A cache Sync, between the last chat and Keepr's answer to /finish. */
  var SAVING_TEXT = "Saving in Keepr…";

  /**
   * The Details lines (BACKLOG-3641). `nameOf` renders a chat name: the name
   * itself on screen, a salted tag in the Copy text.
   *
   * @param {{listed: number, checked: number, matched: number, chats: number, messages: number,
   *          images: number, notChecked: number,
   *          removedByUser: number, notReached: Array<{name: string, reason: string, count?: number}>,
   *          notReachedMore: number}} s
   * @param {function(string): string} nameOf
   */
  function summaryLines(s, nameOf) {
    var lines = [cacheSavedLine(s)];
    var confirmedLine = historyConfirmedLine(s.historyConfirmed);
    if (confirmedLine) lines.push(confirmedLine);
    var depthLine = historyDepthLine(s.depth);
    if (depthLine) lines.push(depthLine);
    var extraLine = extraTimeLine(s.extraTime);
    if (extraLine) lines.push(extraLine);
    if (s.notChecked > 0) {
      lines.push("Not checked: " + s.notChecked + " chats (over this Sync's limit)");
    }
    // A count only: Keepr-only names never go into the page (SR B1).
    if (s.notSynced > 0) {
      lines.push(s.notSynced + " chat" + (s.notSynced === 1 ? "" : "s") + " not synced — switched off by you");
    }
    if (s.noMessagesYet > 0) {
      lines.push(s.noMessagesYet + " chat" + (s.noMessagesYet === 1 ? "" : "s") + " with no messages yet");
    }
    if (s.notText > 0) {
      lines.push(s.notText + " not a text conversation (e.g. an AI chat) — skipped");
    }
    if (s.shortCodes > 0) {
      lines.push(s.shortCodes + " short-code sender" + (s.shortCodes === 1 ? "" : "s") + " skipped (no phone number)");
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
  /** Storyboard A10 / A11: "20 chats · 412 messages (38 new) · 64 photos" (what Keepr saved). */
  function cacheSummaryLine(saved) {
    return plural(saved.chats, "chat", "chats") + " · " + plural(saved.messages, "message", "messages") +
      " (" + saved.newMessages + " new)" +
      (typeof saved.photos === "number" && saved.photos > 0 ? " · " + plural(saved.photos, "photo", "photos") : "");
  }

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

/**
   * Live (founder): which floor a chat read to — a deal's (earlier than the
   * months limit), the months limit, or (a delta Sync) the last Sync.
   */
  function floorKind(chatFloorMs, runFloorMs, monthsFloorMs) {
    if (chatFloorMs === null) return "months";
    if (monthsFloorMs !== null && chatFloorMs < monthsFloorMs) return "deal";
    if (runFloorMs !== null && monthsFloorMs !== null && chatFloorMs > monthsFloorMs) return "lastSync";
    return "months";
  }

  /** "History depth: …" — counts only (no dates, no names). */
  function historyDepthLine(d) {
    if (!d || d.limit + d.start + d.partial === 0) return null;
    var label = windowLabel(d.floorDays);
    var limit = label ? "the " + label + " limit" : "the months limit";
    // Live (founder): by the floor each chat actually used.
    var by = d.limitBy || { lastSync: 0, months: d.limit, deal: 0 };
    var reached = [];
    if (by.lastSync > 0) reached.push([by.lastSync, "reached the last Sync"]);
    if (by.months > 0) reached.push([by.months, "reached " + limit]);
    if (by.deal > 0) reached.push([by.deal, "read back to their deal"]);
    if (reached.length === 0) reached.push([0, "reached " + limit]);
    // The first count says "chats" (as before): "4 chats reached … · 2 reached …".
    var parts = reached.map(function (r, i) { return r[0] + (i === 0 ? " chats " : " ") + r[1]; });
    return "History depth: " + parts.join(" · ") + " · " + d.start + " reached the chat's start · " +
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
    var scanCounts = ["Checked " + s.checked + " · matched " + s.matched + " · sent " + s.chats + " chats / " + s.messages + " messages" +
        " / " + (s.reactions || 0) + " reactions" + (s.images > 0 ? " / " + s.images + " images" : "")];
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
        // Storyboard H07: the user stopped it here — "Sync stopped", Close.
        if (env.stoppedHere && env.stoppedHere()) {
          diag(env, "stopped: by the user on this page");
          env.overlay.show(STOPPED_TITLE, false, { stopped: true });
          return { outcome: "stopped" };
        }
        diag(env, "stopped: cancelled or replaced in Keepr");
        env.overlay.show(CANCELLED, true);
        return { outcome: "job_gone" };
      }
      // SR: Keepr kept refusing with 429 past the run's budget — a failure
      // Keepr records (it is reachable), with Try again on a cache Sync.
      if (err && err.keeprBusy) {
        diag(env, "stopped: Keepr busy (429 past the run's wait budget)");
        var busyExtras = { details: err.message };
        busyExtras.retry = true;
        env.overlay.show(failureLine("keepr_busy"), true, busyExtras);
        try {
          await env.api("POST", "/job/" + jobId + "/error", { code: "keepr_busy", message: err.message });
        } catch (_e) {
          /* Keepr is told when it can be; the page already says so. */
        }
        return { outcome: "keepr_busy" };
      }
      if (err && err.keeprLost) {
        diag(env, "stopped: Keepr lost (" + err.keeprLost + ")");
        // Try again reaches Keepr again (or launches it: the page's retry).
        // SR U1: the short line on the card, the long one in the details.
        var lostExtras = { details: err.message, copy: "Keepr Sync diagnostics: Keepr lost (" + err.keeprLost + ")." };
        lostExtras.retry = true;
        env.overlay.show(failureLine("keepr_" + err.keeprLost), true, lostExtras);
        return { outcome: "keepr_lost", reason: err.keeprLost };
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
      /** BACKLOG-3671 P2: the hidden time so far (nothing changes). */
      peek: function () {
        return { ms: t.ms + (since !== null ? Math.max(0, nowMs() - since) : 0), spells: t.spells };
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

    /**
     * Every job call. Keepr lost — unreachable (after one more try), an
     * unknown job (Keepr restarted), refused (401) — ends the run at once with
     * its reason; a job that is over (410, or a bare 404) ends it as cancelled.
     */
    var rateWaitedMs = 0;
    async function call(method, path, body) {
      var reply = await env.api(method, path, body);
      if (reply && reply.status === 0) {
        await env.sleep(TRANSPORT_RETRY_MS);
        reply = await env.api(method, path, body);
      }
      // SR C5: Keepr's rate limit (429) — wait for its window and send again;
      // never a failed chat for it. The run's waits share one budget: past
      // it, the run fails as keepr_busy (never waits forever).
      for (var waits = 0; reply && reply.status === 429 && waits < RATE_LIMIT_MAX_WAITS; waits++) {
        var after = reply.body && typeof reply.body.retryAfterMs === "number" ? reply.body.retryAfterMs : RATE_LIMIT_DEFAULT_WAIT_MS;
        var waitMs = Math.min(Math.max(after, 250), RATE_LIMIT_DEFAULT_WAIT_MS);
        if (rateWaitedMs + waitMs > RATE_LIMIT_RUN_BUDGET_MS) {
          throw KeeprBusyError();
        }
        rateWaitedMs += waitMs;
        await env.sleep(waitMs);
        reply = await env.api(method, path, body);
      }
      var kind = transportKind(reply);
      if (kind) {
        throw KeeprLostError(kind);
      }
      if (jobGone(reply)) throw JobGoneError();
      return reply;
    }
    /** Circuit breaker: chats in a row that Keepr refused (an HTTP error from /match or /chat). */
    var keeprErrorChats = 0;
    function keeprReplyError(reply, fallback) {
      var err = new Error(messageOf(reply, fallback));
      err.keeprReply = reply && reply.status ? reply.status : 0;
      return err;
    }
    var progress = { listed: 0, candidates: 0, checked: 0, skipped: 0, notChecked: 0 };
    var totals = { chats: 0, messages: 0, images: 0, reactions: 0, historyConfirmed: { marker: 0, first_page: 0, no_overflow: 0, date_floor: 0, none: 0 },
      depth: { limit: 0, start: 0, partial: 0, gaps: 0, gapsRecovered: 0, floorDays: null, limitBy: { lastSync: 0, months: 0, deal: 0 } }, removedByUser: 0, imagesNotKept: 0, notText: 0, noMessagesYet: 0, notSynced: 0, alreadySaved: 0, shortCodes: 0 };
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
      return "Chat " + n + " of " + of;
    }
    /**
     * Founder (live B3): the card shows the SAME thing in every phase — list
     * scan, opening a chat, loading history, images, matching, saving:
     * "Chat N of M" (or, before M is known, "Finding your chats"). The phase
     * itself goes to the step log only.
     */
    /** The run's state (P01–P03): phase, chats found, chat i of M, chats completed. */
    var run = { phase: "finding", found: 0, index: 0, total: 0, done: 0 };
    // BACKLOG-3671 P2 (telemetry; counts and ms only): phase times, each
    // chat's read time (summarised before it leaves), bytes read.
    var clock = function () { return (env.now ? env.now() : new Date()).getTime(); };
    /** Live (2026-10-05): see RUN_NO_PROGRESS_MS. */
    var noProgressRunMs = 0;
    /** Live A/B: the current chat's timings (see timingLine). */
    var chatTiming = null;
    var tm = { findingAt: null, readingAt: null, readEndAt: null, chatMs: [], bytesRead: 0, chatsFound: 0, chatsInRange: 0, chatsFailed: 0 };
    // Live A/B: the run's step totals (ms), summed from each chat's timings.
    var steps = { details: 0, history: 0, settle: 0, commit: 0, photoRead: 0, photoUpload: 0, photoReadMax: 0, photoUploadMax: 0 };
    function addSteps(t) {
      steps.details += t.details; steps.history += t.history; steps.settle += t.settle; steps.commit += t.commit;
      for (var r = 0; r < t.photoRead.length; r++) { steps.photoRead += t.photoRead[r]; steps.photoReadMax = Math.max(steps.photoReadMax, t.photoRead[r]); }
      for (var u = 0; u < t.photoUpload.length; u++) { steps.photoUpload += t.photoUpload[u]; steps.photoUploadMax = Math.max(steps.photoUploadMax, t.photoUpload[u]); }
    }
    var chromeVersion = null;
    function runMetrics() {
      var now = clock();
      var findingEnd = tm.readingAt !== null ? tm.readingAt : now;
      var readingEnd = tm.readEndAt !== null ? tm.readEndAt : now;
      var hiddenSoFar = hiddenStats && hiddenStats.peek ? hiddenStats.peek() : null;
      var stats = perChatStats(tm.chatMs);
      return {
        finding: tm.findingAt === null ? {} : {
          ms: Math.max(0, findingEnd - tm.findingAt), chatsFound: tm.chatsFound, chatsInRange: tm.chatsInRange,
          chatsSkippedHidden: progress.notChecked + totals.notText, chatsSkippedDisabled: totals.notSynced,
        },
        reading: tm.readingAt === null ? {} : {
          ms: Math.max(0, readingEnd - tm.readingAt), chatsRead: totals.chats, chatsSkipped: progress.skipped,
          chatsFailed: tm.chatsFailed, chatsAlreadySaved: totals.alreadySaved, messagesRead: totals.messages,
          photosRead: media.photos.seen, bytesRead: tm.bytesRead,
          perChatP50Ms: stats.perChatP50Ms, perChatP90Ms: stats.perChatP90Ms, perChatSlowestMs: stats.perChatSlowestMs,
          // Live (0.3.57): chats_read 5 vs a count of 15 read as a contradiction.
          // chatsRead = chats whose messages were SENT to Keepr this run (≥ 1
          // message); chatsOpened = chats the run opened and finished with
          // (read, no messages, skipped, failed or already saved) — the
          // per-chat times are over these. chatsOpened ≥ chatsRead.
          chatsOpened: stats.perChatCount,
          // SR: chats that came back empty, and whether the phone was gone partway.
          // (Both are set late in the run: an early failure reports 0 / false.)
          emptyChats: emptyChats ? emptyChats.length : 0,
          phoneDisconnected: typeof phoneDisconnected === "boolean" ? phoneDisconnected : false,
          detailsMs: steps.details, historyMs: steps.history, settleMs: steps.settle, commitMs: steps.commit,
          photoReadMs: steps.photoRead, photoUploadMs: steps.photoUpload,
          photoReadMaxMs: steps.photoReadMax, photoUploadMaxMs: steps.photoUploadMax,
        },
        hidden: hiddenSoFar ? { ms: hiddenSoFar.ms, spells: hiddenSoFar.spells } : undefined,
        chromeVersion: chromeVersion || undefined,
      };
    }
    if (typeof env.setRunMetrics === "function") env.setRunMetrics(runMetrics);
    function runExtras() {
      return { cancel: true, retrying: !!RUNNING_EXTRAS.retrying, run: { phase: run.phase, found: run.found, index: run.index, total: run.total, done: run.done } };
    }
    function runningText() {
      return statusLine(run, !!RUNNING_EXTRAS.retrying);
    }
    /** One phase of the run: logged; the card shows the run's state. */
    function showPhase(phase) {
      if (phase) log("phase: " + phase);
      env.overlay.show(runningText(), false, runExtras());
    }
    // Founder (2026-10-03): a hidden tab no longer pauses the run (it was
    // observed to sync on fine); it is only counted.
    var hiddenStats = hiddenTracker(env);
    var pauses = 0;
    var connectionLostMs = env.connectionLostMs == null ? RCS_CONNECTION_LOST_MS : env.connectionLostMs;
    /** Telemetry (counts and ms only): each banner kind's occurrences and time. */
    var connection = {
      connecting: { count: 0, ms: 0 }, phone_unreachable: { count: 0, ms: 0 }, connection_banner: { count: 0, ms: 0 },
      pc_offline: { count: 0, ms: 0 },
    };
    /** The waiting line for a banner kind. */
    function bannerText(kind) {
      return kind === "phone_unreachable" ? UNREACHABLE_TEXT : kind === "pc_offline" ? OFFLINE_TEXT : CONNECTING_TEXT;
    }
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
      // SR: `waited` restarts each time the banner clears, so a FLAPPING
      // banner never reached the limit (and the pre-finish check could hang):
      // the time held across this whole call is capped too.
      var totalHeld = 0;
      var totalLimit = 2 * connectionLostMs;
      for (;;) {
        var banner = bannerNow();
        if (!banner) break;
        held = true;
        var kind = banner.kind;
        var waited = 0;
        connection[kind].count += 1;
        log("connection banner: " + kind + (kind === "connection_banner" ? " (title " + banner.titleLength + " chars)" : "") +
          (banner.where ? " (" + banner.where + ")" : ""));
        pauses += 1;
        await report(bannerText(kind));
        while (banner) {
          if (waited >= connectionLostMs || totalHeld >= totalLimit) {
            var code = kind === "phone_unreachable" ? "phone_unreachable" : kind === "pc_offline" ? "pc_offline" : "connection_lost";
            log("connection banner for " + Math.round(waited / 1000) + "s: " + code);
            return { code: code, message: CONNECTION_LOST_TEXT[code] };
          }
          await env.sleep(CONNECTION_POLL_MS);
          waited += CONNECTION_POLL_MS;
          totalHeld += CONNECTION_POLL_MS;
          connection[kind].ms += CONNECTION_POLL_MS;
          banner = bannerNow();
          if (banner && banner.kind !== kind) {
            kind = banner.kind;
            connection[kind].count += 1;
            log("connection banner: " + kind);
            await report(bannerText(kind));
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
        var readAt = clock();
        var img = await env.readImage(src);
        if (chatTiming) chatTiming.photoRead.push(clock() - readAt);
        // BACKLOG-3668 L2: stopped at the size cap before it was read in full.
        if (img && img.tooLarge) return "tooLarge";
        if (!img || !/^image\//.test(img.mimeType)) return "readFailed";
        if (typeof img.base64 === "string" && Math.floor(img.base64.length * 3 / 4) > RCS_MAX_PHOTO_BYTES) return "tooLarge";
        var uploadAt = clock();
        var up = await call("POST", base + "/attachment", {
          conversationId: conv.conversationId, msgId: msgId, index: index, mimeType: img.mimeType, base64: img.base64,
        });
        if (chatTiming) chatTiming.photoUpload.push(clock() - uploadAt);
        if (up.ok) {
          totals.images += 1;
          tm.bytesRead += Math.floor(img.base64.length * 3 / 4);
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
        if (imgErr && (imgErr.jobGone || imgErr.keeprBusy)) throw imgErr;
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
            imagePass: true, sleep: env.sleep, now: function () { return (env.now ? env.now() : new Date()).getTime(); },
            floorMs: typeof item.oldestMs === "number" ? item.oldestMs - 1 : item.floorMs,
            budgetMs: Math.max(1000, Math.min(60000, poolMs - used)), extensionPoolLeftMs: 0,
            extractBatch: function () { return env.extract(env.doc, loc.href, env.now ? env.now() : new Date()).messages; },
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
          if (err && (err.jobGone || err.keeprBusy)) throw err;
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
      // The phone's banner (paused): its own card; anything else: the run's.
      if (stage === PAUSED_TEXT || stage === CONNECTING_TEXT || stage === UNREACHABLE_TEXT || stage === OFFLINE_TEXT) env.overlay.show(stage, false, RUNNING_EXTRAS);
      else env.overlay.show(runningText(), false, runExtras());
      await call("POST", base + "/progress", {
        // Keepr shows the same user line (its own screens and the dashboard).
        stage: runningText(),
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
        removedByUser: totals.removedByUser,
        imagesNotKept: totals.imagesNotKept,
        notText: totals.notText,
        shortCodes: totals.shortCodes,
        noMessagesYet: totals.noMessagesYet,
        notSynced: totals.notSynced,
        notReached: reported,
        notReachedMore: notReached.length - reported.length,
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
      var detailsLines = detailsText(s);
      // Founder: chats really not fully synced (a failure, or history that did
      // not reach the floor / has a gap) — one line in the Done box.
      var incomplete = Object.keys(entriesByConv).filter(function (id) {
        return (entriesByConv[id] || []).some(function (e) { return FAILED_REASONS[e.reason] === true || e.reason === "history_gap"; });
      }).length;
      // The done box's line (storyboard A10): "20 chats · 412 messages (38 new) · 64 photos".
      return { notFullyLine: notFullySyncedLine(incomplete), details: detailsLines, summary: s.saved && typeof s.saved === "object" ? cacheSummaryLine(s.saved) : String(detailsLines).split("\n")[0], copy: copyText(s, tags, logLines, version), version: version };
    }

    async function fail(code, message) {
      log("failed: " + code);
      var failExtras = await overlayExtras();
      // C5 (founder): a cache Sync that failed for real says "Sync failed"
      // and offers Try again (Keepr saved the chats it finished).
      failExtras.retry = true;
      // SR U1: the card says one short line; the long text is in the details.
      failExtras.details = message + (failExtras.details ? "\n\n" + failExtras.details : "");
      env.overlay.show(failureLine(code), true, failExtras);
      await env.api("POST", base + "/error", { code: code, message: message, metrics: runMetrics() });
      return { outcome: code };
    }

    // 1. Signed in? (founder decision: no waiting for sign-in, no auto-resume)
    log("stage: job found, waiting for Messages for Web");
    var pageState = await waitForPageState(env, env.pageTimeoutMs == null ? 20000 : env.pageTimeoutMs);
    log("page: " + pageState);
    if (pageState === "not_signed_in") {
      // Storyboard I01: its own card (Keepr still records the failure).
      log("failed: not_signed_in");
      // (Copy details still carries the diagnostics and the version.)
      env.overlay.show(SIGN_IN_TITLE, false, Object.assign(await overlayExtras(), { signIn: true }));
      await env.api("POST", base + "/error", { code: "not_signed_in", message: NOT_SIGNED_IN });
      return { outcome: "not_signed_in" };
    }
    if (pageState !== "ready") {
      return fail("page_not_ready", "Messages for Web did not finish loading. Click Sync in Keepr again.");
    }

    // 2. Claim: contact names only.
    // The claim keeps its own message (already running / over) for the overlay.
    // POST (BACKLOG-3628): Chrome on Windows sends a worker GET without Origin.
    var claim = await env.api("POST", base + "/claim");
    if (!claim.ok) {
      log("claim refused: HTTP " + claim.status);
      // SR: the card's short line; Keepr's own words go to the details.
      var refusedExtras = await overlayExtras();
      var refusedText = messageOf(claim, "Keepr refused this sync.");
      refusedExtras.details = refusedText + (refusedExtras.details ? "\n\n" + refusedExtras.details : "");
      env.overlay.show(failureLine("claim_refused"), true, refusedExtras);
      return { outcome: "claim_refused" };
    }
    // Founder (2026-10-05): the cache Sync is the only kind (the per-
    // transaction Sync was removed). An older Keepr's transaction claim is
    // refused with a clear line, never run.
    if (!(claim.body && claim.body.kind === "cache")) {
      log("claim refused: not a cache Sync (update Keepr)");
      var oldExtras = await overlayExtras();
      oldExtras.details = OLD_KEEPR_CLAIM + (oldExtras.details ? "\n\n" + oldExtras.details : "");
      env.overlay.show(failureLine("claim_refused"), true, oldExtras);
      return { outcome: "claim_refused" };
    }
    log("claimed");
    // BACKLOG-3658: every chat, history back to `since`.
    if (typeof env.chromeVersion === "function") {
      try {
        chromeVersion = await env.chromeVersion();
      } catch (_e) {
        chromeVersion = null;
      }
    }
    // Storyboard H03: a Try again run says "skipping saved chats".
    if (claim.body.retrying === true) RUNNING_EXTRAS.retrying = true;
    var floorSource = claim.body.since;
    var floorMs = typeof floorSource === "string" ? Date.parse(floorSource) : NaN;
    if (!isFinite(floorMs)) floorMs = null;
    // Live (0.3.15): chats switched back on — read to the FULL floor even with
    // no new message (Keepr clears them once saved). Conversation ids only.
    var pendingFull = {};
    var pendingIds = Array.isArray(claim.body.pendingConversationIds) ? claim.body.pendingConversationIds : [];
    for (var pf = 0; pf < pendingIds.length; pf++) if (typeof pendingIds[pf] === "string") pendingFull[pendingIds[pf]] = true;
    var fullFloorMs = typeof claim.body.floor === "string" ? Date.parse(claim.body.floor) : NaN;
    if (!isFinite(fullFloorMs)) fullFloorMs = floorMs;
    // SR (2026-10-02): chats on a live deal Keepr wants read back to the deal's
    // start — the list scan looks for them past the settings floor, never past
    // the oldest deal start. Conversation ids only; each chat's own floor
    // comes from /match.
    var dealIds = [];
    var dealSet = {};
    var dealFloorMs = typeof claim.body.dealFloor === "string" ? Date.parse(claim.body.dealFloor) : NaN;
    if (Array.isArray(claim.body.dealConversationIds) && isFinite(dealFloorMs)) {
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
    showPhase("Loading your conversation list…");
    tm.findingAt = clock();
    /** P01: the list scan's count ("N so far"), shown at most every half second. */
    var foundShownAt = 0;
    function onFound(n) {
      run.found = n;
      var t = Date.now();
      if (t - foundShownAt < 500) return;
      foundShownAt = t;
      showPhase(null);
    }
    if (env.returnToList && !(await env.returnToList())) {
      // No list, no scan: say so instead of "Done — imported 0 chats".
      return fail("list_not_reachable", LIST_NOT_REACHABLE);
    }
    log("stage: loading the conversation list");
    // No env.scroll in the browser: collectConversations drives the page's own
    // scroller (top first, then step down with scroll events).
    var lostList = await holdWhileOffline("Loading your conversation list…");
    if (lostList && lostList.code) return fail(lostList.code, lostList.message);
    var collected = await env.scan.collectConversations(env.doc, {
      scroll: env.scroll, sleep: env.sleep, stopAtOlderThanMs: floorMs, maxItems: CACHE_LIST_MAX, onFound: onFound,
      mustSee: pendingIds, mustSeeFloorMs: fullFloorMs,
      mustSeeDeep: dealIds, mustSeeDeepFloorMs: dealFloorMs,
    });
    // BACKLOG-3658: every chat newer than `since` is checked in list order (no
    // names), at most CACHE_CHECK_MAX; the rest are reported as not checked.
    var plan = cachePlan(collected.conversations, floorMs, pendingFull, dealSet);
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
    // P02: reading — chat i of M; the bar counts the chats completed.
    run.phase = "reading";
    tm.readingAt = clock();
    tm.chatsFound = collected.conversations.length;
    tm.chatsInRange = candidates.length;
    run.total = candidates.length;
    run.index = candidates.length > 0 ? 1 : 0;
    // Chats, not contacts (founder): "Chat i of N" (the step log).
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
    /** SR: chats that came back empty (in order), and the run of them since the last saved chat. */
    var emptyChats = [];
    var trailingEmpty = [];
    /**
     * Live (founder, 0.3.80): a chat's oldest message sent this run (ms), by
     * conversation. A retry that reads LESS far back than an earlier attempt
     * must not claim the chat's start (its "no_more" is not believed).
     */
    var oldestSentByConv = {};
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
      var chatAt = clock();
      // Live A/B (visible vs hidden tab): this chat's timings (ms, counts only).
      chatTiming = { details: 0, history: 0, settle: 0, commit: 0, photoRead: [], photoUpload: [], hiddenAt: hiddenStats.peek().ms };
      run.index = i + 1;
      var lostChat = await holdWhileOffline(stageText(i + 1, candidates.length));
      if (lostChat && lostChat.code) return fail(lostChat.code, lostChat.message);
      try {
        // Live (2026-10-05): Keepr's card follows each chat too (it showed the
        // first chat's line while a later one loaded only its first page).
        await report(stageText(i + 1, candidates.length));
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
        var detailsAt = clock();
        var numbers = await env.scan.readParticipantsAndClose(env.doc, { click: env.click, sleep: env.sleep });
        chatTiming.details = clock() - detailsAt;
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
          if (why === "short_code") {
            // Live (founder): a short-code sender is skipped on purpose — its
            // own line, never "Not fully imported" (nor counted as such).
            totals.shortCodes += 1;
            log("  skipped: short-code sender");
            continue;
          }
          leaveOut(conv, why);
          // Details timed out: a transient failure, retried once at the end.
          if (numbers && numbers.kind === "no_details") noteTransient(conv, "details_timeout");
          continue;
        }
        var match = await call("POST", base + "/match", { conversationId: conv.conversationId, numbers: numbers });
        if (!match.ok) throw keeprReplyError(match, "Keepr could not check this chat.");
        var isMatch = !!(match.body && match.body.matched);
        // Keepr says whether it keeps this chat's images (only for chats with
        // a transaction contact, unless "all chats" is on).
        var keepPhotos = !!(match.body && (match.body.keepPhotos !== undefined ? match.body.keepPhotos : match.body.keepImages));
        var keepVideos = !!(match.body && match.body.keepVideos);
        // SR (2026-10-02): a chat on a live deal is read back to Keepr's floor
        // for it (/match floorMs); every other chat keeps the job's floor.
        var chatFloorMs = pendingFull[conv.conversationId] ? fullFloorMs : floorMs;
        if (match.body && typeof match.body.floorMs === "number" && isFinite(match.body.floorMs)) {
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
        if (match.body && match.body.skip === true) {
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
          // SR: kept in order — a trailing run of these may be the phone gone.
          emptyChats.push(conv);
          trailingEmpty.push(conv);
          log("  no messages yet");
          continue;
        }
        if (!ready) {
          progress.skipped += 1;
          skips.push({ conversationId: conv.conversationId, reason: MESSAGES_NOT_LOADED });
          leaveOut(conv, MESSAGES_NOT_LOADED);
          showPhase("Skipped a chat: its messages did not load");
          continue;
        }
        // Only the latest messages render on open: load older ones back past
        // the floor, then let the set settle.
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
          // Live (2026-10-05): the budgets also run on the wall clock.
          now: clock,
          floorMs: chatFloorMs,
          cap: env.historyCap,
          noNewTimeoutMs: env.historyNoNewMs,
          onProgress: function (n) {
            showPhase("Loading history… " + n + " messages");
          },
          // Tell Keepr after each scroll: a cancelled job answers 404/410 and
          // call() throws, so the load ends instead of running to the cap.
          checkpoint: function (n) {
            return call("POST", base + "/progress", {
              stage: runningText(),
              historyLoaded: n,
              listed: progress.listed,
              candidates: progress.candidates,
              checked: progress.checked,
              skipped: progress.skipped,
            });
          },
        };
        var histHidden = hiddenStats.hidden();
        var historyAt = clock();
        var hist = await env.scan.loadHistory(env.doc, histIo);
        chatTiming.history = clock() - historyAt;
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
        // Live (2026-10-05): the time Google's side has given nothing, across
        // chats. SR F1: only chats that ended STALLED (noProgress / not_settled)
        // add their idle time; a chat that loaded a batch restarts the count
        // (from its own trailing idle); a chat that confirmed its start
        // (no_more, date_floor, cap) clears it — short healthy chats never add up.
        var stalledChat = !!hist.noProgress || hist.stopReason === "not_settled";
        if (!stalledChat) noProgressRunMs = 0;
        else noProgressRunMs = ((hist.batches || 0) > 0 ? 0 : noProgressRunMs) + (hist.idleMs || 0);
        if (hist.noProgress) log("  history stopped growing for " + Math.round((hist.idleMs || 0) / 1000) + "s");
        if (noProgressRunMs >= RUN_NO_PROGRESS_MS) {
          log("  stopped: no new messages from Google for " + Math.round(noProgressRunMs / 1000) + "s");
          return fail("google_unresponsive", GOOGLE_UNRESPONSIVE_MESSAGE);
        }
        var settleAt = clock();
        var settled = await env.scan.waitForMessageSwap(env.doc, "", {
          sleep: env.sleep,
          timeoutMs: env.messagesTimeoutMs,
          stableMs: env.messagesStableMs,
        });
        chatTiming.settle = clock() - settleAt;
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
        var attemptOldest = null;
        for (var ao = 0; ao < messages.length; ao++) {
          var at = Date.parse(messages[ao].sentAt);
          if (isFinite(at) && (attemptOldest === null || at < attemptOldest)) attemptOldest = at;
        }
        var earlierOldest = oldestSentByConv[conv.conversationId];
        if (earlierOldest !== undefined && depthKind(hist) !== "partial" && (attemptOldest === null || attemptOldest > earlierOldest)) {
          // Keepr keeps every message of both attempts (staged by message id);
          // what this attempt may not do is say the chat is complete.
          log("  retry read less far back than before: not marked complete");
          hist = Object.assign({}, hist, { stopReason: "not_settled", readLess: true });
        }
        if (attemptOldest !== null && (earlierOldest === undefined || attemptOldest < earlierOldest)) oldestSentByConv[conv.conversationId] = attemptOldest;
        var commitAt = clock();
        var sent = await call("POST", base + "/chat", {
          conversationId: conv.conversationId,
          title: extracted.title || conv.name,
          messages: messages,
          participants: people,
          // Read down to its floor (not cut by the cap, not unsettled, no gap): a boolean.
          reachedFloor: depthKind(hist) !== "partial",
        });
        chatTiming.commit = clock() - commitAt;
        if (!sent.ok) throw keeprReplyError(sent, "Keepr could not save this chat.");
        keeprErrorChats = 0;
        // A chat with messages: the phone was there up to here.
        trailingEmpty = [];
        var prevSent = sentMessages[conv.conversationId];
        if (prevSent === undefined) totals.chats += 1;
        totals.messages += Math.max(0, messages.length - (prevSent || 0));
        sentMessages[conv.conversationId] = Math.max(prevSent || 0, messages.length);
        // BACKLOG-3642: Keepr may say how many rows it did not re-add.
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
        // Live (founder): the floor THIS chat used (a delta Sync reads to the
        // last Sync; a chat switched back on to the months limit; a deal chat
        // back to its deal) — the log and the depth line say which.
        var floorDays = chatFloorMs === null ? null : Math.round((nowMs - chatFloorMs) / DAY_MS);
        if (prevSent === undefined) {
          totals.depth[depthKind(hist)] += 1;
          if (depthKind(hist) === "limit") totals.depth.limitBy[floorKind(chatFloorMs, floorMs, fullFloorMs)] += 1;
        }
        // The months limit, for the depth line's wording.
        totals.depth.floorDays = fullFloorMs === null ? null : Math.round((nowMs - fullFloorMs) / DAY_MS);
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
        if (err && (err.jobGone || err.keeprLost || err.keeprBusy)) {
          gone = true;
          throw err;
        }
        if (err && err.keeprReply) {
          keeprErrorChats += 1;
          if (keeprErrorChats >= KEEPR_ERROR_CHATS_MAX) {
            log("  stopped: " + keeprErrorChats + " chats in a row refused by Keepr (HTTP " + err.keeprReply + ")");
            return fail("keepr_error", KEEPR_LOST_MESSAGES.keepr_error);
          }
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
        // P02: a chat finished (read, skipped or failed) — the bar advances, never back.
        if (item.attempt === 0) run.done = Math.min(run.total, run.done + 1);
        if (item.attempt === 0 && !gone) tm.chatMs.push(Math.max(0, clock() - chatAt));
        log(timingLine(chatTiming, clock() - chatAt, hiddenStats.peek().ms - chatTiming.hiddenAt));
        if (chatTiming.photoRead.length > 0) log(photoTimingLine(chatTiming));
        addSteps(chatTiming);
        chatTiming = null;
      }
      // Also the cancel check between chats: a job Keepr dropped answers 404/410.
      if (i + 1 < candidates.length) run.index = i + 2;
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
    // SR (on f9dec047c): the phone gone PARTWAY — some chats saved, then the
    // rest came back empty (the banner not recognised) — must not finish as
    // complete. A trailing run of ≥ EMPTY_RUN_MIN_CHATS empty chats, or a
    // connection banner seen at any point: those empty chats are "not fully
    // synced" (the Done line), and Keepr is told (phoneDisconnected) not to
    // move "last synced" or the coverage. One genuinely empty chat stays
    // "no messages yet". (All empty with nothing saved: the backstop below.)
    var bannerSeen = connection.phone_unreachable.count + connection.connecting.count + connection.connection_banner.count + connection.pc_offline.count > 0;
    // SR: a brief banner with every chat read fine is a blip — only a banner
    // WITH empty chats (or a trailing run of them) counts.
    var phoneDisconnected = totals.chats > 0 && (trailingEmpty.length >= EMPTY_RUN_MIN_CHATS || (bannerSeen && emptyChats.length > 0));
    if (phoneDisconnected) {
      var unsure = bannerSeen ? emptyChats : trailingEmpty;
      log("phone gone partway: " + unsure.length + " empty chats not fully synced" + (bannerSeen ? " (a connection banner was seen)" : ""));
      for (var ue = 0; ue < unsure.length; ue++) {
        totals.noMessagesYet -= 1;
        leaveOut(unsure[ue], "phone_not_connected");
      }
    }
    // 5. Done: Keepr brings itself forward. Every chat left out (or imported
    // in part) is named here and on the page — never a silent skip.
    var reported = notReached.slice(0, NOT_REACHED_CAP);
    var more = notReached.length - reported.length;
    // Live (founder): EVERY checked chat failed (none imported) → the run
    // failed, never "done". A partial success stays done, with its list.
    var failedChats = Object.keys(entriesByConv).filter(function (id) {
      return (entriesByConv[id] || []).some(function (e) { return FAILED_REASONS[e.reason] === true; });
    }).length;
    tm.chatsFailed = failedChats;
    tm.readEndAt = clock();
    // Live (2026-10-04): never "Sync done" while the page says it is offline
    // or disconnected — wait it out (the same grace), else fail with its code.
    var lostAtEnd = await holdWhileOffline(null);
    if (lostAtEnd && lostAtEnd.code) return fail(lostAtEnd.code, lostAtEnd.message);
    // Live (founder, 2026-10-05): the phone was unreachable but no banner was
    // seen; every chat opened came back empty and the run said "Done · 0
    // chats". Several chats, all empty, nothing saved: the page has no data —
    // the phone is not connected. Never Done; Keepr records nothing.
    var openedForMessages = matchedCount - totals.alreadySaved;
    if (totals.chats === 0 && totals.noMessagesYet >= EMPTY_RUN_MIN_CHATS && totals.noMessagesYet >= openedForMessages) {
      log("failed: every chat opened was empty (" + totals.noMessagesYet + "): the phone is not connected");
      return fail("phone_unreachable", PHONE_EMPTY_TEXT);
    }
    if (totals.chats === 0 && failedChats > 0 && failedChats >= progress.checked) {
      log("failed: every checked chat failed (" + failedChats + ")");
      return fail("all_failed", "None of the " + failedChats + " chats could be read.");
    }
    // A cache Sync: Keepr answers once it has saved, with what it saved.
    // P03: committing to Keepr.
    run.phase = "saving";
    showPhase(SAVING_TEXT);
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
      // SR: the phone was gone at some point — Keepr moves neither "last
      // synced" nor the coverage.
      phoneDisconnected: phoneDisconnected,
      // BACKLOG-3671 P2: the run's numbers (counts, ms, Chrome's version only).
      metrics: runMetrics(),
    });
    if (!finished || !finished.ok) {
      return fail("finish_refused", messageOf(finished, "Keepr could not finish this Sync."));
    }
    if (finished.body && Object.prototype.hasOwnProperty.call(finished.body, "saved")) {
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

  var SEE_DETAILS = "See details";
  var HIDE_DETAILS = "Hide details";
  /** BACKLOG-3658 security H1: a Sync Keepr did not open in this tab asks first. */
  var ASK_TITLE = "Keepr wants to sync your texts";
  var ASK_TEXT = "Keepr asked to copy your recent Google Messages texts into the Keepr app on this computer.";
  var PAUSED_TITLE = "Sync paused";
  /** Founder (2026-10-02): the page's stop, with an inline confirm. */
  var STOP_SYNC_LABEL = "Stop sync";
  var STOP_SYNC_QUESTION = "Stop the sync? Nothing from this run will be saved.";
  /** The mockup's confirm: the question as the title, the consequence below. */
  var STOP_SYNC_TITLE = "Stop the sync?";
  var STOP_SYNC_BODY = "Nothing from this run will be saved.";
  /** Storyboard H07: after the user stopped it. */
  var STOPPED_TITLE = "Sync stopped";
  var STOPPED_BODY = "Nothing from this run was saved.";
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
  /** Founder (P01): the list scan. */
  var FINDING_TEXT = "Finding your chats";
  /** Founder (P03): committing to Keepr. */
  var SAVING_LINE = "Saving to Keepr";
  /** Founder (B03): the card's amber warning, every phase. */
  var DONT_CLICK_LINE = "Don't click in this tab. Use another Chrome window.";
  /** Storyboard H03: a Try again run. */
  var RETRY_CHIP_HINT = "skipping saved chats";
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
  /** Founder (BoxNotLinked): the not-linked guide on the page. */
  var GUIDE_TITLE = "Link with Keepr";
  /** SR (D02 storyboard): the card's heading; the button says Link with Keepr. */
  var GUIDE_HEADING = "Link this browser";
  /**
   * Founder (live 0.3.57): the guide card opens at the TOP CENTRE (top 16px)
   * — never pinned top-right over Google's account / menu buttons — and is
   * draggable anywhere by its brand mark; its place is remembered.
   */
  var GUIDE_TOP = 16;
  /** C3: an unanswered "Stop the sync?" closes itself after this long (the sync never pauses). */
  var STOP_CONFIRM_AUTO_CLOSE_MS = 10000;
  /** C5 (founder): a real failure of a cache Sync — "Sync failed · Try again". */
  var SYNC_FAILED_TITLE = "Sync failed";
  var TRY_AGAIN_LABEL = "Try again";
  var PAGE_GONE_MESSAGE = "The Google Messages tab was closed.";

  // Keepr brand: the founder-approved box mockups (Box*.dc.html, 2026-10-03),
  // light and dark (the dark ones: #2D2E31 card, #E8EAED text, #6D5DF0 brand).
  // Every text/background pair is >= 4.5:1.
  var PALETTE = {
    light: {
      card: "#FFFFFF", border: "#D6D9E4", doneBorder: "#C7D2FE", warnBorder: "#FCD9A8",
      text: "#1F2433", body: "#374151", muted: "#4B5163", link: "#4F46E5",
      primary: "#4F46E5", primaryHover: "#4338CA", danger: "#B42318", dangerHover: "#912018",
      secondaryBg: "#FFFFFF", secondaryBorder: "#CDD1DE", secondaryText: "#1F2433",
      track: "#E5E7EB", fill: "#4F46E5", ok: "#15803D", warn: "#B45309",
      shadow: "0 8px 24px rgba(31,36,51,0.18)",
      guideShadow: "0 8px 24px rgba(31,36,51,0.18)",
      stoppedBadge: "#6B7280",
      warnText: "#92400E",
      tab: "linear-gradient(135deg, #4F46E5, #6D5DF0)", tabShadow: "0 4px 12px rgba(31,36,51,0.25)",
      tipBg: "#1F2433", tipText: "#FFFFFF",
      detailsBg: "#F9FAFB", detailsBorder: "#E5E7EB",
    },
    dark: {
      card: "#2D2E31", border: "#44464C", doneBorder: "#4F46E5", warnBorder: "#8A6A2F",
      text: "#E8EAED", body: "#E8EAED", muted: "#BDC1C6", link: "#8B80F5",
      primary: "#6D5DF0", primaryHover: "#5B4BE0", danger: "#B42318", dangerHover: "#912018",
      secondaryBg: "#2D2E31", secondaryBorder: "#5F6368", secondaryText: "#E8EAED",
      track: "#44464C", fill: "#8B80F5", ok: "#15803D", warn: "#B45309",
      shadow: "0 8px 24px rgba(0,0,0,0.5)",
      guideShadow: "0 8px 24px rgba(0,0,0,0.5)",
      stoppedBadge: "#5F6368",
      warnText: "#FDD663",
      tab: "#6D5DF0", tabShadow: "0 4px 12px rgba(0,0,0,0.5)",
      tipBg: "#E8EAED", tipText: "#202124",
      detailsBg: "#202124", detailsBorder: "#44464C",
    },
  };
  /** The mockups' button sizes (the box's small buttons). */
  var BOX_BUTTON = { minHeight: "36px", padding: "0 14px", borderRadius: "8px", fontSize: "13px" };
  /** The mockups' card: 320 wide, padding 16, gap 12, radius 16. */
  var CARD_WIDTH = "320px";

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

  var SVG_NS = "http://www.w3.org/2000/svg";
  var markIds = 0;

  /**
   * Founder (2026-10-03): the Keepr brand mark (android-companion BrandMark:
   * rounded square, #4F46E5 → #6D5DF0, white K, #F5A524 dot), drawn as SVG
   * nodes — the same in light and dark. `bare`: the K and the dot only (on
   * the idle tab, whose own background is the brand colour).
   */
  function brandMark(doc, size, bare) {
    var svg = doc.createElementNS(SVG_NS, "svg");
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    svg.setAttribute("viewBox", "0 0 512 512");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.setAttribute("data-keepr", "brand-mark");
    svg.style.display = "block";
    var add = function (tag, attrs) {
      var n = doc.createElementNS(SVG_NS, tag);
      for (var k in attrs) n.setAttribute(k, attrs[k]);
      svg.appendChild(n);
    };
    if (!bare) {
      var id = "keepr-mark-" + (++markIds);
      var defs = doc.createElementNS(SVG_NS, "defs");
      var grad = doc.createElementNS(SVG_NS, "linearGradient");
      grad.setAttribute("id", id);
      grad.setAttribute("x1", "0");
      grad.setAttribute("y1", "0");
      grad.setAttribute("x2", "1");
      grad.setAttribute("y2", "1");
      [["0", "#4F46E5"], ["1", "#6D5DF0"]].forEach(function (st) {
        var stop = doc.createElementNS(SVG_NS, "stop");
        stop.setAttribute("offset", st[0]);
        stop.setAttribute("stop-color", st[1]);
        grad.appendChild(stop);
      });
      defs.appendChild(grad);
      svg.appendChild(defs);
      add("rect", { width: "512", height: "512", rx: "116", fill: "url(#" + id + ")" });
    }
    add("path", { d: "M156 178 L182 154 L208 178 L208 382 L156 382 Z", fill: "#FFFFFF" });
    add("path", { d: "M190 256 L300 382", stroke: "#FFFFFF", "stroke-width": "52" });
    add("path", { d: "M190 254 L292 176", stroke: "#FFFFFF", "stroke-width": "52" });
    add("circle", { cx: "352", cy: "352", r: "30", fill: "#F5A524" });
    return svg;
  }

  /**
   * The indeterminate bar's moving segment (Web Animations); none under
   * prefers-reduced-motion (a static partial bar) or where unsupported.
   */
  function animateSegment(doc, node) {
    var win = doc.defaultView;
    try {
      if (win && win.matchMedia && win.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        node.setAttribute("data-motion", "reduced");
        return false;
      }
      if (typeof node.animate !== "function") return false;
      node.animate([{ left: "-28%" }, { left: "100%" }], { duration: 1400, iterations: Infinity, easing: "ease-in-out" });
      node.setAttribute("data-motion", "moving");
      return true;
    } catch (_e) {
      return false;
    }
  }

  /** The box's state, from what the job shows. */
  function overlayState(text, isError, extras) {
    // Founder (BoxNotLinked): not linked — the guide card under the toolbar.
    if (extras && extras.idle && extras.idle.guide) return "not_linked";
    if (extras && extras.stopped) return "stopped";
    if (extras && extras.signIn) return "sign_in";
    if (extras && extras.idle) return "idle";
    if (extras && extras.ask) return "ask";
    if (isError) return "error";
    // SR U4: the done line is "done" even when the job sent no details.
    if ((extras && extras.details) || text === DONE_LINE) return "done";
    if (text === PAUSED_TEXT || text === CONNECTING_TEXT || text === UNREACHABLE_TEXT || text === OFFLINE_TEXT) return "paused";
    return "syncing";
  }


  /**
   * Founder (storyboards P01–P03, B03, H03): the syncing card's ONE status
   * line, from the run's state (never parsed from text):
   *   finding  "Finding your chats · 34 so far"
   *   reading  "Reading chat 4 of 20" (a Try again run: "· skipping saved chats")
   *   saving   "Saving to Keepr"
   * @param {{phase: string, found?: number, index?: number, total?: number}=} run
   */
  /**
   * BACKLOG-3671 P2: the per-chat read times → p50 / p90 / slowest / count
   * (nearest rank), computed HERE — the raw list never leaves the extension.
   */
  function perChatStats(msList) {
    var xs = (msList || []).filter(function (x) { return typeof x === "number" && isFinite(x) && x >= 0; })
      .slice().sort(function (a, b) { return a - b; });
    if (xs.length === 0) return { perChatCount: 0 };
    var rank = function (p) { return xs[Math.min(xs.length - 1, Math.max(0, Math.ceil(p * xs.length) - 1))]; };
    return { perChatP50Ms: Math.round(rank(0.5)), perChatP90Ms: Math.round(rank(0.9)), perChatSlowestMs: Math.round(xs[xs.length - 1]), perChatCount: xs.length };
  }

  /**
   * BACKLOG-3671 P2: Chrome's version — the full version from
   * userAgentData's fullVersionList, else the user agent's "Chrome/x". The
   * version string only (nothing else from either).
   */
  function chromeVersionFrom(fullVersionList, userAgent) {
    var ok = function (v) { return typeof v === "string" && /^\d+(\.\d+){1,3}$/.test(v) ? v : null; };
    if (Array.isArray(fullVersionList)) {
      for (var i = 0; i < fullVersionList.length; i++) {
        var b = fullVersionList[i];
        if (b && (b.brand === "Google Chrome" || b.brand === "Chromium") && ok(b.version)) return b.version;
      }
    }
    var m = typeof userAgent === "string" ? /Chrome\/(\d+(?:\.\d+){1,3})/.exec(userAgent) : null;
    return m ? ok(m[1]) : null;
  }

  function statusLine(run, retrying) {
    var r = run || { phase: "finding" };
    if (r.phase === "saving") return SAVING_LINE;
    if (r.phase === "reading" && r.total > 0) {
      return "Reading chat " + Math.max(1, Math.min(r.index || 1, r.total)) + " of " + r.total + (retrying ? " · " + RETRY_CHIP_HINT : "");
    }
    return FINDING_TEXT + (r.found > 0 ? " · " + r.found + " so far" : "");
  }

  /** The bar: completed / total while reading; null (indeterminate) otherwise. */
  function runFraction(run) {
    if (!run || run.phase !== "reading" || !(run.total > 0)) return null;
    return Math.min(1, Math.max(0, (run.done || 0) / run.total));
  }

  /**
   * THE Keepr box, as the founder-approved mockups (Box*.dc.html). ALL of its
   * look is here: every element and style is (re)built from (state, theme) on
   * each call; createElement + textContent only, so page text never becomes
   * markup.
   *
   *   idle     a 40×56 K tab on the right edge (its label on hover); a tap
   *            opens "Sync from Keepr" + Open Keepr (bottom-right).
   *   syncing  card: [mark] "Syncing your texts", a progress bar,
   *            "Chat 12 of 180 · keep this tab open", [Stop sync] right.
   *            Collapsible to the chip (▴ / ▾).
   *            Stop → "Stop the sync?" "Nothing from this run will be saved."
   *            [Keep syncing] [Stop sync (red)].
   *   paused   as syncing, amber border, what to do.
   *   done     [✓] "Sync done", the counts, "See details" (left) +
   *            [Open Keepr] (right); the details card above the row; ×.
   *   error    [!] "Sync failed", the reason, [Try again] right (when Keepr
   *            can retry), details as done; ×.
   *   ask      (security H1) "Keepr wants to sync your texts": Not now / Start.
   *
   * The badge is the ONLY drag handle (data-keepr="drag-handle", grab
   * cursor). The keyboard Move button is visually hidden until focused.
   *
   * @param {HTMLElement} box  the fixed box (or any container, in tests)
   * @param {string} text
   * @param {boolean} isError
   * @param {{details?: string, summary?: string, copy?: string, version?: string, cancel?: boolean,
   *   idle?: {linked?: boolean}, ask?: {start: function(): void, later: function(): void}}=} extras
   * @param {{copy: function(string): Promise<boolean>, focus?: function(): Promise<boolean>,
   *   cancel?: function(): Promise<boolean>, close?: function(): void, move?: function(): void,
   *   expanded?: boolean, onExpand?: function(boolean): void, theme?: "light"|"dark"}} io
   */
  function renderOverlay(box, text, isError, extras, io) {
    var doc = box.ownerDocument;
    var theme = io.theme === "dark" || io.theme === "light" ? io.theme : pageTheme(doc);
    var p = PALETTE[theme];
    var state = overlayState(text, isError, extras);
    // Founder (2026-10-04): ONE syncing card — no collapsed chip; only the
    // idle tab opens and closes.
    var collapsible = state === "idle";
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
      border: "1px solid " + (attention ? p.warnBorder : state === "done" ? p.doneBorder : p.border),
      borderRadius: expanded ? "16px" : "999px",
      boxShadow: p.shadow,
      boxSizing: "border-box",
      width: expanded ? CARD_WIDTH : "auto",
      height: "auto",
      maxWidth: "calc(100vw - 16px)",
      padding: expanded ? "16px" : "5px 8px 5px 5px",
      display: "flex",
      flexDirection: "column",
      gap: "12px",
      fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
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
      var b = el("button", key, { fontFamily: "inherit", cursor: "pointer", lineHeight: "1.2" }, label);
      b.type = "button";
      var hover = function (bg, over) {
        b.addEventListener("mouseenter", function () { b.style.background = over; });
        b.addEventListener("mouseleave", function () { b.style.background = bg; });
      };
      if (kind === "primary" || kind === "danger") {
        var bg = kind === "danger" ? p.danger : p.primary;
        Object.assign(b.style, BOX_BUTTON, { background: bg, color: "#FFFFFF", border: "none", fontWeight: "700" });
        hover(bg, kind === "danger" ? p.dangerHover : p.primaryHover);
      } else if (kind === "link") {
        Object.assign(b.style, { background: "none", border: "none", padding: "0", color: p.link, textDecoration: "none", fontSize: "13px", fontWeight: "600" });
      } else if (kind === "icon") {
        Object.assign(b.style, { background: "none", border: "none", padding: "2px 6px", color: p.muted, fontSize: "16px" });
      } else {
        Object.assign(b.style, BOX_BUTTON, {
          background: p.secondaryBg, color: p.secondaryText, border: "1px solid " + p.secondaryBorder, fontWeight: "600",
        });
      }
      return b;
    }
    /** A bottom row: `left` (or nothing) at the left, `right` at the right. */
    function bottomRow(left, right) {
      var row = el("div", "bottom-row", {
        display: "flex", justifyContent: left ? "space-between" : "flex-end", alignItems: "center", gap: "8px",
      });
      if (left) row.appendChild(left);
      for (var i = 0; i < right.length; i++) row.appendChild(right[i]);
      return row;
    }
    var bodyStyle = { fontSize: "13px", lineHeight: "18px", color: p.body };

    if (state === "idle") {
      renderIdleTab();
      return;
    }
    if (state === "not_linked") {
      renderNotLinkedGuide();
      return;
    }
    if (state === "stopped") {
      renderStopped();
      return;
    }
    if (state === "sign_in") {
      renderSignIn();
      return;
    }

    /** Storyboard I01: Google Messages is not signed in — one line, no button. */
    function renderSignIn() {
      var row = el("div", "header", { display: "flex", alignItems: "center", gap: "10px" });
      var mark = el("div", "drag-handle", { flex: "0 0 30px", width: "30px", height: "30px", cursor: "grab", touchAction: "none", userSelect: "none" });
      mark.appendChild(brandMark(doc, 30));
      row.appendChild(mark);
      row.appendChild(el("div", "line", { flex: "1 1 auto", fontSize: "15px", fontWeight: "700", color: p.text }, SIGN_IN_TITLE));
      if (io.close) {
        var x = button("close", "×", "icon");
        x.setAttribute("aria-label", "Close");
        x.addEventListener("click", function () { io.close(); });
        row.appendChild(x);
      }
      box.appendChild(row);
      var line = el("div", "progress", bodyStyle);
      line.appendChild(doc.createTextNode(SIGN_IN_BEFORE));
      line.appendChild(el("b", null, null, "Sync now"));
      line.appendChild(doc.createTextNode(SIGN_IN_AFTER));
      box.appendChild(line);
    }

    /** Storyboard H07: the user stopped the Sync — one line and Close. */
    function renderStopped() {
      var row = el("div", "header", { display: "flex", alignItems: "center", gap: "10px" });
      var mark = el("div", "drag-handle", {
        flex: "0 0 30px", width: "30px", height: "30px", borderRadius: "999px", background: p.stoppedBadge, color: "#FFFFFF",
        display: "flex", alignItems: "center", justifyContent: "center", fontWeight: "800", fontSize: "15px",
        cursor: "grab", touchAction: "none", userSelect: "none",
      }, "K");
      mark.setAttribute("aria-hidden", "true");
      row.appendChild(mark);
      row.appendChild(el("div", "line", { flex: "1 1 auto", fontSize: "15px", fontWeight: "700", color: p.text }, STOPPED_TITLE));
      if (io.close) {
        var xStopped = button("close", "×", "icon");
        xStopped.setAttribute("aria-label", "Close");
        xStopped.addEventListener("click", function () { io.close(); });
        row.appendChild(xStopped);
      }
      box.appendChild(row);
      box.appendChild(el("div", "progress", bodyStyle, STOPPED_BODY));
      var closeStopped = button("close", "Close", "secondary");
      closeStopped.addEventListener("click", function () { if (io.close) io.close(); });
      box.appendChild(bottomRow(null, [closeStopped]));
    }

    /**
     * Founder (BoxNotLinked mockup, 2026-10-04): not linked — a card at the
     * top-right, under Chrome's toolbar, with a yellow ↑ toward the
     * extension's icon: the brand mark, "Link with Keepr", one line, and ×
     * (dismissed for this page load; it comes back on the next while unlinked).
     */
    function renderNotLinkedGuide() {
      // SR (D02 storyboard): 320 wide, padding 16, gap 12, radius 16.
      Object.assign(box.style, { width: "320px", padding: "16px", gap: "12px", borderRadius: "16px", boxShadow: p.guideShadow });
      var row = el("div", "header", { display: "flex", alignItems: "center", gap: "10px" });
      // The brand mark is the drag handle, as on every other card.
      var mark = el("div", "drag-handle", { flex: "0 0 30px", width: "30px", height: "30px", cursor: "grab", touchAction: "none", userSelect: "none" });
      mark.setAttribute("data-keepr-guide-mark", "1");
      mark.title = "Keepr — drag to move";
      mark.appendChild(brandMark(doc, 30));
      row.appendChild(mark);
      row.appendChild(el("div", "line", { flex: "1 1 auto", fontSize: "15px", fontWeight: "700", color: p.text }, GUIDE_HEADING));
      if (io.close) {
        var x = button("close", "×", "icon");
        x.setAttribute("aria-label", "Close");
        x.addEventListener("click", function () { io.close(); });
        row.appendChild(x);
      }
      box.appendChild(row);
      // LinkFlow (SR): the primary "Link with Keepr" opens the extension's own
      // window (the code shows there, never on this page). Trusted clicks only.
      var linkButton = button("link-open", GUIDE_TITLE, "primary");
      // D02: the full width, 44 high, 14px, radius 10 (no hint line, no arrow).
      Object.assign(linkButton.style, { width: "100%", minHeight: "44px", fontSize: "14px", borderRadius: "10px", padding: "0 20px" });
      linkButton.addEventListener("click", function (e) {
        if (!e || e.isTrusted !== true) return;
        if (io.openLink) io.openLink();
      });
      box.appendChild(linkButton);
    }

    /** C3: the idle K tab (collapsed), or its one line + Open Keepr (expanded). */
    function renderIdleTab() {
      var tab = el("div", "drag-handle", {
        display: "flex", alignItems: "center", justifyContent: "center",
        cursor: "grab", touchAction: "none", userSelect: "none",
      });
      tab.setAttribute("data-keepr-tab", "1");
      tab.setAttribute("role", "button");
      tab.setAttribute("tabindex", "0");
      tab.setAttribute("aria-label", expanded ? "Hide Keepr" : "Keepr status");
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
        // The mockup's tab: 40×56, flush with the right edge, rounded on the left.
        Object.assign(box.style, {
          width: "40px", height: "56px", padding: "0", border: "none", gap: "0",
          borderRadius: "12px 0 0 12px", background: p.tab, boxShadow: p.tabShadow, overflow: "visible",
        });
        Object.assign(tab.style, { width: "40px", height: "56px" });
        tab.appendChild(brandMark(doc, 28, true));
        box.appendChild(tab);
        // Its label, on hover / focus: "Keepr · linked".
        var linked = extras && extras.idle && typeof extras.idle.linked === "boolean" ? extras.idle.linked : null;
        var tip = el("div", "tab-label", {
          position: "absolute", right: "48px", top: "50%", transform: "translateY(-50%)", display: "none",
          padding: "8px 12px", borderRadius: "8px", background: p.tipBg, color: p.tipText,
          fontSize: "13px", lineHeight: "18px", whiteSpace: "nowrap", pointerEvents: "none",
        }, linked === null ? "Keepr" : linked ? "Keepr · linked" : "Keepr · not linked");
        box.appendChild(tip);
        var showTip = function (on) { return function () { tip.style.display = on ? "block" : "none"; }; };
        tab.addEventListener("mouseenter", showTip(true));
        tab.addEventListener("mouseleave", showTip(false));
        tab.addEventListener("focus", showTip(true));
        tab.addEventListener("blur", showTip(false));
        return;
      }
      Object.assign(tab.style, { flex: "0 0 30px", width: "30px", height: "30px" });
      tab.appendChild(brandMark(doc, 30));
      var row = el("div", "header", { display: "flex", alignItems: "center", gap: "10px" });
      row.appendChild(tab);
      row.appendChild(el("div", "line", { flex: "1 1 auto", fontSize: "15px", fontWeight: "700", color: p.text }, IDLE_TAB_LINE));
      // Founder (live 0.3.57): every card opened from the K tab has × back to it.
      var collapse = button("close", "×", "icon");
      collapse.setAttribute("aria-label", "Close");
      collapse.addEventListener("click", function () { if (io.onExpand) io.onExpand(false); });
      row.appendChild(collapse);
      box.appendChild(row);
      // Founder: Open Keepr at the bottom-right of the box.
      var openIdle = button("open-keepr", "Open Keepr", "primary");
      openIdle.addEventListener("click", openKeepr);
      box.appendChild(bottomRow(null, [openIdle]));
    }

    // Header: badge (the drag handle) + title + controls.
    var header = el("div", "header", { display: "flex", alignItems: "center", gap: "10px" });
    // Founder (2026-10-03): the brand mark is the logo AND the drag handle;
    // done shows a green ✓ and a failure an amber ! (the mockups).
    var badge = el("div", "drag-handle", {
      flex: "0 0 30px", width: "30px", height: "30px", borderRadius: "999px",
      display: "flex", alignItems: "center", justifyContent: "center",
      cursor: "grab", touchAction: "none", userSelect: "none",
    });
    if (state === "done" || state === "error") {
      Object.assign(badge.style, { background: state === "done" ? p.ok : p.warn, color: "#FFFFFF", fontWeight: "800", fontSize: "15px" });
      badge.textContent = state === "done" ? "✓" : "!";
    } else {
      badge.appendChild(brandMark(doc, 30));
    }
    badge.title = "Keepr — drag to move";
    badge.setAttribute("aria-hidden", "true");
    header.appendChild(badge);

    var retryable = state === "error" && !!(extras && extras.retry) && !!io.retry;
    var title = state === "error" ? SYNC_FAILED_TITLE : state === "done" ? (text === DONE_LINE ? DONE_TITLE : text)
      : state === "syncing" ? SYNCING_TITLE
      : state === "paused" ? PAUSED_TITLE : state === "ask" ? ASK_TITLE : text;
    var line = el("div", "line", {
      flex: "1 1 auto", minWidth: "0", fontSize: expanded ? "15px" : "14px", fontWeight: "700", color: p.text,
      whiteSpace: expanded ? "normal" : "nowrap",
    }, title);
    header.appendChild(line);
    if (io.move) {
      // Keyboard alternative to dragging: hidden until it has focus.
      var move = button("move", "Move", "secondary");
      move.setAttribute("aria-label", "Move this box to the next corner");
      var hidden = { position: "absolute", width: "1px", height: "1px", overflow: "hidden", clip: "rect(0 0 0 0)", padding: "0", border: "0", minHeight: "0" };
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

    if (state === "ask") {
      box.appendChild(el("div", "progress", bodyStyle, ASK_TEXT));
      var later = button("ask-later", "Not now", "secondary");
      var startButton = button("ask-start", "Start", "primary");
      later.addEventListener("click", function () { extras.ask.later(); });
      startButton.addEventListener("click", function () {
        startButton.disabled = true;
        later.disabled = true;
        extras.ask.start();
      });
      box.appendChild(bottomRow(null, [later, startButton]));
      return;
    }

    if (state === "syncing" || state === "paused") {
      var running = [];
      var run = extras && extras.run;
      if (state === "syncing") {
        // Founder (P01–P03): the bar in every phase, from the run's state —
        // determinate while reading (completed / total), else a moving
        // segment (static under prefers-reduced-motion).
        var frac = runFraction(run);
        var bar = el("div", "progress-bar", { height: "6px", borderRadius: "999px", background: p.track, overflow: "hidden", position: "relative" });
        var fill;
        if (frac === null) {
          bar.setAttribute("data-indeterminate", "1");
          fill = el("div", "progress-fill", { position: "absolute", left: "30%", width: "28%", height: "6px", borderRadius: "999px", background: p.fill });
          bar.appendChild(fill);
          animateSegment(doc, fill);
        } else {
          fill = el("div", "progress-fill", { width: Math.round(frac * 100) + "%", height: "6px", background: p.fill });
          bar.appendChild(fill);
        }
        box.appendChild(bar);
        running.push(bar);
      }
      var progressLine = el("div", "progress", {
        fontSize: "13px", color: p.muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
      },
        state === "paused" ? PAUSE_BODIES[text] || PAUSED_BODY : statusLine(run, !!(extras && extras.retrying)));
      box.appendChild(progressLine);
      running.push(progressLine);
      if (state === "syncing") {
        var warn = el("div", "dont-click", { fontSize: "13px", lineHeight: "18px", color: p.warnText }, DONT_CLICK_LINE);
        box.appendChild(warn);
        running.push(warn);
      }
      if (!(extras && extras.cancel)) return;
      // Founder (2026-10-02): "Stop sync" with a confirm; it cancels this job
      // only, through the bridge (a signed job call), ended by the page.
      var cancel = button("cancel", STOP_SYNC_LABEL, "secondary");
      cancel.style.alignSelf = "flex-end";
      box.appendChild(cancel);
      running.push(cancel);
      var confirmBox = el("div", "stop-confirm", { display: "none", flexDirection: "column", gap: "12px" });
      confirmBox.setAttribute("role", "alert");
      confirmBox.appendChild(el("div", "stop-question", bodyStyle, STOP_SYNC_BODY));
      var stopNo = button("stop-no", "Keep syncing", "secondary");
      var stopYes = button("stop-yes", STOP_SYNC_LABEL, "danger");
      confirmBox.appendChild(bottomRow(null, [stopNo, stopYes]));
      box.appendChild(confirmBox);
      // SR: the box is rebuilt on every progress line, so the confirm's state
      // lives in io.stop (kept by the page across renders) until the user
      // answers or the job ends: "closed" | "open" | "stopping".
      var stop = io.stop || { state: "closed", openedAt: 0 };
      var now = function () { return io.now ? io.now() : Date.now(); };
      var paint = function () {
        var asking = stop.state !== "closed";
        confirmBox.style.display = asking ? "flex" : "none";
        running.forEach(function (n) { n.style.display = asking ? "none" : ""; });
        line.textContent = asking ? STOP_SYNC_TITLE : title;
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
        var laterFn = io.setTimeout || setTimeout;
        laterFn(function () {
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

    // done / error: one line (the counts, or the failure), then the bottom row.
    var bodyLine = state === "error" ? text : extras && extras.summary ? extras.summary : "";
    if (bodyLine) box.appendChild(el("div", "progress", bodyStyle, bodyLine));
    if (state === "done" && extras && extras.notFullyLine) box.appendChild(el("div", "not-fully", bodyStyle, extras.notFullyLine));
    // SR U4 (the mockup): Done ALWAYS has See details (left) + Open Keepr
    // (right); with no details, See details shows the summary / copy.
    // Storyboard H01: a failed Sync that can try again shows its reason and
    // Try again only (no See details).
    var hasDetails = (!!(extras && extras.details) || state === "done") && !retryable;
    var detailsText = (extras && (extras.details || extras.summary || extras.copy)) || DONE_TITLE;
    var copyText = (extras && extras.copy) || detailsText;

    // The details card, ABOVE the row (founder: the row's action stays at the
    // box's bottom-right), collapsed by default.
    var toggle = null;
    if (hasDetails) {
      toggle = button("details-toggle", SEE_DETAILS, "link");
      toggle.setAttribute("aria-expanded", "false");
      var card = el("div", "details-card", {
        display: "none", padding: "10px", borderRadius: "10px",
        background: p.detailsBg, color: p.text, border: "1px solid " + p.detailsBorder,
      });
      var details = el("pre", "details", { whiteSpace: "pre-wrap", margin: "0", font: "inherit", fontSize: "13px" }, detailsText);
      var copyButton = button("copy", "Copy details", "secondary");
      copyButton.style.marginTop = "8px";
      card.appendChild(details);
      card.appendChild(copyButton);
      // Founder (2026-10-03): no version line in the box (Copy details and the popup carry it).
      box.appendChild(card);
      toggle.addEventListener("click", function () {
        var opening = card.style.display === "none";
        card.style.display = opening ? "block" : "none";
        toggle.textContent = opening ? HIDE_DETAILS : SEE_DETAILS;
        toggle.setAttribute("aria-expanded", opening ? "true" : "false");
      });
      copyButton.addEventListener("click", function () {
        Promise.resolve(io.copy(copyText)).then(function (ok) {
          copyButton.textContent = ok ? "Copied" : "Copy failed";
        }, function () {
          copyButton.textContent = "Copy failed";
        });
      });
    }

    if (retryable) {
      var retry = button("try-again", TRY_AGAIN_LABEL, "primary");
      retry.addEventListener("click", function () {
        retry.disabled = true;
        Promise.resolve(io.retry()).then(function (ok) {
          if (!ok) retry.disabled = false;
        }, function () { retry.disabled = false; });
      });
      box.appendChild(bottomRow(toggle, [retry]));
      return;
    }
    if (!hasDetails) return;
    var open = button("open-keepr", "Open Keepr", "primary");
    box.appendChild(bottomRow(toggle, [open]));
    // Live (founder): /focus, else keepr://open — the button never changes its words.
    open.addEventListener("click", openKeepr);
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
  function tabPosition(topFrac, size, view, gap) {
    var frac = typeof topFrac === "number" && isFinite(topFrac) ? Math.min(1, Math.max(0, topFrac)) : 0.5;
    var rightGap = typeof gap === "number" && isFinite(gap) ? gap : RIGHT_GAP;
    var minTop = SAFE_TOP;
    var maxTop = Math.max(minTop, view.height - SAFE_BOTTOM - size.height);
    var top = minTop + (maxTop - minTop) * frac;
    // SR: a viewport too short for the safe band (a small window / screen):
    // still fully on screen — never below the bottom, never above the top.
    top = Math.max(0, Math.min(top, view.height - size.height));
    return {
      left: Math.round(Math.max(0, view.width - size.width - rightGap)),
      top: Math.round(top),
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

  /** The not-linked guide's default place: top centre, 16px down. */
  function guidePosition(width, viewWidth) {
    return { left: Math.round(Math.max(0, (viewWidth - width) / 2)), top: GUIDE_TOP };
  }

  /**
   * The guide card's remembered place, read back from storage, is UNTRUSTED:
   * only {left, top} finite numbers, clamped to 0..20000 (then kept inside
   * the view when placed).
   */
  function sanitizeFreePosition(raw) {
    if (!raw || typeof raw !== "object") return null;
    var ok = function (v) { return typeof v === "number" && isFinite(v); };
    if (!ok(raw.left) || !ok(raw.top)) return null;
    var c = function (v) { return Math.round(Math.min(20000, Math.max(0, v))); };
    return { left: c(raw.left), top: c(raw.top) };
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
    /** The guide card: dragged anywhere (clamped to the view), not along the edge. */
    function free() {
      return !!(io.free && io.free());
    }
    var mode = null;
    function settle(pos) {
      if (free()) return place(clampPosition(pos, io.size(), io.view()));
      if (edge) {
        // C3: up and down the right edge only, inside the safe band.
        frac = tabFraction(pos.top, io.size(), io.view());
        return place(tabPosition(frac, io.size(), io.view(), io.rightGap ? io.rightGap() : RIGHT_GAP));
      }
      return place(clampPosition(pos, io.size(), io.view()));
    }
    function current() {
      return { left: parseFloat(box.style.left) || 0, top: parseFloat(box.style.top) || 0 };
    }
    var saved = io.load();
    if (edge) {
      frac = saved && typeof saved.topFrac === "number" ? saved.topFrac : 0.5;
      place(tabPosition(frac, io.size(), io.view(), io.rightGap ? io.rightGap() : RIGHT_GAP));
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
      if (free()) {
        if (io.saveFree) io.saveFree(current());
        return;
      }
      io.save(edge ? { topFrac: frac } : current());
    }
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);

    return {
      /** Keyboard alternative: the next corner, clockwise from top-right. */
      moveToNextCorner: function () {
        if (free()) {
          corner = nextCorner(corner);
          var at = place(cornerPosition(corner, io.size(), io.view()));
          if (io.saveFree) io.saveFree(at);
          return corner;
        }
        if (edge) {
          // C3: the keyboard moves it along the edge: top, middle, bottom.
          frac = frac < 0.25 ? 0.5 : frac < 0.75 ? 1 : 0;
          place(tabPosition(frac, io.size(), io.view(), io.rightGap ? io.rightGap() : RIGHT_GAP));
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
          place(tabPosition(frac, io.size(), io.view(), io.rightGap ? io.rightGap() : RIGHT_GAP));
        }
      },
      /** After a resize (or a taller / wider box): back to its place. */
      keepOnScreen: function () {
        if (free()) {
          // Entering the guide: its remembered place, else its default (top
          // centre); while it shows: kept where it is, inside the view.
          if (mode !== "free") {
            mode = "free";
            var at = (io.loadFree && io.loadFree()) || (io.freeDefault ? io.freeDefault() : current());
            place(clampPosition(at, io.size(), io.view()));
          } else settle(current());
          return;
        }
        mode = "edge";
        if (edge) place(tabPosition(frac, io.size(), io.view(), io.rightGap ? io.rightGap() : RIGHT_GAP));
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

  /**
   * #keepr-link: the worker moves to an already signed-in Messages tab (this
   * one closes) and opens the link window. Else this tab opens it itself —
   * only once Messages is signed in here (on the QR page nothing happens: the
   * page card shows "Link this browser" after pairing, as before).
   */
  async function handleLinkHash(io) {
    var sc = root.screen || {};
    var screenBox = { left: sc.availLeft, top: sc.availTop, width: sc.availWidth, height: sc.availHeight };
    var route = await io.toWorker({ type: "keepr-link-found", screen: screenBox });
    if (route && route.handedOff) return "handed_off";
    for (var waited = 0; waited < LINK_SIGNED_IN_WAIT_MS; waited += 1000) {
      if (io.signedIn()) {
        await io.toWorker({ type: "keepr-open-link-window", screen: screenBox });
        return "opened_here";
      }
      await io.sleep(1000);
    }
    return "not_signed_in";
  }

  var api = {
    handleLinkHash: handleLinkHash,
    withoutLinkHash: withoutLinkHash,
    withoutJobHash: withoutJobHash,
    LINK_HASH_RE: LINK_HASH_RE,
    bootPlan: bootPlan,
    FAILURE_LINES: FAILURE_LINES,
    failureLine: failureLine,
    guidePosition: guidePosition,
    sanitizeFreePosition: sanitizeFreePosition,
    GUIDE_TITLE: GUIDE_TITLE,
    GUIDE_HEADING: GUIDE_HEADING,
    transportKind: transportKind,
    KEEPR_LOST_MESSAGES: KEEPR_LOST_MESSAGES,
    launchKeepr: launchKeepr,
    buildBox: buildBox,
    themeFromColor: themeFromColor,
    pageTheme: pageTheme,
    overlayState: overlayState,
    PALETTE: PALETTE,
    ASK_TITLE: ASK_TITLE,
    STOP_SYNC_QUESTION: STOP_SYNC_QUESTION,
    STOP_SYNC_TITLE: STOP_SYNC_TITLE,
    STOPPED_TITLE: STOPPED_TITLE,
    SIGN_IN_TITLE: SIGN_IN_TITLE,
    cacheSummaryLine: cacheSummaryLine,
    STOPPED_BODY: STOPPED_BODY,
    STOP_SYNC_BODY: STOP_SYNC_BODY,
    DONE_TITLE: DONE_TITLE,
    notFullySyncedLine: notFullySyncedLine,
    statusLine: statusLine,
    runFraction: runFraction,
    perChatStats: perChatStats,
    chromeVersionFrom: chromeVersionFrom,
    FINDING_TEXT: FINDING_TEXT,
    DONT_CLICK_LINE: DONT_CLICK_LINE,
    STOP_CONFIRM_ARM_MS: STOP_CONFIRM_ARM_MS,
    IDLE_TAB_LINE: IDLE_TAB_LINE,
    STOP_CONFIRM_AUTO_CLOSE_MS: STOP_CONFIRM_AUTO_CLOSE_MS,
    SYNC_FAILED_TITLE: SYNC_FAILED_TITLE,
    TRY_AGAIN_LABEL: TRY_AGAIN_LABEL,
    PAGE_GONE_MESSAGE: PAGE_GONE_MESSAGE,
    tabPosition: tabPosition,
    brandMark: brandMark,
    sanitizeTabPosition: sanitizeTabPosition,
    windowLabel: windowLabel,
    mediaLine: mediaLine,
    chatAlreadyOpen: chatAlreadyOpen,
    ALREADY_OPEN_STABLE_MS: ALREADY_OPEN_STABLE_MS,
    RCS_MAX_PHOTO_BYTES: RCS_MAX_PHOTO_BYTES,
    imageSrcAllowed: imageSrcAllowed,
    readImageCapped: readImageCapped,
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
    floorKind: floorKind,
    historyDepthLine: historyDepthLine,
    makePacedSleep: makePacedSleep,
    PACED_MAX_WAIT_MS: PACED_MAX_WAIT_MS,
    PACED_MAX_FAILURES: PACED_MAX_FAILURES,
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
    OFFLINE_TEXT: OFFLINE_TEXT,
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
  // BACKLOG-3668 L1: read once — the job id leaves the URL (history, a shared
  // or bookmarked link); this tab keeps its copy above.
  if (hashJob) {
    try {
      history.replaceState(history.state, "", location.pathname + location.search + withoutJobHash(location.hash));
    } catch (_e) { /* the job still runs */ }
  }
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

  function localSleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }
  /** The run's paced sleep (makePacedSleep) while a Sync runs; else the page's timer. */
  var pacer = null;
  function sleep(ms) {
    return pacer ? pacer.sleep(ms) : localSleep(ms);
  }
  /** One wait through the worker: true once it answered after its own timer. */
  function askWorkerToWake(ms) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage({ type: "keepr-wake", ms: ms }, function (r) {
          resolve(!chrome.runtime.lastError && !!(r && r.ok));
        });
      } catch (_e) {
        resolve(false);
      }
    });
  }

  // Overlay ------------------------------------------------------------------
  var box = null;
  var mover = null;
  var POSITION_KEY = "keepr-overlay-pos";
  /** The box's remembered place (chrome.storage.local), once read. */
  var savedPosition = null;
  /** SR: read the place from the extension's storage; drop what an older build left in the page's. */
  void (function () {
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
  /** The guide card's own remembered place (chrome.storage.local). */
  var GUIDE_POSITION_KEY = "keepr-guide-pos";
  var guideSaved = null;
  try {
    chrome.storage.local.get(GUIDE_POSITION_KEY, function (got) {
      void chrome.runtime.lastError;
      guideSaved = sanitizeFreePosition(got && got[GUIDE_POSITION_KEY]);
    });
  } catch (_e) { /* none */ }
  // The idle tab's open state; the last thing shown, to redraw it.
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
        // The mockup: the idle K tab sits flush with the edge; the open box a little in.
        rightGap: function () { return box && box.getAttribute("data-keepr-state") === "idle" && !idleExpanded ? 0 : RIGHT_GAP; },
        // The not-linked guide: top centre by default, dragged anywhere, its
        // own place remembered (founder, live 0.3.57: never pinned).
        free: function () { return !!box && box.getAttribute("data-keepr-state") === "not_linked"; },
        freeDefault: function () { return guidePosition(box.getBoundingClientRect().width || 320, root.innerWidth); },
        loadFree: function () { return guideSaved; },
        saveFree: function (pos) {
          guideSaved = sanitizeFreePosition(pos);
          if (!guideSaved) return;
          try {
            var item = {};
            item[GUIDE_POSITION_KEY] = guideSaved;
            void chrome.storage.local.set(item);
          } catch (_e) { /* not kept: fine */ }
        },
        onTap: function () {
          if (lastShown && lastShown.extras && lastShown.extras.idle) setIdleOpen(!idleExpanded);
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
      copy: copyToClipboard, focus: focusKeepr, cancel: cancelJob, stop: stopConfirm,
      close: extras && extras.idle && extras.idle.guide ? dismissGuide : dismiss,
      // SR (D03/A06): the page's screen (numbers only) so the code window
      // opens at its right edge, beside Keepr's centred modal.
      openLink: function () {
        var sc = root.screen || {};
        void toWorker({
          type: "keepr-open-link-window",
          screen: { left: sc.availLeft, top: sc.availTop, width: sc.availWidth, height: sc.availHeight },
        });
      },
      rerender: function () { if (lastShown) showOverlay(lastShown.text, lastShown.isError, lastShown.extras); },
      // C5: "Try again" — Keepr starts a new Sync (signed; only after a failed
      // one); this tab runs it (the chats the failed one saved are skipped).
      retry: retrySync,
      move: function () { if (mover) mover.moveToNextCorner(); },
      // Founder: the syncing card never collapses; only the idle tab opens / closes.
      expanded: extras && extras.idle ? idleExpanded : false,
      onExpand: function (open) {
        if (extras && extras.idle) {
          setIdleOpen(open);
          return;
        }
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
  /** The idle tab's label: "Keepr · linked" / "Keepr · not linked" (a boolean from the worker). */
  var idleLinked;
  /** The not-linked guide's × — for this page load only. */
  var guideDismissed = false;
  function idleOnScreen() {
    return !lastShown || !!(lastShown.extras && lastShown.extras.idle);
  }
  function showIdle() {
    if (running || asking || !idleOnScreen()) return;
    showOverlay("", false, { idle: { linked: idleLinked, guide: idleLinked === false && !guideDismissed }, version: manifestVersion() });
  }
  /** C3: idle, the page shows only the K tab (status and linking: the toolbar popup). */
  async function refreshIdle() {
    if (running || asking || !idleOnScreen()) return;
    if (!document.body) {
      await new Promise(function (r) { document.addEventListener("DOMContentLoaded", r, { once: true }); });
    }
    try {
      var status = await toWorker({ type: "keepr-pair-status" });
      idleLinked = status && status.ok ? !!status.paired : undefined;
    } catch (_e) { idleLinked = undefined; }
    showIdle();
  }
  /**
   * Founder (live 0.3.57): the K tab opens its card and × always brings the
   * tab back — the same on every open. Not linked, the card is the "Link
   * this browser" guide again (its × back to the tab); linked, "Sync from
   * Keepr" (its × back to the tab).
   */
  function setIdleOpen(open) {
    if (open && idleLinked === false && guideDismissed) {
      idleExpanded = false;
      guideDismissed = false;
      showIdle();
      return;
    }
    idleExpanded = !!open;
    if (lastShown) showOverlay(lastShown.text, lastShown.isError, lastShown.extras);
  }
  /** × on the not-linked guide: back to the K tab (a tap on it opens the guide again). */
  function dismissGuide() {
    guideDismissed = true;
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
      // Live (founder): Keepr not running → launch it (no tab); the user tries again then.
      if (!r || r.status === 0) {
        launchKeepr(document, "keepr://open");
        return false;
      }
      var jobId = r.ok && r.body && typeof r.body.jobId === "string" ? r.body.jobId : null;
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
      body: { code: "page_gone", message: PAGE_GONE_MESSAGE, metrics: currentRunMetrics() },
    });
  });

  /** The page's Cancel: POST /job/<this job>/cancel through the worker. */
  var currentJobId = null;
  /** BACKLOG-3671 P2: the running job's numbers (set by the job; counts / ms only). */
  var runMetricsFn = null;
  function currentRunMetrics() {
    try {
      return runMetricsFn ? runMetricsFn() : undefined;
    } catch (_e) {
      return undefined;
    }
  }
  /** Storyboard H07: this page's Stop sync ended the run (not Keepr). */
  var stoppedHere = false;
  function cancelJob() {
    if (!currentJobId) return Promise.resolve(false);
    // Signed (a job call); Keepr records who ended it.
    return toWorker({ type: "keepr-job-api", method: "POST", path: "/job/" + currentJobId + "/cancel", body: { endedBy: "user_page", metrics: currentRunMetrics() } })
      .then(function (r) {
        var ok = !!(r && r.ok);
        if (ok) stoppedHere = true;
        return ok;
      });
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

  /**
   * "Open Keepr": the worker asks the bridge (POST /focus, signed when linked)
   * to bring Keepr forward — no tab. Refused or unreachable: keepr://open from
   * this page (no new tab). Resolves true once one of them was done.
   */
  function focusKeepr() {
    return toWorker({ type: "keepr-focus" }).then(function (r) {
      if (r && r.ok) return true;
      // SR: keepr://open only when Keepr is unreachable.
      return r && r.launch ? launchKeepr(document, "keepr://open") : false;
    }, function () {
      return launchKeepr(document, "keepr://open");
    });
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

  function readImage(src) {
    return readImageCapped(src, { fetch: function (u) { return fetch(u); }, toBase64: blobToBase64 });
  }

  async function blobToBase64(blob) {
    var dataUrl = await new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result || "")); };
      r.onerror = function () { reject(r.error || new Error("read failed")); };
      r.readAsDataURL(blob);
    });
    var comma = dataUrl.indexOf(",");
    return comma >= 0 ? dataUrl.slice(comma + 1) : "";
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
      stoppedHere: function () { return stoppedHere; },
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
      setRunMetrics: function (fn) { runMetricsFn = typeof fn === "function" ? fn : null; },
      // BACKLOG-3671 P2: Chrome's version string only.
      chromeVersion: function () {
        var uad = navigator.userAgentData;
        if (uad && typeof uad.getHighEntropyValues === "function") {
          return uad.getHighEntropyValues(["fullVersionList"])
            .then(function (v) { return chromeVersionFrom(v && v.fullVersionList, navigator.userAgent); })
            .catch(function () { return chromeVersionFrom(null, navigator.userAgent); });
        }
        return Promise.resolve(chromeVersionFrom(null, navigator.userAgent));
      },
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
    stoppedHere = false;
    try { sessionStorage.removeItem(STORAGE_KEY); } catch (_e) { /* ignore */ }
    if (!document.body) {
      await new Promise(function (r) { document.addEventListener("DOMContentLoaded", r, { once: true }); });
    }
    // Only while this user-started Sync runs (stopped in finally).
    pacer = makePacedSleep({ send: askWorkerToWake, localSleep: localSleep, now: function () { return Date.now(); } });
    try {
      await runJob(jobId, env());
    } catch (err) {
      var stopped = "The sync stopped: " + String((err && err.message) || err);
      // Copy carries no error text (it could quote the page). SR U1: a short card line.
      showOverlay(failureLine("scan_failed"), true, { details: stopped, copy: "Keepr Sync diagnostics: the sync stopped with an error." });
      await toWorker({
        type: "keepr-job-api", method: "POST", path: "/job/" + jobId + "/error",
        body: { code: "scan_failed", message: String((err && err.message) || err), metrics: currentRunMetrics() },
      });
    } finally {
      if (pacer) {
        var paced = pacer.stats();
        pacer.stop();
        pacer = null;
        sendLog("waits paced by the worker: " + paced.paced + " (asked " + Math.round(paced.askedMs / 1000) + "s, took " +
          Math.round(paced.tookMs / 1000) + "s), fell back to the page timer: " + paced.fallbacks);
      }
      currentJobId = null;
      runMetricsFn = null;
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
    if (!hashJob && !storedJob && LINK_HASH_RE.test(location.hash || "")) {
      // SR: read once — a reload or a restored session never asks again.
      try {
        history.replaceState(history.state, "", location.pathname + location.search + withoutLinkHash(location.hash));
      } catch (_e) { /* the request still runs once */ }
      void handleLinkHash({
        toWorker: toWorker,
        sleep: function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); },
        signedIn: function () {
          return root.KeeprScan.signInState(location.pathname) === "signed_in" &&
            !!(document.querySelector(LIST_ITEM) || document.querySelector(root.KeeprScan.SELECTORS.headerTitle));
        },
      });
    }
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
