/**
 * Logout Route Handler
 *
 * Signs out the user and redirects to login page.
 *
 * BACKLOG-3080: every path ends ONLY this browser's portal session
 * (`scope: 'local'`) and clears the Supabase auth cookies on the response.
 * Middleware and the dashboard layout send a signed-in person who is not a
 * portal user here with `?error=not_authorized`; that value is passed on to
 * /login. The explicit sign-out-everywhere action is `signOutAllDevices`.
 */

import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { clearAuthCookies, signOutLocal } from '@/lib/auth/signOutLocal';

/** The only error values passed through to /login. Anything else is dropped. */
const PASS_THROUGH_ERRORS = new Set(['not_authorized']);

/**
 * BACKLOG-3851 PR-2d: `?next=setup` sends the signed-out browser to /setup
 * instead of /login. The Settings page "Connect Microsoft" button uses it: an
 * admin whose brokerage has no Microsoft organization linked signs in on /setup,
 * whose callback links it. Middleware sends a signed-in user away from /setup,
 * so the sign-out has to come first. Only this one value is accepted.
 */
const NEXT_DESTINATIONS = new Map<string, string>([['setup', '/setup']]);

async function logout(request: Request): Promise<NextResponse> {
  const requestUrl = new URL(request.url);
  const error = requestUrl.searchParams.get('error');
  const next = requestUrl.searchParams.get('next');
  const supabase = await createClient();

  const nextPath = next ? NEXT_DESTINATIONS.get(next) : undefined;
  const target = nextPath
    ? `${requestUrl.origin}${nextPath}`
    : error && PASS_THROUGH_ERRORS.has(error)
      ? `${requestUrl.origin}/login?error=${encodeURIComponent(error)}`
      : `${requestUrl.origin}/login`;

  await signOutLocal(supabase);
  const response = NextResponse.redirect(target);
  // Clear the cookies here too, so a sign-out that fails cannot leave a
  // session that middleware would send straight back to this route.
  clearAuthCookies(request, response);
  return response;
}

export async function POST(request: Request) {
  return logout(request);
}

// Also support GET for simple link-based logout
export async function GET(request: Request) {
  return logout(request);
}
