/**
 * Keepr — service worker (BACKLOG-3619 POC; BACKLOG-3620 Sync jobs).
 *
 * The ONLY part of the extension that talks to the Keepr desktop app: the
 * page's Sync job (job.js) asks it to post to the loopback bridge. A fetch
 * from here carries `Origin: chrome-extension://<this extension's id>`, which
 * is the only origin the bridge accepts. (A fetch from the content script would
 * carry the messages.google.com origin and be refused.) Only a POST is sure to
 * carry that Origin — Chrome on Windows sends a GET from here without one —
 * so every call is a POST (BACKLOG-3628).
 *
 * Every outcome comes back to the page as either { ok: true, ... } or
 * { ok: false, error } — there is no silent success.
 */

const BRIDGE_URL = "http://127.0.0.1:38619";
const SYNC_LOG_PREFIX = "[Keepr Sync]";

const NOT_RUNNING =
  "Keepr isn't reachable. Make sure the Keepr app is open and its import bridge is running.";

// ---------------------------------------------------------------------------
// BACKLOG-3620: Sync jobs
// ---------------------------------------------------------------------------

/**
 * One request to a /job/... route. Always resolves {ok, status, body}.
 *
 * POST only (BACKLOG-3628): Chrome on Windows sends a GET from this worker
 * without an Origin header, and Keepr refuses any request without its Origin.
 * A caller asking for any other method is refused here, before any request.
 */
