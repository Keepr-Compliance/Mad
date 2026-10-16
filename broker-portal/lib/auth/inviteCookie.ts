/**
 * BACKLOG-3684: carries an invitation token from the invitation link to the
 * OAuth callback that accepts it.
 *
 * Set by POST /api/invite/start (never by a GET), read and cleared by
 * /auth/callback and /auth/setup/callback. httpOnly, Secure, SameSite=Lax (it
 * must survive the top-level redirect back from the identity provider),
 * Path=/auth, 30 minutes. The value is "<purpose>.<token>": each callback only
 * uses a cookie its own page set.
 *
 * A browser deletes a cookie only when name AND path match the cookie it holds,
 * so every clear here carries the same Path it was set with.
 */

import type { NextResponse } from 'next/server';

export const INVITE_COOKIE_NAME = 'keepr_invite';
export const INVITE_COOKIE_PATH = '/auth';
export const INVITE_COOKIE_MAX_AGE_SECONDS = 1800;

export type InvitePurpose = 'invite' | 'setup';

const PURPOSES: readonly InvitePurpose[] = ['invite', 'setup'];

/** Tokens are issued as hex (randomBytes / gen_random_bytes); anything else is not ours. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

export function isInvitePurpose(value: unknown): value is InvitePurpose {
  return typeof value === 'string' && (PURPOSES as readonly string[]).includes(value);
}

export function isPlausibleInviteToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}

export function setInviteCookie(response: NextResponse, purpose: InvitePurpose, token: string): void {
  response.cookies.set({
    name: INVITE_COOKIE_NAME,
    value: `${purpose}.${token}`,
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: INVITE_COOKIE_PATH,
    maxAge: INVITE_COOKIE_MAX_AGE_SECONDS,
  });
}

/**
 * The token from the request's invite cookie when it was set for `purpose`,
 * else null.
 */
export function readInviteToken(request: Request, purpose: InvitePurpose): string | null {
  const header = request.headers.get('cookie') ?? '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== INVITE_COOKIE_NAME) continue;
    let value = part.slice(eq + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      return null;
    }
    const dot = value.indexOf('.');
    if (dot < 0) return null;
    const cookiePurpose = value.slice(0, dot);
    const token = value.slice(dot + 1);
    if (cookiePurpose !== purpose || !isPlausibleInviteToken(token)) return null;
    return token;
  }
  return null;
}

/** Deletes the invite cookie on `response`, with the Path it was set with. */
export function clearInviteCookie(response: NextResponse): void {
  response.cookies.delete({ name: INVITE_COOKIE_NAME, path: INVITE_COOKIE_PATH });
}
