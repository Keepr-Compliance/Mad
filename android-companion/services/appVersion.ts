/**
 * App version identity for the Keepr Android companion (BACKLOG-2956).
 *
 * ## Why this module exists
 *
 * Before BACKLOG-2956 the companion had no usable version identity. `expo.version`
 * sat at `"1.0.0"` across 54 commits, and `expo.android.versionCode` was never set
 * at all — so Expo defaulted it to `1` and EVERY build ever produced identified
 * itself as version 1. When a field tester reported four sync failures
 * (BACKLOG-2955), nobody could establish which build she was running: "I have
 * 1.00" was equally consistent with a build from March and one made that morning.
 *
 * ## Why NATIVE values, not the JS config
 *
 * `Constants.expoConfig` is the app config as it was embedded into the JS bundle.
 * `expo-application` reads Android's `PackageInfo` — `versionName` / `versionCode`
 * out of the installed APK's compiled manifest. That is the ground truth of *what
 * Android actually installed*, which is precisely the fact a support conversation
 * needs and precisely the fact the JS config cannot guarantee (a JS bundle can be
 * replaced without the native binary changing — the exact scenario any future OTA
 * mechanism introduces). Native first, config only as a fallback.
 *
 * ## Why the fallback is "unknown" and never a version-shaped literal
 *
 * The previous call sites (`settings.tsx`, `HelpModal.tsx`) ended their fallback
 * chain with the literal `'1.0.0'`. That is the same defect in miniature: when
 * version resolution breaks, the app confidently displays a PLAUSIBLE version, and
 * a support conversation is misled rather than merely uninformed. A wrong answer
 * is worse than no answer here, so unresolvable values render as `unknown`.
 */

import * as Application from 'expo-application';
import Constants from 'expo-constants';

/** Rendered when neither the native manifest nor the app config yields a value. */
export const UNKNOWN_VERSION = 'unknown';

/**
 * User-facing version name — Android `versionName`, from `expo.version`.
 * Example: `"1.1.0"`.
 */
export function getAppVersion(): string {
  // Android PackageInfo.versionName — what this installed APK actually declares.
  const native = Application.nativeApplicationVersion;
  if (native) return native;

  // Fallback: the embedded app config. Used under jest and in Expo Go, where
  // there is no native package to interrogate.
  const fromConfig =
    Constants.expoConfig?.version ??
    Constants.manifest2?.extra?.expoClient?.version;

  return fromConfig ?? UNKNOWN_VERSION;
}

/**
 * Build number — Android `versionCode`, from `expo.android.versionCode`.
 * Returned as a string because that is how the native module reports it.
 * Example: `"2"`.
 *
 * This is the value that actually distinguishes two builds of the same version,
 * and the one Android itself compares when deciding whether an install is an
 * upgrade. It is the number to ask a user for.
 */
export function getBuildNumber(): string {
  // Android PackageInfo.versionCode, stringified by expo-application.
  const native = Application.nativeBuildVersion;
  if (native) return native;

  const fromConfig = Constants.expoConfig?.android?.versionCode;
  return typeof fromConfig === 'number' ? String(fromConfig) : UNKNOWN_VERSION;
}

/**
 * The single string to show a user and to quote in a support conversation:
 * `"1.1.0 (2)"` — version name with the build number in parentheses.
 *
 * The build number is the load-bearing half. Two builds can share a version name;
 * they cannot share a versionCode if the release process is followed.
 */
export function getVersionLabel(): string {
  return `${getAppVersion()} (${getBuildNumber()})`;
}
