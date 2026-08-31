/**
 * Sync run DEPTH — the options a caller uses to say how much of the backlog one
 * `performSync` run should get through (BACKLOG-3005).
 *
 * ## Why this is its own leaf module
 *
 * These live apart from `backgroundSync.ts` because that module has heavy
 * import-time side effects: `TaskManager.defineTask` runs at load, and its
 * dependency graph reaches AsyncStorage and the Supabase client. Any test that
 * mocks `backgroundSync` and then wants the REAL cycle ceiling had to call
 * `jest.requireActual('./backgroundSync')`, which re-instantiates all of that
 * and fails under jest with "Native module is null".
 *
 * The alternative — each mock re-declaring the number as a literal — is worse,
 * and it has already bitten twice on this item: `first-sync.test.tsx` omitted
 * the constant entirely, so the screen passed `maxCycles: undefined` (depth 1)
 * inside its own suite, neutralising the very binding under test; and
 * `appStateCatchup.test.ts` had the same hole. A test asserting against a
 * literal it wrote itself proves nothing about the value the app ships.
 *
 * This module imports NOTHING, so `jest.requireActual('./syncDepth')` is free.
 *
 * @module services/syncDepth
 */

/**
 * How many cycles ONE opted-in run may execute. ~10,000 messages per tap at
 * `MAX_QUEUE_SIZE = 500`.
 *
 * A ceiling, not a target: it exists so a pathological loop terminates, and
 * every real drain stops earlier on "the read was not truncated".
 */
export const MAX_SYNC_CYCLES_PER_RUN = 20;

/** Options for one `performSync` run. */
export interface SyncRunOptions {
  /**
   * BACKLOG-3005. DEFAULT 1. Continuation is opt-in so that every existing
   * caller keeps byte-identical behaviour without being edited.
   */
  maxCycles?: number;
  /** BACKLOG-3017. Set only by the manual "Sync Now" button. */
  userInitiated?: boolean;
}
