'use client';

/**
 * React binding over the pure consent util (`./consent`).
 *
 * BACKLOG-2133: gives the banner and the Clarity loader a single, reactive
 * source of truth. When the user accepts/declines we persist the choice AND
 * broadcast a same-tab custom event so every subscriber (banner visibility +
 * analytics gate) re-resolves together — without a page reload.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  type ConsentDecision,
  type ConsentValue,
  resolveConsent,
  setStoredConsent,
  shouldShowBanner,
} from './consent';

/** Same-tab broadcast channel for consent changes. */
const CONSENT_CHANGE_EVENT = 'keepr:consent-change';

interface ConsentState {
  /** Effective decision (GPC precedence applied). `unset` until resolved. */
  decision: ConsentDecision;
  /** Whether the banner should currently be shown. */
  showBanner: boolean;
  /** Whether non-essential analytics (Clarity) may load. */
  analyticsAllowed: boolean;
  /** Record an explicit choice; persists + notifies subscribers. */
  setConsent: (_value: ConsentValue) => void;
}

/**
 * Resolve consent + banner visibility. Must run client-side only; during SSR
 * and the first render we report a neutral state (`unset`, banner hidden,
 * analytics NOT allowed) so nothing loads before hydration reads real signals.
 */
export function useConsent(): ConsentState {
  const [decision, setDecision] = useState<ConsentDecision>('unset');
  const [showBanner, setShowBanner] = useState(false);

  const sync = useCallback(() => {
    setDecision(resolveConsent());
    setShowBanner(shouldShowBanner());
  }, []);

  useEffect(() => {
    // Read real values after mount (avoids SSR/hydration mismatch).
    sync();

    // Re-resolve on same-tab changes and on cross-tab storage writes.
    const onChange = () => sync();
    window.addEventListener(CONSENT_CHANGE_EVENT, onChange);
    window.addEventListener('storage', onChange);
    return () => {
      window.removeEventListener(CONSENT_CHANGE_EVENT, onChange);
      window.removeEventListener('storage', onChange);
    };
  }, [sync]);

  const setConsent = useCallback((value: ConsentValue) => {
    setStoredConsent(value);
    // Notify this tab's other subscribers (storage event only fires cross-tab).
    window.dispatchEvent(new CustomEvent(CONSENT_CHANGE_EVENT));
    // Optimistic local update so the calling component reacts immediately.
    setDecision(resolveConsent());
    setShowBanner(shouldShowBanner());
  }, []);

  return {
    decision,
    showBanner,
    analyticsAllowed: decision === 'accepted',
    setConsent,
  };
}
