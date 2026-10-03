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
  sender: { id: string; tab?: { id: number } },
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

  function send(message: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      const async = registered(message, { id: EXTENSION_ID, tab: { id: 1 } }, (reply) =>
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
