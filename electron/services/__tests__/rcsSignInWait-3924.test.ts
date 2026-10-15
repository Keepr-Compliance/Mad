/**
 * @jest-environment node
 */
/**
 * BACKLOG-3924 C4 — POST /job/:id/waiting over a REAL bridge (HTTP on a random
 * loopback port), signed with the REAL protocol file the extension ships
 * (chrome-extension/pair-protocol.js). The test plays the extension.
 *
 * Founder (2026-10-12): while the page waits for the user to sign in to Google
 * Messages, each waiting message keeps the job alive 5 minutes (15 in all);
 * Keepr's Stop ends the wait (410); the wait ending is a not_signed_in failure
 * that does NOT bring Keepr to the front.
 *
 * Mutations that turn this red:
 *   the route answered unsigned (handled before the signature gate) → "unsigned"
 *   a bad body accepted                                             → "bad body"
 *   no 410 after Keepr's Stop                                       → "Stop"
 *   the expiry timer not re-armed on /waiting                       → "the timer follows"
 *   /waiting accepted after the claim                               → "after the claim"
 */
import * as http from "http";

jest.mock("../logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  return { __esModule: true, default: { info: noop, warn: noop, error: noop, debug: noop } };
});

import { RcsExtensionBridge, RCS_EXTENSION_ORIGIN } from "../rcsExtensionBridge";
import { RCS_SIGN_IN_WAIT_MS, RcsJobRegistry, type RcsJobSnapshot } from "../rcsImportJob";
import { shouldFocusKeeprOnJobEnd } from "../rcsCacheService";
import { RcsPairingAuth, type PairProtocol, type PairingStore, type RcsPairing } from "../rcsPairingAuth";

/* eslint-disable @typescript-eslint/no-require-imports */
const P = require("../../../chrome-extension/pair-protocol.js") as PairProtocol & {
  startA(code: string): { state: unknown; pA: string };
  finishA(state: unknown, pB: string, cB: string): { cA: string; ke: string };
};
/* eslint-enable @typescript-eslint/no-require-imports */

type Reply = { status: number; body: Record<string, unknown>; text: string };

function post(port: number, path: string, headers: Record<string, string>, body = ""): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path, headers: { "Content-Type": "application/json", Origin: RCS_EXTENSION_ORIGIN, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : {}, text });
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

function memoryStore(): PairingStore {
  const rows: RcsPairing[] = [];
  return {
    get: (id) => rows.find((r) => r.pairId === id) ?? null,
    save: (p) => {
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i].userId === p.userId) rows.splice(i, 1);
      rows.push(p);
    },
    existsForUser: (u) => rows.some((r) => r.userId === u),
    deleteForUser: (u) => {
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i].userId === u) rows.splice(i, 1);
    },
  };
}

let clock = 1_000_000;
let auth: RcsPairingAuth;
let bridge: RcsExtensionBridge;
let port: number;
let changed: RcsJobSnapshot[];
let ended: RcsJobSnapshot[];

async function linkWith(userId: string, code = "123456"): Promise<{ pairId: string; keyHex: string }> {
  const a = P.startA(code);
  const s = await post(port, "/link/start", {}, JSON.stringify({ pA: a.pA }));
  expect(auth.linkEnterCode(userId, code)).toEqual({ ok: true });
  const poll = await post(port, "/link/poll", {}, JSON.stringify({ sessionId: s.body.sessionId }));
  const f = P.finishA(a.state, poll.body.pB as string, poll.body.cB as string);
  const fin = await post(port, "/link/finish", {}, JSON.stringify({ sessionId: s.body.sessionId, cA: f.cA, nonce: P.newNonce() }));
  expect(fin.status).toBe(200);
  return { pairId: s.body.sessionId as string, keyHex: P.sessionKey(f.ke, s.body.sessionId as string) };
}

function signed(p: { pairId: string; keyHex: string }, path: string, body = ""): Record<string, string> {
  const ts = String(clock);
  const nonce = P.newNonce();
  const sig = P.sign(p.keyHex, P.requestString("POST", path, ts, nonce, body));
  return { "X-Keepr-Pair": p.pairId, "X-Keepr-Ts": ts, "X-Keepr-Nonce": nonce, "X-Keepr-Sig": sig };
}

/** The extension's /waiting body (job.js waitForSignIn). */
const WAITING = JSON.stringify({ reason: "sign_in" });

beforeEach(async () => {
  clock = 1_000_000;
  changed = [];
  ended = [];
  auth = new RcsPairingAuth(P, memoryStore(), { now: () => clock });
  bridge = new RcsExtensionBridge({
    importChat: jest.fn(),
    importImage: jest.fn(),
    currentUserId: async () => "user-a",
    listExclusions: () => [],
    setExclusion: () => {},
    jobs: new RcsJobRegistry(() => clock),
    pairing: auth,
    onJobChanged: (s: RcsJobSnapshot) => changed.push(s),
    onJobEnded: (e: { snapshot: RcsJobSnapshot }) => ended.push(e.snapshot),
  } as never);
  expect(await bridge.start(0)).toBe("listening");
  port = bridge.getStatus().port;
});
afterEach(async () => {
  jest.restoreAllMocks();
  await bridge.stop();
});

