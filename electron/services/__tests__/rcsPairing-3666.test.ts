/**
 * @jest-environment node
 */
/**
 * BACKLOG-3666 — Keepr's side of pairing, over a REAL bridge (HTTP on a
 * random loopback port) with the REAL protocol file the extension ships
 * (chrome-extension/pair-protocol.js) and an in-memory store. The test plays
 * the extension.
 *
 * Mutations that turn this red:
 *   A1 a job route answered unsigned                           → "unsigned job route"
 *   A2 the timestamp checked AFTER the nonce (a stale request burns its nonce) → "stale"
 *   A3 a replay accepted                                        → "replay"
 *   A4 a tampered body / bad signature accepted                 → "bad signature"
 *   A5 another user's pairing accepted                          → "re_pair"
 *   A6 an error reply left unsigned (other than unknown pairing) → "signed errors"
 *   A7 the legacy 8-character pairing still answering           → "the legacy pairing is gone"
 *   A11 a link replacing the old one outside one transaction    → "a failed save keeps the old link"
 *   A8 the nonce store unbounded / never evicted                → "nonce store"
 *   A9 /hello revealing more than paired yes / no               → "hello"
 *   A10 an unsigned /status or /exclusions accepted (dual mode back) → "required"
 */
import * as http from "http";

jest.mock("../logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  return { __esModule: true, default: { info: noop, warn: noop, error: noop, debug: noop } };
});

import { LEGACY_PAIR_GONE_MESSAGE, OPEN_ROUTE_MAX_BODY_BYTES, RcsExtensionBridge, RCS_EXTENSION_ORIGIN, RCS_MIN_EXTENSION_VERSION, RCS_RATE_LIMITS } from "../rcsExtensionBridge";
import { RcsJobRegistry } from "../rcsImportJob";
import {
  LINK_PROOF_MS,
  LINK_INTERRUPTED_MESSAGE,
  LINK_INTRUSION_MESSAGE,
  LINK_MAX_TRIES,
  LINK_TTL_MS,
  PAIR_NONCE_CAP,
  PAIR_NONCE_TTL_MS,
  PAIR_TS_WINDOW_MS,
  RcsPairingAuth,
  type PairProtocol,
  type PairingStore,
  type RcsPairing,
} from "../rcsPairingAuth";

/* eslint-disable @typescript-eslint/no-require-imports */
const P = require("../../../chrome-extension/pair-protocol.js") as PairProtocol & {
  startA(code: string): { state: unknown; pA: string };
  finishA(state: unknown, pB: string, cB: string): { cA: string; ke: string };
};
/* eslint-enable @typescript-eslint/no-require-imports */

type Reply = { status: number; body: Record<string, unknown>; text: string; sig: string | undefined };

function post(port: number, path: string, headers: Record<string, string>, body = ""): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: "POST", path, headers: { "Content-Type": "application/json", Origin: RCS_EXTENSION_ORIGIN, ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : {}, text, sig: res.headers["x-keepr-sig"] as string | undefined });
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

