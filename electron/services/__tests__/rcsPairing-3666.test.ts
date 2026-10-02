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
 *   A7 code tries unlimited / not single use / never expiring   → "code"
 *   A8 the nonce store unbounded / never evicted                → "nonce store"
 *   A9 /hello revealing more than paired yes / no               → "hello"
 *   A10 dual routes open in "required" mode                     → "dual"
 */
import * as http from "http";

jest.mock("../logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  return { __esModule: true, default: { info: noop, warn: noop, error: noop, debug: noop } };
});

import { RcsExtensionBridge, RCS_EXTENSION_ORIGIN } from "../rcsExtensionBridge";
import { RcsJobRegistry } from "../rcsImportJob";
import {
  PAIR_CODE_MAX_TRIES,
  PAIR_CODE_TTL_MS,
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

async function startBridge(mode: "dual" | "required" = "dual"): Promise<void> {
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
    pairingMode: mode,
  } as never);
  expect(await bridge.start(0)).toBe("listening");
  port = bridge.getStatus().port;
}

/** The extension's side: pair with the code Keepr shows. → pairId + key. */
async function pairWith(code: string): Promise<{ pairId: string; keyHex: string }> {
  const a = P.startA(code);
  const s = await post(port, "/pair/start", {}, JSON.stringify({ pA: a.pA }));
  expect(s.status).toBe(200);
  const f = P.finishA(a.state, s.body.pB as string, s.body.cB as string);
  const nonce = P.newNonce();
  const fin = await post(port, "/pair/finish", {}, JSON.stringify({ pairId: s.body.pairId, cA: f.cA, nonce }));
  expect(fin.status).toBe(200);
  const keyHex = P.sessionKey(f.ke, s.body.pairId as string);
  // Keepr's success reply is signed with the new key.
  expect(fin.sig).toBe(P.sign(keyHex, P.replyString(200, "/pair/finish", nonce, fin.text)));
  return { pairId: s.body.pairId as string, keyHex };
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

describe("pairing (BACKLOG-3666)", () => {
  it("pairs with the code Keepr shows, bound to the user who issued it", async () => {
    const { code } = auth.issueCode("user-a");
    const p = await pairWith(code);
    expect(store.rows).toEqual([{ pairId: p.pairId, userId: "user-a", keyHex: p.keyHex }]);
    expect(auth.isPaired("user-a")).toBe(true);
  });

  it("code: wrong code refused, at most 5 tries, single use, expires after 5 minutes (A7)", async () => {
    const { code } = auth.issueCode("user-a");
    // A wrong code: the extension rejects Keepr's cB; a made-up cA is refused.
    const a = P.startA("AAAAAAAA");
    const s = await post(port, "/pair/start", {}, JSON.stringify({ pA: a.pA }));
    expect(() => P.finishA(a.state, s.body.pB as string, s.body.cB as string)).toThrow("bad_confirm");
    expect((await post(port, "/pair/finish", {}, JSON.stringify({ pairId: s.body.pairId, cA: "00".repeat(32) }))).status).toBe(403);
    for (let i = 2; i <= PAIR_CODE_MAX_TRIES; i++) {
      expect((await post(port, "/pair/start", {}, JSON.stringify({ pA: P.startA("BBBBBBBB").pA }))).status).toBe(200);
    }
    const sixth = await post(port, "/pair/start", {}, JSON.stringify({ pA: P.startA(code).pA }));
    expect(sixth.status).toBe(429); // and the code is gone
    expect((await post(port, "/pair/start", {}, JSON.stringify({ pA: P.startA(code).pA }))).status).toBe(404);
    // Single use.
    const fresh = auth.issueCode("user-a");
    await pairWith(fresh.code);
    expect((await post(port, "/pair/start", {}, JSON.stringify({ pA: P.startA(fresh.code).pA }))).status).toBe(404);
    // Expiry.
    const late = auth.issueCode("user-a");
    clock += PAIR_CODE_TTL_MS + 1;
    expect((await post(port, "/pair/start", {}, JSON.stringify({ pA: P.startA(late.code).pA }))).status).toBe(404);
    expect(PAIR_CODE_MAX_TRIES).toBe(5);
    expect(PAIR_CODE_TTL_MS).toBe(5 * 60 * 1000);
  });

  it("a re-pair replaces the user's earlier pairing (the old key stops working)", async () => {
    const first = await pairWith(auth.issueCode("user-a").code);
    const second = await pairWith(auth.issueCode("user-a").code);
    expect(store.rows.map((r) => r.pairId)).toEqual([second.pairId]);
    const r = await post(port, "/job/pending", signed(first, "/job/pending").headers);
    expect(r.body.error).toBe("unknown_pair");
  });
});

describe("the auth gate (BACKLOG-3666)", () => {
  let p: { pairId: string; keyHex: string };
  beforeEach(async () => {
    p = await pairWith(auth.issueCode("user-a").code);
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

  it("/hello reveals only paired yes / no (A9)", async () => {
    const plain = await post(port, "/hello", {}, JSON.stringify({ version: "0.3.22" }));
    expect(plain.body).toEqual({ ok: true, paired: false });
    const s = signed(p, "/hello", JSON.stringify({ version: "0.3.22" }));
    const paired = await post(port, "/hello", s.headers, JSON.stringify({ version: "0.3.22" }));
    expect(paired.body).toEqual({ ok: true, paired: true });
    expect(replyOk(p, "/hello", s.nonce, paired)).toBe(true);
  });

  // SR B1: once the signed-in user is paired, the dual routes need a signature
  // too (/exclusions/set is a write). Mutation: dual routes open regardless → red.
  it("paired user: the dual routes are refused unsigned (B1)", async () => {
    for (const route of ["/exclusions/set", "/exclusions/list", "/focus", "/status"]) {
      const r = await post(port, route, {}, JSON.stringify({ conversationId: "abc", excluded: true }));
      expect(r.status).toBe(401);
      expect(r.body.error).toBe("signature_required");
    }
    // Signed, they work.
    const s = signed(p, "/exclusions/list", "{}");
    expect((await post(port, "/exclusions/list", s.headers, "{}")).status).not.toBe(401);
  });

  it("dual mode: an older, unpaired extension keeps the eyes and /status, never a job (A10)", async () => {
    auth.revoke("user-a"); // this user has no pairing: the older extension's unsigned calls
    expect((await post(port, "/exclusions/list", {}, "{}")).status).not.toBe(401);
    expect((await post(port, "/status", {})).status).toBe(200);
    expect((await post(port, "/job/pending", {})).status).toBe(401);
    await bridge.stop();
    await startBridge("required");
    expect((await post(port, "/exclusions/list", {}, "{}")).body.error).toBe("not_paired");
    expect((await post(port, "/status", {})).body.error).toBe("not_paired");
  });
});

// SR S1: the headers are checked BEFORE any body is read, and the body has its
// route's cap. A body that never ends must not hold off the refusal.
// Mutations: the body read first → the refusal never comes (timeout) → red;
// the image cap for every route → the oversized claim is accepted → red.
describe("headers before the body (S1)", () => {
  let p: { pairId: string; keyHex: string };
  beforeEach(async () => {
    p = await pairWith(auth.issueCode("user-a").code);
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

  it("each route has its own cap: an oversized body on a non-image route is refused (413)", async () => {
    const big = JSON.stringify({ x: "y".repeat(10 * 1024 * 1024 + 10) });
    const r = await post(port, "/job/pending", signed(p, "/job/pending", big).headers, big);
    expect(r.status).toBe(413);
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
      pairingMode: "dual",
    } as never);
    expect(await bridge.start(0)).toBe("listening");
    port = bridge.getStatus().port;
    const p = await pairWith(auth.issueCode("user-a").code);
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
