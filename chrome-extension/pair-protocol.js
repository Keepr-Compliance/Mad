/**
 * Keepr pairing protocol (BACKLOG-3666) — ONE file, used by BOTH sides: the
 * extension's service worker (importScripts) and the Keepr app (which loads
 * this very file from the extension folder it ships). Pure functions; the
 * crypto is @noble/curves + @noble/hashes (vendor/noble-p256.js, MIT).
 *
 * PAKE: SPAKE2 (RFC 9382) on P-256 with SHA-256, HKDF and HMAC. A short
 * one-time code (8 base32 characters) shown in Keepr is the password: an
 * attacker can only test ONE guess per online attempt (Keepr allows 5), and
 * a process squatting Keepr's port cannot complete the exchange without it.
 *
 *   extension (A)                         Keepr (B)
 *   x, pA = x·G + w·M   ── /pair/start ─▶  y, pB = y·G + w·N
 *                                          Z = y·(pA − w·M)
 *                       ◀── pB, cB ──────  (cB proves Keepr knows the code)
 *   Z = x·(pB − w·N); check cB
 *   cA                  ── /pair/finish ▶  check cA → paired
 *
 *   K (the session key) = HKDF(Ke, salt = pairId, "keepr pair session v1").
 *
 * Every later request is signed: HMAC-SHA256(K, method, path, ts, nonce,
 * sha256(body)); every reply too: HMAC(K, status, path, the request's nonce,
 * sha256(body)). Hex strings throughout.
 */
