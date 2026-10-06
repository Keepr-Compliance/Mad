'use client';

/**
 * Desktop Auth Login Page
 *
 * OAuth login (Google / Microsoft) for desktop app users.
 * After successful authentication, redirects to callback page which
 * sends tokens back to desktop via deep link.
 */

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { Alert, Spinner } from '@keepr/design-system';
import { Wordmark } from '@keepr/ui';
import { Loader2, XCircle } from 'lucide-react';
import {
  FROM_DESKTOP_PARAM,
  markArrivedFromDesktop,
} from '@/lib/desktop-handoff';
import { signOutLocal } from '@/lib/auth/signOutLocal';

// Error messages for auth failure states
const ERROR_MESSAGES: Record<string, string> = {
  auth_failed: 'Authentication failed. Please try again.',
  session_expired: 'Your session has expired. Please sign in again.',
  cancelled: 'Sign in was cancelled. Please try again.',
};

function DesktopLoginForm() {
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hashError, setHashError] = useState<string | null>(null);
  const searchParams = useSearchParams();

  // BACKLOG-3394: remember that the desktop app opened this tab, BEFORE the user
  // can start any sign-in. The `?from=desktop` parameter does not survive the
  // round trip through the provider's consent screen, so it is copied into
  // sessionStorage here and read on the callback page. Write-only: re-entering
  // this page without the parameter (the stale-session bounce, or "Try Again"
  // on the error state) must not erase it.
  useEffect(() => {
    markArrivedFromDesktop(searchParams.get(FROM_DESKTOP_PARAM));
  }, [searchParams]);

  // Parse error details from URL hash (Supabase puts detailed errors there)
  useEffect(() => {
    const hash = window.location.hash;
    if (hash) {
      const params = new URLSearchParams(hash.substring(1));
      const errorDesc = params.get('error_description');
      if (errorDesc) {
        setHashError(decodeURIComponent(errorDesc.replace(/\+/g, ' ')));
      }
    }
  }, []);

  // Get error from URL params (set by auth callback)
  const urlError = searchParams.get('error');
  const displayError = error || hashError || (urlError ? ERROR_MESSAGES[urlError] : null);

  const handleOAuthLogin = async (provider: 'google' | 'azure') => {
    // Dynamic import to avoid SSR issues
    const { createClient } = await import('@/lib/supabase/client');
    const supabase = createClient();
    setLoading(provider);
    setError(null);

    // Clear any stale session before starting fresh OAuth flow.
    // This prevents issues when "Sign Out All Devices" invalidated the session
    // but the browser still has cached cookies from the old session.
    //
    // SESSION-FIX: scope 'local' clears ONLY this browser's session. The default
    // 'global' scope revokes EVERY session for the user server-side — including a
    // paired phone's — which broke companion pairing (the phone's /register then
    // failed identity verification with "Auth session missing!"). This is a
    // pre-login "clear stale cookies" call, never a deliberate revoke-all; the
    // user-initiated "Sign Out All Devices" flow lives in signOutAllDevices.ts
    // and intentionally keeps scope 'global'.
    await signOutLocal(supabase);

    const { error: authError } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: `${window.location.origin}/auth/desktop/callback`,
        queryParams: {
          prompt: 'select_account', // Always show account picker
        },
        // Request email and profile scopes for Azure to get user name/email
        scopes: provider === 'azure' ? 'email profile openid' : undefined,
      },
    });

    if (authError) {
      setError(authError.message);
      setLoading(null);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md w-full space-y-8">
        {/* Header */}
        <div className="text-center">
          <h1 className="text-3xl font-bold text-gray-900"><Wordmark /></h1>
          <p className="mt-4 text-gray-500">Sign in to continue to the desktop app</p>
        </div>

        {/* Error Message */}
        {displayError && (
          <Alert
            variant="error"
            icon={<XCircle className="h-5 w-5 text-red-400" aria-hidden="true" />}
          >
            <p>{displayError}</p>
          </Alert>
        )}

        {/* Login Buttons */}
        <div className="space-y-4">
          <button
            onClick={() => handleOAuthLogin('google')}
            disabled={loading !== null}
            className="w-full flex items-center justify-center gap-3 px-4 py-3 border border-gray-300 rounded-lg shadow-sm bg-white text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading === 'google' ? (
              <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
            ) : (
              <svg className="h-5 w-5" viewBox="0 0 24 24">
                <path
                  fill="#4285F4"
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                />
                <path
                  fill="#34A853"
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                />
                <path
                  fill="#FBBC05"
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                />
                <path
                  fill="#EA4335"
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                />
              </svg>
            )}
            <span>{loading === 'google' ? 'Signing in...' : 'Continue with Google'}</span>
          </button>

          <button
            onClick={() => handleOAuthLogin('azure')}
            disabled={loading !== null}
            className="w-full flex items-center justify-center gap-3 px-4 py-3 border border-gray-300 rounded-lg shadow-sm bg-white text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading === 'azure' ? (
              <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
            ) : (
              <svg className="h-5 w-5" viewBox="0 0 23 23">
                <path fill="#f35325" d="M1 1h10v10H1z" />
                <path fill="#81bc06" d="M12 1h10v10H12z" />
                <path fill="#05a6f0" d="M1 12h10v10H1z" />
                <path fill="#ffba08" d="M12 12h10v10H12z" />
              </svg>
            )}
            <span>{loading === 'azure' ? 'Signing in...' : 'Continue with Microsoft'}</span>
          </button>
        </div>

        {/* Footer */}
        <p className="text-center text-sm text-gray-500">
          After signing in, you&apos;ll be redirected back to Keepr.
        </p>
      </div>
    </div>
  );
}

// Loading fallback for Suspense
function DesktopLoginLoading() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <Spinner />
    </div>
  );
}

// Main page component with Suspense boundary (required for useSearchParams)
export default function DesktopAuthPage() {
  return (
    <Suspense fallback={<DesktopLoginLoading />}>
      <DesktopLoginForm />
    </Suspense>
  );
}
