/**
 * @jest-environment node
 */

/**
 * BACKLOG-3675 — offline pass verifier (pure).
 *
 * Keys are generated in memory per run with generateKeyPairSync('ed25519');
 * nothing is written to disk. Tokens are built exactly as the issuer builds
 * them (supabase/functions/_shared/offlinePassClaims.ts): base64url JSON
 * header + payload, Ed25519 over the ASCII "<header>.<payload>".
 */

import { generateKeyPairSync, sign, type KeyObject } from "crypto";
import {
  verifyOfflinePass,
  OFFLINE_PASS_MAX_WINDOW_SEC,
} from "../offlinePass/offlinePassVerifier";

const USER_A = "user-a-3675";
const USER_B = "user-b-3675";
const ORG = "org-a-3675";
const IAT = 1_790_000_000;

function newKey(): { privateKey: KeyObject; spkiB64: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey,
    spkiB64: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
}

const K1 = newKey();
const K2 = newKey();
const KEYS = { k1: K1.spkiB64 };

const seg = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");

function payloadFor(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    sub: USER_A,
    ent: "unlimited_transactions",
    org: ORG,
    iat: IAT,
    exp: IAT + OFFLINE_PASS_MAX_WINDOW_SEC,
    pte: null,
    jti: "jti-3675",
    ...over,
  };
}

function token(opts: {
  payload?: Record<string, unknown>;
  header?: Record<string, unknown>;
  key?: KeyObject;
} = {}): string {
  const header = opts.header ?? { alg: "EdDSA", typ: "keepr-offline-pass", kid: "k1" };
  const input = `${seg(header)}.${seg(opts.payload ?? payloadFor())}`;
  const sig = sign(null, Buffer.from(input, "ascii"), opts.key ?? K1.privateKey);
  return `${input}.${sig.toString("base64url")}`;
}

const check = (tok: string, over: Partial<{ nowSec: number; userId: string; highWaterSec: number; keys: Record<string, string> }> = {}) =>
  verifyOfflinePass({
    token: tok,
    nowSec: over.nowSec ?? IAT + 60,
    keys: over.keys ?? KEYS,
    userId: over.userId ?? USER_A,
    highWaterSec: over.highWaterSec ?? 0,
  });

