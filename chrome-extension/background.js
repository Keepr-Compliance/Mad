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

// ---------------------------------------------------------------------------
// C1 (UX redesign, founder 2026-10-03): REVERSED linking. The popup's "Link"
// makes a 6-digit code HERE (never sent anywhere), starts a session with
// Keepr, and waits while the user types the code into Keepr. The session
// lives in this worker (the popup may close). 2 minutes, 5 wrong codes.
// ---------------------------------------------------------------------------
const LINK_POLL_MS = 1500;
let linkSession = null;

function linkView() {
  if (!linkSession) return { status: "none" };
  const s = linkSession;
  return {
    status: s.status, // waiting | linked | failed
    code: s.status === "waiting" ? s.code : undefined,
    expiresAt: s.expiresAt,
    triesLeft: s.triesLeft,
    error: s.error,
  };
}

function linkFailed(error) {
  if (linkSession) {
    linkSession.status = "failed";
    linkSession.error = error;
    linkSession.code = undefined;
  }
}

/** Store a new link (the old one, if any, is replaced). */
async function saveLink(pairId, key) {
  const pairing = { pairId, key, pairedAt: Date.now() };
  await keyStore().put(pairing);
  pairCache = pairing;
}

/** "Link" in the popup: a code, a session with Keepr, then wait for the user. */
async function linkStart(opts) {
  const P = pairLib();
  if (!P) return { ok: false, error: "Linking isn't available in this extension." };
  if (linkSession && linkSession.status === "waiting" && Date.now() < linkSession.expiresAt) return { ok: true, link: linkView() };
  const code = P.newLinkCode();
  const a = P.startA(code);
  const s = await rawPost("/link/start", JSON.stringify({ pA: a.pA }));
  if (s.status === 0) return { ok: false, error: NOT_RUNNING, keeprDown: true };
  if (s.status !== 200 || !s.body || typeof s.body.sessionId !== "string") {
    return { ok: false, error: (s.body && s.body.message) || "Keepr refused the link. Try again." };
  }
  const ttl = typeof s.body.expiresInMs === "number" ? s.body.expiresInMs : 120000;
  linkSession = { code, state: a.state, sessionId: s.body.sessionId, expiresAt: Date.now() + ttl, triesLeft: 5, status: "waiting", error: undefined };
  void linkPollLoop(linkSession, (opts && opts.sleep) || ((ms) => new Promise((r) => setTimeout(r, ms))));
  return { ok: true, link: linkView() };
}

