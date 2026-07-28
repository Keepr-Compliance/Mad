/**
 * Pairing Manager (Android Companion)
 *
 * Owns the companion's PAIRING lifecycle + connection-health VIEW:
 *  - unpair the device (clear pairing + sync data + stop background sync);
 *  - reconcile pairing with auth transitions (sign-out / account switch);
 *  - derive a connection-health status from real sync outcomes.
 *
 * BACKLOG-1463: Pairing screen redesign (original dormant design).
 * BACKLOG-2203: wired the previously-dead health/auto-unpair subsystem.
 *
 * ── Health data lives in smsQueueService, NOT here (BACKLOG-2203) ─────────────
 * The failure streak + last-success timestamp are persisted as part of
 * `smsQueueService.SyncStats` (`consecutiveFailures`, `firstFailureTime`,
 * `lastSuccessfulSyncAt`) and are written by the sync cycle via
 * `recordSyncAttempt`. This module only READS them (one-way
 * pairingManager -> smsQueueService). That is deliberate: it lets the sync
 * cycle record health WITHOUT importing pairingManager, which would re-create
 * the `backgroundSync <-> pairingManager` circular import that BACKLOG-2204
 * explicitly avoided. It also reconciles with 2204's staleness signal instead
 * of duplicating a competing "last success" timestamp.
 *
 * Unpair triggers (BACKLOG-2203):
 *  - On sign out:            unpair (clear pairing data) — a signed-out phone
 *                            must not keep syncing to the desktop.
 *  - On account switch:      unpair — forces a fresh pair, which re-runs the
 *                            desktop-side account-match (BACKLOG-2224 residual).
 *  - After 24h offline:      predicate available (`shouldAutoUnpair`) but the
 *                            destructive timer is INTENTIONALLY NOT ARMED — see
 *                            `shouldAutoUnpair` for the rationale.
 *
 * Storage keys:
 * - @keepr/pairing:        Stored pairing info (shared with home screen).
 * - @keepr/pairing-health: LEGACY (pre-2203) health store — no longer written;
 *                          cleared on unpair as a one-time migration cleanup.
 */

import * as Sentry from '@sentry/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { stopBackgroundSync } from './backgroundSync';
import { resetAllSyncData, getSyncStats } from './smsQueueService';
import type { SyncStats } from './smsQueueService';

// ============================================
// CONSTANTS
// ============================================

const PAIRING_STORAGE_KEY = '@keepr/pairing';

/**
 * Legacy pre-BACKLOG-2203 health store. Health now lives in
 * `smsQueueService.SyncStats`; this key is only removed on unpair so stale data
 * from an older app version cannot linger.
 */
const LEGACY_HEALTH_STORAGE_KEY = '@keepr/pairing-health';

/** Number of consecutive failures before showing the "degraded" warning banner. */
const FAILURE_WARNING_THRESHOLD = 3;

/** Milliseconds offline before the (UNARMED) 24h auto-unpair predicate trips. */
const AUTO_UNPAIR_TIMEOUT_MS = 24 * 60 * 60 * 1000;

// ============================================
// TYPES
// ============================================

/** Connection status derived from pairing + sync health. */
export type ConnectionStatus = 'connected' | 'degraded' | 'disconnected';

/** Why an unpair happened — recorded on the Sentry breadcrumb. */
export type UnpairReason = 'sign-out' | 'account-switch' | 'manual' | 'auto-unpair';

// ============================================
// HEALTH VIEW (reads smsQueueService.SyncStats)
// ============================================

/**
 * Pure predicate: does this health snapshot qualify for auto-unpair?
 *
 * True only when there is an active failure streak whose first failure is at
 * least AUTO_UNPAIR_TIMEOUT_MS (24h) old. Extracted so both `shouldAutoUnpair`
 * and the `getConnectionStatus` telemetry share one tested implementation.
 *
 * @param now injectable clock (defaults to Date.now()).
 */
function isAutoUnpairEligible(
  stats: Pick<SyncStats, 'consecutiveFailures' | 'firstFailureTime'>,
  now: number = Date.now(),
): boolean {
  if (stats.consecutiveFailures === 0) return false;
  if (!stats.firstFailureTime) return false;

  const firstFailure = new Date(stats.firstFailureTime).getTime();
  if (Number.isNaN(firstFailure)) return false;

  return now - firstFailure >= AUTO_UNPAIR_TIMEOUT_MS;
}

/**
 * Whether the device SHOULD be auto-unpaired after a prolonged (>=24h) failure
 * streak.
 *
 * ⚠️ BACKLOG-2203 DECISION — this predicate is INTENTIONALLY NOT ARMED to any
 * automatic destructive trigger. Evaluated and deliberately left off because:
 *   1. Auto-unpairing destroys the pairing and forces a full QR re-scan on the
 *      desktop — a heavy, high-friction recovery.
 *   2. A phone that merely can't reach the desktop for a day (desktop off
 *      overnight, weekend, travel, Android Doze / OEM battery killing — all
 *      made explicitly best-effort by BACKLOG-2204) is NOT a broken pairing.
 *   3. BACKLOG-2204 already makes silent background death VISIBLE (staleness
 *      banner) and self-healing (AppState catch-up on foreground) — strictly
 *      better UX than silently nuking the pairing.
 * The genuinely necessary unpair triggers are the DETERMINISTIC security ones —
 * sign-out and account switch — handled by `reconcilePairingForAuthChange`.
 *
 * The predicate is kept (and surfaced as telemetry in `getConnectionStatus`) so
 * we can measure how often it WOULD fire and so a future, gentler UX (e.g. a
 * user-confirmed re-pair prompt) can arm it without re-deriving the logic.
 *
 * @param now injectable clock (defaults to Date.now()).
 */
