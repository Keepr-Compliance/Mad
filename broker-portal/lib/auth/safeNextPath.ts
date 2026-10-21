/**
 * Where a person goes after signing in — BACKLOG-3863 PR-2 (SR R7), BACKLOG-3705.
 *
 * One validator for every post-login destination this portal accepts from a
 * request: the middleware's `redirectTo` on /login, and the post-login path
 * cookie read by /auth/callback. A destination is accepted only when ALL hold:
 *
 *   1. it starts with exactly one "/" (a second "/" or "\" at position 1 would
 *      make it a host, not a path, once resolved against this origin);
 *   2. it contains no control characters;
 *   3. it contains no ".." anywhere;
 *   4. it is /dashboard itself or under /dashboard/ (a query or fragment after
 *      /dashboard is allowed; "/dashboardx" is not).
 *
 * Anything else is refused, and callers fall back to DEFAULT_NEXT_PATH.
 */

import type { NextResponse } from 'next/server';

export const DEFAULT_NEXT_PATH = '/dashboard';

export const NEXT_PATH_COOKIE_NAME = 'keepr_next';
export const NEXT_PATH_COOKIE_PATH = '/auth';
export const NEXT_PATH_COOKIE_MAX_AGE_SECONDS = 1800;

const SINGLE_LEADING_SLASH = /^\/(?![\/\\])/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const ALLOWED_BASE = '/dashboard';

/** `value` is a destination this portal will redirect to after sign-in. */
export function isSafeNextPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return false;
  if (!SINGLE_LEADING_SLASH.test(value)) return false;
  if (CONTROL_CHARS.test(value)) return false;
  if (value.includes('..')) return false;
  const rest = value.slice(ALLOWED_BASE.length);
  return value.startsWith(ALLOWED_BASE) && (rest === '' || rest[0] === '/' || rest[0] === '?' || rest[0] === '#');
}

/** `value` when it is a safe destination, else `fallback` (default /dashboard). */
export function safeNextPath(value: unknown, fallback: string = DEFAULT_NEXT_PATH): string {
  return isSafeNextPath(value) ? value : fallback;
}

/** Stores a safe destination for the OAuth callback. An unsafe one is not stored. */
export function setNextPathCookie(response: NextResponse, path: string): void {
  if (!isSafeNextPath(path)) return;
  response.cookies.set({
    name: NEXT_PATH_COOKIE_NAME,
    value: path,
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: NEXT_PATH_COOKIE_PATH,
    maxAge: NEXT_PATH_COOKIE_MAX_AGE_SECONDS,
  });
}

/** The cookie's destination, re-validated; null when absent or unsafe. */
export function readNextPathCookie(request: Request): string | null {
  const header = request.headers.get('cookie') ?? '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== NEXT_PATH_COOKIE_NAME) continue;
    let value = part.slice(eq + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      return null;
    }
    return isSafeNextPath(value) ? value : null;
  }
  return null;
}

/** Deletes the cookie on `response`, with the Path it was set with. */
export function clearNextPathCookie(response: NextResponse): void {
  response.cookies.delete({ name: NEXT_PATH_COOKIE_NAME, path: NEXT_PATH_COOKIE_PATH });
}
