/**
 * BACKLOG-3601: the one place in this portal that ends a Supabase session.
 *
 * `signOutLocal` always ends ONLY the session held by this browser or this
 * request (`scope: 'local'`). It takes no scope or options argument on
 * purpose, and it never throws: a failure comes back as `{ error }`.
 *
 * This portal has no sign-out-everywhere action; every sign-out is local.
 *
 * This file is imported by server routes AND by 'use client' pages, so it has
 * no value import from `next/*` and no 'server-only' / 'use server' directive.
 * `lib/__tests__/signOut-guard-3601.test.ts` enforces all of the above.
 */

import type { NextResponse } from 'next/server';

type SignOutOptions = { scope?: 'global' | 'local' | 'others' };

/** The one method this helper needs from a Supabase client (browser or server). */
interface AuthWithSignOut {
  signOut(options?: SignOutOptions): Promise<{ error: unknown }>;
}

export interface SignOutCapableClient {
  auth: AuthWithSignOut;
}

/** Ends this browser's / this request's session only. Never throws. */
export async function signOutLocal(supabase: SignOutCapableClient): Promise<{ error: unknown }> {
  try {
    const result = await supabase.auth.signOut({ scope: 'local' });
    return { error: result?.error ?? null };
  } catch (error) {
    return { error: error ?? new Error('sign-out failed') };
  }
}

/** Names of the Supabase auth cookies the browser sent with this request. */
export function authCookieNames(request: Request): string[] {
  const header = request.headers.get('cookie') ?? '';
  return header
    .split(';')
    .map((part) => part.split('=')[0]?.trim() ?? '')
    .filter((name) => name.startsWith('sb-') || name.includes('supabase'));
}

/**
 * Deletes, on `response`, every Supabase auth cookie the request carried, so a
 * sign-out that fails cannot leave this browser holding a session.
 */
export function clearAuthCookies(request: Request, response: NextResponse): void {
  for (const name of authCookieNames(request)) response.cookies.delete(name);
}
