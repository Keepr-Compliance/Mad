/**
 * BACKLOG-3628 — the extension service worker talks to Keepr with POST only.
 *
 * Chrome on Windows (Chrome 154) sends a GET from an extension service worker
 * WITHOUT an Origin header, and Keepr's bridge refuses any request without its
 * pinned Origin. So the pending check is a POST, and a page asking the worker
 * for any other method is refused before a request is made.
 *
 * Runs chrome-extension/background.js (the file the extension loads) with a
 * stubbed `chrome` and `fetch`.
 *
 * Mutations that turn this suite red:
 *   - the pending check back to `jobApi("GET", "/job/pending")`;
 *   - drop the `method !== "POST"` refusal in jobApi (a page-supplied GET is
 *     forwarded);
 *   - `method` taken from the caller again in the fetch options.
 */

import * as fs from "fs";
import * as path from "path";

type Listener = (
  message: Record<string, unknown>,
  sender: { id: string; url?: string; tab?: { id: number; url?: string } },
  sendResponse: (reply: unknown) => void,
) => boolean;

import { installPairing, signedReply, uninstallPairing } from "./helpers/pairedWorker";

afterEach(() => uninstallPairing());

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "..", "chrome-extension", "background.js"), "utf8");
const EXTENSION_ID = "nlfohmjehedijceeelokclkglmjnlonj";

async function loadWorker(opts: { storage?: Record<string, unknown>; paired?: boolean } = {}) {
  // BACKLOG-3666: job calls need a pairing (paired: replies are signed as Keepr signs them).
  await installPairing(!!opts.paired);
  let listener: Listener | null = null;
  const chromeStub = {
    runtime: {
      id: EXTENSION_ID,
      onMessage: { addListener: (fn: Listener) => (listener = fn) },
      getManifest: () => ({ version: "9.9.9" }),
    },
    storage: opts.storage
      ? {
          session: {
            get: async (key: string) => (key in opts.storage! ? { [key]: opts.storage![key] } : {}),
            set: async (items: Record<string, unknown>) => {
              Object.assign(opts.storage!, items);
            },
          },
        }
      : undefined,
    tabs: { query: jest.fn(async () => []), sendMessage: jest.fn(), update: jest.fn(), remove: jest.fn() },
    windows: { update: jest.fn() },
  };
  // Typed loosely: tests answer with different bodies (BACKLOG-3641 focus).
  const fetchStub = jest.fn(
    async (url: string, init: { method: string; headers?: Record<string, string> }): Promise<{ status: number; json: () => Promise<Record<string, unknown>> }> =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a signed Response-like stub
      signedReply(url, init, 404, { error: "no_job" }) as any,
  );
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function("chrome", "fetch", SOURCE)(chromeStub, fetchStub);
  if (!listener) throw new Error("background.js registered no message listener");
  const registered: Listener = listener;

  function send(
    message: Record<string, unknown>,
    sender: { id: string; url?: string; tab?: { id: number; url?: string } } = { id: EXTENSION_ID, tab: { id: 1 } },
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      const async = registered(message, sender, (reply) =>
        resolve(reply as Record<string, unknown>),
      );
      if (!async) resolve({ sync: true });
    });
  }
  // BACKLOG-3658: the worker says hello on start; tests below see only their own calls.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  const startupCalls = fetchStub.mock.calls.slice();
  fetchStub.mockClear();
  return { send, fetchStub, startupCalls, chromeStub };
}

