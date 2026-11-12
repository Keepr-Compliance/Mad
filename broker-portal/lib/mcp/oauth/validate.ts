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
