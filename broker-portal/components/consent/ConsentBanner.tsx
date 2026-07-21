'use client';

/**
 * Cookie / tracking-consent banner (BACKLOG-2133 + BACKLOG-2122).
 *
 * A slim, non-blocking bar pinned to the bottom of the viewport. Shown only
 * when the user has NOT yet made a choice and no GPC opt-out signal is present
 * (see `useConsent` / `shouldShowBanner`). Accepting enables Microsoft Clarity
 * session-replay; declining keeps it off. Either choice persists and dismisses
 * the banner permanently.
 *
 * US-only scope (founder 2026-07-18): this is a cookie NOTICE with an explicit
 * opt-in for non-essential analytics, plus a silent GPC opt-out handled
 * upstream. It is intentionally NOT a blocking EU-style modal.
 *
 * No policy copy is authored here — the Cookie Policy link points at the
 * canonical route; the legal TEXT is tracked separately (BACKLOG-2117/2122).
 */

import Link from 'next/link';
import { Button } from '@keepr/ui';
import { useConsent } from '@/lib/consent/useConsent';

export function ConsentBanner() {
  const { showBanner, setConsent } = useConsent();

  if (!showBanner) return null;

  return (
    <div
      role="region"
      aria-label="Cookie consent"
      className="fixed inset-x-0 bottom-0 z-50 border-t border-gray-200 bg-white shadow-lg"
    >
      <div className="mx-auto flex max-w-5xl flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-gray-700">
          We use Microsoft Clarity to understand product usage. It records how the
          portal is used (with sensitive fields masked).{' '}
          <Link
            href="/cookies"
            className="font-medium text-indigo-600 underline underline-offset-2 hover:text-indigo-700"
          >
            Cookie Policy
          </Link>
        </p>
        <div className="flex flex-shrink-0 items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setConsent('declined')}
          >
            Decline
          </Button>
          <Button size="sm" onClick={() => setConsent('accepted')}>
            Accept
          </Button>
        </div>
      </div>
    </div>
  );
}
