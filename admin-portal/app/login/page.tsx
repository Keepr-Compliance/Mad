'use client';

/**
 * Admin Portal Login Page
 *
 * OAuth login with Google and Microsoft
 * Only users with internal_roles entries can access the admin portal
 */

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { Alert } from '@keepr/design-system';
import { AppMark } from '@keepr/ui';

// Error messages for auth failure states
const ERROR_MESSAGES: Record<string, string> = {
  auth_failed: 'Authentication failed. Please try again.',
  not_authorized:
    'Your account does not have admin access. Contact your system administrator.',
};

function LoginForm() {
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hashError, setHashError] = useState<string | null>(null);
  const searchParams = useSearchParams();

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

    // Forward redirectTo param so the callback can redirect to the intended page
    const redirectTo = searchParams.get('redirectTo') || '/dashboard';
    const callbackUrl = new URL('/auth/callback', window.location.origin);
    if (redirectTo !== '/dashboard') {
      callbackUrl.searchParams.set('next', redirectTo);
    }

    const { error: authError } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: callbackUrl.toString(),
        queryParams: {
          prompt: 'select_account',
        },
        scopes: provider === 'azure' ? 'email profile openid' : undefined,
      },
    });

    if (authError) {
      setError(authError.message);
      setLoading(null);
    }
  };

  return (
    <div
      className="min-h-screen flex items-center justify-center py-12 px-4 sm:px-6 lg:px-8"
      style={{
        background:
          'radial-gradient(120% 80% at 50% -10%, rgba(79,70,229,0.10), transparent 60%), #F1F2F8',
      }}
    >
      <div
        className="w-full max-w-[400px] rounded-[20px] border bg-white px-9 pt-10 pb-8"
        style={{
          borderColor: '#E7E8F0',
          boxShadow:
            '0 12px 34px -12px rgba(20,22,43,0.16), 0 1px 2px rgba(20,22,43,0.04)',
        }}
      >
        {/* Brand header (Option A: mark carries the brand, heading is a plain instruction) */}
        <div className="flex flex-col items-center text-center">
          {/* Decorative — the heading below provides the accessible name. */}
          <AppMark
            size={60}
            className="drop-shadow-[0_8px_18px_rgba(79,70,229,0.30)]"
          />
          <h1
            className="mt-4 text-[21px] font-extrabold tracking-[-0.02em]"
            style={{ color: '#14162B' }}
          >
            Sign in to Keepr
          </h1>
          <p
            className="mt-2.5 text-[11px] font-bold uppercase tracking-[0.13em]"
            style={{ color: '#9297A6' }}
          >
            Admin Portal
          </p>
        </div>

        {/* Error Message */}
        {displayError && (
          <div className="mt-6">
            <Alert
              variant="error"
              icon={
                <svg
                  className="h-5 w-5 text-red-400"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path
                    fillRule="evenodd"
                    d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z"
                    clipRule="evenodd"
                  />
                </svg>
              }
            >
              {displayError}
            </Alert>
          </div>
        )}

        {/* Login Buttons */}
        <div className="mt-7 space-y-3">
          <button
            onClick={() => handleOAuthLogin('azure')}
            disabled={loading !== null}
            className="w-full flex items-center justify-center gap-3 px-4 py-3 border rounded-xl bg-white text-[15px] font-semibold text-[#14162B] hover:border-[#D4D6E2] hover:bg-[#FCFCFE] hover:shadow-[0_2px_8px_rgba(20,22,43,0.06)] focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            style={{ borderColor: '#E7E8F0' }}
          >
            {loading === 'azure' ? (
              <span className="animate-spin h-5 w-5 border-2 border-gray-400 border-t-transparent rounded-full" />
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

        {/* Access note */}
        <p className="mt-4 text-center text-xs" style={{ color: '#9297A6' }}>
          Only authorized internal users can access this portal.
        </p>

        {/* Legal footer (BACKLOG-2126) */}
        <p
          className="mt-6 text-center text-xs leading-relaxed"
          style={{ color: '#9297A6' }}
        >
          By continuing you agree to Keepr&apos;s{' '}
          <a
            href="https://keeprcompliance.com/terms"
            target="_blank"
            rel="noopener noreferrer"
            className="border-b text-[#6C7180] hover:text-[#14162B]"
            style={{ borderColor: '#E7E8F0' }}
          >
            Terms
          </a>{' '}
          and{' '}
          <a
            href="https://keeprcompliance.com/privacy"
            target="_blank"
            rel="noopener noreferrer"
            className="border-b text-[#6C7180] hover:text-[#14162B]"
            style={{ borderColor: '#E7E8F0' }}
          >
            Privacy Policy
          </a>
          .
        </p>
      </div>
    </div>
  );
}

// Loading fallback for Suspense
function LoginLoading() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="animate-spin h-8 w-8 border-4 border-primary-500 border-t-transparent rounded-full" />
    </div>
  );
}

// Main page component with Suspense boundary (required for useSearchParams)
export default function LoginPage() {
  return (
    <Suspense fallback={<LoginLoading />}>
      <LoginForm />
    </Suspense>
  );
}
