'use client';

import { useEffect, useRef } from 'react';
import { useConsent } from '@/lib/consent/useConsent';

/**
 * Microsoft Clarity session-replay loader — consent-gated (BACKLOG-2133).
 *
 * Clarity is non-essential analytics that RECORDS sessions, so it must not
 * initialize until the user explicitly accepts (or, for a returning visitor,
 * has a persisted `accepted` choice). If the user declines or a GPC opt-out is
 * asserted, Clarity is never loaded. Consent is resolved via `useConsent`, so
 * accepting in-session starts Clarity without a page reload.
 *
 * Idempotency: Clarity's `init` is guarded by a ref so a re-render (or a
 * decline→accept toggle within the same mount) never double-injects the
 * script. Once initialized we leave it for the page lifetime; a subsequent
 * decline stops NEW recording from taking effect on the next load.
 */
export default function ClarityAnalytics({ projectId }: { projectId: string }) {
  const { analyticsAllowed } = useConsent();
  const initialized = useRef(false);

  useEffect(() => {
    if (!analyticsAllowed || initialized.current) return;
    initialized.current = true;

    // Dynamic import to avoid SSR issues and to keep Clarity out of the code
    // path taken when the user never consents.
    import('@microsoft/clarity').then((module) => {
      module.default.init(projectId);
    });
  }, [analyticsAllowed, projectId]);

  return null;
}
