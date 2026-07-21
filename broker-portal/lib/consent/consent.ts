/**
 * Cookie / tracking-consent state for the broker portal.
 *
 * BACKLOG-2133 (+ BACKLOG-2122 overlap): Microsoft Clarity session-replay and
 * any other non-essential analytics MUST NOT load until the user explicitly
 * accepts. This module is the single source of truth for that decision.
 *
 * Design (US-only scope, founder 2026-07-18):
 *   - No EU opt-in banner is legally required, but we still DEFAULT TO NOT
 *     LOADING analytics until the user makes a choice (opt-in mechanism), so the
 *     same code path also satisfies stricter regimes.
 *   - CCPA/CPRA: honor Global Privacy Control (GPC) as an opt-out signal. If GPC
 *     is asserted we treat consent as DECLINED silently — the banner is never
 *     shown and nothing is persisted/logged.
 *   - The persisted choice (`keepr-consent=accepted|declined`) lets the user
 *     change/withdraw consent at any time and dismisses the banner permanently.
 *
 * This file is intentionally free of React and DOM-framework code so it can be
 * unit-tested in isolation (Node/jsdom) and imported by both server and client.
 */

/** Persisted consent choices. `unset` = no choice recorded yet. */
export type ConsentValue = 'accepted' | 'declined';

/** Effective consent decision after applying GPC precedence. */
export type ConsentDecision = ConsentValue | 'unset';

/** localStorage key holding the persisted `ConsentValue`. */
export const CONSENT_STORAGE_KEY = 'keepr-consent';

/**
 * True when the browser is asserting a Global Privacy Control opt-out signal.
 *
 * `navigator.globalPrivacyControl` is the standardized property (mirrors the
 * `Sec-GPC: 1` request header). It is `true` only when the user has opted out;
 * `undefined`/`false` means no signal. We read defensively because the property
 * is non-standard-typed across browsers and absent under SSR.
 */
export function isGpcEnabled(): boolean {
  if (typeof navigator === 'undefined') return false;
  // `globalPrivacyControl` is not in the base Navigator type in all TS libs.
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
  return nav.globalPrivacyControl === true;
}

/**
 * Read the persisted consent choice from localStorage.
 *
 * Returns `'unset'` when nothing valid is stored (first visit, cleared storage,
 * or a corrupted value). Never throws — storage access can fail in private
 * mode / sandboxed frames, in which case we behave as if no choice was made.
 */
export function getStoredConsent(): ConsentDecision {
  if (typeof window === 'undefined') return 'unset';
  try {
    const raw = window.localStorage.getItem(CONSENT_STORAGE_KEY);
    if (raw === 'accepted' || raw === 'declined') return raw;
    return 'unset';
  } catch {
    return 'unset';
  }
}

/**
 * Persist a consent choice. Best-effort: swallows storage errors so a failure
 * to persist never breaks the UI (the banner simply reappears next visit).
 */
export function setStoredConsent(value: ConsentValue): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, value);
  } catch {
    /* storage unavailable — ignore */
  }
}

/**
 * The effective consent decision, applying GPC precedence.
 *
 * Precedence (highest first):
 *   1. GPC asserted  → 'declined' (silent opt-out; overrides any stored value)
 *   2. Stored choice → 'accepted' | 'declined'
 *   3. Otherwise     → 'unset'
 *
 * NOTE: GPC intentionally overrides even a previously stored `accepted`. A user
 * who later enables a GPC signal is expressing a fresh opt-out we must honor.
 */
export function resolveConsent(): ConsentDecision {
  if (isGpcEnabled()) return 'declined';
  return getStoredConsent();
}

/**
 * Whether non-essential analytics (Microsoft Clarity, GA, …) may load.
 * True ONLY when the effective decision is an explicit 'accepted'.
 */
export function analyticsAllowed(): boolean {
  return resolveConsent() === 'accepted';
}

/**
 * Whether the consent banner should be shown.
 *
 * Shown only when the user has NOT made a choice AND GPC is not asserting an
 * opt-out. When GPC is on we honor it silently (no banner), and once a choice
 * is stored the banner stays dismissed.
 */
export function shouldShowBanner(): boolean {
  if (isGpcEnabled()) return false;
  return getStoredConsent() === 'unset';
}
