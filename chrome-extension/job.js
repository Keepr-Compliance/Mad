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
      // chat header proves the page is signed in and loaded too.
      if (env.scan.SELECTORS && env.doc.querySelector(env.scan.SELECTORS.headerTitle)) return "ready";
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
  var RETURN_TO_KEEPR = "Switch back to Keepr to see the imported messages.";

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

  /** The finished overlay: totals, every chat left out, the way back to Keepr. */
  function doneText(totals, reported, more) {
    var lines = [
      "Done — imported " + totals.chats + " chats, " + totals.messages + " messages, " + totals.images + " images.",
    ];
    if (reported.length > 0) {
      lines.push("Not fully imported:");
      for (var i = 0; i < reported.length; i++) {
        lines.push("• " + reported[i].name + " (" + reasonText(reported[i]) + ")");
      }
      if (more > 0) lines.push("+" + more + " more");
    }
    lines.push(RETURN_TO_KEEPR);
    return lines.join("\n");
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
   *                        sleep(ms), click(el), scroll(), scrollMessagesUp?(), openConversation(conv),
   *                        returnToList?() (narrow window: back to the list; never throws),
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
        env.overlay.show(CANCELLED, true);
        return { outcome: "job_gone" };
      }
      throw err;
    }
  }

  async function runJobInner(jobId, env) {
    var base = "/job/" + jobId;
    var skips = [];
    // BACKLOG-3629: every chat left out, or imported in part, by name.
    var notReached = [];
    function leaveOut(conv, reason, count) {
      var entry = { name: conv.name || "(unnamed chat)", reason: reason };
      if (count !== undefined) entry.count = count;
      notReached.push(entry);
    }

    /** Every job call: a 404/410 ends the run. */
    async function call(method, path, body) {
      var reply = await env.api(method, path, body);
      if (jobGone(reply)) throw JobGoneError();
      return reply;
    }
    var progress = { listed: 0, candidates: 0, checked: 0, skipped: 0 };
    var totals = { chats: 0, messages: 0, images: 0 };

    async function report(stage) {
      env.overlay.show(stage, false);
      await call("POST", base + "/progress", {
        stage: stage,
        listed: progress.listed,
        candidates: progress.candidates,
        checked: progress.checked,
        skipped: progress.skipped,
      });
    }

    async function fail(code, message) {
      env.overlay.show(message, true);
      await env.api("POST", base + "/error", { code: code, message: message });
      return { outcome: code };
    }

    // 1. Signed in? (founder decision: no waiting for sign-in, no auto-resume)
    var pageState = await waitForPageState(env, env.pageTimeoutMs == null ? 20000 : env.pageTimeoutMs);
    if (pageState === "not_signed_in") return fail("not_signed_in", NOT_SIGNED_IN);
    if (pageState !== "ready") {
      return fail("page_not_ready", "Messages for Web did not finish loading. Click Sync in Keepr again.");
    }

    // 2. Claim: contact names only.
    // The claim keeps its own message (already running / over) for the overlay.
    // POST (BACKLOG-3628): Chrome on Windows sends a worker GET without Origin.
    var claim = await env.api("POST", base + "/claim");
    if (!claim.ok) {
      env.overlay.show(messageOf(claim, "Keepr refused this sync."), true);
      return { outcome: "claim_refused" };
    }
    var contacts = (claim.body && claim.body.contacts) || [];
    // History floor: the transaction's start date; none → no date floor.
    var floorMs = claim.body && typeof claim.body.startDate === "string" ? Date.parse(claim.body.startDate) : NaN;
    if (!isFinite(floorMs)) floorMs = null;
    var history = [];

    // 3. Scan the list and pick candidates. A narrow window shows the list OR
    // a chat (BACKLOG-3629): make sure the list is the pane on screen first.
    env.overlay.show("Loading your conversation list…", false);
    if (env.returnToList) await env.returnToList();
    var collected = await env.scan.collectConversations(env.doc, { scroll: env.scroll, sleep: env.sleep });
    var candidates = env.scan.pickCandidates(collected.conversations, contacts);
    progress.listed = collected.conversations.length;
    progress.candidates = candidates.length;
    await report("Checking " + candidates.length + " possible chats");

    // 4. Each candidate: open, read numbers, close Details, ask Keepr.
    for (var i = 0; i < candidates.length; i++) {
      var conv = candidates[i].conversation;
      var opened = false;
      var gone = false;
      var imagesFailed = 0;
      try {
        env.overlay.show("Checking chat " + (i + 1) + " of " + candidates.length + "…", false);
        // The messages on screen before the click: the next chat is ready only
        // once this set has been replaced (the URL and title flip first).
        var before = env.scan.messageIdSet(env.doc);
        await env.openConversation(conv);
        opened = true;
        var numbers = await env.scan.readParticipantsAndClose(env.doc, { click: env.click, sleep: env.sleep });
        progress.checked += 1;
        if (!numbers || numbers.length === 0) {
          // Keepr cannot check a chat with no number on screen: report it.
          leaveOut(conv, "no_numbers");
          continue;
        }
        var match = await call("POST", base + "/match", { conversationId: conv.conversationId, numbers: numbers });
        if (!match.ok) throw new Error(messageOf(match, "Keepr could not check this chat."));
        if (!match.body || !match.body.matched) continue;

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
        leaveOut(conv, opened ? "error" : "not_opened");
      } finally {
        if (imagesFailed > 0) leaveOut(conv, "images_failed", imagesFailed);
        // Narrow window (BACKLOG-3629): the chat replaced the list; go back to
        // it so the next chat can be found. A no-op when both panes show.
        if (!gone && env.returnToList) await env.returnToList();
      }
      await report("Checked " + progress.checked + " of " + candidates.length + " chats");
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
    });
    env.overlay.show(doneText(totals, reported, more), false);
    return {
      outcome: "finished", progress: progress, totals: totals, skips: skips, history: history, notReached: notReached,
    };
  }

  var api = {
    runJob: runJob,
    jobIdFromHash: jobIdFromHash,
    waitForPageState: waitForPageState,
    NOT_SIGNED_IN: NOT_SIGNED_IN,
    RETURN_TO_KEEPR: RETURN_TO_KEEPR,
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
  function showOverlay(text, isError) {
    if (!document.body) return;
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "keepr-job-overlay";
      Object.assign(panel.style, {
        position: "fixed", top: "16px", right: "16px", zIndex: "2147483647",
        maxWidth: "360px", padding: "10px 14px", borderRadius: "10px",
        fontFamily: "system-ui, -apple-system, sans-serif", fontSize: "14px",
        boxShadow: "0 2px 10px rgba(0,0,0,0.25)",
        // The finished text lists chats left out, one per line.
        whiteSpace: "pre-line", maxHeight: "60vh", overflowY: "auto",
      });
      document.body.appendChild(panel);
    }
    panel.textContent = "Keepr: " + text;
    panel.style.background = isError ? "#fee2e2" : "#eef2ff";
    panel.style.color = isError ? "#991b1b" : "#1e1b4b";
  }

  // Page actions -------------------------------------------------------------
  function click(el) {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    el.click();
  }

  function scroller() {
    return root.KeeprScan.findListScroller(document);
  }

  async function scroll() {
    var el = scroller();
    if (el) el.scrollTop = el.scrollHeight;
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
      scroll: scroll,
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
    running = true;
    try { sessionStorage.removeItem(STORAGE_KEY); } catch (_e) { /* ignore */ }
    if (!document.body) {
      await new Promise(function (r) { document.addEventListener("DOMContentLoaded", r, { once: true }); });
    }
    try {
      await runJob(jobId, env());
    } catch (err) {
      showOverlay("The sync stopped: " + String((err && err.message) || err), true);
      await toWorker({
        type: "keepr-job-api", method: "POST", path: "/job/" + jobId + "/error",
        body: { code: "scan_failed", message: String((err && err.message) || err) },
      });
    } finally {
      running = false;
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