function memoryStore(): PairingStore & { rows: RcsPairing[] } {
  const rows: RcsPairing[] = [];
  return {
    rows,
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
let currentUser: string | null = "user-a";
let store: ReturnType<typeof memoryStore>;
let auth: RcsPairingAuth;
let bridge: RcsExtensionBridge;
let port: number;

async function startBridge(): Promise<void> {
  store = memoryStore();
  auth = new RcsPairingAuth(P, store, { now: () => clock });
  bridge = new RcsExtensionBridge({
    importChat: jest.fn(),
    importImage: jest.fn(),
    currentUserId: async () => currentUser,
    listExclusions: () => [],
    setExclusion: () => {},
    jobs: new RcsJobRegistry(),
    pairing: auth,
  } as never);
  expect(await bridge.start(0)).toBe("listening");
  port = bridge.getStatus().port;
}

/**
 * The extension's side of the (C1) link: the popup's code, typed in Keepr by
 * `userId`, confirmed by the extension. → pairId + key.
 */
async function linkWith(userId: string, code = "123456"): Promise<{ pairId: string; keyHex: string }> {
  const a = P.startA(code);
  const s = await post(port, "/link/start", {}, JSON.stringify({ pA: a.pA }));
  expect(s.status).toBe(200);
  expect(auth.linkEnterCode(userId, code)).toEqual({ ok: true });
  const poll = await post(port, "/link/poll", {}, JSON.stringify({ sessionId: s.body.sessionId }));
  const f = P.finishA(a.state, poll.body.pB as string, poll.body.cB as string);
  const nonce = P.newNonce();
  const fin = await post(port, "/link/finish", {}, JSON.stringify({ sessionId: s.body.sessionId, cA: f.cA, nonce }));
  expect(fin.status).toBe(200);
  const keyHex = P.sessionKey(f.ke, s.body.sessionId as string);
  // Keepr's success reply is signed with the new key.
  expect(fin.sig).toBe(P.sign(keyHex, P.replyString(200, "/link/finish", nonce, fin.text)));
  return { pairId: s.body.sessionId as string, keyHex };
}

function signed(p: { pairId: string; keyHex: string }, path: string, body = "", over: Partial<Record<"ts" | "nonce" | "sig", string>> = {}) {
  const ts = over.ts ?? String(clock);
  const nonce = over.nonce ?? P.newNonce();
  const sig = over.sig ?? P.sign(p.keyHex, P.requestString("POST", path, ts, nonce, body));
  return { headers: { "X-Keepr-Pair": p.pairId, "X-Keepr-Ts": ts, "X-Keepr-Nonce": nonce, "X-Keepr-Sig": sig }, nonce };
}

const replyOk = (p: { keyHex: string }, path: string, nonce: string, r: Reply) =>
  r.sig === P.sign(p.keyHex, P.replyString(r.status, path, nonce, r.text));

beforeEach(async () => {
  clock = 1_000_000;
  currentUser = "user-a";
  await startBridge();
});
afterEach(async () => {
  await bridge.stop();
});

describe("pairing (BACKLOG-3666; linking C1)", () => {
  it("links for the user who typed the code", async () => {
    const p = await linkWith("user-a");
    expect(store.rows).toEqual([{ pairId: p.pairId, userId: "user-a", keyHex: p.keyHex }]);
    expect(auth.isPaired("user-a")).toBe(true);
  });

  // SR (2026-10-03): Keepr no longer mints 8-character codes, so the legacy
  // exchange is gone now (410, "update the extension"). Mutation: the
  // handlers answering again → red.
  it("the legacy pairing is gone: /pair/start and /pair/finish → 410 (A7)", async () => {
    for (const path of ["/pair/start", "/pair/finish"]) {
      const r = await post(port, path, {}, JSON.stringify({ pA: P.startA("ABCDEFGH").pA }));
      expect([path, r.status, r.body.error]).toEqual([path, 410, "gone"]);
      expect(r.body.message).toBe(LEGACY_PAIR_GONE_MESSAGE);
    }
  });

  it("a new link replaces the user's earlier one (the old key stops working)", async () => {
    const first = await linkWith("user-a");
    const second = await linkWith("user-a", "654321");
    expect(store.rows.map((r) => r.pairId)).toEqual([second.pairId]);
    const r = await post(port, "/job/pending", signed(first, "/job/pending").headers);
    expect(r.body.error).toBe("unknown_pair");
  });

  // SR (2026-10-03): the old link is removed and the new one saved in ONE
  // transaction (the store's save): a failed save leaves the old link.
  // Mutation: a separate revoke before the save → red.
  it("a failed save keeps the old link (A11)", async () => {
    const first = await linkWith("user-a");
    const realSave = store.save;
    store.save = () => {
      throw new Error("disk I/O error");
    };
    const a = P.startA("654321");
    const s = await post(port, "/link/start", {}, JSON.stringify({ pA: a.pA }));
    auth.linkEnterCode("user-a", "654321");
    const poll = await post(port, "/link/poll", {}, JSON.stringify({ sessionId: s.body.sessionId }));
    const f = P.finishA(a.state, poll.body.pB as string, poll.body.cB as string);
    const fin = await post(port, "/link/finish", {}, JSON.stringify({ sessionId: s.body.sessionId, cA: f.cA, nonce: P.newNonce() }));
    expect(fin.status).toBe(500);
    store.save = realSave;
    expect(store.rows.map((r) => r.pairId)).toEqual([first.pairId]);
  });
});

describe("the auth gate (BACKLOG-3666)", () => {
  let p: { pairId: string; keyHex: string };
  beforeEach(async () => {
    p = await linkWith("user-a");
  });

  it("unsigned job route → 401 not_paired; signed → routed, and the reply is signed (A1)", async () => {
    expect((await post(port, "/job/pending", {})).body.error).toBe("not_paired");
    const s = signed(p, "/job/pending");
    const r = await post(port, "/job/pending", s.headers);
    expect(r.status).toBe(404); // routed: no job is waiting
    expect(r.body.error).toBe("no_job");
    expect(replyOk(p, "/job/pending", s.nonce, r)).toBe(true);
  });

  it("unknown pairing → 401, the only unsigned error", async () => {
    const r = await post(port, "/job/pending", signed({ pairId: "f".repeat(32), keyHex: p.keyHex }, "/job/pending").headers);
    expect(r.status).toBe(401);
    expect(r.body.error).toBe("unknown_pair");
    expect(r.sig).toBeUndefined();
  });

  it("stale timestamp → 401 stale, checked BEFORE the nonce (the nonce is not burned) (A2, A6)", async () => {
    const nonce = P.newNonce();
    const old = String(clock - PAIR_TS_WINDOW_MS - 1);
    const r = await post(port, "/job/pending", signed(p, "/job/pending", "", { ts: old, nonce }).headers);
    expect(r.body.error).toBe("stale");
    expect(replyOk(p, "/job/pending", nonce, r)).toBe(true);
    // The same nonce, fresh timestamp: accepted (a stale request never reached the nonce store).
    expect((await post(port, "/job/pending", signed(p, "/job/pending", "", { nonce }).headers)).body.error).toBe("no_job");
    expect(PAIR_TS_WINDOW_MS).toBe(60_000);
  });

  it("bad signature or a tampered body → 401 bad_signature, signed (A4, A6)", async () => {
    const s = signed(p, "/exclusions/set", JSON.stringify({ conversationId: "abc", excluded: true }));
    const r = await post(port, "/exclusions/set", s.headers, JSON.stringify({ conversationId: "abc", excluded: false }));
    expect(r.body.error).toBe("bad_signature");
    expect(replyOk(p, "/exclusions/set", s.nonce, r)).toBe(true);
    const wrongKey = signed({ pairId: p.pairId, keyHex: "00".repeat(32) }, "/job/pending");
    expect((await post(port, "/job/pending", wrongKey.headers)).body.error).toBe("bad_signature");
  });

  it("replay → 401 replay, signed (A3, A6)", async () => {
    const s = signed(p, "/job/pending");
    expect((await post(port, "/job/pending", s.headers)).body.error).toBe("no_job");
    const again = await post(port, "/job/pending", s.headers);
    expect(again.body.error).toBe("replay");
    expect(replyOk(p, "/job/pending", s.nonce, again)).toBe(true);
  });

  it("another user signed in → 401 re_pair, signed; signed out too (A5, A6)", async () => {
    currentUser = "user-b";
    const s = signed(p, "/job/pending");
    const r = await post(port, "/job/pending", s.headers);
    expect(r.body.error).toBe("re_pair");
    expect(replyOk(p, "/job/pending", s.nonce, r)).toBe(true);
    currentUser = null;
    expect((await post(port, "/job/pending", signed(p, "/job/pending").headers)).body.error).toBe("re_pair");
  });

  it("revoked (sign-out) → unknown_pair", async () => {
    auth.revoke("user-a");
    expect((await post(port, "/job/pending", signed(p, "/job/pending").headers)).body.error).toBe("unknown_pair");
  });

  // C1 (SR): plus the oldest extension version this Keepr works with (the
  // popup's "out of date"). Mutation: no minExtensionVersion → red.
  it("/hello reveals only paired yes / no, and the minimum extension version (A9)", async () => {
    const plain = await post(port, "/hello", {}, JSON.stringify({ version: "0.3.22" }));
    expect(plain.body).toEqual({ ok: true, paired: false, minExtensionVersion: RCS_MIN_EXTENSION_VERSION });
    const s = signed(p, "/hello", JSON.stringify({ version: "0.3.22" }));
    const paired = await post(port, "/hello", s.headers, JSON.stringify({ version: "0.3.22" }));
    expect(paired.body).toEqual({ ok: true, paired: true, minExtensionVersion: RCS_MIN_EXTENSION_VERSION });
    expect(replyOk(p, "/hello", s.nonce, paired)).toBe(true);
  });

  // SR B1: once the signed-in user is paired, the dual routes need a signature
  // too (/exclusions/set is a write). Mutation: dual routes open regardless → red.
  it("paired user: the dual routes are refused unsigned (B1)", async () => {
    for (const route of ["/exclusions/set", "/exclusions/list", "/status"]) {
      const r = await post(port, route, {}, JSON.stringify({ conversationId: "abc", excluded: true }));
      expect(r.status).toBe(401);
      expect(r.body.error).toBe("signature_required");
    }
    // Signed, they work.
    const s = signed(p, "/exclusions/list", "{}");
    expect((await post(port, "/exclusions/list", s.headers, "{}")).status).not.toBe(401);
  });

  // SR (2026-10-03): /focus is open — Open Keepr works from an unlinked
  // browser even while this user has a link. Mutation: /focus back among the
  // signed-only routes → red.
  it("paired user: an unsigned /focus is still answered (never signature_required)", async () => {
    const r = await post(port, "/focus", {}, "");
    expect(r.status).not.toBe(401);
    expect(r.body.error).not.toBe("signature_required");
  });

  // SR P0 / CASA N18: "required" — unsigned, only the open routes answer,
  // even before this user has a link. Mutation: the dual exception back → red.
  it("required: unsigned /status and /exclusions are refused even with no link (A10)", async () => {
    auth.revoke("user-a"); // no pairing: an older extension's unsigned calls
    for (const route of ["/status", "/exclusions/list", "/exclusions/set", "/job/pending"]) {
      const r = await post(port, route, {}, "{}");
      expect([route, r.status, r.body.error]).toEqual([route, 401, "not_paired"]);
    }
    // The open routes still answer: /hello says only paired yes / no and the minimum version.
    const hello = await post(port, "/hello", {}, JSON.stringify({ version: "0.3.40" }));
    expect(hello.status).toBe(200);
    expect(hello.body).toEqual({ ok: true, paired: false, minExtensionVersion: RCS_MIN_EXTENSION_VERSION });
    expect((await post(port, "/focus", {}, "")).status).not.toBe(401);
    expect((await post(port, "/pair/start", {}, "{}")).status).toBe(410);
  });
});

// SR S1: the headers are checked BEFORE any body is read, and the body has its
// route's cap. A body that never ends must not hold off the refusal.
// Mutations: the body read first → the refusal never comes (timeout) → red;
// the image cap for every route → the oversized claim is accepted → red.
describe("headers before the body (S1)", () => {
  let p: { pairId: string; keyHex: string };
  beforeEach(async () => {
    p = await linkWith("user-a");
  });

  /** Headers and a first chunk, then the body never ends. → the reply (or "no reply"). */
  function endless(path: string, headers: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> } | "no reply"> {
    return new Promise((resolve) => {
      const req = http.request(
        { host: "127.0.0.1", port, method: "POST", path, headers: { "Content-Type": "application/json", Origin: RCS_EXTENSION_ORIGIN, "Content-Length": "100000", ...headers } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") }));
        },
      );
      req.on("error", () => undefined);
      req.write("{\"a\":");
      setTimeout(() => {
        resolve("no reply");
        req.destroy();
      }, 1500);
    });
  }

  it("unknown pairing, stale timestamp, unsigned job route: refused without waiting for the body", async () => {
    const unknown = signed({ pairId: "e".repeat(32), keyHex: p.keyHex }, "/job/pending").headers;
    expect(await endless("/job/pending", unknown)).toMatchObject({ status: 401, body: { error: "unknown_pair" } });
    const stale = signed(p, "/job/pending", "", { ts: String(clock - PAIR_TS_WINDOW_MS - 5) }).headers;
    expect(await endless("/job/pending", stale)).toMatchObject({ status: 401, body: { error: "stale" } });
    expect(await endless("/job/pending", {})).toMatchObject({ status: 401, body: { error: "not_paired" } });
  });

  // SR (C4–C5 review) S1: unsigned open routes are rate-limited from their
  // headers, before the body; and their bodies are small (8 KB).
  // Mutations: the pre-body limit removed (the refusal waits for the body →
  // "no reply") → red; the open routes' cap back to the general one → red.
  it("unsigned open routes: the rate limit answers before any body is read (429)", async () => {
    for (let i = 0; i < RCS_RATE_LIMITS.link; i++) await post(port, "/link/poll", {}, JSON.stringify({ sessionId: "x" }));
    expect(await endless("/link/poll", {})).toMatchObject({ status: 429, body: { error: "rate_limited" } });
  });

  it("open routes: a body over 8 KB is refused (413); a small one is answered", async () => {
    // /link/start has no smaller cap of its own: only the open-route cap refuses it.
    const big = JSON.stringify({ pA: "x", pad: "y".repeat(OPEN_ROUTE_MAX_BODY_BYTES) });
    expect((await post(port, "/link/start", {}, big)).status).toBe(413);
    expect((await post(port, "/hello", {}, JSON.stringify({ version: "0.3.68" }))).status).toBe(200);
  });

  it("each route has its own cap: an oversized body on a non-image route is refused (413)", async () => {
    const big = JSON.stringify({ x: "y".repeat(10 * 1024 * 1024 + 10) });
    const r = await post(port, "/job/pending", signed(p, "/job/pending", big).headers, big);
    expect(r.status).toBe(413);
  });
});

// C1 (UX redesign, SR 2026-10-03): the reversed link's rules, Keepr side.
// Mutations: a second start not aborting both → red; no rate limit / no
// intrusion warning → red; tries not counted (5th not dropping) → red; no
// 2-minute expiry → red.
describe("C1: the reversed link (the popup's code typed in Keepr)", () => {
  const start = async () => post(port, "/link/start", {}, JSON.stringify({ pA: P.startA("123456").pA }));

  it("one pending session: a second /link/start aborts BOTH", async () => {
    expect((await start()).status).toBe(200);
    const second = await start();
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ error: "interrupted", message: LINK_INTERRUPTED_MESSAGE });
    expect(auth.linkState().state).toBe("none");
  });

  it("more than 5 starts a minute: locked for a minute, and Keepr says another app tried", async () => {
    for (let i = 0; i < 5; i++) {
      await start();
      auth.linkEnterCode("user-a", "999999"); // (any state; each start counts)
      clock += 1000;
    }
    const sixth = await start();
    expect(sixth.status).toBe(429);
    expect(sixth.body).toMatchObject({ error: "locked", message: LINK_INTRUSION_MESSAGE });
    expect(auth.linkState()).toMatchObject({ state: "locked", intrusion: true });
    clock += 61_000;
    expect(auth.linkState()).toMatchObject({ state: "none", intrusion: true });
    expect((await start()).status).toBe(200);
  });

  it("wrong codes: each counts; the 5th drops the session", async () => {
    const s = await start();
    const id = s.body.sessionId as string;
    for (let i = 1; i <= LINK_MAX_TRIES; i++) {
      expect(auth.linkEnterCode("user-a", "000000")).toEqual({ ok: true });
      const fin = await post(port, "/link/finish", {}, JSON.stringify({ sessionId: id, cA: "wrong" }));
      expect(fin.status).toBe(i < LINK_MAX_TRIES ? 403 : 429);
    }
    expect(auth.linkState().state).toBe("none");
  });

  it("the session lives 2 minutes from the popup's start", async () => {
    const s = await start();
    clock += LINK_TTL_MS + 1;
    expect(auth.linkEnterCode("user-a", "123456")).toEqual({ ok: false, reason: "expired" });
    expect((await post(port, "/link/poll", {}, JSON.stringify({ sessionId: s.body.sessionId }))).status).toBe(404);
    expect(LINK_TTL_MS).toBe(2 * 60 * 1000);
  });

  it("the right code: linked for the user who typed it, replacing that user's earlier link", async () => {
    const old = await linkWith("user-a", "111111");
    const a = P.startA("123456");
    const s = await post(port, "/link/start", {}, JSON.stringify({ pA: a.pA }));
    expect(auth.linkEnterCode("user-a", "123-456")).toEqual({ ok: true });
    const poll = await post(port, "/link/poll", {}, JSON.stringify({ sessionId: s.body.sessionId }));
    const f = P.finishA(a.state, poll.body.pB as string, poll.body.cB as string);
    const nonce = P.newNonce();
    const fin = await post(port, "/link/finish", {}, JSON.stringify({ sessionId: s.body.sessionId, cA: f.cA, nonce }));
    expect(fin.status).toBe(200);
    const keyHex = P.sessionKey(f.ke, s.body.sessionId as string);
    expect(fin.sig).toBe(P.sign(keyHex, P.replyString(200, "/link/finish", nonce, fin.text)));
    expect(store.rows.map((r) => r.pairId)).toEqual([s.body.sessionId]);
    // The old browser's signed calls: unknown now (it forgets its link).
    expect((await post(port, "/job/pending", signed(old, "/job/pending").headers)).body.error).toBe("unknown_pair");
  });
});

