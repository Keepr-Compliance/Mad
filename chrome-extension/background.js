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
// BACKLOG-3666: pairing with the signed-in Keepr app
// ---------------------------------------------------------------------------
// The protocol (pair-protocol.js) and its crypto (vendor/noble-p256.js, MIT)
// are local files of this extension: no remote code. Keepr runs the same file.
if (typeof importScripts === "function" && typeof KeeprPair === "undefined") {
  try {
    importScripts("vendor/noble-p256.js", "pair-protocol.js");
  } catch (_err) {
    // Pairing unavailable: every job call is refused (never sent unsigned).
  }
}

const PAIR_DB = "keepr-pairing";
const NOT_PAIRED =
  "Pair the extension with Keepr: open Keepr › Settings › Google Messages for the code, then type it into the Keepr box in Google Messages.";
const NOT_VERIFIED = "Keepr's reply could not be verified. Is the real Keepr app running?";

function pairLib() {
  return typeof KeeprPair !== "undefined" ? KeeprPair : null;
}

/** The pairing (pairId + a NON-extractable HMAC CryptoKey) in IndexedDB. */
const idbKeyStore = {
  open() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open(PAIR_DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore("keys");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  },
  async run(mode, fn) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const req = fn(db.transaction("keys", mode).objectStore("keys"));
      req.onsuccess = () => resolve(req.result === undefined ? null : req.result);
      req.onerror = () => reject(req.error);
    });
  },
  get() {
    return this.run("readonly", (s) => s.get("current"));
  },
  put(value) {
    return this.run("readwrite", (s) => s.put(value, "current"));
  },
  clear() {
    return this.run("readwrite", (s) => s.delete("current"));
  },
};

/** Tests replace the key store; the extension uses IndexedDB. */
function keyStore() {
  return globalThis.KeeprPairKeyStore || idbKeyStore;
}

let pairCache;
async function currentPairing() {
  if (pairCache === undefined) {
    try {
      pairCache = (await keyStore().get()) || null;
    } catch (_err) {
      pairCache = null;
    }
  }
  return pairCache;
}

async function forgetPairing() {
  pairCache = null;
  try {
    await keyStore().clear();
  } catch (_err) {
    // ignore
  }
}

function toHex(buf) {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

async function hmacHex(key, text) {
  return toHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text)));
}

/** One unsigned POST (only /pair/* and, unpaired, the dual routes). → {status, body, text, sig} */
async function rawPost(path, bodyText, headers) {
  let response;
  try {
    response = await fetch(`${BRIDGE_URL}${path}`, {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, headers || {}),
      body: bodyText,
    });
  } catch (_err) {
    return { status: 0, body: { message: NOT_RUNNING }, text: "", sig: null };
  }
  let text = "";
  try {
    text = typeof response.text === "function" ? await response.text() : JSON.stringify(await response.json());
  } catch (_err) {
    text = "";
  }
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (_err) {
    body = null;
  }
  const sig = response.headers && typeof response.headers.get === "function" ? response.headers.get("x-keepr-sig") : null;
  return { status: response.status, body, text, sig };
}

/**
 * EVERY bridge request. Paired: signed (pair id, timestamp, nonce, HMAC over
 * method, path, ts, nonce, sha256(body)) and the reply must carry Keepr's
 * signature over status, path, nonce, sha256(body) — else it is refused (a
 * process squatting Keepr's port cannot sign). "unknown_pair" / "re_pair":
 * the pairing is forgotten. Unpaired: `requirePaired` calls (every job call)
 * are refused here, never sent.
 */
