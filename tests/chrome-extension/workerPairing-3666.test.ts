/**
 * @jest-environment node
 */
/**
 * BACKLOG-3666 — the extension's side of pairing, END TO END: the real
 * service worker (background.js) against a REAL Keepr bridge (HTTP on a
 * random loopback port) running the REAL pairing gate and protocol.
 *
 * SR (2026-10-03): the worker links only through the popup's code (C1); the
 * legacy 8-character exchange is gone from both sides.
 *
 * Mutations that turn this red:
 *   W1 a job call sent while unpaired                         → "unpaired"
 *   W2 a reply accepted without Keepr's signature (squatter)  → "squatter"
 *   W3 re_pair / unknown_pair not forgetting the pairing      → "re_pair"
 *   W4 the key extractable                                    → "non-extractable"
 *   W6 the legacy code exchange still in the worker           → "no legacy exchange"
 */
import * as fs from "fs";
import * as path from "path";

jest.mock("../../electron/services/logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  return { __esModule: true, default: { info: noop, warn: noop, error: noop, debug: noop } };
});

import { RcsExtensionBridge, RCS_EXTENSION_ORIGIN } from "../../electron/services/rcsExtensionBridge";
import { RcsJobRegistry } from "../../electron/services/rcsImportJob";
import { RcsPairingAuth, type PairProtocol, type PairingStore, type RcsPairing } from "../../electron/services/rcsPairingAuth";
import { installPairing, P, uninstallPairing } from "./helpers/pairedWorker";

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "..", "chrome-extension", "background.js"), "utf8");
const EXTENSION_ID = "nlfohmjehedijceeelokclkglmjnlonj";
type Listener = (m: Record<string, unknown>, s: { id: string; url?: string }, r: (x: unknown) => void) => boolean;

let currentUser: string | null = "user-a";
let rows: RcsPairing[];
let auth: RcsPairingAuth;
let bridge: RcsExtensionBridge;
let port: number;

beforeEach(async () => {
  currentUser = "user-a";
  rows = [];
  const store: PairingStore = {
    get: (id) => rows.find((r) => r.pairId === id) ?? null,
    save: (p) => {
      rows = rows.filter((r) => r.userId !== p.userId).concat([p]);
    },
    existsForUser: (u) => rows.some((r) => r.userId === u),
    deleteForUser: (u) => {
      rows = rows.filter((r) => r.userId !== u);
    },
  };
  auth = new RcsPairingAuth(P as unknown as PairProtocol, store);
  bridge = new RcsExtensionBridge({
    importChat: jest.fn(),
    importImage: jest.fn(),
    currentUserId: async () => currentUser,
    jobs: new RcsJobRegistry(),
    pairing: auth,
    pairingMode: "dual",
  } as never);
  expect(await bridge.start(0)).toBe("listening");
  port = bridge.getStatus().port;
});
afterEach(async () => {
  await bridge.stop();
  uninstallPairing();
});

