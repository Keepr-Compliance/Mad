/** Request checks for the OAuth routes (BACKLOG-4238). */

const MAX_REDIRECT_URI_LENGTH = 2000;

/**
 * Shape of a redirect URI: at most 2000 characters, parseable, https, no
 * fragment, no userinfo. Whether it is allowed is decided by the database.
 */
export function isRedirectUriShape(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > MAX_REDIRECT_URI_LENGTH) return false;
  if (value.includes('#')) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  if (url.hash) return false;
  return true;
}

// C0 controls, DEL and C1 controls.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

function codePoints(s: string): number {
  return [...s].length;
}

/**
 * The client name to store: the given name when it is a string of 1-100
 * characters without control characters; the host of the first redirect URI
 * when no name was given; otherwise null (refused).
 */
export function clientNameFor(value: unknown, firstRedirectUri: string): string | null {
  if (value === undefined) {
    const host = new URL(firstRedirectUri).host;
    return codePoints(host) >= 1 && codePoints(host) <= 100 ? host : null;
  }
  if (typeof value !== 'string') return null;
  const n = codePoints(value);
  if (n < 1 || n > 100) return null;
  if (CONTROL_CHARS.test(value)) return null;
  return value;
}

/** True when `value` is absent, or an array of strings each in `allowed`. */
export function isSubsetOf(value: unknown, allowed: readonly string[]): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  return value.every((v) => typeof v === 'string' && allowed.includes(v));
}

/** Parameters of a query string or form body, with duplicate detection. */
interface ParsedForm {
  /** Defined parameters that appear exactly once with a non-empty value. An empty value counts as absent. */
  values: Map<string, string>;
  /** Defined parameters that appear more than once. */
  duplicates: string[];
  /** Every parameter name in the request, defined or not, in order. */
  names: string[];
}

export function parseForm(params: URLSearchParams, defined: readonly string[]): ParsedForm {
  const known = new Set(defined);
  const counts = new Map<string, number>();
  const values = new Map<string, string>();
  const names: string[] = [];
  for (const [name, value] of params) {
    names.push(name);
    if (!known.has(name)) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
    if (value !== '') values.set(name, value);
  }
  const duplicates = [...counts].filter(([, n]) => n > 1).map(([name]) => name);
  for (const name of duplicates) values.delete(name);
  return { values, duplicates, names };
}

/**
 * True when `raw` is the resource `expected` ('https://host/path'): the scheme
 * and host compared without case, the path byte for byte, and nothing else
 * (no port, userinfo, query, fragment or trailing slash).
 */
export function canonicalResource(raw: string, expected: string): boolean {
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)(\/[^?#]*)$/.exec(raw);
  const e = /^(https):\/\/([^/?#]+)(\/[^?#]*)$/.exec(expected);
  if (!m || !e) return false;
  return m[1].toLowerCase() === e[1] && m[2].toLowerCase() === e[2].toLowerCase() && m[3] === e[3];
}

/** Scope values that mean the one scope this server grants. */
const READ_SCOPES = new Set(['mcp:read', 'offline_access', 'openid', 'profile', 'email']);

/**
 * 'mcp:read' when the scope is absent or empty, or every space-separated value
 * is one of READ_SCOPES; otherwise the raw value, which the database refuses.
 */
export function normaliseScope(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return 'mcp:read';
  const tokens = raw.split(' ').filter((t) => t.length > 0);
  if (tokens.length === 0) return 'mcp:read';
  return tokens.every((t) => READ_SCOPES.has(t)) ? 'mcp:read' : raw;
}

const CLIENT_ID = /^kpr_c_[A-Za-z0-9_-]{22}$/;
const CREDENTIAL: Record<'ac' | 'rt' | 'bd', RegExp> = {
  ac: /^kpr_ac_[A-Za-z0-9_-]{43}$/,
  rt: /^kpr_rt_[A-Za-z0-9_-]{43}$/,
  bd: /^kpr_bd_[A-Za-z0-9_-]{43}$/,
};
// RFC 7636 section 4.1
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{22}$/;
/** The consent nonce: base64url of 32 bytes (mcp_authorize_view). */
const NONCE = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isClientId(v: unknown): v is string {
  return typeof v === 'string' && CLIENT_ID.test(v);
}

export function isCredential(kind: 'ac' | 'rt' | 'bd', v: unknown): v is string {
  return typeof v === 'string' && CREDENTIAL[kind].test(v);
}

export function isCodeVerifier(v: unknown): v is string {
  return typeof v === 'string' && VERIFIER.test(v);
}

export function isRequestId(v: unknown): v is string {
  return typeof v === 'string' && REQUEST_ID.test(v);
}

export function isNonce(v: unknown): v is string {
  return typeof v === 'string' && NONCE.test(v);
}

/** A connection id: a lowercase uuid, as Postgres prints it. */
export function isConnectionId(v: unknown): v is string {
  return typeof v === 'string' && UUID.test(v);
}