async function bridgeFetch(path, bodyText, opts) {
  const P = pairLib();
  const pairing = P ? await currentPairing() : null;
  if (!pairing) {
    if (opts && opts.requirePaired) return { ok: false, status: 0, body: { error: "not_paired", message: NOT_PAIRED } };
    const r = await rawPost(path, bodyText);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, body: r.body };
  }
  const ts = String(Date.now());
  const nonce = P.newNonce();
  const sig = await hmacHex(pairing.key, P.requestString("POST", path, ts, nonce, bodyText));
  const r = await rawPost(path, bodyText, { "X-Keepr-Pair": pairing.pairId, "X-Keepr-Ts": ts, "X-Keepr-Nonce": nonce, "X-Keepr-Sig": sig });
  if (r.status === 0) return { ok: false, status: 0, body: r.body };
  // The one unsigned error: Keepr no longer knows this pairing.
  if (r.status === 401 && r.body && r.body.error === "unknown_pair") {
    await forgetPairing();
    return { ok: false, status: 401, body: { error: "not_paired", message: NOT_PAIRED } };
  }
  const expected = await hmacHex(pairing.key, P.replyString(r.status, path, nonce, r.text));
  if (!r.sig || !P.safeEqual(r.sig, expected)) {
    return { ok: false, status: 0, body: { error: "unverified", message: NOT_VERIFIED } };
  }
  if (r.status === 401 && r.body && r.body.error === "re_pair") {
    await forgetPairing();
    return { ok: false, status: 401, body: { error: "not_paired", message: NOT_PAIRED } };
  }
  return { ok: r.status >= 200 && r.status < 300, status: r.status, body: r.body };
}