/** The real worker; its fetch reaches the test bridge (or `override`, a fake "Keepr"). */
async function worker(override?: (url: string, init: RequestInit) => Promise<Response> | undefined) {
  const store = await installPairing(false);
  let listener: Listener | null = null;
  const sent: string[] = [];
  const chromeStub = {
    runtime: { id: EXTENSION_ID, getURL: (p: string) => `chrome-extension://${EXTENSION_ID}/${p}`, onMessage: { addListener: (fn: Listener) => (listener = fn) }, getManifest: () => ({ version: "9.9.9" }) },
    tabs: { query: jest.fn(async () => []) },
  };
  const fetchShim = async (url: string, init: RequestInit) => {
    sent.push(new URL(url).pathname);
    const fake = override?.(url, init);
    if (fake) return fake;
    const headers = { ...(init.headers as Record<string, string>), Origin: RCS_EXTENSION_ORIGIN };
    return fetch(url.replace(":38619", `:${port}`), { ...init, headers });
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function("chrome", "fetch", SOURCE)(chromeStub, fetchShim);
  const send = (m: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolve) => {
      if (!listener!(m, { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/popup.html` }, (x) => resolve(x as Record<string, unknown>))) resolve({ sync: true });
    });
  await new Promise((r) => setTimeout(r, 20)); // the startup hello
  sent.length = 0;
  return { send, sent, store };
}

const pending = { type: "keepr-check-pending" };

async function waitFor(check: () => Promise<boolean> | boolean, ms = 8000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out");
}

/** Link `w` the C1 way: its code, typed in Keepr by the signed-in user. */
async function link(w: { send: (m: Record<string, unknown>) => Promise<Record<string, unknown>> }): Promise<void> {
  const l = (await w.send({ type: "keepr-link-start" })).link as { code: string };
  expect(auth.linkEnterCode(currentUser as string, l.code)).toEqual({ ok: true });
  await waitFor(async () => (await w.send({ type: "keepr-pair-status" })).paired === true);
}

jest.setTimeout(20000);

describe("the worker's link with Keepr (BACKLOG-3666, C1)", () => {
  it("unpaired: a job call is refused here and never sent (W1)", async () => {
    const w = await worker();
    const r = await w.send(pending);
    expect(r).toMatchObject({ ok: false, status: 0, body: { error: "not_paired" } });
    expect(w.sent).toEqual([]);
  });

  it("linked: job calls are signed and their replies verified", async () => {
    const w = await worker();
    await link(w);
    expect(rows).toHaveLength(1);
    const r = await w.send(pending);
    expect(r).toMatchObject({ ok: false, status: 404, body: { error: "no_job" } }); // signed, routed, verified
  });

  it("the key is a non-extractable CryptoKey (W4)", async () => {
    const w = await worker();
    await link(w);
    const key = w.store.current!.key as unknown as { extractable: boolean; type: string; usages: string[] };
    expect(key.type).toBe("secret");
    expect(key.extractable).toBe(false);
    expect(key.usages).toEqual(["sign"]);
  });

  // A process squatting Keepr's port, without the code typed in Keepr.
  it("a squatter can't complete a link, and can't answer a linked worker (W2)", async () => {
    const fake = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    let pA = "";
    const squat = await worker((url, init) => {
      const p = new URL(url).pathname;
      if (p === "/link/start") {
        pA = JSON.parse(String(init.body)).pA;
        return Promise.resolve(fake(200, { sessionId: "squat", expiresInMs: 120000 }));
      }
      if (p === "/link/poll") {
        // It guesses the code.
        const guess = P.respondB("000001", pA);
        return Promise.resolve(fake(200, { state: "answered", pB: guess.pB, cB: guess.cB }));
      }
      if (p === "/link/finish") return Promise.resolve(fake(429, { error: "too_many_tries" }));
      return undefined;
    });
    await squat.send({ type: "keepr-link-start" });
    await waitFor(async () => ((await squat.send({ type: "keepr-link-state" })).link as { status: string }).status === "failed");
    expect(await squat.send({ type: "keepr-pair-status" })).toEqual({ ok: true, paired: false });

    // Linked for real, then the squatter answers a job call (unsigned, or signed with a guess).
    let squatting = false;
    const w = await worker((url) => (squatting && new URL(url).pathname.startsWith("/job/") ? Promise.resolve(fake(200, { jobId: "x" })) : undefined));
    await link(w);
    squatting = true;
    expect(await w.send(pending)).toMatchObject({ ok: false, status: 0, body: { error: "unverified" } });
  });

  it("Keepr says re_pair (another user signed in), or no longer knows the link: forgotten (W3)", async () => {
    const w = await worker();
    await link(w);
    currentUser = "user-b";
    expect(await w.send(pending)).toMatchObject({ ok: false, status: 401, body: { error: "not_paired" } });
    expect(await w.send({ type: "keepr-pair-status" })).toEqual({ ok: true, paired: false });

    currentUser = "user-a";
    const w2 = await worker();
    await link(w2);
    auth.revoke("user-a");
    expect(await w2.send(pending)).toMatchObject({ ok: false, status: 401, body: { error: "not_paired" } });
    expect(await w2.send({ type: "keepr-pair-status" })).toEqual({ ok: true, paired: false });
  });

  // SR (2026-10-03): nothing can mint an 8-character code any more.
  // Mutation: the legacy exchange kept in the worker → red.
  it("no legacy exchange left in the worker (W6)", () => {
    expect(SOURCE).not.toMatch(/pairWithCode|"\/pair\/start"|case "keepr-pair":/);
  });
});