// Live (B1): "linked" means PROVEN by the extension (a signed call, or the
// link itself) within 24 h — not just a row. An unsigned "no link here"
// drops a row not proven in the last 10 minutes. Mutations: isLinkProven =
// isPaired → red; no proof on a signed call → red; a recent proof dropped → red.
describe("an honest 'linked' (B1)", () => {
  it("proven by the link and by signed calls; a restart (no proof yet) is not 'linked'; 24 h without proof is not", async () => {
    const p = await linkWith("user-a");
    expect(auth.isLinkProven("user-a")).toBe(true);
    const restarted = new RcsPairingAuth(P, store, { now: () => clock });
    expect(restarted.isPaired("user-a")).toBe(true);
    expect(restarted.isLinkProven("user-a")).toBe(false);
    clock += LINK_PROOF_MS + 1;
    expect(auth.isLinkProven("user-a")).toBe(false);
    expect((await post(port, "/job/pending", signed(p, "/job/pending").headers)).status).toBe(404);
    expect(auth.isLinkProven("user-a")).toBe(true);
  });

  // SR (B1): an unsigned hello NEVER deletes a link — it changes only what
  // Keepr shows. Mutations: the bridge deleting on it → red; the hello not
  // changing the display → red; Forget link not deleting → red.
  const unlinkedHello = () => post(port, "/hello", {}, JSON.stringify({ version: "0.3.38", linked: false }));

  it("a second, unlinked profile's hello never deletes the link; Keepr shows 'not linked' until the next signed call", async () => {
    const p = await linkWith("user-a");
    clock += 60 * 60 * 1000; // long after the link
    for (let i = 0; i < 3; i++) await unlinkedHello();
    expect(store.rows).toHaveLength(1);
    expect(auth.isPaired("user-a")).toBe(true);
    expect(auth.isLinkProven("user-a")).toBe(false);
    clock += 1;
    expect((await post(port, "/job/pending", signed(p, "/job/pending").headers)).status).toBe(404);
    expect(auth.isLinkProven("user-a")).toBe(true);
  });

  it("a Keepr restart, then an unsigned hello: the link is kept", async () => {
    await linkWith("user-a");
    const restarted = new RcsPairingAuth(P, store, { now: () => clock });
    restarted.noteExtensionUnlinked();
    await unlinkedHello();
    expect(store.rows).toHaveLength(1);
    expect(restarted.isPaired("user-a")).toBe(true);
  });

  it("Forget link deletes the user's link", async () => {
    await linkWith("user-a");
    auth.forgetLink("user-a");
    expect(store.rows).toEqual([]);
    expect(auth.isLinkProven("user-a")).toBe(false);
  });
});