export async function shouldAutoUnpair(now: number = Date.now()): Promise<boolean> {
  const stats = await getSyncStats();
  return isAutoUnpairEligible(stats, now);
}

/**
 * Current connection status, derived from whether we're paired + the sync
 * failure streak.
 *
 * - connected:    paired, no (or few) recent failures.
 * - degraded:     paired, 3+ consecutive failures (warning banner).
 * - disconnected: not paired.
 *
 * Read-only. It NEVER unpairs — even when `isAutoUnpairEligible` is true it only
 * records the eligibility as telemetry (BACKLOG-2203: the 24h timer is unarmed).
 */
export async function getConnectionStatus(): Promise<ConnectionStatus> {
  const pairing = await AsyncStorage.getItem(PAIRING_STORAGE_KEY);
  if (!pairing) {
    return 'disconnected';
  }

  const stats = await getSyncStats();
  const status: ConnectionStatus =
    stats.consecutiveFailures >= FAILURE_WARNING_THRESHOLD
      ? 'degraded'
      : 'connected';

  Sentry.addBreadcrumb({
    category: 'pairing',
    message: `Connection status: ${status}`,
    level: status === 'degraded' ? 'warning' : 'info',
    data: {
      consecutiveFailures: stats.consecutiveFailures,
      // Telemetry only — we do NOT act on this (24h timer intentionally off).
      autoUnpairEligible: isAutoUnpairEligible(stats),
    },
  });

  return status;
}

/**
 * Current consecutive-failure count, for display / banners.
 */
export async function getConsecutiveFailures(): Promise<number> {
  const stats = await getSyncStats();
  return stats.consecutiveFailures;
}

/**
 * ISO timestamp of the last sync cycle that successfully reached the desktop.
 *
 * BACKLOG-2203: re-pointed to `SyncStats.lastSuccessfulSyncAt` (the 2204
 * staleness signal). Previously this read the dead `@keepr/pairing-health`
 * store, which was never written — so `HelpModal`'s "Last sync" diagnostic
 * always showed nothing. Signature is unchanged (`Promise<string | null>`).
 */
export async function getLastSuccessTime(): Promise<string | null> {
  const stats = await getSyncStats();
  return stats.lastSuccessfulSyncAt;
}

// ============================================
// UNPAIR
// ============================================

/**
 * Unpair the device: clear pairing info + all sync data + stop background sync.
 *
 * Idempotent and safe when NOT paired — returns `false` and does nothing (no
 * background-sync teardown, no breadcrumb noise) if there is no stored pairing.
 * `resetAllSyncData()` clears the queue, cursor, sync stats (including the
 * failure streak) and the sync lock, so a subsequent fresh pair starts clean.
 *
 * @param reason why we're unpairing — recorded for telemetry.
 * @returns true if the device was paired and is now unpaired; false if it was
 *   already unpaired (no-op).
 */
export async function unpairDevice(reason: UnpairReason): Promise<boolean> {
  const pairing = await AsyncStorage.getItem(PAIRING_STORAGE_KEY);
  if (!pairing) {
    return false; // Not paired — idempotent no-op.
  }

  Sentry.addBreadcrumb({
    category: 'pairing',
    message: `Device unpaired (${reason})`,
    level: 'warning',
  });

  await AsyncStorage.removeItem(PAIRING_STORAGE_KEY);
  // One-time cleanup of the legacy pre-2203 health store (harmless if absent).
  await AsyncStorage.removeItem(LEGACY_HEALTH_STORAGE_KEY);
  await resetAllSyncData();

  try {
    await stopBackgroundSync();
  } catch {
    // Non-fatal — the background task may not be registered.
  }

  return true;
}

/**
 * Reconcile the pairing with an auth-state transition (BACKLOG-2203 / 2224).
 *
 * Called from the app's `onAuthStateChange` subscription with the new user id
 * and the previous one. Unpairs when the user context changes in a way that
 * must not carry a pairing across it:
 *   - SIGN-OUT      (userId became null while previously signed in) -> unpair.
 *   - ACCOUNT SWITCH (userId changed to a DIFFERENT non-null id)    -> unpair,
 *     which forces a fresh pair and re-runs the desktop account-match (the
 *     BACKLOG-2224 residual: a phone that signs into a different account must
 *     not keep the old pairing).
 * A fresh sign-in (previousUserId null — e.g. app start restoring a session),
 * the same user, or a token refresh leave the pairing untouched.
 *
 * Idempotent + safe when not paired (delegates to `unpairDevice`).
 *
 * @returns true if it unpaired the device, false otherwise.
 */
export async function reconcilePairingForAuthChange(
  userId: string | null,
  previousUserId: string | null,
): Promise<boolean> {
  // Sign-out: we had an authenticated user and now we don't.
  if (userId === null) {
    if (previousUserId === null) {
      return false; // Was already signed out — nothing to reconcile.
    }
    return unpairDevice('sign-out');
  }

  // Account switch: a different non-null user than before.
  if (previousUserId !== null && userId !== previousUserId) {
    return unpairDevice('account-switch');
  }

  // Fresh sign-in / restored session / same user / token refresh — keep pairing.
  return false;
}
