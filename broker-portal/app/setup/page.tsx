'use client';

/**
 * IT Admin Setup Page
 *
 * Dedicated page for first-time IT admin onboarding.
 * Microsoft-only (enterprise feature), uses consent prompt
 * to ensure email/profile scopes are granted.
 */

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { Alert, Spinner } from '@keepr/design-system';
import { Loader2, XCircle } from 'lucide-react';

const ERROR_MESSAGES: Record<string, string> = {
  auth_failed: 'Authentication failed. Please try again.',
  azure_only: 'Organization setup requires a Microsoft work account.',
  no_tenant: 'Could not verify your Microsoft organization. Please contact support.',
  no_email:
    'Microsoft did not return your email address. Check your Azure AD app permissions (email claim must be enabled).',
  provision_failed: 'Failed to create your organization. Please try again or contact support.',
  consumer_account: 'Personal Microsoft accounts are not supported. Please use your work account.',
};

function SetupForm() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hashError, setHashError] = useState<string | null>(null);
  const searchParams = useSearchParams();
  const router = useRouter();

  // Redirect authenticated users to dashboard
  useEffect(() => {
    const checkAuth = async () => {
      const { createClient } = await import('@/lib/supabase/client');
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        router.replace('/dashboard');
      }
    };
    checkAuth();
  }, [router]);

  // Parse error details from URL hash
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

  const urlError = searchParams.get('error');
  const displayError = error || hashError || (urlError ? ERROR_MESSAGES[urlError] : null);

  const handleSetup = async () => {
    const { createClient } = await import('@/lib/supabase/client');
    const supabase = createClient();
    setLoading(true);
    setError(null);

    const { error: authError } = await supabase.auth.signInWithOAuth({
      provider: 'azure',
      options: {
        redirectTo: `${window.location.origin}/auth/setup/callback`,
        queryParams: {
          prompt: 'consent',
        },
        scopes: 'email profile openid',
      },
    });

    if (authError) {
      setError(authError.message);
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md w-full space-y-8">
        <div className="text-center">
          <h1 className="text-3xl font-bold text-gray-900">Keepr.</h1>
          <h2 className="mt-2 text-xl text-gray-600">Set Up Your Organization</h2>
          <p className="mt-4 text-gray-500">
            Sign in with a Microsoft work account from the organization you want to set up.
          </p>
        </div>

        {displayError && (
          <Alert
            variant="error"
            icon={<XCircle className="h-5 w-5 text-red-400" aria-hidden="true" />}
          >
            <p>{displayError}</p>
          </Alert>
        )}

        <div className="space-y-4">
          <button
            onClick={handleSetup}
            disabled={loading}
            className="w-full flex items-center justify-center gap-3 px-4 py-3 border border-gray-300 rounded-lg shadow-sm bg-white text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? (
              <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
            ) : (
              <svg className="h-5 w-5" viewBox="0 0 23 23">
                <path fill="#f35325" d="M1 1h10v10H1z" />
                <path fill="#81bc06" d="M12 1h10v10H12z" />
                <path fill="#05a6f0" d="M1 12h10v10H1z" />
                <path fill="#ffba08" d="M12 12h10v10H12z" />
              </svg>
            )}
            <span>{loading ? 'Setting up...' : 'Set up with Microsoft'}</span>
          </button>
        </div>

        <div className="text-center space-y-2">
          <p className="text-sm text-gray-500">
            This creates your organization and sets you up as IT administrator.
          </p>
          <p className="text-sm text-gray-400">
            Already have an account?{' '}
            <a href="/login" className="text-primary-600 hover:text-primary-700">
              Sign in
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}

function SetupLoading() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <Spinner />
    </div>
  );
}

export default function SetupPage() {
  return (
    <Suspense fallback={<SetupLoading />}>
      <SetupForm />
    </Suspense>
  );
}