describe("the nonce store (A8)", () => {
  it("evicts after 120 s and is capped at 10 000 per pairing", () => {
    const s = memoryStore();
    const a = new RcsPairingAuth(P, s, { now: () => clock });
    const keyHex = "11".repeat(32);
    s.save({ pairId: "pid", userId: "u", keyHex });
    const req = (nonce: string) =>
      a.verify(
        { "x-keepr-pair": "pid", "x-keepr-ts": String(clock), "x-keepr-nonce": nonce, "x-keepr-sig": P.sign(keyHex, P.requestString("POST", "/x", clock, nonce, "")) },
        "POST", "/x", "", "u",
      );
    const n0 = "a".repeat(32);
    expect(req(n0).ok).toBe(true);
    expect(req(n0)).toMatchObject({ ok: false, error: "replay" });
    clock += PAIR_NONCE_TTL_MS + 1;
    expect(req(n0).ok).toBe(true); // evicted
    for (let i = 1; i < PAIR_NONCE_CAP; i++) expect(req(i.toString(16).padStart(32, "0")).ok).toBe(true);
    expect(req("b".repeat(32))).toMatchObject({ ok: false, error: "busy" });
    expect(PAIR_NONCE_CAP).toBe(10_000);
    expect(PAIR_NONCE_TTL_MS).toBe(120_000);
  });
});