// Live (founder): Keepr's "Open Google Messages" (#keepr-link). An already
// signed-in Messages tab comes to the front, the new tab closes, the link
// window opens; with none, the new tab stays. Mutations: a not-signed-in tab
// chosen; the new tab not closed; no link window → red.
describe("service worker: keepr-link-found", () => {
  const NEW_TAB = { id: EXTENSION_ID, url: "https://messages.google.com/web/conversations#keepr-link", tab: { id: 50, url: "https://messages.google.com/web/conversations#keepr-link" } };
  async function setup(other: Array<{ id: number; windowId: number; signedIn: boolean }>, paired = false) {
    const w = await loadWorker({ paired });
    const tabs = w.chromeStub.tabs as unknown as Record<string, jest.Mock>;
    tabs.query = jest.fn(async () => [{ id: 50, windowId: 1 }, ...other.map((o) => ({ id: o.id, windowId: o.windowId }))]);
    tabs.sendMessage = jest.fn((id: number, _m: unknown, cb: (r: unknown) => void) => cb({ signedIn: other.find((o) => o.id === id)?.signedIn ?? false, running: false }));
    tabs.update = jest.fn(async () => undefined);
    tabs.remove = jest.fn(async () => undefined);
    const created: unknown[] = [];
    (w.chromeStub.runtime as Record<string, unknown>).getURL = (p: string) => "chrome-extension://x/" + p;
    (w.chromeStub as Record<string, unknown>).windows = {
      update: jest.fn(async () => undefined),
      create: jest.fn(async (o: unknown) => {
        created.push(o);
        return { id: 9 };
      }),
      getCurrent: jest.fn(async () => ({})),
    };
    return { w, tabs, created };
  }

  it("a signed-in Messages tab: brought forward, the new tab closed, the link window opened", async () => {
    const { w, tabs, created } = await setup([{ id: 7, windowId: 2, signedIn: false }, { id: 8, windowId: 3, signedIn: true }]);
    expect(await w.send({ type: "keepr-link-found", screen: {} }, NEW_TAB)).toEqual({ handedOff: true });
    expect(tabs.update).toHaveBeenCalledWith(8, { active: true });
    expect(tabs.update).not.toHaveBeenCalledWith(7, { active: true });
    expect(tabs.remove).toHaveBeenCalledWith(50);
    expect(created).toHaveLength(1);
  });

  // SR: already linked (a link key held) → the popup's linked view, never a
  // new link session. Mutation: the autolink page while linked → red.
  it("already linked: the tab comes forward and the window shows the linked view (no autolink)", async () => {
    const { w, created } = await setup([{ id: 8, windowId: 3, signedIn: true }], true);
    expect(await w.send({ type: "keepr-link-found", screen: {} }, NEW_TAB)).toEqual({ handedOff: true });
    expect(created).toHaveLength(1);
    expect((created[0] as { url: string }).url).toBe("chrome-extension://x/popup.html");
    expect(w.fetchStub.mock.calls.some(([u]) => String(u).includes("/link/start"))).toBe(false);
  });

  it("not linked: the link window (autolink)", async () => {
    const { w, created } = await setup([{ id: 8, windowId: 3, signedIn: true }]);
    await w.send({ type: "keepr-link-found", screen: {} }, NEW_TAB);
    expect((created[0] as { url: string }).url).toBe("chrome-extension://x/popup.html?autolink=1");
  });

  // SR: one helper for both routes. Mutation: a route with its own tab scan → red.
  it("routeJob and routeLink share signedInMessagesTabs / moveToTab", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const src = (require("fs") as typeof import("fs")).readFileSync(require("path").join(__dirname, "..", "..", "chrome-extension", "background.js"), "utf8").replace(/\r\n/g, "\n");
    for (const fn of ["routeJob", "routeLink"]) {
      const body = src.slice(src.indexOf("async function " + fn + "("), src.indexOf("\n}\n", src.indexOf("async function " + fn + "(")));
      expect(body).toContain("signedInMessagesTabs(senderTab.id)");
      expect(body).toContain("moveToTab(");
      expect(body).not.toContain("chrome.tabs.query");
    }
  });

  it("no signed-in Messages tab: the new tab stays, nothing opened here", async () => {
    const { w, tabs, created } = await setup([{ id: 7, windowId: 2, signedIn: false }]);
    expect(await w.send({ type: "keepr-link-found", screen: {} }, NEW_TAB)).toEqual({ handedOff: false });
    expect(tabs.remove).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
  });
});

// Live A/B (Step A): a running Sync's waits are answered from the worker's
// own timer. Only from a messages.google.com tab of this extension; capped.
// Mutations: the origin check removed; no cap → red.
describe("service worker: keepr-wake (paced waits)", () => {
  const MSG_TAB = { id: EXTENSION_ID, url: "https://messages.google.com/web/conversations", tab: { id: 1, url: "https://messages.google.com/web/conversations" } };
  it("answers after its own timer; only for a Messages tab; capped at 60 s", async () => {
    const w = await loadWorker();
    jest.useFakeTimers();
    try {
      let answered: Record<string, unknown> | null = null;
      void w.send({ type: "keepr-wake", ms: 250 }, MSG_TAB).then((r) => (answered = r));
      jest.advanceTimersByTime(249);
      await Promise.resolve();
      expect(answered).toBeNull();
      jest.advanceTimersByTime(1);
      await Promise.resolve();
      expect(answered).toEqual({ ok: true });
      let capped: Record<string, unknown> | null = null;
      void w.send({ type: "keepr-wake", ms: 10 * 60_000 }, MSG_TAB).then((r) => (capped = r));
      jest.advanceTimersByTime(60_000);
      await Promise.resolve();
      expect(capped).toEqual({ ok: true });
    } finally {
      jest.useRealTimers();
    }
    // Another site, or no tab (an extension page): refused.
    expect(await w.send({ type: "keepr-wake", ms: 1 }, { id: EXTENSION_ID, url: "https://example.test/", tab: { id: 2, url: "https://example.test/" } })).toEqual({ sync: true });
    expect(await w.send({ type: "keepr-wake", ms: 1 }, { id: EXTENSION_ID })).toEqual({ sync: true });
  });
});

