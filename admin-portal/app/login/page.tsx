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
    <div className="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md w-full space-y-8">
        {/* Header */}
        <div className="text-center">
          <h1 className="text-3xl font-bold text-gray-900">Keepr.</h1>
          <h2 className="mt-2 text-xl text-gray-600">Admin Portal</h2>
          <p className="mt-4 text-gray-500">Sign in to access the administration dashboard</p>
        </div>

        {/* Error Message */}
        {displayError && (
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
        )}

        {/* Login Buttons */}
        <div className="space-y-4">
          <button
            onClick={() => handleOAuthLogin('azure')}
            disabled={loading !== null}
            className="w-full flex items-center justify-center gap-3 px-4 py-3 border border-gray-300 rounded-lg shadow-sm bg-white text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
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
            <span>{loading === 'azure' ? 'Signing in...' : 'Sign in with Microsoft'}</span>
          </button>
        </div>

        {/* Footer */}
        <div className="text-center">
          <p className="text-sm text-gray-500">
            Only authorized internal users can access this portal.
          </p>
        </div>
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