describe("BACKLOG-3675 offline pass verifier", () => {
  it("baseline: a well-formed pass for the signed-in user verifies", () => {
    const v = check(token());
    expect(v).toEqual(expect.objectContaining({ ok: true, kid: "k1" }));
  });

  describe("P1 edited pass ⇒ rejected", () => {
    const original = token();
    const [h, p, s] = original.split(".");

    it.each([
      ["sub", { sub: USER_B }],
      ["exp", { exp: IAT + OFFLINE_PASS_MAX_WINDOW_SEC + 3600 }],
      ["pte", { pte: IAT + 10 }],
    ])("payload field %s changed, original signature kept", (_name, over) => {
      const edited = `${h}.${seg(payloadFor(over))}.${s}`;
      expect(check(edited, { userId: (over as { sub?: string }).sub ?? USER_A })).toEqual({ ok: false, reason: "signature" });
    });

    it("header kid changed to another listed key, original signature kept", () => {
      const edited = `${seg({ alg: "EdDSA", typ: "keepr-offline-pass", kid: "k2" })}.${p}.${s}`;
      expect(check(edited, { keys: { k1: K1.spkiB64, k2: K2.spkiB64 } })).toEqual({ ok: false, reason: "signature" });
    });

    it("one byte of the signature flipped", () => {
      const sig = Buffer.from(s, "base64url");
      sig[10] ^= 0x01;
      expect(check(`${h}.${p}.${sig.toString("base64url")}`)).toEqual({ ok: false, reason: "signature" });
    });

    it("one byte of the payload flipped", () => {
      const bytes = Buffer.from(p, "base64url");
      bytes[5] ^= 0x01;
      const v = check(`${h}.${bytes.toString("base64url")}.${s}`);
      expect(v.ok).toBe(false);
    });
  });

  describe("P2 expiry boundary sweep", () => {
    const exp = IAT + 3600;
    const tok = token({ payload: payloadFor({ exp }) });
    it("now = exp - 1 ⇒ accepted", () => expect(check(tok, { nowSec: exp - 1 }).ok).toBe(true));
    it("now = exp ⇒ rejected", () => expect(check(tok, { nowSec: exp })).toEqual({ ok: false, reason: "expired" }));
    it("now = exp + 1 ⇒ rejected", () => expect(check(tok, { nowSec: exp + 1 })).toEqual({ ok: false, reason: "expired" }));
  });

  it("P3 pass for user B, signed in as user A ⇒ rejected", () => {
    expect(check(token({ payload: payloadFor({ sub: USER_B }) }))).toEqual({ ok: false, reason: "wrong_user" });
  });

  describe("P4 paid period (verifier half)", () => {
    it("exp beyond pte ⇒ rejected", () => {
      const tok = token({ payload: payloadFor({ pte: IAT + 3600, exp: IAT + 3601 }) });
      expect(check(tok)).toEqual({ ok: false, reason: "window" });
    });
    it("exp == pte ⇒ accepted", () => {
      const tok = token({ payload: payloadFor({ pte: IAT + 3600, exp: IAT + 3600 }) });
      expect(check(tok).ok).toBe(true);
    });
  });

  describe("P5 48 h cap", () => {
    it("exp - iat = 172801 ⇒ rejected", () => {
      const tok = token({ payload: payloadFor({ exp: IAT + 172801 }) });
      expect(check(tok)).toEqual({ ok: false, reason: "window" });
    });
    it("exp - iat = 172800 ⇒ accepted", () => {
      const tok = token({ payload: payloadFor({ exp: IAT + 172800 }) });
      expect(check(tok).ok).toBe(true);
    });
    it("exp == iat ⇒ rejected", () => {
      const tok = token({ payload: payloadFor({ exp: IAT }) });
      expect(check(tok, { nowSec: IAT - 1 })).toEqual({ ok: false, reason: "window" });
    });
  });

  describe("P11 unsigned / unknown kid", () => {
    it('alg "none" with an empty signature ⇒ rejected', () => {
      const input = `${seg({ alg: "none", typ: "keepr-offline-pass", kid: "k1" })}.${seg(payloadFor())}`;
      expect(check(`${input}.`).ok).toBe(false);
      expect(check(`${input}.AA`)).toEqual({ ok: false, reason: "header" });
    });
    it('kid "k9" (not listed), signed with k1 ⇒ rejected', () => {
      const tok = token({ header: { alg: "EdDSA", typ: "keepr-offline-pass", kid: "k9" } });
      expect(check(tok)).toEqual({ ok: false, reason: "unknown_kid" });
    });
    it("kid k1 but signed with another key ⇒ rejected", () => {
      expect(check(token({ key: K2.privateKey }))).toEqual({ ok: false, reason: "signature" });
    });
    it("empty key map (the shipped placeholder) ⇒ every pass rejected", () => {
      expect(check(token(), { keys: {} })).toEqual({ ok: false, reason: "unknown_kid" });
    });
  });

  describe("P13 clock rollback (high-water)", () => {
    it("high-water = now + 3600 ⇒ rejected", () => {
      expect(check(token(), { highWaterSec: IAT + 60 + 3600 })).toEqual({ ok: false, reason: "clock_rollback" });
    });
    it("high-water = now + 899 ⇒ accepted (inside the 15 min skew)", () => {
      expect(check(token(), { highWaterSec: IAT + 60 + 899 }).ok).toBe(true);
    });
    it("high-water = now + 901 ⇒ rejected", () => {
      expect(check(token(), { highWaterSec: IAT + 60 + 901 })).toEqual({ ok: false, reason: "clock_rollback" });
    });
  });

  describe("V6 pass dated in the future", () => {
    it("now = iat - 900 ⇒ accepted; now = iat - 901 ⇒ rejected", () => {
      expect(check(token(), { nowSec: IAT - 900 }).ok).toBe(true);
      expect(check(token(), { nowSec: IAT - 901 })).toEqual({ ok: false, reason: "not_yet_valid" });
    });
  });

  describe("V1/V4 shape and payload", () => {
    it("two segments ⇒ rejected", () => {
      expect(check(token().split(".").slice(0, 2).join("."))).toEqual({ ok: false, reason: "shape" });
    });
    it("non-canonical base64url (padding) ⇒ rejected", () => {
      const [h, p, s] = token().split(".");
      expect(check(`${h}=.${p}.${s}`)).toEqual({ ok: false, reason: "shape" });
    });
    it("extra header field ⇒ rejected", () => {
      const tok = token({ header: { alg: "EdDSA", typ: "keepr-offline-pass", kid: "k1", x: 1 } });
      expect(check(tok)).toEqual({ ok: false, reason: "header" });
    });
    it.each([
      ["v: 2", { v: 2 }],
      ["ent other", { ent: "transaction_checklists" }],
      ["iat string", { iat: String(IAT) }],
      ["exp float", { exp: IAT + 0.5 }],
      ["pte string", { pte: "2026-11-01T00:00:00Z" }],
    ])("%s ⇒ rejected", (_n, over) => {
      expect(check(token({ payload: payloadFor(over) }))).toEqual({ ok: false, reason: "payload" });
    });
  });
});
