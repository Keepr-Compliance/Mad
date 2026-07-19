/**
 * Consent util unit tests (BACKLOG-2133).
 *
 * Covers the decision matrix the compliance requirement hinges on:
 *   - default = NOT loaded (analytics off until explicit accept)
 *   - accept / decline persist and resolve correctly
 *   - GPC opt-out takes precedence and is honored SILENTLY (no banner), even
 *     over a previously stored `accepted`.
 */

import {
  CONSENT_STORAGE_KEY,
  analyticsAllowed,
  getStoredConsent,
  isGpcEnabled,
  resolveConsent,
  setStoredConsent,
  shouldShowBanner,
} from '@/lib/consent/consent';

/** Set (or clear) the GPC signal on navigator for a test. */
function setGpc(value: boolean | undefined) {
  Object.defineProperty(navigator, 'globalPrivacyControl', {
    value,
    configurable: true,
  });
}

describe('consent util', () => {
  beforeEach(() => {
    window.localStorage.clear();
    setGpc(undefined);
  });

  describe('default (no choice, no GPC)', () => {
    it('resolves to unset', () => {
      expect(resolveConsent()).toBe('unset');
      expect(getStoredConsent()).toBe('unset');
    });

    it('does NOT allow analytics by default', () => {
      expect(analyticsAllowed()).toBe(false);
    });

    it('shows the banner', () => {
      expect(shouldShowBanner()).toBe(true);
    });
  });

  describe('accept', () => {
    beforeEach(() => setStoredConsent('accepted'));

    it('persists to localStorage under the documented key', () => {
      expect(window.localStorage.getItem(CONSENT_STORAGE_KEY)).toBe('accepted');
    });

    it('resolves to accepted and allows analytics', () => {
      expect(resolveConsent()).toBe('accepted');
      expect(analyticsAllowed()).toBe(true);
    });

    it('hides the banner', () => {
      expect(shouldShowBanner()).toBe(false);
    });
  });

  describe('decline', () => {
    beforeEach(() => setStoredConsent('declined'));

    it('resolves to declined and blocks analytics', () => {
      expect(resolveConsent()).toBe('declined');
      expect(analyticsAllowed()).toBe(false);
    });

    it('persists the decline (banner stays dismissed)', () => {
      expect(shouldShowBanner()).toBe(false);
      // Re-reading gives the same declined value (persistence).
      expect(getStoredConsent()).toBe('declined');
    });
  });

  describe('GPC precedence', () => {
    it('detects the GPC signal', () => {
      setGpc(true);
      expect(isGpcEnabled()).toBe(true);
      setGpc(false);
      expect(isGpcEnabled()).toBe(false);
      setGpc(undefined);
      expect(isGpcEnabled()).toBe(false);
    });

    it('treats GPC as declined and NEVER shows the banner (silent opt-out)', () => {
      setGpc(true);
      expect(resolveConsent()).toBe('declined');
      expect(analyticsAllowed()).toBe(false);
      expect(shouldShowBanner()).toBe(false);
    });

    it('overrides a previously stored accepted choice', () => {
      setStoredConsent('accepted');
      expect(analyticsAllowed()).toBe(true);
      setGpc(true);
      expect(resolveConsent()).toBe('declined');
      expect(analyticsAllowed()).toBe(false);
      expect(shouldShowBanner()).toBe(false);
    });
  });

  describe('resilience', () => {
    it('treats a corrupted stored value as unset', () => {
      window.localStorage.setItem(CONSENT_STORAGE_KEY, 'garbage');
      expect(getStoredConsent()).toBe('unset');
      expect(shouldShowBanner()).toBe(true);
    });
  });
});
