/**
 * Battery-optimization prompt + deep link (BACKLOG-2204).
 *
 * Pins the GUARDED prompt decision (only nags when genuinely appropriate) and
 * the Android-only settings deep link (with fallback).
 */

// Minimal react-native mock so we can flip Platform.OS and observe the intents.
jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  Linking: { sendIntent: jest.fn(), openSettings: jest.fn() },
}));
jest.mock('@sentry/react-native', () => ({
  addBreadcrumb: jest.fn(),
  captureException: jest.fn(),
}));
// Stateful in-memory AsyncStorage (same pattern as the other service tests).
jest.mock('@react-native-async-storage/async-storage', () => {
  let store: Record<string, string> = {};
  return {
    __esModule: true,
    default: {
      getItem: jest.fn(async (k: string) => (k in store ? store[k] : null)),
      setItem: jest.fn(async (k: string, v: string) => {
        store[k] = v;
      }),
      removeItem: jest.fn(async (k: string) => {
        delete store[k];
      }),
      __reset: () => {
        store = {};
      },
    },
  };
});

import { Platform, Linking } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Sentry from '@sentry/react-native';
import {
  shouldPromptBatteryOptimization,
  openBatteryOptimizationSettings,
  getBatteryOptPromptDismissed,
  setBatteryOptPromptDismissed,
  type BatteryOptPromptInput,
} from '../batteryOptimization';
import type { SyncFreshness } from '../syncStaleness';

const mockSendIntent = Linking.sendIntent as jest.MockedFunction<
  typeof Linking.sendIntent
>;
const mockOpenSettings = Linking.openSettings as jest.MockedFunction<
  typeof Linking.openSettings
>;
const resetStore = (): void =>
  (AsyncStorage as unknown as { __reset: () => void }).__reset();

// Mutable Platform.OS handle for per-test overrides.
const setPlatform = (os: string): void => {
  (Platform as unknown as { OS: string }).OS = os;
};

const STALE: SyncFreshness = { status: 'stale', ageMs: 4 * 3_600_000 };
const FRESH: SyncFreshness = { status: 'fresh', ageMs: 60_000 };
const NEVER: SyncFreshness = { status: 'never', ageMs: null };

/** A fully "appropriate to prompt" input; individual tests override one field. */
const okInput = (
  over: Partial<BatteryOptPromptInput> = {},
): BatteryOptPromptInput => ({
  platformOS: 'android',
  paired: true,
  backgroundSyncEnabled: true,
  dismissed: false,
  freshness: STALE,
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  resetStore();
  setPlatform('android');
  mockSendIntent.mockResolvedValue(undefined);
  mockOpenSettings.mockResolvedValue(undefined);
});

describe('shouldPromptBatteryOptimization', () => {
  it('is true only when Android + paired + bg-sync on + not dismissed + stale', () => {
    expect(shouldPromptBatteryOptimization(okInput())).toBe(true);
  });

  it('is false on non-Android', () => {
    expect(shouldPromptBatteryOptimization(okInput({ platformOS: 'ios' }))).toBe(
      false,
    );
  });

  it('is false when not paired', () => {
    expect(shouldPromptBatteryOptimization(okInput({ paired: false }))).toBe(
      false,
    );
  });

  it('is false when background sync is disabled', () => {
    expect(
      shouldPromptBatteryOptimization(okInput({ backgroundSyncEnabled: false })),
    ).toBe(false);
  });

  it('is false when already dismissed', () => {
    expect(shouldPromptBatteryOptimization(okInput({ dismissed: true }))).toBe(
      false,
    );
  });

  it('is false when sync is fresh or never (no evidence of a problem)', () => {
    expect(shouldPromptBatteryOptimization(okInput({ freshness: FRESH }))).toBe(
      false,
    );
    expect(shouldPromptBatteryOptimization(okInput({ freshness: NEVER }))).toBe(
      false,
    );
  });
});

describe('openBatteryOptimizationSettings', () => {
  it('returns false and sends no intent on non-Android', async () => {
    setPlatform('ios');
    await expect(openBatteryOptimizationSettings()).resolves.toBe(false);
    expect(mockSendIntent).not.toHaveBeenCalled();
  });

  it('sends the battery-optimization settings intent on Android', async () => {
    await expect(openBatteryOptimizationSettings()).resolves.toBe(true);
    expect(mockSendIntent).toHaveBeenCalledWith(
      'android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS',
    );
    expect(mockOpenSettings).not.toHaveBeenCalled();
  });

  it('falls back to the app settings page if the intent is unavailable', async () => {
    mockSendIntent.mockRejectedValueOnce(new Error('no activity'));
    await expect(openBatteryOptimizationSettings()).resolves.toBe(true);
    expect(mockOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('returns false and reports if both the intent and the fallback fail', async () => {
    mockSendIntent.mockRejectedValueOnce(new Error('no activity'));
    mockOpenSettings.mockRejectedValueOnce(new Error('nope'));
    await expect(openBatteryOptimizationSettings()).resolves.toBe(false);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });
});

describe('dismissal persistence', () => {
  it('defaults to not-dismissed', async () => {
    await expect(getBatteryOptPromptDismissed()).resolves.toBe(false);
  });

  it('round-trips a dismissal', async () => {
    await setBatteryOptPromptDismissed(true);
    await expect(getBatteryOptPromptDismissed()).resolves.toBe(true);
  });
});
