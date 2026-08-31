/**
 * BACKLOG-2956 — the consent primitive behind the Play prominent-disclosure gate.
 *
 * `hasDisclosureConsent()` is what `app/onboarding/permissions.tsx` consults
 * before it may fire a runtime permission prompt, so its failure mode matters as
 * much as its happy path: every uncertain answer has to read as "no consent".
 * A version bump must invalidate an older consent rather than being covered by it.
 */
jest.mock('@react-native-async-storage/async-storage', () => {
  let store: Record<string, string> = {};
  return {
    __reset: () => {
      store = {};
    },
    setItem: jest.fn(async (k: string, v: string) => {
      store[k] = v;
    }),
    getItem: jest.fn(async (k: string) => (k in store ? store[k] : null)),
    removeItem: jest.fn(async (k: string) => {
      delete store[k];
    }),
  };
});

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  DISCLOSURE_CONSENT_KEY,
  DISCLOSURE_VERSION,
  hasDisclosureConsent,
  recordDisclosureConsent,
  clearDisclosureConsent,
} from '../disclosureConsent';

const resetStore = (
  AsyncStorage as unknown as { __reset: () => void }
).__reset;

describe('disclosureConsent (BACKLOG-2956)', () => {
  beforeEach(() => {
    resetStore();
    jest.clearAllMocks();
  });

  it('reports no consent on a fresh install', async () => {
    expect(await hasDisclosureConsent()).toBe(false);
  });

  it('records consent against the current disclosure version', async () => {
    await recordDisclosureConsent();

    expect(await AsyncStorage.getItem(DISCLOSURE_CONSENT_KEY)).toBe(
      String(DISCLOSURE_VERSION),
    );
    expect(await hasDisclosureConsent()).toBe(true);
  });

  it('does NOT accept a consent given to an older disclosure', async () => {
    // A user who agreed to disclosure v(N-1) has not agreed to what v(N) says.
    await AsyncStorage.setItem(
      DISCLOSURE_CONSENT_KEY,
      String(DISCLOSURE_VERSION - 1),
    );
    expect(await hasDisclosureConsent()).toBe(false);
  });

  it('does NOT accept a garbage stored value', async () => {
    await AsyncStorage.setItem(DISCLOSURE_CONSENT_KEY, 'yes');
    expect(await hasDisclosureConsent()).toBe(false);
  });

  it('fails CLOSED when the store throws', async () => {
    (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(
      new Error('storage unavailable'),
    );
    // An unreadable store must gate the permission prompt, never leak past it.
    expect(await hasDisclosureConsent()).toBe(false);
  });

  it('surfaces a failed WRITE so the caller can keep the user on the screen', async () => {
    (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(
      new Error('storage full'),
    );
    await expect(recordDisclosureConsent()).rejects.toThrow('storage full');
  });

  it('clearing consent revokes it, so the next account consents for itself', async () => {
    await recordDisclosureConsent();
    expect(await hasDisclosureConsent()).toBe(true);

    await clearDisclosureConsent();

    expect(await hasDisclosureConsent()).toBe(false);
    expect(await AsyncStorage.getItem(DISCLOSURE_CONSENT_KEY)).toBeNull();
  });
});