(function (root) {
  "use strict";

  var N0 = typeof module !== "undefined" && module.exports && typeof require === "function"
    ? require("./vendor/noble-p256.js")
    : root.KeeprNoble;
  if (!N0) throw new Error("Keepr pairing: the crypto library is missing");
  var noble = N0;
  var Point = noble.p256.ProjectivePoint;
  var ORDER = noble.p256.CURVE.n;

  var VERSION = "keepr-pair-v1";
  var ID_A = "keepr-extension";
  var ID_B = "keepr-app";
  /** RFC 9382 §6, P-256: the fixed points M and N (nobody knows their discrete logs). */
  var M = Point.fromHex("02886e2f97ace46e55ba9dd7242579f2993b64e16ef3dcab95afd497333d8fa12f");
  var N = Point.fromHex("03d8bbd6c639c62937b04d997f38c3770719c629d7014d49a24b4f98baa1292b49");

  /** RFC 4648 base32 without padding: a code is 8 of these (40 bits). */
  var CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  var CODE_LENGTH = 8;

  var hex = noble.bytesToHex;
  var unhex = noble.hexToBytes;
  var utf8 = noble.utf8ToBytes;

  function bytesToBigInt(b) {
    var h = hex(b);
    return h.length ? BigInt("0x" + h) : BigInt(0);
  }

  /** A fresh code from the CSPRNG: 8 characters of CODE_ALPHABET. */
  function newCode() {
    var bytes = noble.randomBytes(CODE_LENGTH);
    var out = "";
    for (var i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[bytes[i] & 31];
    return out;
  }

  /**
   * UX redesign (C1, founder 2026-10-03): REVERSED linking. The extension's
   * popup makes a 6-digit code (never sent anywhere) and the user types it
   * into Keepr. Same SPAKE2: the popup is A, Keepr is B. 2 minutes, 5 tries,
   * one pending session (Keepr side).
   */
  var LINK_CODE_LENGTH = 6;

  /** A fresh 6-digit link code from the CSPRNG (no modulo bias that matters: 0..999 999 from 24 bits, rejection-sampled). */
  function newLinkCode() {
    for (;;) {
      var b = noble.randomBytes(3);
      var n = (b[0] << 16) | (b[1] << 8) | b[2];
      if (n < 16000000) return String(n % 1000000).padStart(LINK_CODE_LENGTH, "0");
    }
  }

  /** As typed in Keepr: digits only (spaces and dashes removed). null when it cannot be a link code. */
  function normalizeLinkCode(text) {
    var c = String(text || "").replace(/[\s-]/g, "");
    return /^[0-9]{6}$/.test(c) ? c : null;
  }

  /** As typed: upper case, spaces and dashes removed. null when it cannot be a code. */
  function normalizeCode(text) {
    var c = String(text || "").toUpperCase().replace(/[\s-]/g, "");
    if (c.length !== CODE_LENGTH) return null;
    for (var i = 0; i < c.length; i++) if (CODE_ALPHABET.indexOf(c[i]) < 0) return null;
    return c;
  }

  /** w: the code as a non-zero scalar (HKDF, 48 bytes reduced mod n: no bias that matters). */
  function codeScalar(code) {
    var okm = noble.hkdf(noble.sha256, utf8(code), utf8(VERSION), utf8("w"), 48);
    var w = bytesToBigInt(okm) % ORDER;
    return w === BigInt(0) ? BigInt(1) : w;
  }

  function randomScalar() {
    var k = bytesToBigInt(noble.randomBytes(48)) % ORDER;
    return k === BigInt(0) ? BigInt(1) : k;
  }

  /** A peer's public point: on the curve and not the identity, else throws. */
  function peerPoint(h) {
    var p = Point.fromHex(String(h || ""));
    p.assertValidity();
    if (p.equals(Point.ZERO)) throw new Error("bad_point");
    return p;
  }

  /** RFC 9382 transcript: each part prefixed by its 8-byte little-endian length. */
  function transcript(parts) {
    var chunks = [];
    parts.forEach(function (p) {
      var len = new Uint8Array(8);
      var n = p.length;
      for (var i = 0; i < 8; i++) {
        len[i] = n & 0xff;
        n = Math.floor(n / 256);
      }
      chunks.push(len, p);
    });
    return noble.concatBytes.apply(null, chunks);
  }

  function scalarBytes(k) {
    var h = k.toString(16);
    while (h.length < 64) h = "0" + h;
    return unhex(h);
  }

  function keys(pA, pB, Z, w) {
    var tt = transcript([utf8(ID_A), utf8(ID_B), pA.toRawBytes(false), pB.toRawBytes(false), Z.toRawBytes(false), scalarBytes(w)]);
    var h = noble.sha256(tt);
    var ke = h.slice(0, 16);
    var ka = h.slice(16, 32);
    var kc = noble.hkdf(noble.sha256, ka, new Uint8Array(0), utf8("ConfirmationKeys"), 32);
    return {
      ke: ke,
      cA: hex(noble.hmac(noble.sha256, kc.slice(0, 16), tt)),
      cB: hex(noble.hmac(noble.sha256, kc.slice(16, 32), tt)),
    };
  }

  /** Constant-time equality of two hex strings. */
  function safeEqual(a, b) {
    a = String(a || "");
    b = String(b || "");
    var diff = a.length ^ b.length;
    for (var i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0);
    return diff === 0;
  }

  /** A (the extension): its first message. Keep the state; send `pA`. */
  function startA(code) {
    var w = codeScalar(code);
    var x = randomScalar();
    var pA = Point.BASE.multiply(x).add(M.multiply(w));
    return { state: { x: x, w: w, pA: pA }, pA: pA.toHex(true) };
  }

  /** B (Keepr): its answer to pA. Send `pB`, `cB`; keep `expectCA` and `ke`. */
  function respondB(code, pAHex) {
    var pA = peerPoint(pAHex);
    var w = codeScalar(code);
    var y = randomScalar();
    var pB = Point.BASE.multiply(y).add(N.multiply(w));
    var Z = pA.subtract(M.multiply(w)).multiply(y);
    var k = keys(pA, pB, Z, w);
    return { pB: pB.toHex(true), cB: k.cB, expectCA: k.cA, ke: hex(k.ke) };
  }

  /** A: Keepr's answer. Throws "bad_confirm" unless Keepr knew the code. → { cA, ke } */
  function finishA(state, pBHex, cBHex) {
    var pB = peerPoint(pBHex);
    var Z = pB.subtract(N.multiply(state.w)).multiply(state.x);
    var k = keys(state.pA, pB, Z, state.w);
    if (!safeEqual(k.cB, cBHex)) throw new Error("bad_confirm");
    return { cA: k.cA, ke: hex(k.ke) };
  }

  /** The session key (32 bytes, hex) for a pairing id. */
  function sessionKey(keHex, pairId) {
    return hex(noble.hkdf(noble.sha256, unhex(keHex), utf8(String(pairId)), utf8("keepr pair session v1"), 32));
  }

  function bodyHash(bodyText) {
    return hex(noble.sha256(utf8(bodyText == null ? "" : String(bodyText))));
  }

  /** What a request signature covers. */
  function requestString(method, path, ts, nonce, bodyText) {
    return [VERSION, String(method).toUpperCase(), path, String(ts), nonce, bodyHash(bodyText)].join("\n");
  }

  /** What a reply signature covers (bound to the request's nonce). */
  function replyString(status, path, nonce, bodyText) {
    return [VERSION, "reply", String(status), path, nonce, bodyHash(bodyText)].join("\n");
  }

  /** HMAC-SHA256 with the session key (hex) — Keepr's side; the extension signs with a non-extractable WebCrypto key. */
  function sign(keyHex, text) {
    return hex(noble.hmac(noble.sha256, unhex(keyHex), utf8(text)));
  }

  function newNonce() {
    return hex(noble.randomBytes(16));
  }

  var api = {
    VERSION: VERSION,
    CODE_ALPHABET: CODE_ALPHABET,
    CODE_LENGTH: CODE_LENGTH,
    newCode: newCode,
    normalizeCode: normalizeCode,
    newLinkCode: newLinkCode,
    normalizeLinkCode: normalizeLinkCode,
    startA: startA,
    respondB: respondB,
    finishA: finishA,
    sessionKey: sessionKey,
    requestString: requestString,
    replyString: replyString,
    sign: sign,
    safeEqual: safeEqual,
    newNonce: newNonce,
    bodyHash: bodyHash,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.KeeprPair = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
