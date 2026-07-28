/**
 * Pairing lifecycle + connection-health guards (BACKLOG-2203).
 *
 * Pins the wiring of the previously-DEAD pairingManager subsystem:
 *   Part 1 — auto-unpair on sign-out / account switch (the security trigger,
 *            also the BACKLOG-2224 account-switch residual);
 *   Part 2 — connection health that reflects REAL sync outcomes, derived from
 *            smsQueueService's persisted stats (NOT a duplicate timestamp),
 *            proving the health path introduces no backgroundSync<->pairingManager
 *            circular import;
 *   Part 3 — the 24h auto-unpair predicate is evaluated but INTENTIONALLY NOT
 *            armed to any destructive trigger.
 *
 * Design note (no circular import): these tests drive the REAL
 * `recordSyncAttempt` (smsQueueService) and read health back through
 * pairingManager, with `../backgroundSync` fully mocked out. smsQueueService
 * imports neither pairingManager nor backgroundSync, so the health signal flows
 * one-way smsQueueService -> pairingManager. That is exactly why wiring the dead
 * code did NOT need to import pairingManager into the sync cycle (the cycle
 * BACKLOG-2204 avoided).
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

// --- Stateful in-memory AsyncStorage (same rationale as smsQueueService.test) ---
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
const resetStore = (): void =>
  (AsyncStorage as unknown as { __reset: () => void }).__reset();

// --- Sentry breadcrumbs are no-ops in tests ---
jest.mock('@sentry/react-native', () => ({
  addBreadcrumb: jest.fn(),
  captureException: jest.fn(),
}));

// --- backgroundSync is mocked so loading pairingManager does NOT pull expo
//     task-manager / background-fetch, AND so we can assert teardown happened
//     WITHOUT the real module. (This is also what keeps the test honest about
//     the absence of a circular import: pairingManager's health path never
//     touches the real backgroundSync.) ---
jest.mock('../backgroundSync', () => ({
  stopBackgroundSync: jest.fn(async () => undefined),
}));

import { stopBackgroundSync } from '../backgroundSync';
import {
  reconcilePairingForAuthChange,
  unpairDevice,
  getConnectionStatus,
  getConsecutiveFailures,
  getLastSuccessTime,
  shouldAutoUnpair,
} from '../pairingManager';
// The REAL sync-stats writer — the source of truth for connection health.
import { recordSyncAttempt, getSyncStats } from '../smsQueueService';

const PAIRING_KEY = '@keepr/pairing';
const STATS_KEY = '@keepr/sync-stats';

async function setPaired(): Promise<void> {
  await AsyncStorage.setItem(
    PAIRING_KEY,
    JSON.stringify({
      ip: '192.168.1.5',
      port: 8765,
      secret: 'shared-secret',
      deviceName: 'Pixel 8',
    }),
  );
}

async function isPaired(): Promise<boolean> {
  return (await AsyncStorage.getItem(PAIRING_KEY)) !== null;
}

beforeEach(() => {
  resetStore();
  jest.clearAllMocks();
});

// ===========================================================================
// Part 1 — auto-unpair on sign-out / account switch (BACKLOG-2203 / 2224)
// ===========================================================================
describe('reconcilePairingForAuthChange — sign-out / account switch', () => {
  it('sign-out unpairs a paired device', async () => {
    await setPaired();

    const unpaired = await reconcilePairingForAuthChange(null, 'userA');

    expect(unpaired).toBe(true);
    expect(await isPaired()).toBe(false);
    expect(stopBackgroundSync).toHaveBeenCalledTimes(1);
  });

  it('sign-out is a no-op when NOT paired', async () => {
    const unpaired = await reconcilePairingForAuthChange(null, 'userA');

    expect(unpaired).toBe(false);
    expect(stopBackgroundSync).not.toHaveBeenCalled();
  });

  it('account switch (different user id) unpairs — forces a fresh account-match re-pair', async () => {
    await setPaired();

    const unpaired = await reconcilePairingForAuthChange('userB', 'userA');

    expect(unpaired).toBe(true);
    expect(await isPaired()).toBe(false);
    expect(stopBackgroundSync).toHaveBeenCalledTimes(1);
  });

  it('same user (token refresh) does NOT unpair', async () => {
    await setPaired();

    const unpaired = await reconcilePairingForAuthChange('userA', 'userA');

    expect(unpaired).toBe(false);
    expect(await isPaired()).toBe(true);
    expect(stopBackgroundSync).not.toHaveBeenCalled();
  });

  it('fresh sign-in (no previous user) preserves a restored pairing (app-start INITIAL_SESSION)', async () => {
    await setPaired();

    const unpaired = await reconcilePairingForAuthChange('userA', null);

    expect(unpaired).toBe(false);
    expect(await isPaired()).toBe(true);
  });

  it('already signed out (null -> null) is a no-op', async () => {
    const unpaired = await reconcilePairingForAuthChange(null, null);
    expect(unpaired).toBe(false);
  });
});

describe('unpairDevice — idempotent teardown', () => {
  it('clears pairing + all sync data + stops background sync, then is a no-op', async () => {
    await setPaired();
    // Populate real sync stats/queue through the real path.
    await recordSyncAttempt(true, 3, true);
    expect((await getSyncStats()).totalSynced).toBe(3);

    const first = await unpairDevice('manual');
    expect(first).toBe(true);
    expect(await isPaired()).toBe(false);
    // resetAllSyncData wiped stats back to defaults (streak + timestamps gone).
    const stats = await getSyncStats();
    expect(stats.totalSynced).toBe(0);
    expect(stats.lastSuccessfulSyncAt).toBeNull();
    expect(stats.consecutiveFailures).toBe(0);
    expect(stopBackgroundSync).toHaveBeenCalledTimes(1);

    // Second call: already unpaired -> no-op (no extra teardown).
    const second = await unpairDevice('manual');
    expect(second).toBe(false);
    expect(stopBackgroundSync).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// Part 2 — connection health reflects REAL sync outcomes (no circular import)
// ===========================================================================
describe('connection health reflects real sync outcomes via smsQueueService', () => {
  it('getLastSuccessTime reflects lastSuccessfulSyncAt after a reached-desktop cycle', async () => {
    expect(await getLastSuccessTime()).toBeNull();

    await recordSyncAttempt(false, 0, true); // idle cycle, desktop reached

    const stats = await getSyncStats();
    expect(await getLastSuccessTime()).toBe(stats.lastSuccessfulSyncAt);
    expect(await getLastSuccessTime()).not.toBeNull();
  });

  it('a reached-desktop cycle resets the failure streak', async () => {
    await recordSyncAttempt(false, 0, false);
    await recordSyncAttempt(false, 0, false);
    expect(await getConsecutiveFailures()).toBe(2);

    await recordSyncAttempt(false, 0, true); // reached -> reset
    expect(await getConsecutiveFailures()).toBe(0);
  });

  it('getConnectionStatus is "disconnected" when not paired', async () => {
    expect(await getConnectionStatus()).toBe('disconnected');
  });

  it('getConnectionStatus is "connected" when paired + healthy', async () => {
    await setPaired();
    await recordSyncAttempt(false, 0, true);
    expect(await getConnectionStatus()).toBe('connected');
  });

  it('getConnectionStatus becomes "degraded" only at 3+ consecutive failures', async () => {
    await setPaired();
    await recordSyncAttempt(false, 0, false);
    await recordSyncAttempt(false, 0, false);
    expect(await getConnectionStatus()).toBe('connected'); // 2 < threshold

    await recordSyncAttempt(false, 0, false);
    expect(await getConnectionStatus()).toBe('degraded'); // 3 -> degraded
  });
});

// ===========================================================================
// Part 3 — 24h auto-unpair predicate: evaluated but INTENTIONALLY NOT armed
// ===========================================================================
describe('24h auto-unpair predicate — evaluated but the timer is NOT armed', () => {
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;

  it('shouldAutoUnpair is false with no failures', async () => {
    expect(await shouldAutoUnpair()).toBe(false);
  });

  it('shouldAutoUnpair is false for a fresh (<24h) failure streak', async () => {
    await recordSyncAttempt(false, 0, false);
    const { firstFailureTime } = await getSyncStats();
    const firstMs = new Date(firstFailureTime as string).getTime();

    expect(await shouldAutoUnpair(firstMs + HOUR)).toBe(false);
  });

  it('shouldAutoUnpair becomes true after 24h of continuous failure', async () => {
    await recordSyncAttempt(false, 0, false);
    const { firstFailureTime } = await getSyncStats();
    const firstMs = new Date(firstFailureTime as string).getTime();

    expect(await shouldAutoUnpair(firstMs + DAY + 1)).toBe(true);
  });

  it('the timer is OFF: getConnectionStatus never unpairs, even when 24h-eligible', async () => {
    await setPaired();
    // Seed an eligible streak directly: 5 failures whose first is 25h old.
    await AsyncStorage.setItem(
      STATS_KEY,
      JSON.stringify({
        totalSynced: 0,
        lastSyncTime: null,
        lastSuccessfulSyncAt: null,
        syncAttempts: 5,
        successfulSyncs: 0,
        consecutiveFailures: 5,
        firstFailureTime: new Date(Date.now() - 25 * HOUR).toISOString(),
      }),
    );

    // The predicate agrees the device is eligible for auto-unpair...
    expect(await shouldAutoUnpair()).toBe(true);

    const status = await getConnectionStatus();

    // ...but nothing acts on it: status is merely "degraded" and, critically,
    // the pairing is STILL intact — no destructive auto-unpair fired.
    expect(status).toBe('degraded');
    expect(await isPaired()).toBe(true);
    expect(stopBackgroundSync).not.toHaveBeenCalled();
  });
});
