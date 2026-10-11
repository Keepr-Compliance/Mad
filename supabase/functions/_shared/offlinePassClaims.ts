/**
 * Offline pass claims and signing (BACKLOG-3675).
 *
 * Shared by the `issue-offline-pass` Edge Function (Deno) and its jest tests
 * (node). This file has ZERO imports on purpose: Deno needs ".ts"-suffixed
 * specifiers and tsc rejects them, so any import would break one side. It
 * uses only globals both runtimes provide: TextEncoder, btoa/atob and
 * WebCrypto (`globalThis.crypto.subtle`).
 *
 * Pass format (verified on the desktop by offlinePassVerifier.ts):
 *   base64url(header) "." base64url(payload) "." base64url(Ed25519 signature)
 *   signature over the ASCII bytes of base64url(header) "." base64url(payload).
 */

/** The longest window a pass may cover: 48 hours. */
export const OFFLINE_PASS_MAX_WINDOW_SEC = 172800;
export const OFFLINE_PASS_TYP = "keepr-offline-pass";
export const OFFLINE_PASS_ENTITLEMENT = "unlimited_transactions";

export interface OfflinePassClaims {
  v: 1;
  sub: string;
  ent: typeof OFFLINE_PASS_ENTITLEMENT;
  org: string;
  iat: number;
  exp: number;
  pte: number | null;
  jti: string;
}

export interface MembershipRowLike {
  organization_id: string;
  organizations?:
    | { personal_owner_user_id?: string | null }
    | Array<{ personal_owner_user_id?: string | null }>
    | null;
}

/**
 * Pick the organization whose features decide, from the caller's ACTIVE
 * membership rows already ordered by (created_at, id): the earliest
 * non-personal (brokerage) row, else the earliest row. This is the same rule
 * as the desktop's supabaseService.getActiveOrganizationMembershipOutcome, so
 * issuer and desktop resolve the same organization.
 */
export function chooseMembership(rows: readonly MembershipRowLike[]): string | null {
  if (rows.length === 0) return null;
  const isPersonal = (row: MembershipRowLike): boolean => {
    const embed = row.organizations;
    const org = !embed ? null : Array.isArray(embed) ? (embed[0] ?? null) : embed;
    return !!org?.personal_owner_user_id;
  };
  const chosen = rows.find((row) => !isPersonal(row)) ?? rows[0];
  return chosen.organization_id;
}

/**
 * True only when `get_org_features` returned the feature with `enabled: true`
 * (a boolean). The refusal shape `{error, features: []}` and any other value
 * read as not entitled.
 */
export function isUnlimitedEnabled(orgFeatures: unknown): boolean {
  if (!orgFeatures || typeof orgFeatures !== "object" || Array.isArray(orgFeatures)) return false;
  const record = orgFeatures as Record<string, unknown>;
  if (record.error !== undefined && record.error !== null) return false;
  const features = record.features;
  if (!features || typeof features !== "object" || Array.isArray(features)) return false;
  const entry = (features as Record<string, unknown>)[OFFLINE_PASS_ENTITLEMENT];
  if (!entry || typeof entry !== "object") return false;
  return (entry as Record<string, unknown>).enabled === true;
}

/**
 * Read the optional `paid_through` from the override object.
 * absent / null → `{ ok: true, pte: null }` (no paid-period cap);
 * a parseable ISO-8601 string → seconds; anything else → `{ ok: false }`.
 */
export function parsePaidThrough(
  override: unknown,
): { ok: true; pte: number | null } | { ok: false } {
  if (!override || typeof override !== "object" || Array.isArray(override)) {
    return { ok: true, pte: null };
  }
  const raw = (override as Record<string, unknown>).paid_through;
  if (raw === undefined || raw === null) return { ok: true, pte: null };
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(raw)) return { ok: false };
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return { ok: false };
  return { ok: true, pte: Math.floor(ms / 1000) };
}

/**
 * Claims for a new pass: `exp = min(iat + 48 h, pte)`.
 * @returns null when the paid period has already ended (`pte <= iat`).
 */
export function computePassClaims(input: {
  sub: string;
  org: string;
  nowSec: number;
  pte: number | null;
  jti: string;
}): OfflinePassClaims | null {
  const iat = Math.floor(input.nowSec);
  if (input.pte !== null && input.pte <= iat) return null;
  const cap = iat + OFFLINE_PASS_MAX_WINDOW_SEC;
  const exp = input.pte === null ? cap : Math.min(cap, input.pte);
  return {
    v: 1,
    sub: input.sub,
    ent: OFFLINE_PASS_ENTITLEMENT,
    org: input.org,
    iat,
    exp,
    pte: input.pte,
    jti: input.jti,
  };
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64Decode(b64: string): Uint8Array {
  const binary = atob(b64.trim());
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function encodeJsonSegment(value: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

/**
 * Sign the claims with an Ed25519 private key given as PKCS#8 DER (base64),
 * using WebCrypto. Returns the compact token.
 */
export async function signOfflinePass(input: {
  claims: OfflinePassClaims;
  kid: string;
  pkcs8Base64: string;
}): Promise<string> {
  const subtle = globalThis.crypto.subtle;
  const der = base64Decode(input.pkcs8Base64);
  // `der` is a fresh array, so its whole buffer is exactly the key bytes.
  const key = await subtle.importKey("pkcs8", der.buffer as ArrayBuffer, { name: "Ed25519" }, false, ["sign"]);
  const header = { alg: "EdDSA", typ: OFFLINE_PASS_TYP, kid: input.kid };
  const signingInput = `${encodeJsonSegment(header)}.${encodeJsonSegment(input.claims)}`;
  const signature = await subtle.sign(
    { name: "Ed25519" },
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}