/** The extension side of SPAKE2 with the code Keepr shows. → {ok} | {ok:false, error} */
async function pairWithCode(codeText) {
  const P = pairLib();
  if (!P) return { ok: false, error: "Pairing isn't available in this extension." };
  const code = P.normalizeCode(codeText);
  if (!code) return { ok: false, error: "Type the 8-character code Keepr shows." };
  const a = P.startA(code);
  const s = await rawPost("/pair/start", JSON.stringify({ pA: a.pA }));
  if (s.status === 0) return { ok: false, error: NOT_RUNNING };
  if (s.status !== 200 || !s.body || typeof s.body.pairId !== "string") {
    return { ok: false, error: (s.body && s.body.message) || "Keepr refused the code. Show a new one in Keepr." };
  }
  let f;
  try {
    f = P.finishA(a.state, s.body.pB, s.body.cB);
  } catch (_err) {
    // Live (E): a wrong code caught here is told to Keepr, so Keepr's count is
    // right — the 5th wrong try uses the code up at once (Keepr says so).
    const told = await rawPost("/pair/finish", JSON.stringify({ pairId: s.body.pairId, cA: "wrong" }));
    if (told.status === 429 && told.body && told.body.message) return { ok: false, error: told.body.message };
    return { ok: false, error: "That code didn't match. Check the code in Keepr and try again." };
  }
  const key = await crypto.subtle.importKey("raw", fromHex(P.sessionKey(f.ke, s.body.pairId)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const nonce = P.newNonce();
  const fin = await rawPost("/pair/finish", JSON.stringify({ pairId: s.body.pairId, cA: f.cA, nonce }));
  if (fin.status !== 200) return { ok: false, error: (fin.body && fin.body.message) || "Keepr refused the pairing." };
  const expected = await hmacHex(key, P.replyString(200, "/pair/finish", nonce, fin.text));
  if (!fin.sig || !P.safeEqual(fin.sig, expected)) return { ok: false, error: NOT_VERIFIED };
  const pairing = { pairId: s.body.pairId, key, pairedAt: Date.now() };
  await keyStore().put(pairing);
  pairCache = pairing;
  return { ok: true };
}

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
  // BACKLOG-3666: job calls only when paired, always signed.
  return bridgeFetch(path, body === undefined ? "" : JSON.stringify(body), { requirePaired: true });
}

// ---------------------------------------------------------------------------
// Idle chip (founder, 2026-10-02): "Last sync: …" — this extension's OWN
// record of when a Sync last finished (a /job/<id>/finish Keepr answered).
// Nothing new is asked of Keepr; it never leaves this browser.
// ---------------------------------------------------------------------------
const LAST_SYNC_KEY = "keepr-last-sync-at";
const FINISH_ROUTE = /^\/job\/[^/]+\/finish$/;

async function noteSyncFinished(path, reply) {
  if (!reply || !reply.ok || !FINISH_ROUTE.test(String(path))) return;
  try {
    if (chrome.storage && chrome.storage.local) await chrome.storage.local.set({ [LAST_SYNC_KEY]: Date.now() });
  } catch (_err) {
    // Not kept: the chip just shows no time.
  }
}

async function lastSyncAt() {
  try {
    if (!chrome.storage || !chrome.storage.local) return { ok: true, at: null };
    const stored = await chrome.storage.local.get(LAST_SYNC_KEY);
    const at = stored && typeof stored[LAST_SYNC_KEY] === "number" ? stored[LAST_SYNC_KEY] : null;
    return { ok: true, at };
  } catch (_err) {
    return { ok: true, at: null };
  }
}

/** POST /focus: Keepr brings itself to the front. Resolves {ok}. */
async function focusKeepr() {
  const r = await bridgeFetch("/focus", "", {});
  return r.status === 200 ? { ok: true } : { ok: false, error: (r.body && r.body.message) || NOT_RUNNING };
}

// ---------------------------------------------------------------------------
// BACKLOG-3658: presence (a Sync is always started from Keepr)
// ---------------------------------------------------------------------------

/** One POST to a non-job bridge route. Always resolves {ok, status, body}. */
async function postBridge(path, body) {
  return bridgeFetch(path, JSON.stringify(body || {}), {});
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

/**
 * A Sync's tab: Chrome must not discard it while the run is on (a hidden tab
 * now syncs on). The tab's own setting is remembered and put back after.
 */
const keptTabs = new Map();
async function keepTab(tab, keep) {
  if (!tab || typeof tab.id !== "number") return { ok: false };
  try {
    if (keep) {
      if (!keptTabs.has(tab.id)) keptTabs.set(tab.id, tab.autoDiscardable !== false);
      await chrome.tabs.update(tab.id, { autoDiscardable: false });
    } else {
      const before = keptTabs.has(tab.id) ? keptTabs.get(tab.id) : true;
      keptTabs.delete(tab.id);
      await chrome.tabs.update(tab.id, { autoDiscardable: before });
    }
    return { ok: true };
  } catch (_err) {
    return { ok: false }; // the tab is gone: nothing to keep
  }
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
      jobApi(message.method, message.path, message.body)
        .then(async (reply) => {
          await noteSyncFinished(message.path, reply);
          return reply;
        })
        .then(sendResponse, fail);
      return true;
    case "keepr-pair":
      // BACKLOG-3666: the code typed into the Keepr box or the options page.
      pairWithCode(String(message.code || "")).then(sendResponse, fail);
      return true;
    case "keepr-pair-status":
      currentPairing().then((p) => sendResponse({ ok: true, paired: !!p }), fail);
      return true;
    case "keepr-last-sync":
      // The idle chip's "Last sync: …" (this extension's own record).
      lastSyncAt().then(sendResponse, fail);
      return true;
    case "keepr-check-pending":
      jobApi("POST", "/job/pending").then(sendResponse, fail);
      return true;
    case "keepr-job-found":
      routeJob(message.jobId, sender.tab).then(sendResponse, fail);
      return true;
    case "keepr-keep-tab":
      // Founder (2026-10-03): the job's tab is not auto-discarded while a run is on.
      keepTab(sender && sender.tab, message.keep === true).then(sendResponse, fail);
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

// SR K (2026-10-02): the eye's keyboard command ("toggle-eye", Alt+Shift+E by
// default, remappable at chrome://extensions/shortcuts) goes to the active
// Google Messages tab, which switches the focused / selected chat.
async function routeEyeCommand(command) {
  if (command !== "toggle-eye") return false;
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ active: true, currentWindow: true, url: "https://messages.google.com/web/*" });
  } catch (_err) {
    tabs = [];
  }
  const tab = tabs[0];
  if (!tab || tab.id === undefined) return false;
  try {
    chrome.tabs.sendMessage(tab.id, { type: "keepr-eye-toggle" }, () => void chrome.runtime.lastError);
  } catch (_err) {
    return false;
  }
  return true;
}
if (chrome.commands && chrome.commands.onCommand) {
  chrome.commands.onCommand.addListener((command) => {
    void routeEyeCommand(command);
  });
}

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
