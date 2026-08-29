/**
 * Data Disclosure Consent (Android Companion) — BACKLOG-2956.
 *
 * Google Play requires a "Prominent Disclosure & Consent" flow for an app that
 * accesses SMS or contacts and transmits that data off the device. The rules
 * are specific, and none of them are satisfied by a privacy policy or a store
 * listing:
 *
 *   - the disclosure must appear IN the app, in normal usage;
 *   - it must appear IMMEDIATELY BEFORE the runtime permission prompt — not
 *     after it, not beside it;
 *   - it must say what is collected, why, and that it leaves the device;
 *   - the user must give AFFIRMATIVE consent (press something). Continuing
 *     automatically does not count.
 *
 * It applies here with no exemption because the companion also syncs from a
 * background task (`expo-background-fetch`, see services/backgroundSync.ts),
 * i.e. while the app is not in the foreground.
 *
 * This module is the single source of truth for whether that consent has been
 * given. It is deliberately a SERVICE and not raw AsyncStorage inside the
 * screen: the permissions screen has to consult it before it may request a
 * runtime permission, and a service is mockable at that call site without
 * disturbing the AsyncStorage spies the existing onboarding tests rely on.
 *
 * Versioning: consent is recorded against DISCLOSURE_VERSION. If the disclosed
 * behaviour changes (new data type, new destination), bump the version and every
 * user is asked again — an old consent cannot silently cover a new collection.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

/** Persisted key holding the version of the disclosure the user consented to. */
export const DISCLOSURE_CONSENT_KEY = '@keepr/data-disclosure-consent';

/**
 * Version of the disclosure copy in `app/onboarding/disclosure.tsx`.
 *
 * BUMP THIS whenever the disclosure's substance changes — what is collected,
 * why, where it goes, or that it happens in the background. Bumping invalidates
 * every stored consent, so users re-consent to the new terms.
 */
export const DISCLOSURE_VERSION = 1;

/**
 * Whether the user has affirmatively consented to the CURRENT disclosure.
 *
 * Fails CLOSED: a storage error, a missing value, or a consent recorded against
 * an older disclosure version all return false, which keeps the permission
 * prompt gated. Never returns true on a guess.
 */
export async function hasDisclosureConsent(): Promise<boolean> {
  try {
    const stored = await AsyncStorage.getItem(DISCLOSURE_CONSENT_KEY);
    if (stored === null) return false;
    return Number.parseInt(stored, 10) === DISCLOSURE_VERSION;
  } catch {
    return false;
  }
}

/**
 * Record affirmative consent to the current disclosure.
 *
 * Called ONLY from the disclosure screen's consent button press handler. It must
 * never be called on mount, on focus, or on navigation — Play treats consent
 * that the user did not actively give as no consent at all.
 *
 * Throws on a storage failure so the caller can keep the user on the screen
 * rather than advancing them into a permission prompt with no recorded consent.
 */
export async function recordDisclosureConsent(): Promise<void> {
  await AsyncStorage.setItem(DISCLOSURE_CONSENT_KEY, String(DISCLOSURE_VERSION));
}

/**
 * Clear the stored consent. Used when the user signs out of onboarding, so the
 * NEXT account to sign in on this phone is asked for its own consent rather
 * than inheriting the previous user's.
 */
export async function clearDisclosureConsent(): Promise<void> {
  try {
    await AsyncStorage.removeItem(DISCLOSURE_CONSENT_KEY);
  } catch {
    /* non-fatal: a stale consent is re-checked against the version anyway */
  }
}
