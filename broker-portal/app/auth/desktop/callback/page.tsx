'use client';

/**
 * Desktop Auth Callback Page
 *
 * Receives OAuth callback from Supabase, extracts session tokens,
 * stores them securely via token_claims (SOC 2), and redirects to
 * the desktop app via keepr://callback?claim=UUID deep link.
 *
 * BACKLOG-1603: Tokens are NO LONGER embedded in the deep link URL.
 * Instead, a short-lived claim ID (60s TTL, single-use) is passed.
 * The desktop app claims the tokens over HTTPS.
 */

import { useEffect, useState, useCallback, Suspense } from 'react';
import { createTokenClaim } from '@/lib/actions/createTokenClaim';
import { Spinner } from '@keepr/design-system';
import { CheckCircle2, Loader2, XCircle } from 'lucide-react';

type Status = 'loading' | 'redirecting' | 'success' | 'error';

function DesktopCallbackContent() {
  const [status, setStatus] = useState<Status>('loading');
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [deepLinkUrl, setDeepLinkUrl] = useState<string>('');
  const [hasDesktopApp, setHasDesktopApp] = useState<boolean | null>(null);

  const handleCallback = useCallback(async () => {
    // Check for errors in hash fragment first (Supabase puts errors there)
    const hash = window.location.hash;
    if (hash) {
      const params = new URLSearchParams(hash.substring(1));
      const errorDesc = params.get('error_description');
      const errorCode = params.get('error');
      if (errorCode || errorDesc) {
        setStatus('error');
        setErrorMessage(
          errorDesc
            ? decodeURIComponent(errorDesc.replace(/\+/g, ' '))
            : 'Authentication failed. Please try again.'
        );
        return;
      }
    }

    try {
      // Dynamic import to avoid SSR issues
      const { createClient } = await import('@/lib/supabase/client');
      const supabase = createClient();

      // Get session from Supabase (handles hash fragment automatically)
      const {
        data: { session },
        error,
      } = await supabase.auth.getSession();

      if (error) {
        setStatus('error');
        setErrorMessage(error.message);
        return;
      }

      if (!session) {
        setStatus('error');
        setErrorMessage('No session found. Please try signing in again.');
        return;
      }

      // Verify the session is actually valid by checking with the server.
      // getSession() reads from local storage/cookies and may return a stale
      // session that was invalidated server-side (e.g., "Sign Out All Devices").
      const { data: { user }, error: userError } = await supabase.auth.getUser();
      if (userError || !user) {
        // Session is stale/invalidated — clear it and redirect to retry
        await supabase.auth.signOut();
        window.location.href = '/auth/desktop?error=session_expired';
        return;
      }

      // Check if user has ever logged in from the desktop app
      const { data: devices } = await supabase
        .from('devices')
        .select('device_id')
        .eq('user_id', user.id)
        .limit(1);
      setHasDesktopApp(!!devices && devices.length > 0);

      // BACKLOG-1603: Store tokens in token_claims via server action (SOC 2)
      // The server action uses the service role client to call create_token_claim() RPC
      const provider = (user.app_metadata?.provider as string) || 'google';
      const claimResult = await createTokenClaim(
        user.id,
        {
          access_token: session.access_token,
          refresh_token: session.refresh_token,
          provider_token: session.provider_token,
          provider_refresh_token: session.provider_refresh_token,
        },
        provider
      );

      if (!claimResult.success || !claimResult.claimId) {
        // Claim creation failed — fall back to direct token passing
        // This ensures auth still works if the token_claims infrastructure has issues
        // WARNING: This fallback embeds tokens in the URL, which is less secure.
        // If this fires in production, investigate why token_claims is failing.
        console.error('[DesktopCallback] SECURITY: Token claim failed, falling back to direct token in URL. Error:', claimResult.error);
        const fallbackUrl = new URL('keepr://callback');
        fallbackUrl.searchParams.set('access_token', session.access_token);
        fallbackUrl.searchParams.set('refresh_token', session.refresh_token);

        const fallbackLink = fallbackUrl.toString();
        setDeepLinkUrl(fallbackLink);
        setStatus('redirecting');
        window.location.href = fallbackLink;
        setTimeout(() => { setStatus('success'); }, 2000);
        return;
      }

      // Build deep link URL with claim ID only (no tokens in URL!)
      const callbackUrl = new URL('keepr://callback');
      callbackUrl.searchParams.set('claim', claimResult.claimId);

      const deepLink = callbackUrl.toString();
      setDeepLinkUrl(deepLink);
      setStatus('redirecting');

      // Attempt to redirect to desktop app
      window.location.href = deepLink;

      // After a delay, if we're still here, show success with manual link
      setTimeout(() => {
        setStatus('success');
      }, 2000);
    } catch {
      setStatus('error');
      setErrorMessage('An unexpected error occurred. Please try again.');
    }
  }, []);

  useEffect(() => {
    handleCallback();
  }, [handleCallback]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md w-full space-y-6 p-8 bg-white rounded-lg shadow-sm border border-gray-200 text-center">
        {status === 'loading' && (
          <>
            <Loader2 className="h-12 w-12 animate-spin text-primary-500 mx-auto" />
            <p className="text-gray-600">Signing you in...</p>
          </>
        )}

        {status === 'redirecting' && (
          <>
            <Loader2 className="h-12 w-12 animate-spin text-green-500 mx-auto" />
            <p className="text-gray-900 font-medium">Opening Keepr...</p>
            <p className="text-gray-500 text-sm">You should be redirected automatically.</p>
          </>
        )}

        {status === 'success' && (
          <>
            <div className="text-green-600">
              <CheckCircle2 className="w-12 h-12 mx-auto" />
            </div>
            <p className="text-gray-900 font-medium">Sign in successful!</p>
            {hasDesktopApp === false ? (
              <>
                <p className="text-gray-500 text-sm">
                  It looks like you don&apos;t have Keepr installed yet. Download it to get started.
                </p>
                <a
                  href="/download"
                  className="inline-block mt-4 px-6 py-3 bg-primary-600 text-white rounded-md hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 transition-colors"
                >
                  Download Keepr
                </a>
                <p className="text-gray-400 text-xs mt-4">
                  Already have Keepr?{' '}
                  <a href={deepLinkUrl} className="text-primary-600 hover:underline">
                    Open Keepr
                  </a>
                </p>
              </>
            ) : (
              <>
                <p className="text-gray-500 text-sm">
                  If Keepr didn&apos;t open automatically, click the button below.
                </p>
                <div className="flex flex-col sm:flex-row items-center justify-center gap-3 mt-4">
                  <a
                    href={deepLinkUrl}
                    className="inline-block px-6 py-3 bg-primary-600 text-white rounded-md hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 transition-colors"
                  >
                    Open Keepr
                  </a>
                  <a
                    href="/download"
                    className="inline-block px-6 py-3 bg-white border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 transition-colors"
                  >
                    Download Keepr
                  </a>
                </div>
                <p className="text-gray-400 text-xs mt-4">
                  You can close this browser tab after Keepr opens.
                </p>
              </>
            )}
          </>
        )}

        {status === 'error' && (
          <>
            <div className="text-red-600">
              <XCircle className="w-12 h-12 mx-auto" />
            </div>
            <p className="text-gray-900 font-medium">Sign in failed</p>
            <p className="text-red-600 text-sm">{errorMessage}</p>
            <a
              href="/auth/desktop"
              className="inline-block mt-4 px-6 py-3 bg-primary-600 text-white rounded-md hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 transition-colors"
            >
              Try Again
            </a>
          </>
        )}
      </div>
    </div>
  );
}

// Loading fallback for Suspense
function CallbackLoading() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <Spinner />
    </div>
  );
}

// Main page component with Suspense boundary
export default function DesktopCallbackPage() {
  return (
    <Suspense fallback={<CallbackLoading />}>
      <DesktopCallbackContent />
    </Suspense>
  );
}
