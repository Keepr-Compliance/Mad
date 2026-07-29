/**
 * Battery-optimization guidance (Android Companion).
 *
 * BACKLOG-2204, Part 1. The single most effective thing a managed-Expo app can
 * do about Doze / OEM battery-killing is ask the user to exempt the app from
 * battery optimization — an always-on native foreground service is NOT
 * available without a native config-plugin / dev-client build and is Play-policy
 * sensitive, so it is deliberately out of scope here (see the module docs on
 * backgroundSync.ts). This module provides:
 *
 *   1. `openBatteryOptimizationSettings()` — deep-links the user to the Android
 *      battery-optimization list so they can allow Keepr Companion to run in the
 *      background. Uses the SETTINGS-LIST action, which needs NO extra
 *      permission and is Play-policy safe (unlike the per-app
 *      ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS dialog, which requires the
 *      REQUEST_IGNORE_BATTERY_OPTIMIZATIONS permission and is restricted).
 *
 *   2. `shouldPromptBatteryOptimization()` — a pure, guarded decision so the app
 *      only nags the user when it is actually appropriate (Android, paired,
 *      background sync on, not already dismissed, AND sync is genuinely stale).
 *
 *   3. dismissal persistence so the one-time prompt does not reappear on every
 *      foreground.
 */

import { Platform, Linking } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Sentry from '@sentry/react-native';
import type { SyncFreshness } from './syncStaleness';

/** Storage key: has the user already been shown / dismissed the prompt. */
const BATTERY_OPT_PROMPTED_KEY = '@keepr/battery-opt-prompt-dismissed';

/**
 * Android Settings action that opens the battery-optimization app list. The
 * user picks Keepr Companion and switches it to "Don't optimize". Requires no
 * runtime permission and is safe under Play policy.
 */
const IGNORE_BATTERY_OPT_SETTINGS_ACTION =
  'android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS';

// ============================================
// DISMISSAL PERSISTENCE
// ============================================

/** Whether the user has already dismissed / acted on the one-time prompt. */
export async function getBatteryOptPromptDismissed(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(BATTERY_OPT_PROMPTED_KEY)) === 'true';
  } catch {
    return false;
  }
}

/** Mark the one-time battery-optimization prompt as dismissed (or reset it). */
export async function setBatteryOptPromptDismissed(
  dismissed: boolean,
): Promise<void> {
  await AsyncStorage.setItem(BATTERY_OPT_PROMPTED_KEY, String(dismissed));
}

// ============================================
// PROMPT DECISION (pure / guarded)
// ============================================

export interface BatteryOptPromptInput {
  /** Platform.OS at call time. */
  platformOS: typeof Platform.OS;
  /** Whether this device is currently paired with a desktop. */
  paired: boolean;
  /** Whether background sync is enabled in settings. */
  backgroundSyncEnabled: boolean;
  /** Whether the one-time prompt was already dismissed. */
  dismissed: boolean;
  /** Current sync freshness (from getSyncFreshness). */
  freshness: SyncFreshness;
}

/**
 * Decide whether to show the one-time battery-optimization prompt.
 *
 * Only "appropriate" when ALL hold:
 *  - Android (the intent is Android-only);
 *  - paired (nothing to sync otherwise);
 *  - background sync enabled (the user opted into background operation);
 *  - not previously dismissed (don't nag);
 *  - sync is actually `stale` (real evidence Doze/OEM killed background sync —
 *    never bother a healthy install).
 */
export function shouldPromptBatteryOptimization(
  input: BatteryOptPromptInput,
): boolean {
  return (
    input.platformOS === 'android' &&
    input.paired &&
    input.backgroundSyncEnabled &&
    !input.dismissed &&
    input.freshness.status === 'stale'
  );
}

// ============================================
// DEEP LINK
// ============================================

/**
 * Open the Android battery-optimization settings so the user can exempt Keepr
 * Companion. Falls back to the app's own settings page if the list action is
 * unavailable on the device. Returns false on non-Android (no-op).
 */
export async function openBatteryOptimizationSettings(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;

  try {
    await Linking.sendIntent(IGNORE_BATTERY_OPT_SETTINGS_ACTION);
    return true;
  } catch {
    Sentry.addBreadcrumb({
      category: 'battery-opt',
      message: 'IGNORE_BATTERY_OPTIMIZATION_SETTINGS intent failed; falling back',
      level: 'warning',
    });
    try {
      await Linking.openSettings();
      return true;
    } catch (fallbackError) {
      Sentry.captureException(fallbackError, {
        tags: { component: 'batteryOptimization' },
      });
      return false;
    }
  }
}
