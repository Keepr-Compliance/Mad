/**
 * Keepr — content script (BACKLOG-3619 POC).
 *
 * On a Messages for Web conversation page, shows a "Send to Keepr" button.
 * Clicking it extracts every message the page has loaded (extract.js, loaded
 * before this file) and hands the chat to the service worker, which posts it
 * to the Keepr desktop app. The result — "Sent N messages" or the error — is
 * shown next to the button.
 *
 * BACKLOG-3658: also a "Sync to Keepr" button on every Messages page. It is
 * always shown; when Keepr cannot start a Sync now it is disabled and says
 * why (Keepr's POST /cache/status answers ready, or a reason — no user data).
 *
 * This script never contacts Keepr itself.
 */
(function () {
  "use strict";

  var SYNC_LABEL = "Sync to Keepr";
  var SYNC_HINTS = {
    not_opted_in: "Turn on in Keepr: Dashboard → Sync Android",
    signed_out: "Sign in to Keepr first",
    busy: "Keepr is busy — try again in a moment",
    unreachable: "Open Keepr to sync",
    page_signed_out: "Sign in to Google Messages first",
  };

  /**
   * The page's "Sync to Keepr" button: label, disabled, and the hint under it.
   * @param {{running: boolean, starting: boolean, pageSignedIn: boolean,
   *   status: null | {ok: boolean, body?: {ready?: boolean, reason?: string}}}} s
   */
  function syncButtonState(s) {
    if (s.running) return { label: "Sync running…", disabled: true, hint: "" };
    if (s.starting) return { label: "Starting…", disabled: true, hint: "" };
    if (!s.pageSignedIn) return { label: SYNC_LABEL, disabled: true, hint: SYNC_HINTS.page_signed_out };
    if (!s.status || !s.status.ok || !s.status.body) return { label: SYNC_LABEL, disabled: true, hint: SYNC_HINTS.unreachable };
    if (s.status.body.ready === true) return { label: SYNC_LABEL, disabled: false, hint: "" };
    var hint = SYNC_HINTS[s.status.body.reason] || SYNC_HINTS.busy;
    return { label: SYNC_LABEL, disabled: true, hint: hint };
  }

  /** A refused start (403/409/503): Keepr's reason as the page hint. */
  function startRefusalHint(reply) {
    var body = (reply && reply.body) || {};
    if (body.error === "not_opted_in") return SYNC_HINTS.not_opted_in;
    if (body.error === "signed_out") return SYNC_HINTS.signed_out;
    if (body.error === "already_syncing" || body.error === "busy") return SYNC_HINTS.busy;
    if (!reply || reply.status === 0) return SYNC_HINTS.unreachable;
    return typeof body.message === "string" ? body.message.slice(0, 200) : "Keepr could not start the sync.";
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { syncButtonState: syncButtonState, startRefusalHint: startRefusalHint, SYNC_HINTS: SYNC_HINTS };
    return;
  }

  if (window.__keeprSendInstalled) return;
  window.__keeprSendInstalled = true;

  const CONVERSATION_PATH = /\/web\/conversations\/[^/?#]+/;

  const container = document.createElement("div");
  container.id = "keepr-send-container";
  Object.assign(container.style, {
    position: "fixed",
    right: "24px",
    bottom: "96px",
    zIndex: "2147483647",
    display: "none",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: "6px",
    fontFamily: "system-ui, -apple-system, sans-serif",
  });

  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Send to Keepr";
  Object.assign(button.style, {
    padding: "8px 14px",
    borderRadius: "18px",
    border: "none",
    background: "#4f46e5",
    color: "#fff",
    fontSize: "14px",
    fontWeight: "600",
    cursor: "pointer",
    boxShadow: "0 2px 6px rgba(0,0,0,0.25)",
  });

  const status = document.createElement("div");
  Object.assign(status.style, {
    display: "none",
    maxWidth: "280px",
    padding: "6px 10px",
    borderRadius: "8px",
    fontSize: "13px",
    boxShadow: "0 1px 4px rgba(0,0,0,0.2)",
  });

  container.appendChild(status);
  container.appendChild(button);

  function showStatus(text, isError) {
    status.textContent = text;
    status.style.display = "block";
    status.style.background = isError ? "#fee2e2" : "#dcfce7";
    status.style.color = isError ? "#991b1b" : "#166534";
  }

  function mount() {
    if (!container.isConnected && document.body) document.body.appendChild(container);
    container.style.display = CONVERSATION_PATH.test(location.pathname) ? "flex" : "none";
  }

  function sendToWorker(chat) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: "keepr-send-chat", chat }, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message || "Extension error" });
            return;
          }
          resolve(response || { ok: false, error: "No response from the extension." });
        });
      } catch (err) {
        resolve({ ok: false, error: String((err && err.message) || err) });
      }
    });
  }

  // BACKLOG-3661: no manual Send while a Sync runs in this tab (job.js).
  let sending = false;
  function syncRunning() {
    return !!(globalThis.KeeprSyncState && globalThis.KeeprSyncState.running);
  }
  function refreshButton() {
    const syncing = syncRunning();
    button.disabled = sending || syncing;
    button.style.opacity = button.disabled ? "0.6" : "1";
    button.textContent = syncing ? "Sync running…" : "Send to Keepr";
  }

  button.addEventListener("click", async () => {
    if (sending || syncRunning()) {
      refreshButton();
      return;
    }
    sending = true;
    button.disabled = true;
    button.style.opacity = "0.6";
    try {
      const extracted = globalThis.KeeprExtract.extractConversation(document, location.href, new Date());
      if (!extracted.conversationId) {
        showStatus("Couldn't read this conversation's id from the page address.", true);
        return;
      }
      if (extracted.messages.length === 0) {
        showStatus("No messages found on the page. Scroll the conversation and try again.", true);
        return;
      }
      // BACKLOG-3630: Keepr keys a chat on its participants' phone numbers, read
      // from the chat's Details panel (opened and closed here).
      showStatus("Reading the chat's phone numbers…", false);
      let numbers = [];
      try {
        numbers = await globalThis.KeeprScan.readParticipantsAndClose(document, {
          click: (el) => {
            el.dispatchEvent(new globalThis.MouseEvent("mousedown", { bubbles: true }));
            el.dispatchEvent(new globalThis.MouseEvent("mouseup", { bubbles: true }));
            el.click();
          },
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        });
      } catch (_err) {
        numbers = [];
      }
      const participants = numbers.rows || numbers.map((n) => ({ name: "", number: n }));
      if (participants.length === 0) {
        // BACKLOG-3664: an AI chat (Gemini) has no Details or number.
        showStatus(
          numbers.kind === "not_text"
            ? "This isn't a text conversation, so there is nothing to send"
            : "Open the chat's Details: no phone number found",
          true,
        );
        return;
      }
      showStatus(`Sending ${extracted.messages.length} messages…`, false);
      // Manual send is text, files and reactions only: image bytes are sent
      // by a Sync job (BACKLOG-3620). A message with only an image is left out.
      const messages = extracted.messages
        .map((m) => ({
          msgId: m.msgId,
          direction: m.direction,
          sender: m.sender,
          text: m.text,
          sentAt: m.sentAt,
          transport: m.transport,
          images: 0,
          files: m.files,
          reactions: m.reactions,
        }))
        .filter((m) => m.text.length > 0 || m.files.length > 0);
      if (messages.length === 0) {
        showStatus("No text messages found on the page. Scroll the conversation and try again.", true);
        return;
      }
      const result = await sendToWorker({
        conversationId: extracted.conversationId,
        title: extracted.title,
        messages,
        participants,
      });
      if (result.ok) {
        const skipped = extracted.skipped.noDate + extracted.skipped.noText;
        showStatus(
          `Sent ${result.received} messages (${result.stored} new)` +
            (skipped > 0 ? `; ${skipped} not sent (no text or no date)` : "") +
            ".",
          false,
        );
      } else {
        showStatus(result.error || "Keepr could not save this chat.", true);
      }
    } catch (err) {
      showStatus(`Couldn't read this conversation: ${String((err && err.message) || err)}`, true);
    } finally {
      sending = false;
      refreshButton();
    }
  });

  // ---------------------------------------------------------------------------
  // BACKLOG-3658: "Sync to Keepr" (one button per page; createElement only)
  // ---------------------------------------------------------------------------
  const syncBox = document.createElement("div");
  syncBox.id = "keepr-sync-container";
  Object.assign(syncBox.style, {
    position: "fixed",
    left: "24px",
    bottom: "24px",
    zIndex: "2147483647",
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: "4px",
    fontFamily: "system-ui, -apple-system, sans-serif",
  });
  const syncButton = document.createElement("button");
  syncButton.type = "button";
  syncButton.setAttribute("data-keepr", "sync-to-keepr");
  syncButton.textContent = SYNC_LABEL;
  Object.assign(syncButton.style, {
    padding: "8px 14px",
    borderRadius: "18px",
    border: "none",
    background: "#4f46e5",
    color: "#fff",
    fontSize: "14px",
    fontWeight: "600",
    cursor: "pointer",
    boxShadow: "0 2px 6px rgba(0,0,0,0.25)",
  });
  const syncHint = document.createElement("div");
  syncHint.setAttribute("data-keepr", "sync-hint");
  Object.assign(syncHint.style, {
    display: "none",
    maxWidth: "260px",
    padding: "4px 8px",
    borderRadius: "6px",
    fontSize: "12px",
    background: "#f3f4f6",
    color: "#374151",
    boxShadow: "0 1px 3px rgba(0,0,0,0.15)",
  });
  syncBox.appendChild(syncHint);
  syncBox.appendChild(syncButton);

  let cacheStatus = null;
  let starting = false;
  let refusal = "";
  let statusAt = 0;
  const STATUS_EVERY_MS = 10 * 1000;

  function toWorker(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, status: 0, body: null });
            return;
          }
          resolve(response || { ok: false, status: 0, body: null });
        });
      } catch (_err) {
        resolve({ ok: false, status: 0, body: null });
      }
    });
  }

  function pageSignedIn() {
    return !!(globalThis.KeeprScan && globalThis.KeeprScan.signInState(location.pathname) === "signed_in");
  }

  function renderSync() {
    // One button per page, whatever re-runs this script (SR: single injection).
    if (!syncBox.isConnected && document.body && !document.getElementById(syncBox.id)) {
      document.body.appendChild(syncBox);
    }
    const state = syncButtonState({
      running: syncRunning(),
      starting,
      pageSignedIn: pageSignedIn(),
      status: cacheStatus,
    });
    syncButton.disabled = state.disabled;
    syncButton.style.opacity = state.disabled ? "0.6" : "1";
    syncButton.style.cursor = state.disabled ? "default" : "pointer";
    syncButton.textContent = state.label;
    const hint = refusal || state.hint;
    syncHint.textContent = hint;
    syncHint.style.display = hint ? "block" : "none";
  }

  async function refreshCacheStatus(force) {
    if (!force && Date.now() - statusAt < STATUS_EVERY_MS) return;
    statusAt = Date.now();
    if (pageSignedIn()) void toWorker({ type: "keepr-hello", paired: true });
    cacheStatus = await toWorker({ type: "keepr-cache-status" });
    if (cacheStatus && cacheStatus.ok && cacheStatus.body && cacheStatus.body.ready) refusal = "";
    renderSync();
  }

  syncButton.addEventListener("click", async () => {
    if (syncButton.disabled || starting || syncRunning()) return;
    starting = true;
    refusal = "";
    renderSync();
    try {
      const reply = await toWorker({ type: "keepr-cache-start" });
      if (!reply || !reply.ok) refusal = startRefusalHint(reply);
    } finally {
      starting = false;
      await refreshCacheStatus(true);
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void refreshCacheStatus(true);
  });

  // Messages for Web is a single-page app: re-check the address as it changes.
  // Loaded at document_start (BACKLOG-3620), so body may not exist yet;
  // mount() waits for it and the interval below retries.
  mount();
  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      status.style.display = "none";
    }
    mount();
    refreshButton();
    renderSync();
    void refreshCacheStatus(false);
  }, 1000);
})();