/** Wait for Keepr's answer (the user typed the code there), then confirm. */
async function linkPollLoop(session, sleep) {
  const P = pairLib();
  while (linkSession === session && session.status === "waiting") {
    if (Date.now() > session.expiresAt) {
      linkFailed("That code expired. Click Link for a new one.");
      return;
    }
    const r = await rawPost("/link/poll", JSON.stringify({ sessionId: session.sessionId }));
    if (linkSession !== session) return;
    if (r.status === 0) {
      await sleep(LINK_POLL_MS);
      continue;
    }
    if (r.status === 410) return linkFailed("That code expired. Click Link for a new one.");
    if (r.status !== 200 || !r.body) return linkFailed("Keepr stopped the link. Click Link to try again.");
    if (r.body.state !== "answered") {
      await sleep(LINK_POLL_MS);
      continue;
    }
    let f;
    try {
      f = P.finishA(session.state, r.body.pB, r.body.cB);
    } catch (_err) {
      // A wrong code typed in Keepr: Keepr is told (it counts the tries).
      const told = await rawPost("/link/finish", JSON.stringify({ sessionId: session.sessionId, cA: "wrong" }));
      if (told.status === 429) return linkFailed("Too many wrong codes. Click Link for a new one.");
      if (told.body && typeof told.body.triesLeft === "number") session.triesLeft = told.body.triesLeft;
      await sleep(LINK_POLL_MS);
      continue;
    }
    const key = await crypto.subtle.importKey("raw", fromHex(P.sessionKey(f.ke, session.sessionId)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const nonce = P.newNonce();
    const fin = await rawPost("/link/finish", JSON.stringify({ sessionId: session.sessionId, cA: f.cA, nonce }));
    if (fin.status !== 200) return linkFailed("Keepr refused the link. Click Link to try again.");
    const expected = await hmacHex(key, P.replyString(200, "/link/finish", nonce, fin.text));
    if (!fin.sig || !P.safeEqual(fin.sig, expected)) return linkFailed(NOT_VERIFIED);
    await saveLink(session.sessionId, key);
    session.status = "linked";
    session.code = undefined;
    return;
  }
}

/** The popup closed linking ("Cancel"): the session is dropped here (Keepr's expires). */
function linkCancel() {
  linkSession = null;
  return { ok: true };
}

/** "Unlink" in the popup (after its confirm): Keepr revokes it (signed), then it is forgotten here. */
async function unlink() {
  const r = await bridgeFetch("/link/unlink", "{}", { requirePaired: true });
  // Forgotten here whatever Keepr said (Keepr down: it is unknown there after a new link anyway).
  await forgetPairing();
  return { ok: true, keepr: r.ok };
}

/** C2: what the popup shows, asked each time it opens (this worker may have slept). */
async function popupState() {
  const version = extensionVersion();
  const pairing = await currentPairing();
  const hello = await rawPost("/hello", JSON.stringify({ version }));
  if (hello.status === 0) return { state: "keepr_down", version, link: linkView() };
  const min = hello.body && typeof hello.body.minExtensionVersion === "string" ? hello.body.minExtensionVersion : null;
  if (min && compareVersions(version, min) < 0) return { state: "out_of_date", version, minVersion: min };
  if (linkSession && linkSession.status === "waiting") return { state: "linking", version, link: linkView() };
  if (!pairing) return { state: "not_linked", version, link: linkView() };
  const status = await bridgeFetch("/status", "{}");
  // Keepr no longer knows this link (unlinked, another browser linked): forgotten by bridgeFetch.
  if (!(await currentPairing())) return { state: "not_linked", version, link: linkView() };
  const last = await lastSyncAt();
  return {
    state: "linked",
    version,
    email: status.ok && status.body && typeof status.body.linkedEmail === "string" ? status.body.linkedEmail : null,
    lastSyncAt: last && typeof last.at === "number" ? last.at : null,
  };
}

const MESSAGES_URL = "https://messages.google.com/web/conversations";
const KEEPR_LINK_URL = "keepr://link";

/** C2 "Go to Google Messages": the open Messages tab, else a new one. */
async function openMessages() {
  try {
    const tabs = await chrome.tabs.query({ url: "https://messages.google.com/web/*" });
    if (tabs && tabs.length > 0 && typeof tabs[0].id === "number") {
      await chrome.tabs.update(tabs[0].id, { active: true });
      if (typeof tabs[0].windowId === "number" && chrome.windows) await chrome.windows.update(tabs[0].windowId, { focused: true });
      return { ok: true };
    }
    await chrome.tabs.create({ url: MESSAGES_URL });
    return { ok: true };
  } catch (_err) {
    return { ok: false };
  }
}

/**
 * C2 "Open Keepr" while Keepr is not running (or while linking): keepr://link
 * starts Keepr and opens its link screen (the OS asks the user once). The tab
 * the protocol needs is closed again.
 */
async function openApp() {
  try {
    const tab = await chrome.tabs.create({ url: KEEPR_LINK_URL, active: false });
    if (tab && typeof tab.id === "number") setTimeout(() => void chrome.tabs.remove(tab.id).catch(() => undefined), 3000);
    return { ok: true };
  } catch (_err) {
    return { ok: false };
  }
}

/** "0.3.9" < "0.3.10". Missing parts count as 0. */
function compareVersions(a, b) {
  const pa = String(a || "0").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b || "0").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * LEGACY (BACKLOG-3666 8-character codes made by Keepr): no page offers it
 * any more (C4) — the popup links (C1). Kept, with Keepr's /pair/* endpoints,
 * only until 2026-12-01 (LEGACY_PAIR_ENDPOINTS_REMOVE_AFTER; merge notes).
 * The extension side of SPAKE2 with the code Keepr shows. → {ok} | {ok:false, error}
 */
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
    case "keepr-popup-state":
      // C2: the popup asks what to show each time it opens.
      popupState().then(sendResponse, fail);
      return true;
    case "keepr-open-messages":
      openMessages().then(sendResponse, fail);
      return true;
    case "keepr-open-app":
      openApp().then(sendResponse, fail);
      return true;
    case "keepr-link-start":
      linkStart().then(sendResponse, fail);
      return true;
    case "keepr-link-state":
      sendResponse({ ok: true, link: linkView() });
      return false;
    case "keepr-link-cancel":
      sendResponse(linkCancel());
      return false;
    case "keepr-unlink":
      unlink().then(sendResponse, fail);
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
    // C4 (UX redesign): the welcome page, on install only (pin, Link, Sync from Keepr).
    if (details && details.reason === "install" && chrome.tabs && chrome.runtime.getURL) {
      try {
        void chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") });
      } catch (_err) {
        // The popup has everything anyway.
      }
    }
  });
}

// BACKLOG-3658: the worker started (install, browser start, or a wake-up):
// tell Keepr the extension is installed. At most once a minute.
void sayHello(false).catch(() => {});
