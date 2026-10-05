/**
 * @jest-environment node
 */
/**
 * BACKLOG-3666 — the pairing protocol (chrome-extension/pair-protocol.js),
 * SPAKE2 on P-256 (RFC 9382) over the vendored @noble libraries. The same
 * file runs in the extension and in Keepr.
 *
 * Mutations that turn this red:
 *   P1 the cB check skipped (a wrong code or a squatter accepted)   → "wrong code", "squatter"
 *   P2 w·M / w·N not removed (both sides disagree)                   → "round trip"
 *   P3 the session key not bound to the pairing id                   → "session key"
 *   P4 a signed field left out of the request / reply string         → "signatures"
 *   P5 an invalid peer point accepted                                → "points"
 *
 * EQUIVALENT (recorded, SR): dropping peerPoint()'s own assertValidity /
 * identity check stays green — noble's Point.fromHex already rejects an
 * off-curve or identity encoding. Kept as defence in depth.
 */
import * as fs from "fs";
import * as path from "path";
import { webcrypto } from "crypto";

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const P = require("../../chrome-extension/pair-protocol.js") as Record<string, any>;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

const EXT = path.join(__dirname, "..", "..", "chrome-extension");

describe("SPAKE2 pairing (P-256)", () => {
  it("round trip: both sides agree on the confirmation and the key (P2)", () => {
    const code = P.newLinkCode();
    const a = P.startA(code);
    const b = P.respondB(code, a.pA);
    const f = P.finishA(a.state, b.pB, b.cB);
    expect(f.cA).toBe(b.expectCA);
    expect(f.ke).toBe(b.ke);
    expect(P.sessionKey(f.ke, "pair-1")).toBe(P.sessionKey(b.ke, "pair-1"));
  });

  it("a wrong code: the extension rejects Keepr's confirmation, and Keepr would reject the extension's (P1)", () => {
    const a = P.startA("AAAAAAAA");
    const b = P.respondB("BBBBBBBB", a.pA);
    expect(() => P.finishA(a.state, b.pB, b.cB)).toThrow("bad_confirm");
  });

  // A process squatting Keepr's port, without the code shown in Keepr, guesses.
  it("a squatter cannot complete the exchange without the code (P1)", () => {
    const a = P.startA(P.newLinkCode());
    for (let i = 0; i < 5; i++) {
      const guess = P.respondB(P.newLinkCode(), a.pA);
      expect(() => P.finishA(a.state, guess.pB, guess.cB)).toThrow("bad_confirm");
    }
    // Nor can it answer with a random point and a made-up confirmation.
    const fake = P.startA(P.newLinkCode());
    expect(() => P.finishA(a.state, fake.pA, "00".repeat(32))).toThrow("bad_confirm");
  });

  it("each run is fresh: same code, different messages and keys", () => {
    const code = P.newLinkCode();
    const a1 = P.startA(code);
    const a2 = P.startA(code);
    expect(a1.pA).not.toBe(a2.pA);
    expect(P.respondB(code, a1.pA).ke).not.toBe(P.respondB(code, a1.pA).ke);
  });

  it("invalid peer points are refused (P5)", () => {
    expect(() => P.respondB("AAAAAAAA", "00")).toThrow();
    expect(() => P.respondB("AAAAAAAA", "02" + "ff".repeat(32))).toThrow();
    const a = P.startA("AAAAAAAA");
    expect(() => P.finishA(a.state, "zz", "00")).toThrow();
  });

  // SR clean-up step 2: the old 8-character codes are gone (only the
  // popup's 6-digit link code remains). Mutation: the helpers back → red.
  it("codes: 6 digits; typed codes normalized; no 8-character code helpers", () => {
    for (let i = 0; i < 20; i++) expect(P.newLinkCode()).toMatch(/^[0-9]{6}$/);
    expect(P.normalizeLinkCode(" 482-913 ")).toBe("482913");
    expect(P.normalizeLinkCode("48291")).toBeNull();
    expect(P.newCode).toBeUndefined();
    expect(P.normalizeCode).toBeUndefined();
  });
});

describe("session key and signatures", () => {
  const code = "QWERTY23";
  const a = P.startA(code);
  const b = P.respondB(code, a.pA);
  const key = P.sessionKey(b.ke, "pair-1");

  it("the session key is bound to the pairing id (P3)", () => {
    expect(P.sessionKey(b.ke, "pair-2")).not.toBe(key);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("every field of a request and a reply is signed (P4)", () => {
    const base = P.sign(key, P.requestString("POST", "/job/x/chat", 1000, "n1", "{\"a\":1}"));
    expect(P.sign(key, P.requestString("GET", "/job/x/chat", 1000, "n1", "{\"a\":1}"))).not.toBe(base);
    expect(P.sign(key, P.requestString("POST", "/job/y/chat", 1000, "n1", "{\"a\":1}"))).not.toBe(base);
    expect(P.sign(key, P.requestString("POST", "/job/x/chat", 1001, "n1", "{\"a\":1}"))).not.toBe(base);
    expect(P.sign(key, P.requestString("POST", "/job/x/chat", 1000, "n2", "{\"a\":1}"))).not.toBe(base);
    expect(P.sign(key, P.requestString("POST", "/job/x/chat", 1000, "n1", "{\"a\":2}"))).not.toBe(base);
    const reply = P.sign(key, P.replyString(200, "/job/x/chat", "n1", "{}"));
    expect(P.sign(key, P.replyString(403, "/job/x/chat", "n1", "{}"))).not.toBe(reply);
    expect(P.sign(key, P.replyString(200, "/job/x/chat", "n2", "{}"))).not.toBe(reply);
    expect(P.sign(key, P.replyString(200, "/job/x/chat", "n1", "{\"x\":1}"))).not.toBe(reply);
    expect(P.safeEqual(reply, reply)).toBe(true);
    expect(P.safeEqual(reply, reply.slice(0, -1) + "0")).toBe(reply.endsWith("0"));
  });

  it("the extension's non-extractable WebCrypto HMAC key signs exactly as Keepr's", async () => {
    const raw = Buffer.from(key, "hex");
    const cryptoKey = await webcrypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    expect(cryptoKey.extractable).toBe(false);
    const text = P.requestString("POST", "/job/x/claim", 1234, "abc", "");
    const sig = Buffer.from(await webcrypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(text))).toString("hex");
    expect(sig).toBe(P.sign(key, text));
  });
});

describe("the vendored library", () => {
  it("is unminified, licensed, and loaded locally (no remote code)", () => {
    const bundle = fs.readFileSync(path.join(EXT, "vendor", "noble-p256.js"), "utf8");
    expect(bundle.split("\n").length).toBeGreaterThan(1000);
    expect(fs.readFileSync(path.join(EXT, "vendor", "LICENSE-noble.txt"), "utf8")).toMatch(/@noble\/curves 1\.9\.7[\s\S]*MIT[\s\S]*@noble\/hashes 1\.8\.0/);
    for (const f of ["pair-protocol.js", "vendor/noble-p256.js"]) {
      expect(fs.readFileSync(path.join(EXT, f), "utf8")).not.toMatch(/https?:\/\/[^\s"']*\.(js|mjs)\b|import\(|fetch\(/);
    }
  });
});
