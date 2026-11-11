/**
 * /oauth/consent/start — BACKLOG-4237.
 *
 * Signed-out entry to the consent flow: keeps the authorization id in an
 * httpOnly cookie on /oauth for 10 minutes, sets the post-login destination to
 * the AI apps page, and sends the person to /login.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { setNextPathCookie } from '@/lib/auth/safeNextPath';
import {
  CONSENT_COOKIE_MAX_AGE_SECONDS,
  CONSENT_COOKIE_NAME,
  CONSENT_COOKIE_PATH,
  CONSENT_RESUME_PATH,
  isAuthorizationId,
} from '@/lib/mcp/consent';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<Response> {
  const id = request.nextUrl.searchParams.get('authorization_id');
  if (!isAuthorizationId(id)) {
    return NextResponse.redirect(new URL('/oauth/consent', request.url));
  }

  const loginUrl = new URL('/login', request.url);
  loginUrl.searchParams.set('redirectTo', CONSENT_RESUME_PATH);
  const response = NextResponse.redirect(loginUrl);
  response.cookies.set({
    name: CONSENT_COOKIE_NAME,
    value: id,
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: CONSENT_COOKIE_PATH,
    maxAge: CONSENT_COOKIE_MAX_AGE_SECONDS,
  });
  setNextPathCookie(response, CONSENT_RESUME_PATH);
  return response;
}
