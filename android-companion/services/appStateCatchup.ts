/**
 * AppState catch-up sync (Android Companion).
 *
 * BACKLOG-2204: background-fetch is the ONLY periodic trigger the managed-Expo
 * companion has, and Android Doze / OEM battery managers throttle or kill it
 * while the phone is idle. The reliable safety net is this: whenever the user
 * brings Keepr Companion back to the foreground, immediately run a catch-up
 * sync so anything missed while backgrounded/Doze'd is captured as soon as the
 * app is opened.
 *
 * Design:
 * - Fires only on a real background/inactive -> active transition (not on the
 *   initial mount, and not on active -> active no-ops).
 * - Delegates to the existing `performSync`, which is serialised by the
 *   BACKLOG-2200 cross-context mutex — so a catch-up can never race the
 *   background task or a manual "Sync Now". On top of that we keep a local
 *   `inFlight` guard so two quick foregrounds don't even enqueue two calls, and
 *   a throttle so rapid background<->foreground toggles don't stack.
 * - `performSync` is a benign no-op when unpaired, so this is safe to run
 *   liberally; the layer that wires it (app/_layout.tsx) additionally only
 *   registers once the user is signed in + onboarded.
 *
 * The transition/guard/throttle logic is kept free of the React-Native
 * AppState singleton (via `createCatchupHandler`) so it is unit-testable.
 */

import { AppState, type AppStateStatus } from 'react-native';
import * as Sentry from '@sentry/react-native';
import { performSync } from './backgroundSync';

/**
 * Minimum spacing between AppState-triggered catch-up syncs.
 *
 * The BACKLOG-2200 mutex already guarantees correctness under overlap; this
 * throttle only avoids needless churn/log-noise when the app is toggled in and
 * out of the foreground in quick succession.
 */
export const CATCHUP_MIN_INTERVAL_MS = 30_000; // 30 seconds

interface CatchupState {
  /** True while a catch-up performSync is awaiting completion. */
  inFlight: boolean;
  /** Unix ms of the last catch-up we started (0 = none yet). */
  lastRunAt: number;
}

const state: CatchupState = { inFlight: false, lastRunAt: 0 };

/** Test-only: reset the module-level throttle/guard state between cases. */
export function __resetCatchupState(): void {
  state.inFlight = false;
  state.lastRunAt = 0;
}

/**
 * Run a foreground catch-up sync — guarded and throttled.
 *
 * - `inFlight` guard: never overlaps a catch-up already awaiting performSync
 *   (belt-and-braces on top of the 2200 mutex, which lives inside performSync).
 * - throttle: at most one catch-up per CATCHUP_MIN_INTERVAL_MS.
 *
 * @param now injectable clock (defaults to Date.now()).
 */
export async function runCatchupSync(now: number = Date.now()): Promise<void> {
  if (state.inFlight) return;
  if (state.lastRunAt !== 0 && now - state.lastRunAt < CATCHUP_MIN_INTERVAL_MS) {
    return;
  }

  state.inFlight = true;
  state.lastRunAt = now;
  try {
    await performSync();
    Sentry.addBreadcrumb({
      category: 'sync',
      message: 'AppState catch-up sync ran',
      level: 'info',
    });
  } catch (error) {
    // performSync already swallows expected sync failures into its result; a
    // throw here is unexpected. Report but never crash the foreground.
    Sentry.captureException(error, {
      tags: { component: 'appStateCatchup' },
    });
  } finally {
    state.inFlight = false;
  }
}

/**
 * Whether an AppState transition should trigger a catch-up: only when the app
 * becomes `active` from a non-active state (background / inactive).
 */
export function isForegroundTransition(
  prev: AppStateStatus,
  next: AppStateStatus,
): boolean {
  return next === 'active' && prev !== 'active';
}

/**
 * Build an AppState 'change' handler that fires a catch-up on
 * background/inactive -> active. Tracks previous state internally so it can be
 * unit-tested without the RN AppState singleton.
 *
 * @param initial the state to treat as "previous" for the first event
 *   (defaults to 'active', matching a freshly-foregrounded app).
 */
export function createCatchupHandler(
  initial: AppStateStatus = 'active',
): (next: AppStateStatus) => void {
  let prev: AppStateStatus = initial;
  return (next: AppStateStatus): void => {
    const shouldRun = isForegroundTransition(prev, next);
    prev = next;
    if (shouldRun) {
      // Fire-and-forget: runCatchupSync is self-guarding.
      void runCatchupSync();
    }
  };
}

/**
 * Subscribe the catch-up handler to the AppState singleton.
 * Returns an unsubscribe fn. Called from app/_layout.tsx once the user is
 * signed in + onboarded.
 */
export function registerAppStateCatchup(): () => void {
  const handler = createCatchupHandler(AppState.currentState);
  const subscription = AppState.addEventListener('change', handler);
  return () => subscription.remove();
}
