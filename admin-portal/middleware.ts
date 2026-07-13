/**
 * Next.js Middleware - Admin Portal
 *
 * Handles:
 * 1. Session refresh via Supabase SSR
 * 2. Auth protection for dashboard routes
 * 3. Internal role verification (rejects non-internal users)
 * 4. Permission-based route gating via RBAC
 * 5. Redirect logic for authenticated/unauthenticated users
 */

import { type NextRequest, NextResponse } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { isBareAuthTokenCookie, safeAuthErrorInfo } from '@/lib/supabase/cookie-guard';

/** Maps route prefixes to required permission keys (any one grants access) */
const ROUTE_PERMISSIONS: Record<string, string[]> = {
  '/dashboard/analytics': ['analytics.view'],
  '/dashboard/users': ['users.view'],
  '/dashboard/organizations': ['organizations.view'],
  '/dashboard/audit-log': ['audit.view'],
  '/dashboard/settings': ['internal_users.view', 'roles.view', 'audit.view'],
  '/dashboard/support': ['support.view'],
};

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
  const isAuthRoute = pathname === '/login';

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

    // Verify internal role for protected routes
    if (isProtectedRoute && user) {
      const { data: internalRole } = await supabase
        .from('internal_roles')
        .select('role_id')
        .eq('user_id', user.id)
        .single();

      if (!internalRole) {
        // User is authenticated but does not have an internal role
        return NextResponse.redirect(new URL('/login?error=not_authorized', request.url));
      }

      // Check route-level permissions (skip for /dashboard root — always allowed for internal users)
      for (const [routePrefix, requiredPermissions] of Object.entries(ROUTE_PERMISSIONS)) {
        if (pathname.startsWith(routePrefix)) {
          const { data: hasAnyPerm } = await supabase.rpc('has_any_permission', {
            check_user_id: user.id,
            permission_keys: requiredPermissions,
          });

          if (!hasAnyPerm) {
            return NextResponse.redirect(new URL('/dashboard?error=insufficient_permissions', request.url));
          }
          break;
        }
      }
    }

    // Redirect authenticated internal users from login page to dashboard
    if (isAuthRoute && user) {
      const { data: internalRole } = await supabase
        .from('internal_roles')
        .select('role_id')
        .eq('user_id', user.id)
        .single();

      if (internalRole) {
        const rawRedirect = request.nextUrl.searchParams.get('redirectTo') ?? '/dashboard';
        const redirectTo = /^\/[a-zA-Z0-9\-_\/\?\&\=\#\.]+$/.test(rawRedirect) ? rawRedirect : '/dashboard';
        return NextResponse.redirect(new URL(redirectTo, request.url));
      }
    }
  } catch (error) {
    // BACKLOG-1952 (H1): NEVER log the error object, error.message, or the
    // cookie value here — the bare-JSON auth-token TypeError embeds the full
    // session (access_token / refresh_token / provider_token) in its message.
    // Log ONLY the static { name, code } so the leak can never reach Vercel
    // logs or Sentry via a serialized error. (Previously an empty `catch {}`
    // that silently swallowed the failure.)
    console.warn('[middleware] auth check failed', safeAuthErrorInfo(error));

    // On a protected route, a failed auth check must NOT fall through to the
    // page — redirect to login and clear any Supabase auth cookies so the user
    // gets a fresh session instead of a 500 or a leaked token.
    if (isProtectedRoute) {
      const redirectResponse = NextResponse.redirect(new URL('/login', request.url));
      request.cookies.getAll().forEach((cookie) => {
        if (cookie.name.includes('supabase') || cookie.name.startsWith('sb-')) {
          redirectResponse.cookies.delete(cookie.name);
        }
      });
      return redirectResponse;
    }

    // For non-protected routes (timeout / network on /login etc.), let the
    // request through — page-level auth checks handle protection as a fallback.
  }

  return response;
}

export const config = {
  matcher: [
    // Skip Next.js internals and static files
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
