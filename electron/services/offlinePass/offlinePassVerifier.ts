/**
 * Offline pass verifier (BACKLOG-3675).
 *
 * Pure: the current time, the key map, the signed-in user id and the stored
 * high-water mark are all injected. No I/O, no Electron import.
 *
 * Token format: three base64url segments (no padding) joined by ".":
 *   header  {"alg":"EdDSA","typ":"keepr-offline-pass","kid":"k1"}
 *   payload {"v":1,"sub","ent","org","iat","exp","pte","jti"}
 *   signature: Ed25519 over the ASCII bytes of "<header>.<payload>".
 *
 * Every check below must pass; any failure returns `{ ok: false }` and the
 * caller treats the account as not entitled (the normal paywall path).
 */

import { createPublicKey, verify as cryptoVerify } from "crypto";

/** The longest window a pass may cover: 48 hours. */
export const OFFLINE_PASS_MAX_WINDOW_SEC = 172800;
/** Tolerated clock difference between the device and the issuer. */
export const OFFLINE_PASS_SKEW_SEC = 900;
export const OFFLINE_PASS_TYP = "keepr-offline-pass";
export const OFFLINE_PASS_ENTITLEMENT = "unlimited_transactions";

export interface OfflinePassPayload {
  v: 1;
  sub: string;
  ent: typeof OFFLINE_PASS_ENTITLEMENT;
  org?: string;
  iat: number;
  exp: number;
  pte: number | null;
  jti?: string;
}

export type OfflinePassRejection =
  | "shape"
  | "header"
  | "unknown_kid"
  | "signature"
  | "payload"
  | "wrong_user"
  | "window"
  | "expired"
  | "not_yet_valid"
  | "clock_rollback";

export type OfflinePassVerdict =
  | { ok: true; kid: string; payload: OfflinePassPayload }
  | { ok: false; reason: OfflinePassRejection };

export interface VerifyOfflinePassInput {
  token: string;
  /** Current wall-clock time, in whole seconds. */
  nowSec: number;
  /** kid → Ed25519 SPKI DER, base64. */
  keys: Readonly<Record<string, string>>;
  /** The signed-in user's id. The pass must name exactly this user. */
  userId: string;
  /** Largest wall-clock second the store has observed (0 when none). */
  highWaterSec: number;
}

/** Decode one base64url segment; null unless it re-encodes to the same text. */
function decodeCanonicalSegment(segment: string): Buffer | null {
  if (segment.length === 0 || !/^[A-Za-z0-9_-]+$/.test(segment)) return null;
  const bytes = Buffer.from(segment, "base64url");
  if (bytes.toString("base64url") !== segment) return null;
  return bytes;
}

function parseJsonObject(bytes: Buffer): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

export function verifyOfflinePass(input: VerifyOfflinePassInput): OfflinePassVerdict {
  const { token, nowSec, keys, userId, highWaterSec } = input;

  // V1 shape
  if (typeof token !== "string") return { ok: false, reason: "shape" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "shape" };
  const [headerSeg, payloadSeg, sigSeg] = parts;
  const headerBytes = decodeCanonicalSegment(headerSeg);
  const payloadBytes = decodeCanonicalSegment(payloadSeg);
  const signature = decodeCanonicalSegment(sigSeg);
  if (!headerBytes || !payloadBytes || !signature) return { ok: false, reason: "shape" };

  const header = parseJsonObject(headerBytes);
  if (
    !header ||
    Object.keys(header).length !== 3 ||
    header.alg !== "EdDSA" ||
    header.typ !== OFFLINE_PASS_TYP ||
    typeof header.kid !== "string"
  ) {
    return { ok: false, reason: "header" };
  }
  const kid = header.kid;

  // V2 kid must be listed; there is no fallback key.
  if (!Object.prototype.hasOwnProperty.call(keys, kid)) {
    return { ok: false, reason: "unknown_kid" };
  }

  // V3 signature
  let signatureValid = false;
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(keys[kid], "base64"),
      format: "der",
      type: "spki",
    });
    signatureValid = cryptoVerify(
      null,
      Buffer.from(`${headerSeg}.${payloadSeg}`, "ascii"),
      publicKey,
      signature,
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) return { ok: false, reason: "signature" };

  // V4 payload
  const payload = parseJsonObject(payloadBytes);
  if (
    !payload ||
    payload.v !== 1 ||
    payload.ent !== OFFLINE_PASS_ENTITLEMENT ||
    typeof payload.sub !== "string" ||
    !isInt(payload.iat) ||
    !isInt(payload.exp) ||
    !(payload.pte === null || isInt(payload.pte))
  ) {
    return { ok: false, reason: "payload" };
  }
  if (payload.sub !== userId) return { ok: false, reason: "wrong_user" };

  const iat = payload.iat;
  const exp = payload.exp;
  const pte = payload.pte as number | null;

  // V5 window: the 48 h cap and the paid-period cap, re-enforced here.
  if (!(exp > iat) || exp - iat > OFFLINE_PASS_MAX_WINDOW_SEC || (pte !== null && exp > pte)) {
    return { ok: false, reason: "window" };
  }

  // V6 time
  if (!(nowSec < exp)) return { ok: false, reason: "expired" };
  if (nowSec < iat - OFFLINE_PASS_SKEW_SEC) return { ok: false, reason: "not_yet_valid" };

  // V7 clock moved back after a later time was observed
  if (nowSec < highWaterSec - OFFLINE_PASS_SKEW_SEC) {
    return { ok: false, reason: "clock_rollback" };
  }

  return { ok: true, kid, payload: payload as unknown as OfflinePassPayload };
}