describe("C4: POST /job/:id/waiting (BACKLOG-3924)", () => {
  it("signed, before the claim: 200, Keepr says S7, and the job outlives the 60 s limit", async () => {
    const p = await linkWith("user-a");
    const job = bridge.createCacheJob("user-a", { since: "2026-08-01T00:00:00.000Z" })!;
    const path = `/job/${job.jobId}/waiting`;
    clock += 10_000;
    const r = await post(port, path, signed(p, path, WAITING), WAITING);
    expect(r.status).toBe(200);
    expect(changed[changed.length - 1]).toMatchObject({ jobId: job.jobId, state: "created", stage: "Waiting for you to sign in to Google Messages in Chrome" });
    clock += 4 * 60_000;
    expect(bridge.getJob()).toMatchObject({ jobId: job.jobId, state: "created" });
    // The page then claims it as usual.
    const claimPath = `/job/${job.jobId}/claim`;
    expect((await post(port, claimPath, signed(p, claimPath))).status).toBe(200);
  });

  it("unsigned: refused (401) and the job is not kept alive", async () => {
    await linkWith("user-a");
    const job = bridge.createCacheJob("user-a", { since: "2026-08-01T00:00:00.000Z" })!;
    const r = await post(port, `/job/${job.jobId}/waiting`, {}, WAITING);
    expect(r.status).toBe(401);
    clock += 60_000;
    expect(bridge.getJob()).toMatchObject({ state: "failed", error: { code: "not_opened" } });
  });

  it("bad body: 400", async () => {
    const p = await linkWith("user-a");
    const job = bridge.createCacheJob("user-a", { since: "2026-08-01T00:00:00.000Z" })!;
    const path = `/job/${job.jobId}/waiting`;
    const bad = JSON.stringify({ reason: 42 });
    expect((await post(port, path, signed(p, path, bad), bad)).status).toBe(400);
  });

  it("after Keepr's Stop: 410, so the page ends its wait", async () => {
    const p = await linkWith("user-a");
    const job = bridge.createCacheJob("user-a", { since: "2026-08-01T00:00:00.000Z" })!;
    const path = `/job/${job.jobId}/waiting`;
    expect((await post(port, path, signed(p, path, WAITING), WAITING)).status).toBe(200);
    bridge.cancelJob(job.jobId);
    const r = await post(port, path, signed(p, path, WAITING), WAITING);
    expect(r.status).toBe(410);
  });

  it("after the claim: 409 (a running Sync is not waiting)", async () => {
    const p = await linkWith("user-a");
    const job = bridge.createCacheJob("user-a", { since: "2026-08-01T00:00:00.000Z" })!;
    const claimPath = `/job/${job.jobId}/claim`;
    expect((await post(port, claimPath, signed(p, claimPath))).status).toBe(200);
    const path = `/job/${job.jobId}/waiting`;
    expect((await post(port, path, signed(p, path, WAITING), WAITING)).status).toBe(409);
    expect(bridge.getJob()).toMatchObject({ state: "running" });
  });

  it("the timer follows the wait: with nobody polling, the job ends not_signed_in 5 min after the last message — and Keepr stays behind Chrome", async () => {
    const p = await linkWith("user-a");
    const job = bridge.createCacheJob("user-a", { since: "2026-08-01T00:00:00.000Z" })!;
    const armed: Array<{ ms: number; fn: () => void }> = [];
    const real = global.setTimeout;
    jest.spyOn(global, "setTimeout").mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
      armed.push({ ms: ms ?? 0, fn });
      return real(fn, ms, ...(rest as []));
    }) as typeof setTimeout);
    const path = `/job/${job.jobId}/waiting`;
    expect((await post(port, path, signed(p, path, WAITING), WAITING)).status).toBe(200);
    const timer = armed.filter((a) => a.ms === RCS_SIGN_IN_WAIT_MS + 50);
    expect(timer).toHaveLength(1);
    // Nobody calls the bridge; the clock passes the deadline; the timer fires.
    clock += RCS_SIGN_IN_WAIT_MS;
    const before = changed.length;
    timer[0].fn();
    const last = changed[changed.length - 1];
    expect(changed.length).toBe(before + 1);
    expect(last).toMatchObject({ jobId: job.jobId, state: "failed", error: { code: "not_signed_in" } });
    expect(shouldFocusKeeprOnJobEnd(last)).toBe(false);
  });

  it("the page's own give-up (/error not_signed_in) ends it, announced, and Keepr stays behind Chrome", async () => {
    const p = await linkWith("user-a");
    const job = bridge.createCacheJob("user-a", { since: "2026-08-01T00:00:00.000Z" })!;
    const path = `/job/${job.jobId}/waiting`;
    expect((await post(port, path, signed(p, path, WAITING), WAITING)).status).toBe(200);
    const errPath = `/job/${job.jobId}/error`;
    // The page's /error body as job.js sends it (NOT_SIGNED_IN).
    const body = JSON.stringify({ code: "not_signed_in", message: "Sign in to Google Messages, then click Sync in Keepr again" });
    expect((await post(port, errPath, signed(p, errPath, body), body)).status).toBe(200);
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ state: "failed", error: { code: "not_signed_in" } });
    expect(shouldFocusKeeprOnJobEnd(ended[0])).toBe(false);
  });
});
