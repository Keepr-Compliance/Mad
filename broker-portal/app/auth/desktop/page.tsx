'use client';

/**
 * Desktop Auth Login Page
 *
 * OAuth login for desktop app users, plus magic link (email OTP).
 * After successful authentication, redirects to callback page which
 * sends tokens back to desktop via deep link.
 */

import { useState, useEffect, useRef, useCallback, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { Alert, Spinner } from '@keepr/design-system';
import { Wordmark } from '@keepr/ui';
import { Loader2, Mail, XCircle } from 'lucide-react';

// Error messages for auth failure states
const ERROR_MESSAGES: Record<string, string> = {
  auth_failed: 'Authentication failed. Please try again.',
  session_expired: 'Your session has expired. Please sign in again.',
  cancelled: 'Sign in was cancelled. Please try again.',
};

// Simple email format validation
function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Resend cooldown in seconds
const RESEND_COOLDOWN = 60;

function DesktopLoginForm() {
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hashError, setHashError] = useState<string | null>(null);
  const searchParams = useSearchParams();

  // Magic link state
  const [email, setEmail] = useState('');
  const [magicLinkSent, setMagicLinkSent] = useState(false);
  const [sentEmail, setSentEmail] = useState('');
  const [cooldown, setCooldown] = useState(0);
  const cooldownRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  // Cleanup cooldown interval on unmount
  useEffect(() => {
    return () => {
      if (cooldownRef.current) clearInterval(cooldownRef.current);
    };
  }, []);

  // Get error from URL params (set by auth callback)
  const urlError = searchParams.get('error');
  const displayError = error || hashError || (urlError ? ERROR_MESSAGES[urlError] : null);

  const startCooldown = useCallback(() => {
    setCooldown(RESEND_COOLDOWN);
    if (cooldownRef.current) clearInterval(cooldownRef.current);
    cooldownRef.current = setInterval(() => {
      setCooldown((prev) => {
        if (prev <= 1) {
          if (cooldownRef.current) clearInterval(cooldownRef.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }, []);

  const handleOAuthLogin = async (provider: 'google' | 'azure') => {
    // Dynamic import to avoid SSR issues
    const { createClient } = await import('@/lib/supabase/client');
    const supabase = createClient();
    setLoading(provider);
    setError(null);

    // Clear any stale session before starting fresh OAuth flow.
    // This prevents issues when "Sign Out All Devices" invalidated the session
    // but the browser still has cached cookies from the old session.
    await supabase.auth.signOut();

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

  const handleMagicLink = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValidEmail(email)) {
      setError('Please enter a valid email address.');
      return;
    }

    const { createClient } = await import('@/lib/supabase/client');
    const supabase = createClient();
    setLoading('email');
    setError(null);

    const { error: otpError } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/desktop/callback`,
      },
    });

    if (otpError) {
      setError(otpError.message);
      setLoading(null);
      return;
    }

    setSentEmail(email);
    setMagicLinkSent(true);
    setLoading(null);
    startCooldown();
  };

  const handleResend = async () => {
    if (cooldown > 0) return;

    const { createClient } = await import('@/lib/supabase/client');
    const supabase = createClient();
    setLoading('email');
    setError(null);

    const { error: otpError } = await supabase.auth.signInWithOtp({
      email: sentEmail,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/desktop/callback`,
      },
    });

    if (otpError) {
      setError(otpError.message);
      setLoading(null);
      return;
    }

    setLoading(null);
    startCooldown();
  };

  const handleBackToLogin = () => {
    setMagicLinkSent(false);
    setError(null);
    setCooldown(0);
    if (cooldownRef.current) clearInterval(cooldownRef.current);
  };

  // Magic link sent confirmation view
  if (magicLinkSent) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
        <div className="max-w-md w-full space-y-8">
          <div className="text-center">
            <h1 className="text-3xl font-bold text-gray-900"><Wordmark /></h1>
          </div>

          {/* Error (e.g., resend failure) */}
          {error && (
            <Alert variant="error">
              <p>{error}</p>
            </Alert>
          )}

          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-8 text-center space-y-4">
            <div className="text-green-600">
              <Mail className="w-12 h-12 mx-auto" />
            </div>
            <h3 className="text-lg font-semibold text-gray-900">Check your email</h3>
            <p className="text-sm text-gray-600">
              We sent a magic link to <span className="font-medium">{sentEmail}</span>
            </p>
            <p className="text-sm text-gray-500">
              Click the link in the email to sign in to the desktop app.
            </p>

            <div className="pt-4 space-y-3">
              <p className="text-sm text-gray-500">
                Didn&apos;t receive it?{' '}
                <button
                  onClick={handleResend}
                  disabled={cooldown > 0 || loading === 'email'}
                  className="text-primary-600 hover:text-primary-700 font-medium disabled:text-gray-400 disabled:cursor-not-allowed"
                >
                  {loading === 'email'
                    ? 'Sending...'
                    : cooldown > 0
                      ? `Resend in ${cooldown}s`
                      : 'Resend'}
                </button>
              </p>
              <button
                onClick={handleBackToLogin}
                className="text-sm text-gray-500 hover:text-gray-700 underline"
              >
                Back to login
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

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

        {/* Divider */}
        <div className="relative">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-gray-300" />
          </div>
          <div className="relative flex justify-center text-sm">
            <span className="px-2 bg-gray-50 text-gray-500">or</span>
          </div>
        </div>

        {/* Magic Link */}
        <form onSubmit={handleMagicLink} className="space-y-3">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Enter your email address"
            required
            className="w-full px-4 py-3 border border-gray-300 rounded-lg shadow-sm bg-white text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 transition-colors"
          />
          <button
            type="submit"
            disabled={loading !== null}
            className="w-full px-4 py-3 bg-primary-600 text-white rounded-lg shadow-sm hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
          >
            {loading === 'email' ? (
              <span className="flex items-center justify-center gap-2">
                <Loader2 className="h-5 w-5 animate-spin text-white" />
                Sending...
              </span>
            ) : (
              'Continue with email'
            )}
          </button>
        </form>

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
