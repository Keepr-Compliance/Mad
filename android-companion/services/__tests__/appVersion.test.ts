/**
 * Version identity resolution — BACKLOG-2956.
 *
 * The defect this guards: the companion had no way to identify a build. Every
 * build reported version "1.0.0" and versionCode 1, so when a field tester hit
 * four sync failures (BACKLOG-2955) nobody could establish which build she was
 * running — a March build and a build made that morning were indistinguishable.
 *
 * WHAT THIS TEST VERIFIES:
 *   1. Resolution prefers the NATIVE package manifest over the JS app config.
 *      This is the load-bearing property: `Constants.expoConfig` describes what
 *      was bundled, `expo-application` describes what Android actually
 *      installed, and only the second one answers "which build is on the phone".
 *   2. The label carries the BUILD NUMBER, not just the version name. The
 *      version name alone is what failed us — it cannot distinguish two builds.
 *   3. When nothing resolves, the value is `unknown` and NEVER a plausible
 *      version-shaped literal. The old call sites fell back to the string
 *      '1.0.0', which meant a broken resolution displayed a believable wrong
 *      answer — worse than displaying no answer, because it misleads support.
 *
 * Mechanic: the mock factories below return plain, MUTABLE objects, and each
 * test writes the fields it needs. The mocked module objects are grabbed via
 * the imports rather than closed-over consts, because `jest.mock` factories are
 * hoisted above `const` initialisation — a factory that referenced an outer
 * const would capture `undefined`. `beforeEach` resets every field so no test
 * inherits another's state.
 */

jest.mock('expo-application', () => ({
  __esModule: true,
  nativeApplicationVersion: null,
  nativeBuildVersion: null,
}));

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: null, manifest2: null },
}));

import * as Application from 'expo-application';
import Constants from 'expo-constants';

import {
  UNKNOWN_VERSION,
  getAppVersion,
  getBuildNumber,
  getVersionLabel,
} from '../appVersion';

/** The mocked `expo-application` module object, writable for this test. */
const mockApplication = Application as unknown as {
  nativeApplicationVersion: string | null;
  nativeBuildVersion: string | null;
};

/** The mocked `expo-constants` default export, writable for this test. */
const mockConstants = Constants as unknown as {
  expoConfig: {
    version?: string;
    android?: { versionCode?: number };
  } | null;
  manifest2: { extra?: { expoClient?: { version?: string } } } | null;
};

beforeEach(() => {
  mockApplication.nativeApplicationVersion = null;
  mockApplication.nativeBuildVersion = null;
  mockConstants.expoConfig = null;
  mockConstants.manifest2 = null;
});

describe('version identity resolution (BACKLOG-2956)', () => {
  describe('native package manifest wins', () => {
    it('prefers the native versionName over the app config version', () => {
      // Deliberately DIFFERENT values: if resolution silently read the config,
      // this returns 9.9.9 and the test fails. Identical fixtures could not
      // tell the two sources apart.
      mockApplication.nativeApplicationVersion = '7.7.7';
      mockConstants.expoConfig = { version: '9.9.9' };

      expect(getAppVersion()).toBe('7.7.7');
    });

    it('prefers the native versionCode over the app config versionCode', () => {
      mockApplication.nativeBuildVersion = '42';
      mockConstants.expoConfig = { android: { versionCode: 99 } };

      expect(getBuildNumber()).toBe('42');
    });
  });

  describe('app config fallback (jest / Expo Go — no native package)', () => {
    it('falls back to expoConfig.version when there is no native version', () => {
      mockConstants.expoConfig = { version: '1.1.0' };

      expect(getAppVersion()).toBe('1.1.0');
    });

    it('falls back to manifest2 when expoConfig has no version', () => {
      mockConstants.expoConfig = {};
      mockConstants.manifest2 = { extra: { expoClient: { version: '1.2.3' } } };

      expect(getAppVersion()).toBe('1.2.3');
    });

    it('stringifies the numeric versionCode from the app config', () => {
      // app.json declares versionCode as a NUMBER; every consumer displays a
      // string. An unstringified number would render as "1.1.0 (2)" by
      // coincidence of template interpolation but break a strict comparison.
      mockConstants.expoConfig = { android: { versionCode: 2 } };

      expect(getBuildNumber()).toBe('2');
    });
  });

  describe('unresolvable values are never version-shaped', () => {
    it('returns "unknown" for the version when nothing resolves', () => {
      expect(getAppVersion()).toBe(UNKNOWN_VERSION);
    });

    it('returns "unknown" for the build number when nothing resolves', () => {
      expect(getBuildNumber()).toBe(UNKNOWN_VERSION);
    });

    it('never falls back to a plausible version literal', () => {
      // The regression guard. settings.tsx and HelpModal.tsx both used to end
      // their fallback chain with the literal '1.0.0', so a broken lookup
      // displayed a real-looking version and a support conversation was
      // actively misled. Assert the failure mode is inert, not plausible.
      expect(getAppVersion()).not.toBe('1.0.0');
      expect(getVersionLabel()).toBe('unknown (unknown)');
    });

    it('marks only the missing half when the version resolves but the build does not', () => {
      mockApplication.nativeApplicationVersion = '1.1.0';

      expect(getVersionLabel()).toBe('1.1.0 (unknown)');
    });
  });

  describe('the support-facing label', () => {
    it('renders version name with the build number in parentheses', () => {
      mockApplication.nativeApplicationVersion = '1.1.0';
      mockApplication.nativeBuildVersion = '2';

      // This exact string is what a user reads back on a support call, so it is
      // asserted verbatim rather than by substring.
      expect(getVersionLabel()).toBe('1.1.0 (2)');
    });

    it('distinguishes two builds that share a version name', () => {
      // The whole point of the item. Under the old scheme both of these
      // rendered "1.0.0" and were indistinguishable.
      mockApplication.nativeApplicationVersion = '1.1.0';
      mockApplication.nativeBuildVersion = '2';
      const build2 = getVersionLabel();

      mockApplication.nativeBuildVersion = '3';
      const build3 = getVersionLabel();

      expect(build2).not.toBe(build3);
      expect(build2).toBe('1.1.0 (2)');
      expect(build3).toBe('1.1.0 (3)');
    });
  });
});
