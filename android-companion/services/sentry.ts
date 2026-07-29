import * as Sentry from '@sentry/react-native';
import Constants from 'expo-constants';

/**
 * Sentry setup for the Keepr Android companion.
 *
 * Extracted from `app/_layout.tsx` in BACKLOG-2222 so the init options are unit
 * testable and the native-crash / source-map wiring lives in one place.
 *
 * Two halves make production crashes readable:
 *  1. This JS init (release/dist + native crash handling) — the runtime side.
 *  2. Build-time wiring (BACKLOG-2222): the `@sentry/react-native/expo` config
 *     plugin (app.json) links the Android native SDK at prebuild, `metro.config.js`
 *     (`getSentryExpoConfig`) injects Debug IDs, and `scripts/build-apk.sh`
 *     uploads the JS bundle + source map to the SAME org/project as this DSN.
 *     `release`/`dist` below MUST match the values used by that upload step or
 *     minified stack traces will not symbolicate.
 */

/**
 * Sentry DSN for the Android companion.
 *
 * BACKLOG-2197: This is the PUBLIC client DSN of the existing `electron` Sentry
 * project (org keeprcompliancecom). Public/client DSNs are designed to ship in
 * client binaries — they only permit sending events, not reading them — so
 * committing it is safe and standard for mobile/RN apps.
 *
 * Why reuse the electron project instead of a new RN project: the org disables
 * project creation for members (founder-approved decision). Android events are
 * distinguished inside the shared project by the `app: android-companion` tag
 * set in `initialScope` below, so they can be filtered apart from desktop
 * errors. Override per-build with the EXPO_PUBLIC_SENTRY_DSN env var if a
 * dedicated RN project is ever provisioned.
 */
export const SENTRY_DSN =
  process.env.EXPO_PUBLIC_SENTRY_DSN ??
  'https://3ad649526bc88f8e51702b9138f30672@o4510880506183680.ingest.us.sentry.io/4510880579518464';

/**
 * App version (e.g. "1.0.0") used for Sentry release/dist. Mirrors the version
 * resolution already used in settings.tsx / HelpModal.tsx.
 */
export function getAppVersion(): string {
  return (
    Constants.expoConfig?.version ??
    Constants.manifest2?.extra?.expoClient?.version ??
    'unknown'
  );
}

/**
 * Build the options passed to `Sentry.init`. Pure + exported so the wiring
 * (DSN reuse, app tag, dev gate, release/dist, native crash capture) is unit
 * testable without booting the native SDK (BACKLOG-2222).
 */
export function getSentryInitOptions(): Sentry.ReactNativeOptions {
  const version = getAppVersion();

  return {
    dsn: SENTRY_DSN,
    // Send events in production builds; stay silent in dev to avoid noise.
    enabled: !__DEV__,
    environment: __DEV__ ? 'development' : 'production',
    // release/dist MUST match the source-map upload in scripts/build-apk.sh so
    // minified JS frames symbolicate.
    release: `keepr-companion@${version}`,
    dist: version,
    tracesSampleRate: 1.0,
    // BACKLOG-2222: capture NATIVE (JVM/NDK) crashes, not just JS errors. The
    // @sentry/react-native/expo config plugin (app.json) links the native SDK
    // at prebuild; these flags (both default true) are set explicitly to
    // document that native crash reporting is intentionally on. enableNative
    // is the prerequisite for enableNativeCrashHandling.
    enableNative: true,
    enableNativeCrashHandling: true,
    // Tag every event so Android companion telemetry is filterable within the
    // shared `electron` Sentry project (BACKLOG-2197).
    initialScope: {
      tags: { app: 'android-companion' },
    },
  };
}

/**
 * Initialize Sentry (JS + native). Call once at module load, as early as
 * possible in the app entry (`app/_layout.tsx`), before the first render.
 */
export function initSentry(): void {
  Sentry.init(getSentryInitOptions());
}