// SR S3: the revocation race. A signed request passes the gate as user-a; the
// session is signed out before the write. The write re-checks the user
// (stillSameUser): 409 user_changed, the job is cancelled, nothing staged.
// Mutation: no re-check at the write → the chat is staged for a signed-out
// user → red.
describe("signed out while a signed request is past the gate (S3)", () => {
  it("the write refuses (user_changed), the job is cancelled, nothing staged", async () => {
    await bridge.stop();
    store = memoryStore();
    auth = new RcsPairingAuth(P, store, { now: () => clock });
    const staged = jest.fn(async () => ({ received: 2, stored: 2, alreadyPresent: 0, linked: 0, reactions: 0, reactionsStored: 0 }));
    let signOutAfterGate = false;
    bridge = new RcsExtensionBridge({
      importChat: jest.fn(),
      importImage: jest.fn(),
      importCacheChat: staged,
      // The gate asks first (user-a); the sign-out lands right after it.
      currentUserId: async () => {
        const u = currentUser;
        if (signOutAfterGate) {
          signOutAfterGate = false;
          currentUser = null;
        }
        return u;
      },
      jobs: new RcsJobRegistry(),
      pairing: auth,
    } as never);
    expect(await bridge.start(0)).toBe("listening");
    port = bridge.getStatus().port;
    const p = await linkWith("user-a");
    const job = bridge.createCacheJob("user-a", { since: "2026-08-01T00:00:00.000Z" })!;
    const go = async (route: string, body = "") => post(port, `/job/${job.jobId}/${route}`, signed(p, `/job/${job.jobId}/${route}`, body).headers, body);
    expect((await go("claim")).status).toBe(200);
    const match = JSON.stringify({ conversationId: "aaaaaaaaaaaaaaaaaaa", numbers: ["(555) 555-0142"] });
    expect((await go("match", match)).status).toBe(200);
    signOutAfterGate = true;
    const chat = JSON.stringify({
      conversationId: "aaaaaaaaaaaaaaaaaaa", title: "Test Contact A",
      messages: [{ msgId: "1", direction: "inbound", sender: "x", text: "one", sentAt: "2026-09-20T13:05:00.000Z", transport: "sms" }],
      participants: [{ name: "Test Contact A", number: "(555) 555-0142" }],
    });
    const r = await go("chat", chat);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("user_changed");
    expect(staged).not.toHaveBeenCalled();
    expect(bridge.activeJob()).toBeNull();
  });
});