describe("service worker: POST only (BACKLOG-3628)", () => {
  it("the pending check is a POST to /job/pending", async () => {
    const w = await loadWorker({ paired: true });
    const reply = await w.send({ type: "keepr-check-pending" });
    expect(w.fetchStub).toHaveBeenCalledTimes(1);
    const [url, init] = w.fetchStub.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:38619/job/pending");
    expect(init.method).toBe("POST");
    expect(reply).toMatchObject({ ok: false, status: 404 });
  });

  it.each(["GET", "PUT", "DELETE", undefined])("a page asking for %s is refused and nothing is fetched", async (method) => {
    const w = await loadWorker();
    const reply = await w.send({ type: "keepr-job-api", method, path: "/job/pending" });
    expect(reply).toMatchObject({ ok: false, status: 0 });
    expect(w.fetchStub).not.toHaveBeenCalled();
  });

  it("a POST job call is forwarded as a POST", async () => {
    const w = await loadWorker({ paired: true });
    await w.send({
      type: "keepr-job-api",
      method: "POST",
      path: "/job/11111111-2222-4333-8444-555555555555/claim", // pii-allow-uuid: invented, not from any live row
    });
    expect(w.fetchStub).toHaveBeenCalledTimes(1);
    expect(w.fetchStub.mock.calls[0][1].method).toBe("POST");
  });

  it("a non-job path is still refused", async () => {
    const w = await loadWorker();
    const reply = await w.send({ type: "keepr-job-api", method: "POST", path: "/chat" });
    expect(reply).toMatchObject({ ok: false, status: 0 });
    expect(w.fetchStub).not.toHaveBeenCalled();
  });
});