async function jobApi(method, path, body) {
  if (method !== "POST") {
    return { ok: false, status: 0, body: { message: "Refused: Keepr job calls are POST only." } };
  }
  if (typeof path !== "string" || !path.startsWith("/job/")) {
    return { ok: false, status: 0, body: { message: "Refused: not a job route." } };
  }
  let response;
  try {
    response = await fetch(`${BRIDGE_URL}${path}`, {
      method: "POST",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (_err) {
    return { ok: false, status: 0, body: { message: NOT_RUNNING } };
  }
  let parsed = null;
  try {
    parsed = await response.json();
  } catch (_err) {
    parsed = null;
  }
  return { ok: response.status >= 200 && response.status < 300, status: response.status, body: parsed };
}

/** POST /focus: Keepr brings itself to the front. Resolves {ok}. */
async function focusKeepr() {
  try {
    const response = await fetch(`${BRIDGE_URL}/focus`, { method: "POST" });
    return { ok: response.status === 200 };
  } catch (_err) {
    return { ok: false, error: NOT_RUNNING };
  }
}

// ---------------------------------------------------------------------------
// BACKLOG-3658: presence (a Sync is always started from Keepr)
// ---------------------------------------------------------------------------

/** One POST to a non-job bridge route. Always resolves {ok, status, body}. */
async function postBridge(path, body) {
  let response;
  try {
    response = await fetch(`${BRIDGE_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
  } catch (_err) {
    return { ok: false, status: 0, body: { message: NOT_RUNNING } };
  }
  let parsed = null;
  try {
    parsed = await response.json();
  } catch (_err) {
    parsed = null;
  }
  return { ok: response.status >= 200 && response.status < 300, status: response.status, body: parsed };
}

/** A hello of each kind goes out at most once a minute (the worker restarts often). */
const HELLO_EVERY_MS = 60 * 1000;
const lastHelloAt = {};

async function helloSentRecently(kind, nowMs) {
  const key = "keepr-hello-" + kind;
  let last = lastHelloAt[kind];
  try {
    if (last === undefined && chrome.storage && chrome.storage.session) {
      const stored = await chrome.storage.session.get(key);
      last = stored && typeof stored[key] === "number" ? stored[key] : undefined;
    }
  } catch (_err) {
    // No session storage: the in-memory time still throttles this worker.
  }
  if (last !== undefined && nowMs - last < HELLO_EVERY_MS) return true;
  lastHelloAt[kind] = nowMs;
  try {
    if (chrome.storage && chrome.storage.session) await chrome.storage.session.set({ [key]: nowMs });
  } catch (_err) {
    // ignore
  }
  return false;
}

function extensionVersion() {
  try {
    return chrome.runtime.getManifest().version;
  } catch (_err) {
    return undefined;
  }
}

/**
 * POST /hello: the extension is installed ({version}), or a signed-in Messages
 * page is open ({paired:true}). No user data in either.
 */
async function sayHello(paired) {
  const kind = paired ? "paired" : "version";
  if (await helloSentRecently(kind, Date.now())) return { ok: true, throttled: true };
  const body = { version: extensionVersion() };
  if (paired) body.paired = true;
  return postBridge("/hello", body);
}

function askTab(tabId, message) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(response || null);
      });
    } catch (_err) {
      resolve(null);
    }
  });
}

/**
 * A new Messages tab found a job. If another Messages tab is already signed in,
 * run the job there (a second tab lands on the sign-in page — observed), bring
 * it forward and close the new tab. Otherwise the new tab runs it.
 */
async function routeJob(jobId, senderTab) {
  if (!senderTab || senderTab.id === undefined) return { handedOff: false };
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: "https://messages.google.com/web/*" });
  } catch (_err) {
    tabs = [];
  }
  for (const tab of tabs) {
    if (tab.id === undefined || tab.id === senderTab.id) continue;
    const state = await askTab(tab.id, { type: "keepr-ping" });
    // A tab still running another job would drop this one.
    if (!state || !state.signedIn || state.running) continue;
    const accepted = await askTab(tab.id, { type: "keepr-run-job", jobId });
    if (!accepted || !accepted.ok) continue;
    try {
      await chrome.tabs.update(tab.id, { active: true });
      if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
      await chrome.tabs.remove(senderTab.id);
    } catch (_err) {
      // The job is running in the other tab either way.
    }
    return { handedOff: true };
  }
  return { handedOff: false };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return false;
  // Only accept messages from this extension's own content scripts.
  if (sender.id !== chrome.runtime.id) return false;

  const fail = (err) => sendResponse({ ok: false, error: String((err && err.message) || err) });

  switch (message.type) {
    case "keepr-job-api":
      jobApi(message.method, message.path, message.body).then(sendResponse, fail);
      return true;
    case "keepr-check-pending":
      jobApi("POST", "/job/pending").then(sendResponse, fail);
      return true;
    case "keepr-job-found":
      routeJob(message.jobId, sender.tab).then(sendResponse, fail);
      return true;
    case "keepr-focus":
      // BACKLOG-3641: the overlay's "Open Keepr" button.
      focusKeepr().then(sendResponse, fail);
      return true;
    case "keepr-hello":
      // BACKLOG-3658: a signed-in Messages page is open.
      sayHello(message.paired === true).then(sendResponse, fail);
      return true;
    case "keepr-exclusions-list":
      // BACKLOG-3658 P3c: the conversation ids switched off (ids only).
      postBridge("/exclusions/list", {}).then(sendResponse, fail);
      return true;
    case "keepr-exclusions-set":
      postBridge("/exclusions/set", {
        conversationId: String(message.conversationId || "").slice(0, 200),
        excluded: message.excluded === true,
      }).then(sendResponse, fail);
      return true;
    case "keepr-log":
      // BACKLOG-3641: the Sync step log, for the founder to copy from this
      // worker's console. The page sends shapes and hashes only (job.js).
      console.log(SYNC_LOG_PREFIX + " " + String(message.line).slice(0, 1000));
      sendResponse({ ok: true });
      return false;
    default:
      return false;
  }
});

// BACKLOG-3658 P3b: on first install, show the first-run page (what the
// extension does; the consent itself is given in Keepr).
if (chrome.runtime.onInstalled) {
  chrome.runtime.onInstalled.addListener((details) => {
    if (details && details.reason === "install" && chrome.runtime.openOptionsPage) {
      try {
        void chrome.runtime.openOptionsPage();
      } catch (_err) {
        // The page is reachable from the Extensions page anyway.
      }
    }
  });
}

// BACKLOG-3658: the worker started (install, browser start, or a wake-up):
// tell Keepr the extension is installed. At most once a minute.
void sayHello(false).catch(() => {});
