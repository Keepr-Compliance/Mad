/**
 * @jest-environment node
 */
/**
 * BACKLOG-3666 — the extension's side of pairing, END TO END: the real
 * service worker (background.js) against a REAL Keepr bridge (HTTP on a
 * random loopback port) running the REAL pairing gate and protocol.
 *
 * Mutations that turn this red:
 *   W1 a job call sent while unpaired                         → "unpaired"
 *   W2 a reply accepted without Keepr's signature (squatter)  → "squatter"
 *   W3 re_pair / unknown_pair not forgetting the pairing      → "re_pair"
 *   W4 the key extractable                                    → "non-extractable"
 *   W5 a wrong code stored as paired                          → "wrong code"
 *
 * EQUIVALENT (recorded, SR): skipping the worker's own cB check (finishA)
 * stays green — Keepr's /pair/finish then refuses the wrong cA (403, same
 * message), so nothing is stored. Kept as defence in depth: it is the check
 * that stops a port squatter, which has no Keepr behind it.
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
type Listener = (m: Record<string, unknown>, s: { id: string }, r: (x: unknown) => void) => boolean;

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
    runtime: { id: EXTENSION_ID, onMessage: { addListener: (fn: Listener) => (listener = fn) }, getManifest: () => ({ version: "9.9.9" }) },
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
      if (!listener!(m, { id: EXTENSION_ID }, (x) => resolve(x as Record<string, unknown>))) resolve({ sync: true });
    });
  await new Promise((r) => setTimeout(r, 20)); // the startup hello
  sent.length = 0;
  return { send, sent, store };
}

const pending = { type: "keepr-check-pending" };

describe("the worker pairs with Keepr (BACKLOG-3666)", () => {
  it("unpaired: a job call is refused here and never sent (W1)", async () => {
    const w = await worker();
    const r = await w.send(pending);
    expect(r).toMatchObject({ ok: false, status: 0, body: { error: "not_paired" } });
    expect(w.sent).toEqual([]);
  });

  it("the right code pairs; job calls are then signed and their replies verified", async () => {
    const w = await worker();
    const { code } = auth.issueCode("user-a");
    expect(await w.send({ type: "keepr-pair", code: code.toLowerCase().replace(/(....)/, "$1-") })).toEqual({ ok: true });
    expect(await w.send({ type: "keepr-pair-status" })).toEqual({ ok: true, paired: true });
    expect(rows).toHaveLength(1);
    const r = await w.send(pending);
    expect(r).toMatchObject({ ok: false, status: 404, body: { error: "no_job" } }); // signed, routed, verified
  });

  it("the key is a non-extractable CryptoKey (W4)", async () => {
    const w = await worker();
    await w.send({ type: "keepr-pair", code: auth.issueCode("user-a").code });
    const key = w.store.current!.key as unknown as { extractable: boolean; type: string; usages: string[] };
    expect(key.type).toBe("secret");
    expect(key.extractable).toBe(false);
    expect(key.usages).toEqual(["sign"]);
  });

  it("five wrong tries use the code up: the worker says so plainly", async () => {
    const w = await worker();
    auth.issueCode("user-a");
    for (let i = 0; i < 5; i++) expect((await w.send({ type: "keepr-pair", code: "AAAAAAAA" })).ok).toBe(false);
    const r = await w.send({ type: "keepr-pair", code: "AAAAAAAA" });
    expect(r.error).toBe("Code used up by wrong attempts — get a new code.");
  });

  it("a wrong code: refused, still unpaired (W5)", async () => {
    const w = await worker();
    auth.issueCode("user-a");
    const r = await w.send({ type: "keepr-pair", code: "AAAAAAAA" });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/didn't match/);
    expect(await w.send({ type: "keepr-pair-status" })).toEqual({ ok: true, paired: false });
    expect(rows).toEqual([]);
  });

  // A process squatting Keepr's port, without the code Keepr shows.
  it("a squatter can't complete pairing, and can't answer a paired worker (W2)", async () => {
    const fake = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    const squat = await worker((url, init) => {
      const p = new URL(url).pathname;
      if (p === "/pair/start") {
        const pA = JSON.parse(String(init.body)).pA;
        const guess = P.respondB(P.newCode(), pA);
        return Promise.resolve(fake(200, { pairId: "squat", pB: guess.pB, cB: guess.cB }));
      }
      if (p === "/pair/finish") return Promise.resolve(fake(200, { ok: true, paired: true }));
      return undefined;
    });
    const r = await squat.send({ type: "keepr-pair", code: "QWERTY23" });
    expect(r.ok).toBe(false);
    expect(await squat.send({ type: "keepr-pair-status" })).toEqual({ ok: true, paired: false });

    // Paired for real, then the squatter answers a job call (unsigned, or signed with a guess).
    let squatting = false;
    const w = await worker((url) => (squatting && new URL(url).pathname.startsWith("/job/") ? Promise.resolve(fake(200, { jobId: "x" })) : undefined));
    await w.send({ type: "keepr-pair", code: auth.issueCode("user-a").code });
    squatting = true;
    expect(await w.send(pending)).toMatchObject({ ok: false, status: 0, body: { error: "unverified" } });
  });

  it("Keepr says re_pair (another user signed in), or no longer knows the pairing: forgotten (W3)", async () => {
    const w = await worker();
    await w.send({ type: "keepr-pair", code: auth.issueCode("user-a").code });
    currentUser = "user-b";
    expect(await w.send(pending)).toMatchObject({ ok: false, status: 401, body: { error: "not_paired" } });
    expect(await w.send({ type: "keepr-pair-status" })).toEqual({ ok: true, paired: false });

    currentUser = "user-a";
    const w2 = await worker();
    await w2.send({ type: "keepr-pair", code: auth.issueCode("user-a").code });
    auth.revoke("user-a");
    expect(await w2.send(pending)).toMatchObject({ ok: false, status: 401, body: { error: "not_paired" } });
    expect(await w2.send({ type: "keepr-pair-status" })).toEqual({ ok: true, paired: false });
  });
});
