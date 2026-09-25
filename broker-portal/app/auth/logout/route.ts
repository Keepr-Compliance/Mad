/**
 * Logout Route Handler
 *
 * Signs out the user and redirects to login page.
 *
 * BACKLOG-3080: middleware and the dashboard layout send a signed-in person who
 * is not a portal user here with `?error=not_authorized`. That branch ends ONLY
 * this browser's portal session (`scope: 'local'`) and shows the login error.
 * The bare Sign Out link is unchanged.
 */

import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

/** The only error values passed through to /login. Anything else is dropped. */
const PASS_THROUGH_ERRORS = new Set(['not_authorized']);

/** Names of the Supabase auth cookies on this request. */
function authCookieNames(request: Request): string[] {
  const header = request.headers.get('cookie') ?? '';
  return header
    .split(';')
    .map((part) => part.split('=')[0]?.trim() ?? '')
    .filter((name) => name.startsWith('sb-') || name.includes('supabase'));
}

async function logout(request: Request): Promise<NextResponse> {
  const requestUrl = new URL(request.url);
  const error = requestUrl.searchParams.get('error');
  const supabase = await createClient();

  if (error && PASS_THROUGH_ERRORS.has(error)) {
    await supabase.auth.signOut({ scope: 'local' });
    const response = NextResponse.redirect(
      `${requestUrl.origin}/login?error=${encodeURIComponent(error)}`
    );
    // Clear the cookies here too, so a sign-out that fails cannot leave a
    // session that middleware would send straight back to this route.
    for (const name of authCookieNames(request)) response.cookies.delete(name);
    return response;
  }

  await supabase.auth.signOut();
  return NextResponse.redirect(`${requestUrl.origin}/login`);
}

export async function POST(request: Request) {
  return logout(request);
}

// Also support GET for simple link-based logout
export async function GET(request: Request) {
  return logout(request);
}
