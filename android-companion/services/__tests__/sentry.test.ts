/**
 * Config guard for BACKLOG-2222 — Sentry init options for the Android companion.
 *
 * The runtime half of "make production crashes readable". The build-time half
 * (Sentry Expo config plugin in app.json, getSentryExpoConfig in metro.config.js,
 * the guarded source-map upload in scripts/build-apk.sh) is verified statically /
 * on-device, so this test locks the INIT contract those pieces depend on:
 *
 *   1. reuses the existing `electron` project DSN (project id in the DSN),
 *   2. tags every event `app: android-companion` (filterable in the shared
 *      project — BACKLOG-2197),
 *   3. gates reporting on non-dev (enabled = !__DEV__) — dev builds stay silent,
 *   4. enables NATIVE crash capture (not just JS) — BACKLOG-2222,
 *   5. sets release/dist from the app version, which the build-apk.sh upload
 *      MUST match for minified stack traces to symbolicate,
 *   6. initSentry() actually forwards these options to Sentry.init.
 *
 * Sentry's native module is mocked so this runs without booting the SDK, and
 * expo-constants is mocked to pin the app version deterministically.
 */

jest.mock('@sentry/react-native', () => ({
  init: jest.fn(),
  setUser: jest.fn(),
  captureException: jest.fn(),
}));

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { version: '9.9.9' } },
}));

// BACKLOG-2956: version identity now resolves from the NATIVE package manifest
// (expo-application) first. Distinct values from the expo-constants mock above
// so a regression to reading the JS config is visible rather than silent.
jest.mock('expo-application', () => ({
  __esModule: true,
  nativeApplicationVersion: '7.7.7',
  nativeBuildVersion: '42',
}));

import * as Sentry from '@sentry/react-native';
import {
  SENTRY_DSN,
  getAppVersion,
  getSentryInitOptions,
  initSentry,
} from '../sentry';

describe('sentry init config (BACKLOG-2222)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reuses the existing electron Sentry project DSN', () => {
    // Project id 4510880579518464 is the shared `electron` project.
    expect(SENTRY_DSN).toContain('ingest.us.sentry.io/4510880579518464');
  });

  it('tags every event app:android-companion', () => {
    expect(getSentryInitOptions().initialScope).toEqual({
      tags: { app: 'android-companion' },
    });
  });

  it('gates reporting on non-dev (enabled = !__DEV__)', () => {
    const options = getSentryInitOptions();
    // Not hardcoded: must track the __DEV__ global so dev builds stay silent.
    expect(options.enabled).toBe(!__DEV__);
    expect(options.environment).toBe(__DEV__ ? 'development' : 'production');
  });

  it('enables native crash capture, not just JS', () => {
    const options = getSentryInitOptions();
    expect(options.enableNative).toBe(true);
    expect(options.enableNativeCrashHandling).toBe(true);
  });

  it('sets release/dist from the app version for source-map matching', () => {
    // 7.7.7 is the NATIVE versionName, not the 9.9.9 in the expo-constants mock:
    // asserts that resolution prefers the installed package over the JS config.
    expect(getAppVersion()).toBe('7.7.7');
    const options = getSentryInitOptions();
    // MUST match the --release / --dist passed by scripts/build-apk.sh and
    // scripts/build-release.sh, or minified frames stop symbolicating.
    expect(options.release).toBe('keepr-companion@7.7.7');
    // BACKLOG-2956: dist is the BUILD NUMBER (versionCode), so two builds of one
    // version are distinguishable in Sentry. It was the version name before,
    // which made them identical.
    expect(options.dist).toBe('42');
  });

  it('initSentry forwards the options to Sentry.init', () => {
    initSentry();
    expect(Sentry.init).toHaveBeenCalledTimes(1);
    expect(Sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: SENTRY_DSN,
        enableNative: true,
        enableNativeCrashHandling: true,
        initialScope: { tags: { app: 'android-companion' } },
      }),
    );
  });
});