// Founder (2026-10-02): the page's "Stop sync" — a signed cancel that records
// who ended it. Mutation: endedBy ignored → red.
describe("Stop sync on the page (ended_by=user_page)", () => {
  it("a signed cancel with endedBy user_page cancels the job and records it", async () => {
    const p = await linkWith("user-a");
    const job = bridge.createCacheJob("user-a", { since: "2026-08-01T00:00:00.000Z" })!;
    const path = `/job/${job.jobId}/cancel`;
    const body = JSON.stringify({ endedBy: "user_page" });
    const r = await post(port, path, signed(p, path, body).headers, body);
    expect(r.status).toBe(200);
    expect(bridge.activeJob()).toBeNull();
    expect(bridge.getJob()).toMatchObject({ jobId: job.jobId, state: "cancelled", endedBy: "user_page" });
  });

  it("an unsigned cancel is refused (job routes are always signed)", async () => {
    await linkWith("user-a");
    const job = bridge.createCacheJob("user-a", { since: "2026-08-01T00:00:00.000Z" })!;
    const r = await post(port, `/job/${job.jobId}/cancel`, {}, JSON.stringify({ endedBy: "user_page" }));
    expect(r.status).toBe(401);
    expect(bridge.activeJob()).not.toBeNull();
  });
});
