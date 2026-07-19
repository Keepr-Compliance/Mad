'use client';

/**
 * Payment Complete — deep-link bounce page (BACKLOG-2015).
 *
 * The desktop app's Stripe Checkout `success_url` points here
 * (`/payments/complete?session={CHECKOUT_SESSION_ID}`, set in
 * broker-portal/app/api/payments/checkout-session/route.ts). This page's only job
 * is to bounce the browser back into the desktop app via the
 * `keepr://payment-callback?session=<id>` deep link so the app can confirm the
 * unlock (JWT-authed /status + authoritative transaction_unlocks gate re-read).
 *
 * SECURITY: unauthenticated by design — the session id grants NOTHING here; the
 * app confirms with the user's JWT. The `session` param is loosely validated
 * (Stripe `cs_` shape, charset, length cap) before being embedded in the
 * redirect so a crafted URL can't inject into the deep link. Auto-navigation to
 * a custom scheme can be blocked by some browsers, so a visible "Open Keepr"
 * fallback link is always rendered.
 */

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Wordmark } from '@keepr/ui';

/**
 * Validate an untrusted Stripe Checkout Session id. Accepts `cs_` + alphanumerics
 * / underscores, capped length. Returns null for anything else (the page still
 * renders guidance; the app can be reopened manually).
 */
function sanitizeSessionId(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 128) return null;
  if (!/^[A-Za-z0-9_]+$/.test(trimmed)) return null;
  return trimmed;
}

function PaymentCompleteInner() {
  const searchParams = useSearchParams();
  const sessionId = useMemo(
    () => sanitizeSessionId(searchParams.get('session')),
    [searchParams],
  );
  const [redirected, setRedirected] = useState(false);

  const deepLink = sessionId
    ? `keepr://payment-callback?session=${encodeURIComponent(sessionId)}`
    : 'keepr://payment-callback';

  // Auto-bounce back into the app (best-effort; browsers may block custom schemes).
  useEffect(() => {
    const timer = setTimeout(() => {
      window.location.href = deepLink;
      setRedirected(true);
    }, 400);
    return () => clearTimeout(timer);
  }, [deepLink]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4">
      <div className="max-w-md w-full text-center space-y-6">
        <h1 className="text-3xl font-bold text-gray-900"><Wordmark /></h1>
        <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm space-y-4">
          <p className="text-lg font-semibold text-gray-900">Payment received</p>
          <p className="text-sm text-gray-600">
            {redirected
              ? 'Returning you to the Keepr app to finish unlocking your deal…'
              : 'Taking you back to the Keepr app…'}
          </p>
          <a
            href={deepLink}
            className="inline-block rounded-lg bg-indigo-600 px-5 py-3 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700"
          >
            Open Keepr
          </a>
          <p className="text-xs text-gray-400">
            If nothing happens, click “Open Keepr” above, or return to the app —
            your unlock will appear automatically. You can close this tab.
          </p>
        </div>
      </div>
    </div>
  );
}

// useSearchParams requires a Suspense boundary in the App Router.
export default function PaymentCompletePage() {
  return (
    <Suspense fallback={null}>
      <PaymentCompleteInner />
    </Suspense>
  );
}
