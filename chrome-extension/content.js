/**
 * Keepr — content script (BACKLOG-3619 POC).
 *
 * On a Messages for Web conversation page, shows a "Send to Keepr" button.
 * Clicking it extracts every message the page has loaded (extract.js, loaded
 * before this file) and hands the chat to the service worker, which posts it
 * to the Keepr desktop app. The result — "Sent N messages" or the error — is
 * shown next to the button.
 *
 * BACKLOG-3658 (founder decision): no Sync button on the page — a Sync is
 * always started from Keepr. A signed-in page only tells Keepr it is paired
 * (POST /hello {paired:true}, through the worker, at most once a minute).
 *
 * This script never contacts Keepr itself.
 */
(function () {
  "use strict";

  if (window.__keeprSendInstalled) return;
  window.__keeprSendInstalled = true;

  // Founder: never two Keepr elements. A reloaded extension leaves this script
  // running in open tabs (another isolated world: the window flag above does
  // not see it). The newest instance writes its token on <html> and removes a
  // stale container; an older one sees another token and removes its own.
  const CONTAINER_ID = "keepr-send-container";
  const OWNER_ATTR = "data-keepr-send-owner";
  const INSTANCE = String(Date.now()) + "-" + Math.random().toString(36).slice(2);
  function claimPage() {
    if (document.documentElement) document.documentElement.setAttribute(OWNER_ATTR, INSTANCE);
    const stale = document.getElementById(CONTAINER_ID);
    if (stale && stale.parentNode) stale.parentNode.removeChild(stale);
  }
  function ownsPage() {
    return !!document.documentElement && document.documentElement.getAttribute(OWNER_ATTR) === INSTANCE;
  }
  claimPage();

  const CONVERSATION_PATH = /\/web\/conversations\/[^/?#]+/;

  const container = document.createElement("div");
  container.id = CONTAINER_ID;
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

  // BACKLOG-3658: a signed-in Messages page tells Keepr it is paired (the
  // worker throttles it; no user data). Once per page load.
  let pairedSent = false;
  function sayPaired() {
    if (pairedSent) return;
    if (!globalThis.KeeprScan || globalThis.KeeprScan.signInState(location.pathname) !== "signed_in") return;
    pairedSent = true;
    try {
      chrome.runtime.sendMessage({ type: "keepr-hello", paired: true }, () => {
        void chrome.runtime.lastError; // Keepr or the worker may be asleep: fine
      });
    } catch (_err) {
      // ignore
    }
  }

  // Messages for Web is a single-page app: re-check the address as it changes.
  // Loaded at document_start (BACKLOG-3620), so body may not exist yet;
  // mount() waits for it and the interval below retries.
  mount();
  let lastPath = location.pathname;
  const tick = setInterval(() => {
    if (!ownsPage()) {
      // A newer instance owns the page: step aside for good.
      if (container.parentNode) container.parentNode.removeChild(container);
      clearInterval(tick);
      return;
    }
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      status.style.display = "none";
    }
    mount();
    refreshButton();
    sayPaired();
  }, 1000);
})();
