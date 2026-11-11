/**
 * BACKLOG-4015: who may call directory-sync.
 *
 * The function is deployed with verify_jwt = true (supabase/config.toml), so the gateway has
 * already verified the signature of any JWT bearer that reaches this code. A caller is accepted
 * when either:
 *   1. the bearer is timing-safe equal to one of the function's own keys: the injected
 *      SUPABASE_SERVICE_ROLE_KEY, or any value of the SUPABASE_SECRET_KEYS object; or
 *   2. the bearer is a JWT whose payload has role "service_role" and ref equal to this
 *      project's ref, read from SUPABASE_URL's host.
 * Everything else is refused. Fails closed: when the project ref cannot be read from
 * SUPABASE_URL, branch 2 accepts nothing.
 *
 * Web APIs only (atob, TextDecoder, URL, JSON). Nothing here logs a header, token or key.
 */

export type AuthDecision = { ok: true } | { ok: false; status: 401 | 403 };

export interface ServiceAuthEnv {
  /** Deno.env SUPABASE_SERVICE_ROLE_KEY as injected into the function. */
  serviceKey: string;
  /** Deno.env SUPABASE_URL. */
  supabaseUrl: string;
  /** Deno.env SUPABASE_SECRET_KEYS, raw, if set. */
  secretKeys?: string | null;
}

/** Constant-time string compare (same shape as submission-sweep/handler.ts). */
export function timingSafeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/**
 * Parse SUPABASE_SECRET_KEYS into a list of key strings.
 *
 * The platform injects a JSON object of name -> key (measured on keepr-test, BACKLOG-4150).
 * Only that form is read: every string value of the object is a key. Anything else (not JSON,
 * a JSON array, string or other value) yields no keys, so the variable never widens the set
 * of accepted bearers beyond its own values.
 */
export function parseSecretKeys(raw: string | null | undefined): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  return Object.values(parsed).filter((v): v is string => typeof v === "string");
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    let b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4 !== 0) b64 += "=";
    const json = new TextDecoder().decode(
      Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)),
    );
    const payload = JSON.parse(json);
    return payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The project ref is the first label of SUPABASE_URL's host (<ref>.supabase.co; measured on
 * keepr-test). Returns null when the URL cannot be parsed or has no usable first label.
 * Local `supabase start` (host kong / 127.0.0.1) and custom domains: behaviour UNTRACED; the
 * JWT branch then compares against a label that is not a ref, and so refuses (fails closed).
 */
export function projectRefFromUrl(supabaseUrl: string): string | null {
  try {
    return new URL(supabaseUrl).hostname.split(".")[0] || null;
  } catch {
    return null;
  }
}

export function authorizeServiceCaller(
  authHeader: string | null,
  env: ServiceAuthEnv,
): AuthDecision {
  if (!authHeader?.startsWith("Bearer ")) return { ok: false, status: 401 };
  const token = authHeader.substring(7);
  if (token.length === 0) return { ok: false, status: 403 };

  // 1. The function's own keys. Compare against every candidate (no early exit).
  // An empty candidate cannot match: an empty token was refused above.
  const candidates = [env.serviceKey, ...parseSecretKeys(env.secretKeys)];
  let keyMatch = false;
  for (const key of candidates) {
    if (timingSafeEqual(token, key)) keyMatch = true;
  }
  if (keyMatch) return { ok: true };

  // 2. A gateway-verified service_role JWT for this project.
  const claims = decodeJwtPayload(token);
  const ref = projectRefFromUrl(env.supabaseUrl);
  if (
    claims &&
    claims.role === "service_role" &&
    ref !== null &&
    claims.ref === ref
  ) {
    return { ok: true };
  }
  return { ok: false, status: 403 };
}
