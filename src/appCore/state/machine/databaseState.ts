/**
 * Local database state — one recorded fact, replacing a derivation.
 *
 * BACKLOG-3321. Before this module, "is the local database open?" was answered
 * by deriving it from the machine's position: any `onboarding` or `ready`
 * state, and any `loading` phase after `initializing-db`, read as open. That is
 * false on the pre-auth route that keeps the database closed
 * (`AUTH_PRE_VALIDATED` with `offline_grace_expired` / `session_clear_failed`):
 * the user signs in, reaches onboarding or the dashboard, and the selector says
 * the database is open when it was never opened.
 *
 * The machine now RECORDS what happened to the database on every state that
 * can follow an open (loading, unauthenticated, onboarding, ready), and the
 * selector reads that record.
 *
 * Template: `fdaState.ts` (`const exhaustive: never`).
 *
 * @module appCore/state/machine/databaseState
 */

import type { AppState } from "./types";

/**
 * What the renderer knows about the local database.
 */
export type DatabaseState =
  /**
   * `DB_INIT_COMPLETE(success)` was received, or main reported the database
   * open (`system:is-database-initialized` -> `{ success: true, initialized: true }`).
   */
  | "initialized"
  /**
   * Main reported the database closed (`{ success: true, initialized: false }`).
   */
  | "not-initialized"
  /**
   * Nothing has said either way: the initial state, or a probe that failed.
   *
   * Has real producers and must not be folded into either answer: after a
   * renderer reload (`main.ts` render-process-gone / unresponsive -> Reload)
   * the database is still open in main while the renderer starts fresh.
   */
  | "unknown";

/**
 * THE BOUNDARY QUESTION: may the UI treat the database as open?
 *
 * Only an observed open answers yes. `"unknown"` is false: the consumers
 * (AppShell spinner, Secure Storage Continue) must not run queries against a
 * database nobody has seen open.
 */
export function isDatabaseInitialized(db: DatabaseState): boolean {
  switch (db) {
    case "initialized":
      return true;
    case "not-initialized":
      return false;
    case "unknown":
      return false;
    default: {
      // Compile-time exhaustiveness. At runtime a value outside the union (a
      // cast fixture, a malformed state) is not an observed open.
      const exhaustive: never = db;
      void exhaustive;
      return false;
    }
  }
}

/**
 * Translate the `system:is-database-initialized` IPC result.
 *
 * The result is an OBJECT, `{ success, initialized }`
 * (`electron/handlers/systemHandlers.ts`). Reading it as a boolean makes every
 * resolved call "open" — `{ success: true, initialized: false }` is truthy.
 * A rejected or missing result (caller passes `null`) is `"unknown"`.
 */
export function databaseFromProbe(
  result: { success: boolean; initialized?: boolean } | null | undefined
): DatabaseState {
  if (!result || result.success !== true) return "unknown";
  if (result.initialized === true) return "initialized";
  if (result.initialized === false) return "not-initialized";
  return "unknown";
}

/**
 * The database fact recorded on a state.
 *
 * An `error` state records nothing of its own: the database did not change by
 * failing, so the answer is the state the error was raised from. Errors raised
 * from an error nest, so this recurses. An error with no `previousState` is
 * `"unknown"`.
 */
export function recordedDatabase(state: AppState): DatabaseState {
  switch (state.status) {
    case "loading":
    case "unauthenticated":
    case "onboarding":
    case "ready":
      return state.database;
    case "error":
      return state.previousState
        ? recordedDatabase(state.previousState)
        : "unknown";
    default: {
      const exhaustive: never = state;
      void exhaustive;
      return "unknown";
    }
  }
}
