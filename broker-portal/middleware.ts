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
import {
  PORTAL_MEMBERSHIP_SELECT,
  classifyPortalAccess,
  mayOpenDashboardPath,
  BILLING_PATHS,
  maySuspendedOpenPath,
  suspendedLanding,
  mayOrgSuspendedOpenPath,
  orgSuspendedLanding,
  type PortalMembershipRow,
} from '@/lib/auth/membership';
import { LICENCE_READ_FAILED, readOwnLicenceSuspended } from '@/lib/auth/suspension';
import { billingEnabled } from '@/lib/billing/flag';
import { ORG_SUSPENSION_READ_FAILED, readOrgBillingSuspended } from '@/lib/auth/orgSuspension';
import { readBillingContactLogin } from '@/lib/auth/billingContact';
import { safeNextPath, setNextPathCookie } from '@/lib/auth/safeNextPath';

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
      const bounce = NextResponse.redirect(loginUrl);
      // BACKLOG-3863 R7: /auth/callback reads this to land on the same page
      // after OAuth. Only a path safeNextPath() accepts is stored.
      setNextPathCookie(bounce, pathname);
      return bounce;
    }

    // BACKLOG-3080: what this person may open, from the one shared classifier
    // (lib/auth/membership.ts). The dashboard layout and each page ask the same
    // question again on the server; this is not the only gate.
    if (isProtectedRoute && user) {
      // See lib/auth/membership.ts for why the personal-organization column is
      // never named in this query.
      // BACKLOG-3878: the licence is read alongside the memberships, never after.
      const [{ data: memberships }, suspended] = await Promise.all([
        supabase
          .from('organization_members')
          .select(PORTAL_MEMBERSHIP_SELECT)
          .eq('user_id', user.id)
          .order('created_at', { ascending: true })
          .order('id', { ascending: true }),
        readOwnLicenceSuspended(supabase, user.id),
      ]);

      const access = classifyPortalAccess(memberships as PortalMembershipRow[] | null, user.id);

      // Not a portal user at all: end this browser's portal session.
      if (access.kind === 'none') {
        return NextResponse.redirect(new URL('/auth/logout?error=not_authorized', request.url));
      }

      // BACKLOG-3878: a suspended account keeps Billing (personal owner only),
      // My Account and Support, for every access kind. Checked before the
      // access redirect so a refused path ends in one hop. A failed licence
      // read lets this request through (the pages ask again) and logs a
      // static code only.
      if (suspended === null) {
        console.warn('[middleware] suspended check skipped', { code: LICENCE_READ_FAILED });
      } else if (suspended) {
        const billingOn = billingEnabled();
        if (!maySuspendedOpenPath(access, pathname, billingOn)) {
          return NextResponse.redirect(new URL(suspendedLanding(access, billingOn), request.url));
        }
      }

      // BACKLOG-3853 PR-2B: a suspended BROKERAGE (org_deals), read only for a
      // person routed on one and only when the licence rule above let them
      // through (the licence rule wins). Sequential: it needs the organization
      // from the memberships. A failed read lets this request through (every
      // data path is refused in the database) and logs a static code only.
      if (suspended !== true) {
        const orgSuspended = await readOrgBillingSuspended(supabase, access);
        if (orgSuspended === null) {
          console.warn('[middleware] brokerage suspension check skipped', { code: ORG_SUSPENSION_READ_FAILED });
        } else if (orgSuspended) {
          const billingOn = billingEnabled();
          if (!mayOrgSuspendedOpenPath(access, pathname, billingOn)) {
            return NextResponse.redirect(new URL(orgSuspendedLanding(access, billingOn), request.url));
          }
        }
      }

      // BACKLOG-4007 PR-4: the billing-only login may also open Billing. Asked only for an
      // unlicensed member on a Billing path; a failed read is false (the floor stays).
      const billingContact =
        BILLING_PATHS.some((base) => pathname === base || pathname.startsWith(`${base}/`)) &&
        (await readBillingContactLogin(supabase, access));

      // A path above this person's access goes back to the dashboard.
      if (!mayOpenDashboardPath(access, pathname, { billingContact })) {
        return NextResponse.redirect(new URL('/dashboard', request.url));
      }
    }

    // Redirect authenticated users from login page
    if (isAuthRoute && user) {
      // BACKLOG-3705 / 3863 R7: the shared validator, never a local pattern.
      const redirectTo = safeNextPath(request.nextUrl.searchParams.get('redirectTo'));
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
    // Skip the PWA service worker script and manifest too (BACKLOG-3796),
    // anchored with $ so /sw.js.map and nested paths still run middleware.
    '/((?!_next/static|_next/image|favicon.ico|sw\\.js$|manifest\\.webmanifest$|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