// BACKLOG-3641. Mutation: drop the keepr-log case (or its prefix) → red.
describe("service worker: Sync step log (BACKLOG-3641)", () => {
  it("prints each page line to this worker's console with the [Keepr Sync] prefix", async () => {
    const spy = jest.spyOn(console, "log").mockImplementation(() => {});
    try {
      const w = await loadWorker();
      const reply = await w.send({ type: "keepr-log", line: "listed 60, stopReason stable" });
      expect(reply).toEqual({ ok: true });
      expect(spy).toHaveBeenCalledWith("[Keepr Sync] listed 60, stopReason stable");
      expect(w.fetchStub).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

// BACKLOG-3641. Mutation: keepr-focus not handled, or not a POST to /focus → red.
describe("service worker: Open Keepr", () => {
  it("keepr-focus POSTs /focus and reports ok", async () => {
    const w = await loadWorker();
    w.fetchStub.mockResolvedValueOnce({ status: 200, json: async () => ({ ok: true }) });
    const reply = await w.send({ type: "keepr-focus" });
    expect(w.fetchStub).toHaveBeenCalledTimes(1);
    const [url, init] = w.fetchStub.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:38619/focus");
    expect(init.method).toBe("POST");
    expect(reply).toEqual({ ok: true });
  });
});

// Live (founder 2026-10-03): Keepr refused the extension's calls
// ("signature_required") every 2 s and Open Keepr did nothing. A LINKED worker
// signs every call; an UNLINKED one, refused because Keepr has a link it
// lacks, stops asking for a minute and tells the page to launch keepr://open.
// Mutations: a linked call sent unsigned → red; no backoff after the refusal
// → red; /focus refused without "launch" → red.
describe("service worker: signed when linked; quiet when Keepr has a link it lacks", () => {
  const ROUTE_MESSAGES: Array<Record<string, unknown>> = [
    { type: "keepr-focus" },
    { type: "keepr-exclusions-list" },
    { type: "keepr-exclusions-set", conversationId: "c-1", excluded: true },
    { type: "keepr-popup-state" },
    { type: "keepr-check-pending" },
    { type: "keepr-retry" },
    { type: "keepr-hello", paired: true },
    { type: "keepr-job-api", method: "POST", path: "/job/j-1/progress", body: {} },
  ];

  it("linked: every bridge call carries the signature (fetch spy)", async () => {
    const w = await loadWorker({ paired: true });
    for (const m of ROUTE_MESSAGES) await w.send(m);
    const calls = w.startupCalls.concat(w.fetchStub.mock.calls);
    expect(calls.length).toBeGreaterThanOrEqual(ROUTE_MESSAGES.length);
    for (const [url, init] of calls) {
      expect([url, typeof (init.headers || {})["X-Keepr-Sig"]]).toEqual([url, "string"]);
    }
  });

  it("linked: Open Keepr is a signed /focus and nothing else (no tab)", async () => {
    const w = await loadWorker({ paired: true });
    w.fetchStub.mockImplementationOnce(async (url: string, init: { method: string; headers?: Record<string, string> }) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      signedReply(url, init, 200, { ok: true }) as any,
    );
    expect(await w.send({ type: "keepr-focus" })).toEqual({ ok: true });
    expect(w.fetchStub).toHaveBeenCalledTimes(1);
    expect(w.chromeStub.tabs.update).not.toHaveBeenCalled();
  });

  // SR C4 ("required"): Keepr refuses every unsigned call outside the open
  // routes, so an unlinked browser never sends one. Mutation: the gated
  // route sent unsigned again → red (fetch called).
  it("not linked: /exclusions and /status are never sent unsigned; /focus still asked (open)", async () => {
    const w = await loadWorker();
    w.fetchStub.mockImplementation(async () => ({ status: 200, json: async () => ({ ok: true }) }) as never);
    for (let i = 0; i < 5; i++) {
      const r = await w.send({ type: "keepr-exclusions-list" });
      expect(r).toMatchObject({ ok: false, status: 401, body: { error: "not_paired" } });
      expect(String((r.body as { message: string }).message)).toBe("Not linked. Click the Keepr icon in Chrome's toolbar to link.");
    }
    expect(w.fetchStub).toHaveBeenCalledTimes(0);
    // SR: /focus is open — Keepr comes forward with no OS prompt.
    expect(await w.send({ type: "keepr-focus" })).toEqual({ ok: true });
    expect(w.fetchStub).toHaveBeenCalledTimes(1);
  });

  // SR: keepr://open ONLY when Keepr is unreachable; 429 (asked twice) is done.
  // Mutations: launch on a refusal → red; 429 not ok → red.
  it("Open Keepr: launch only when Keepr is unreachable", async () => {
    const w = await loadWorker();
    const reply = (status: number) => w.fetchStub.mockImplementationOnce(async () => ({ status, json: async () => ({}) }) as never);
    reply(429);
    expect(await w.send({ type: "keepr-focus" })).toEqual({ ok: true });
    reply(500);
    expect(await w.send({ type: "keepr-focus" })).toMatchObject({ ok: false, launch: false });
    w.fetchStub.mockImplementationOnce(async () => {
      throw new Error("offline");
    });
    expect(await w.send({ type: "keepr-focus" })).toMatchObject({ ok: false, launch: true });
  });
});

// BACKLOG-3658: presence (/hello) and the page's "Sync to Keepr".
// Mutations that turn this block red: drop the startup hello; drop the
// once-a-minute throttle (or its stored time); send user data or `paired` in
// the startup hello.
describe("service worker: presence (BACKLOG-3658)", () => {
  const bodyOf = (init: unknown) => JSON.parse(String((init as { body: string }).body));

  // Live (B1): an extension with no link also says linked:false (unsigned),
  // so Keepr drops a stale row — still no user data.
  it("says hello with only its version (and 'no link here') when the worker starts", async () => {
    const w = await loadWorker();
    expect(w.startupCalls).toHaveLength(1);
    const [url, init] = w.startupCalls[0];
    expect(url).toBe("http://127.0.0.1:38619/hello");
    expect(init.method).toBe("POST");
    expect(bodyOf(init)).toEqual({ version: "9.9.9", linked: false });
  });

  it("does not say hello again within a minute of the last one (kept across worker restarts)", async () => {
    const recent = await loadWorker({ storage: { "keepr-hello-version": Date.now() - 10_000 } });
    expect(recent.startupCalls).toHaveLength(0);
    const stale = await loadWorker({ storage: { "keepr-hello-version": Date.now() - 61_000 } });
    expect(stale.startupCalls).toHaveLength(1);
  });

  it("a signed-in page says paired, once a minute", async () => {
    const w = await loadWorker();
    w.fetchStub.mockResolvedValue({ status: 200, json: async () => ({ ok: true }) });
    const first = await w.send({ type: "keepr-hello", paired: true });
    expect(first).toMatchObject({ ok: true, status: 200 });
    expect(w.fetchStub).toHaveBeenCalledTimes(1);
    expect(w.fetchStub.mock.calls[0][0]).toBe("http://127.0.0.1:38619/hello");
    expect(bodyOf(w.fetchStub.mock.calls[0][1])).toEqual({ version: "9.9.9", paired: true, linked: false });
    const second = await w.send({ type: "keepr-hello", paired: true });
    expect(second).toMatchObject({ ok: true, throttled: true });
    expect(w.fetchStub).toHaveBeenCalledTimes(1);
  });

  // Founder decision: a Sync is always started from Keepr. Mutation: bring the
  // page start/status messages back → red.
  it("the page can no longer start a Sync or ask for a button state", async () => {
    const w = await loadWorker();
    expect(await w.send({ type: "keepr-cache-start" })).toEqual({ sync: true });
    expect(await w.send({ type: "keepr-cache-status" })).toEqual({ sync: true });
    expect(w.fetchStub).not.toHaveBeenCalled();
  });
});
