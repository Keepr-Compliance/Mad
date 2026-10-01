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

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "..", "chrome-extension", "background.js"), "utf8");
const EXTENSION_ID = "nlfohmjehedijceeelokclkglmjnlonj";

function loadWorker() {
  let listener: Listener | null = null;
  const chromeStub = {
    runtime: {
      id: EXTENSION_ID,
      onMessage: { addListener: (fn: Listener) => (listener = fn) },
    },
    tabs: { query: jest.fn(async () => []), sendMessage: jest.fn(), update: jest.fn(), remove: jest.fn() },
    windows: { update: jest.fn() },
  };
  const fetchStub = jest.fn(async (_url: string, _init: { method: string }) => ({
    status: 404,
    json: async () => ({ error: "no_job" }),
  }));
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
  return { send, fetchStub };
}

describe("service worker: POST only (BACKLOG-3628)", () => {
  it("the pending check is a POST to /job/pending", async () => {
    const w = loadWorker();
    const reply = await w.send({ type: "keepr-check-pending" });
    expect(w.fetchStub).toHaveBeenCalledTimes(1);
    const [url, init] = w.fetchStub.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:38619/job/pending");
    expect(init.method).toBe("POST");
    expect(reply).toMatchObject({ ok: false, status: 404 });
  });

  it.each(["GET", "PUT", "DELETE", undefined])("a page asking for %s is refused and nothing is fetched", async (method) => {
    const w = loadWorker();
    const reply = await w.send({ type: "keepr-job-api", method, path: "/job/pending" });
    expect(reply).toMatchObject({ ok: false, status: 0 });
    expect(w.fetchStub).not.toHaveBeenCalled();
  });

  it("a POST job call is forwarded as a POST", async () => {
    const w = loadWorker();
    await w.send({
      type: "keepr-job-api",
      method: "POST",
      path: "/job/11111111-2222-4333-8444-555555555555/claim", // pii-allow-uuid: invented, not from any live row
    });
    expect(w.fetchStub).toHaveBeenCalledTimes(1);
    expect(w.fetchStub.mock.calls[0][1].method).toBe("POST");
  });

  it("a non-job path is still refused", async () => {
    const w = loadWorker();
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
      const w = loadWorker();
      const reply = await w.send({ type: "keepr-log", line: "listed 60, stopReason stable" });
      expect(reply).toEqual({ ok: true });
      expect(spy).toHaveBeenCalledWith("[Keepr Sync] listed 60, stopReason stable");
      expect(w.fetchStub).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
