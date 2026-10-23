/**
 * Where a person goes after signing in to the admin portal — BACKLOG-3705.
 *
 * One validator for every post-login destination this portal accepts from a
 * request: the middleware's `redirectTo` on /login and the callback's `next`.
 * Local copy of the broker portal's rules, with this portal's own tests. A
 * destination is accepted only when ALL hold:
 *
 *   1. it starts with exactly one "/" (a second "/" or "\" at position 1 would
 *      make it a host, not a path, once resolved against this origin);
 *   2. it contains no control characters;
 *   3. it contains no ".." and no backslash, before or after percent-decoding to a
 *      fixed point (at most 5 rounds; a bad escape or a value still changing at the
 *      cap is refused);
 *   4. it is /dashboard itself or under /dashboard/ (a query or fragment after
 *      /dashboard is allowed; "/dashboardx" is not);
 *   5. resolved against a placeholder origin it keeps that origin and its pathname is
 *      still /dashboard or under /dashboard/.
 *
 * Anything else is refused, and callers fall back to DEFAULT_NEXT_PATH.
 */

export const DEFAULT_NEXT_PATH = '/dashboard';

const SINGLE_LEADING_SLASH = /^\/(?![/\\])/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const ALLOWED_BASE = '/dashboard';
const RESOLVE_BASE = 'https://x.invalid';
const MAX_DECODE_ROUNDS = 5;

/** Percent-decodes until the value stops changing. Null on a bad escape or when still changing at the cap. */
function decodeToFixpoint(value: string): string | null {
  let current = value;
  for (let i = 0; i < MAX_DECODE_ROUNDS; i++) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      return null;
    }
    if (next === current) return current;
    current = next;
  }
  return null;
}

function isUnderAllowedBase(path: string): boolean {
  const rest = path.slice(ALLOWED_BASE.length);
  return path.startsWith(ALLOWED_BASE) && (rest === '' || rest[0] === '/' || rest[0] === '?' || rest[0] === '#');
}

/** `value` is a destination this portal will redirect to after sign-in. */
export function isSafeNextPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return false;
  const decoded = decodeToFixpoint(value);
  if (decoded === null) return false;
  // The raw value and its fully decoded form must both pass every rule.
  for (const candidate of [value, decoded]) {
    if (!SINGLE_LEADING_SLASH.test(candidate)) return false;
    if (CONTROL_CHARS.test(candidate)) return false;
    if (candidate.includes('..') || candidate.includes('\\')) return false;
    if (!isUnderAllowedBase(candidate)) return false;
    // Resolve the way a redirect would: it must stay on this origin and under /dashboard.
    let resolved: URL;
    try {
      resolved = new URL(candidate, RESOLVE_BASE);
    } catch {
      return false;
    }
    if (resolved.origin !== RESOLVE_BASE) return false;
    if (resolved.pathname !== ALLOWED_BASE && !resolved.pathname.startsWith(`${ALLOWED_BASE}/`)) return false;
  }
  return true;
}

/** `value` when it is a safe destination, else `fallback` (default /dashboard). */
export function safeNextPath(value: unknown, fallback: string = DEFAULT_NEXT_PATH): string {
  return isSafeNextPath(value) ? value : fallback;
}
