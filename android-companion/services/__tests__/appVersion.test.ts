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

// `var`, not `let`: jest.mock factories are hoisted and this one runs at the
// first require — a `let` would still be in its temporal dead zone and throw a
// ReferenceError instead of reading `false`.
// eslint-disable-next-line no-var
var mockNativeUnlinked = false;

/**
 * Values the mocked native module reports. Held in a module-scope object read
 * through getters, so this file never needs a static
 * `import * as Application from 'expo-application'`.
 *
 * That matters: a static import loads the module into the OUTER registry at file
 * load, and a module already resolved there is not re-created by
 * `jest.isolateModules` — so the factory would never re-run and the
 * unlinked-module simulation below would silently do nothing. Measured with a
 * probe: with no prior import the factory runs inside `isolateModules` and
 * throws as intended; with one, it does not.
 */
// eslint-disable-next-line no-var
var mockApplicationState: {
  nativeApplicationVersion: string | null;
  nativeBuildVersion: string | null;
} = { nativeApplicationVersion: null, nativeBuildVersion: null };

jest.mock('expo-application', () => {
  // Simulating an UNLINKED native module has to happen in THIS factory. A
  // `jest.doMock` for the same module inside `jest.isolateModules` does not
  // reliably win over a hoisted file-scope `jest.mock`.
  if (mockNativeUnlinked) {
    throw new Error("Cannot find native module 'ExpoApplication'");
  }
  return {
    __esModule: true,
    get nativeApplicationVersion() {
      return mockApplicationState.nativeApplicationVersion;
    },
    get nativeBuildVersion() {
      return mockApplicationState.nativeBuildVersion;
    },
  };
});

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: null, manifest2: null },
}));

import Constants from 'expo-constants';

import {
  UNKNOWN_VERSION,
  getAppVersion,
  getBuildNumber,
  getVersionLabel,
} from '../appVersion';

/** The mocked `expo-constants` default export, writable for this test. */
const mockConstants = Constants as unknown as {
  expoConfig: {
    version?: string;
    android?: { versionCode?: number };
  } | null;
  manifest2: { extra?: { expoClient?: { version?: string } } } | null;
};

beforeEach(() => {
  mockApplicationState.nativeApplicationVersion = null;
  mockApplicationState.nativeBuildVersion = null;
  mockConstants.expoConfig = null;
  mockConstants.manifest2 = null;
});

describe('version identity resolution (BACKLOG-2956)', () => {
  describe('native package manifest wins', () => {
    it('prefers the native versionName over the app config version', () => {
      // Deliberately DIFFERENT values: if resolution silently read the config,
      // this returns 9.9.9 and the test fails. Identical fixtures could not
      // tell the two sources apart.
      mockApplicationState.nativeApplicationVersion = '7.7.7';
      mockConstants.expoConfig = { version: '9.9.9' };

      expect(getAppVersion()).toBe('7.7.7');
    });

    it('prefers the native versionCode over the app config versionCode', () => {
      mockApplicationState.nativeBuildVersion = '42';
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
      mockApplicationState.nativeApplicationVersion = '1.1.0';

      expect(getVersionLabel()).toBe('1.1.0 (unknown)');
    });
  });

  describe('the support-facing label', () => {
    it('renders version name with the build number in parentheses', () => {
      mockApplicationState.nativeApplicationVersion = '1.1.0';
      mockApplicationState.nativeBuildVersion = '2';

      // This exact string is what a user reads back on a support call, so it is
      // asserted verbatim rather than by substring.
      expect(getVersionLabel()).toBe('1.1.0 (2)');
    });

    it('distinguishes two builds that share a version name', () => {
      // The whole point of the item. Under the old scheme both of these
      // rendered "1.0.0" and were indistinguishable.
      mockApplicationState.nativeApplicationVersion = '1.1.0';
      mockApplicationState.nativeBuildVersion = '2';
      const build2 = getVersionLabel();

      mockApplicationState.nativeBuildVersion = '3';
      const build3 = getVersionLabel();

      expect(build2).not.toBe(build3);
      expect(build2).toBe('1.1.0 (2)');
      expect(build3).toBe('1.1.0 (3)');
    });
  });
  describe('a missing native module degrades, it does NOT take the app down', () => {
    // SR review finding. `expo-application` resolves its native binding at MODULE
    // SCOPE via `requireNativeModule`, which THROWS when the module is not linked
    // (the null-returning variant, `requireOptionalNativeModule`, is not what it
    // uses). A static import would therefore throw during module evaluation —
    // and this module is reached from `services/sentry.ts`, which `app/_layout.tsx`
    // imports, so the throw would land BEFORE `initSentry()` runs: the app fails
    // to open and Sentry is not up to report why.
    //
    // The trigger is real: any build that reuses a stale `android/` generated
    // before expo-application was added will not have autolinked it.
    //
    // These tests load the module fresh with a throwing `expo-application` and
    // assert it falls back rather than propagating. Without the try/catch in
    // loadNativeApplication(), every one of them throws instead of returning.

    /**
     * Run `fn` against a freshly-loaded appVersion.ts while `expo-application`
     * throws on require.
     *
     * The flag MUST stay set for the duration of the assertions, not just the
     * load. `loadNativeApplication()` is lazy — requiring appVersion.ts does not
     * touch expo-application, so the factory only runs on the FIRST getter call.
     * An earlier version reset the flag in a `finally` around the load, which
     * meant the throw never fired and all three tests passed vacuously. A
     * control caught it: deleting the try/catch under test left them green.
     */
    function withUnlinkedNativeModule(
      expoConfig: unknown,
      fn: (mod: typeof import('../appVersion')) => void,
    ): void {
      mockNativeUnlinked = true;
      // Clear the registry FIRST. Earlier tests in this file call the getters,
      // which lazily require expo-application into the outer registry; a module
      // already resolved there is not re-created by isolateModules alone, so the
      // factory would not re-run and the throw would never fire.
      jest.resetModules();
      try {
        jest.isolateModules(() => {
          // Mutate whatever expo-constants instance THIS isolated registry hands
          // out rather than registering a competing doMock — a second factory for
          // an already-hoisted jest.mock is not guaranteed to win.
          const isolatedConstants = (
            require('expo-constants') as { default: Record<string, unknown> }
          ).default;
          isolatedConstants.expoConfig = expoConfig;
          isolatedConstants.manifest2 = null;
          fn(require('../appVersion') as typeof import('../appVersion'));
        });
      } finally {
        mockNativeUnlinked = false;
      }
    }

    it('falls back to the app config instead of throwing', () => {
      withUnlinkedNativeModule(
        { version: '1.1.0', android: { versionCode: 2 } },
        (mod) => {
          expect(() => mod.getVersionLabel()).not.toThrow();
          expect(mod.getVersionLabel()).toBe('1.1.0 (2)');
        },
      );
    });

    it('degrades to "unknown" when there is no config either', () => {
      withUnlinkedNativeModule(null, (mod) => {
        expect(mod.getVersionLabel()).toBe('unknown (unknown)');
      });
    });

    it('the throw is real — the factory does fire in these tests', () => {
      // Guards the guard. If the simulation ever stops working, the three tests
      // above go quietly vacuous again; this one fails loudly instead.
      withUnlinkedNativeModule({ version: '1.1.0' }, () => {
        expect(() => require('expo-application')).toThrow(
          /Cannot find native module/,
        );
      });
    });
  });
});
