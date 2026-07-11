/**
 * Next.js Middleware
 *
 * Handles:
 * 1. Session refresh via Supabase SSR
 * 2. Auth protection for dashboard routes
 * 3. Redirect logic for authenticated/unauthenticated users
 */

import { type NextRequest, NextResponse } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { IMPERSONATION_COOKIE_NAME } from '@/lib/constants';
import { isBareAuthTokenCookie, safeAuthErrorInfo } from '@/lib/supabase/cookie-guard';

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({
    request: {
      headers: request.headers,
    },
  });

  // Create Supabase client with cookie handling
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          try {
            const value = request.cookies.get(name)?.value;
            // BACKLOG-1952 (H1): if the auth-token cookie is a bare JSON session
            // string (not the base64- form), the single-cookie adapter assigns
            // `.user` onto the string and throws a TypeError containing the raw
            // session. Hide the poisoned cookie from the SDK → it sees no
            // session → clean redirect to login instead of a token-leaking crash.
            if (isBareAuthTokenCookie(name, value)) {
              return undefined;
            }
            return value;
          } catch {
            // Handle invalid UTF-8 sequences in cookie values
            return undefined;
          }
        },
        set(name: string, value: string, options: CookieOptions) {
          request.cookies.set({
            name,
            value,
            ...options,
          });
          response = NextResponse.next({
            request: {
              headers: request.headers,
            },
          });
          response.cookies.set({
            name,
            value,
            ...options,
          });
        },
        remove(name: string, options: CookieOptions) {
          request.cookies.set({
            name,
            value: '',
            ...options,
          });
          response = NextResponse.next({
            request: {
              headers: request.headers,
            },
          });
          response.cookies.set({
            name,
            value: '',
            ...options,
          });
        },
      },
    }
  );

  const pathname = request.nextUrl.pathname;
  const isProtectedRoute = pathname.startsWith('/dashboard');
  const isAuthRoute = pathname === '/login' || pathname === '/setup';
  const isImpersonationRoute = pathname === '/auth/impersonate';

  // Allow impersonation entry route without any auth check
  if (isImpersonationRoute) {
    return response;
  }

  // TASK-2133: Lightweight cookie-exists check only.
  // Middleware runs in Edge Runtime where DB access is limited.
  // The page-level getImpersonationSession() is the authoritative check
  // (validates signature via TASK-2131 and DB session via TASK-2133).
  const impersonationCookie = request.cookies.get(IMPERSONATION_COOKIE_NAME);
  if (isProtectedRoute && impersonationCookie?.value) {
    // Cookie exists -- allow access through to the page, where full
    // signature + DB validation will occur via getImpersonationSession().
    return response;
  }

  try {
    // Refresh session (important for token refresh)
    const {
      data: { user },
    } = await supabase.auth.getUser();

    // Redirect unauthenticated users from protected routes
    if (isProtectedRoute && !user) {
      const loginUrl = new URL('/login', request.url);
      loginUrl.searchParams.set('redirectTo', pathname);
      return NextResponse.redirect(loginUrl);
    }

    // Redirect agent-role users away from dashboard to download page
    if (isProtectedRoute && user) {
      const { data: membership } = await supabase
        .from('organization_members')
        .select('role')
        .eq('user_id', user.id)
        .limit(1)
        .single();

      if (membership && !['admin', 'it_admin', 'broker'].includes(membership.role)) {
        return NextResponse.redirect(new URL('/download', request.url));
      }
    }

    // Redirect authenticated users from login page
    if (isAuthRoute && user) {
      const rawRedirect = request.nextUrl.searchParams.get('redirectTo') ?? '/dashboard';
      const redirectTo = /^\/[a-zA-Z0-9\-_\/\?\&\=\#\.]+$/.test(rawRedirect) ? rawRedirect : '/dashboard';
      return NextResponse.redirect(new URL(redirectTo, request.url));
    }
  } catch (error) {
    // BACKLOG-1952 (H1): NEVER log the error object, error.message, or the
    // cookie value here — the bare-JSON auth-token TypeError embeds the full
    // session (access_token / refresh_token / provider_token) in its message.
    // Log ONLY the static { name, code } so the leak can never reach Vercel
    // logs or Sentry via a serialized error.
    console.warn('[middleware] auth check failed', safeAuthErrorInfo(error));

    // BACKLOG-1486: Corrupted cookies (invalid UTF-8 sequences) can crash
    // Supabase SSR during cookie chunk reassembly or session parsing.
    // Clear all Supabase-related cookies and redirect to login so the
    // user gets a fresh session instead of a 500 error.
    //
    // NOTE: inspecting error.message here is a substring test only — the
    // message is matched, never logged or forwarded — so no secret escapes.
    const isCorruptedCookie =
      error instanceof Error &&
      (error.message.includes('UTF-8') ||
        error.message.includes('malformed') ||
        error.message.includes('Invalid string'));

    if (isCorruptedCookie || isProtectedRoute) {
      const redirectUrl = new URL('/login', request.url);
      const redirectResponse = NextResponse.redirect(redirectUrl);

      // Delete all Supabase auth cookies (sb-* and supabase-*)
      request.cookies.getAll().forEach((cookie) => {
        if (cookie.name.includes('supabase') || cookie.name.startsWith('sb-')) {
          redirectResponse.cookies.delete(cookie.name);
        }
      });

      return redirectResponse;
    }

    // For non-protected routes with non-cookie errors (timeout, network),
    // let the request through. Page-level auth checks handle protection.
  }

  return response;
}

export const config = {
  matcher: [
    // Skip Next.js internals and static files
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
