'use client';

/**
 * Login Page
 *
 * OAuth login with Google and Microsoft, plus magic link (email OTP)
 * Displays error messages from auth callback
 */

import { useState, useEffect, useRef, useCallback, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { Alert, Spinner } from '@keepr/design-system';
import { AppMark } from '@keepr/ui';
import { Loader2, Mail, XCircle } from 'lucide-react';

// Error messages for auth failure states
const ERROR_MESSAGES: Record<string, string> = {
  auth_failed: 'Authentication failed. Please try again.',
  not_authorized:
    'Your account is not authorized to access the broker portal. Contact your administrator.',
  org_not_setup: 'org_not_setup', // Special case: rendered with links below
  jit_disabled: 'jit_disabled', // Special case: rendered with links below
};

// Simple email format validation
function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Resend cooldown in seconds
const RESEND_COOLDOWN = 60;

// Option A brand palette (matches the app mark + landing; not in the sky-blue
// design-system token scale, so the mock's exact hex values are used here).
const CANVAS_BG =
  'radial-gradient(120% 80% at 50% -10%, rgba(79,70,229,0.10), transparent 60%), #F1F2F8';
const CARD_SHADOW =
  '0 12px 34px -12px rgba(20,22,43,0.16), 0 1px 2px rgba(20,22,43,0.04)';

/** Full-page canvas + centered auth card (Option A chrome). */
function AuthCard({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="min-h-screen flex items-center justify-center py-12 px-4 sm:px-6 lg:px-8"
      style={{ background: CANVAS_BG }}
    >
      <div
        className="w-full max-w-[400px] rounded-[20px] border bg-white px-9 pt-10 pb-8"
        style={{ borderColor: '#E7E8F0', boxShadow: CARD_SHADOW }}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * Option A brand header: the mark carries the brand (decorative — the heading
 * provides the accessible name), then a plain "Sign in to Keepr" instruction
 * and an uppercase portal label.
 */
function BrandHeader({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center text-center">
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
        {label}
      </p>
    </div>
  );
}

/** Legal footer with Terms + Privacy links (BACKLOG-2126). */
function LegalFooter() {
  return (
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
  );
}

function LoginForm() {
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

    const { error: authError } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
        queryParams: {
          prompt: 'select_account', // Always show account picker
        },
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
        emailRedirectTo: `${window.location.origin}/auth/callback`,
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
        emailRedirectTo: `${window.location.origin}/auth/callback`,
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
      <AuthCard>
        <BrandHeader label="Broker Portal" />

        {/* Error (e.g., resend failure) */}
        {error && (
          <div className="mt-6">
            <Alert variant="error">
              <p>{error}</p>
            </Alert>
          </div>
        )}

        <div className="mt-7 text-center space-y-4">
          <div className="text-green-600">
            <Mail className="w-12 h-12 mx-auto" />
          </div>
          <h2 className="text-lg font-semibold text-gray-900">Check your email</h2>
          <p className="text-sm text-gray-600">
            We sent a magic link to <span className="font-medium">{sentEmail}</span>
          </p>
          <p className="text-sm text-gray-500">Click the link in the email to sign in.</p>

          <div className="pt-2 space-y-3">
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
      </AuthCard>
    );
  }

  const oauthButtonClass =
    'w-full flex items-center justify-center gap-3 px-4 py-3 border rounded-xl bg-white text-[15px] font-semibold text-[#14162B] hover:border-[#D4D6E2] hover:bg-[#FCFCFE] hover:shadow-[0_2px_8px_rgba(20,22,43,0.06)] focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed transition-all';

  return (
    <AuthCard>
      <BrandHeader label="Broker Portal" />

      {/* Error Message */}
      {displayError && (
        <div className="mt-6">
          <Alert
            variant="error"
            icon={<XCircle className="h-5 w-5 text-red-400" aria-hidden="true" />}
          >
            {displayError === 'org_not_setup' ? (
              <p>
                Your organization hasn&apos;t been set up yet. Ask your IT administrator to visit the{' '}
                <a href="/setup" className="font-medium underline hover:text-red-600">setup page</a>
                , or{' '}
                <a href="/download" className="font-medium underline hover:text-red-600">sign up for an individual account</a>.
                {' '}If you have an agent license,{' '}
                <a href="/auth/desktop" className="font-medium underline hover:text-red-600">sign in to the desktop app here</a>.
              </p>
            ) : displayError === 'jit_disabled' ? (
              <p>
                Your organization requires an invitation or SCIM provisioning to join. Contact your IT administrator to be added.
              </p>
            ) : (
              <p>{displayError}</p>
            )}
          </Alert>
        </div>
      )}

      {/* Login Buttons */}
      <div className="mt-7 space-y-3">
        <button
          onClick={() => handleOAuthLogin('google')}
          disabled={loading !== null}
          className={oauthButtonClass}
          style={{ borderColor: '#E7E8F0' }}
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
          className={oauthButtonClass}
          style={{ borderColor: '#E7E8F0' }}
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
      <div className="relative my-6">
        <div className="absolute inset-0 flex items-center">
          <div className="w-full border-t" style={{ borderColor: '#E7E8F0' }} />
        </div>
        <div className="relative flex justify-center text-sm">
          <span className="px-2 bg-white" style={{ color: '#9297A6' }}>or</span>
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
          className="w-full px-4 py-3 border rounded-xl bg-white text-[15px] text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 transition-colors"
          style={{ borderColor: '#E7E8F0' }}
        />
        <button
          type="submit"
          disabled={loading !== null}
          className="w-full px-4 py-3 bg-primary-600 text-white rounded-xl hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-[15px] font-semibold"
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

      {/* Agent license redirect */}
      <div className="mt-4">
        <Alert variant="info">
          <p>
            Looking for the Keepr desktop app?{' '}
            <a href="/auth/desktop" className="font-medium underline hover:text-primary-600">
              Click here to sign in
            </a>{' '}
            if you have an agent license.
          </p>
        </Alert>
      </div>

      {/* Footer */}
      <div className="mt-4 text-center space-y-1.5">
        <p className="text-xs" style={{ color: '#9297A6' }}>
          Only authorized brokers can access this portal.
        </p>
        <p className="text-xs" style={{ color: '#9297A6' }}>
          Need to set up a new organization?{' '}
          <a href="/setup" className="text-primary-600 hover:text-primary-700">
            Get started here
          </a>
        </p>
      </div>

      <LegalFooter />
    </AuthCard>
  );
}

// Loading fallback for Suspense
function LoginLoading() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <Spinner />
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
