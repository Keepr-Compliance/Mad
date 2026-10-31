/**
 * Database State Selectors
 *
 * Pure selector functions for deriving database-related state from AppState.
 * These selectors enable hooks to query state machine state without
 * coupling to the specific state structure.
 *
 * @module appCore/state/machine/selectors/databaseSelectors
 */

import type { AppState } from "../types";
import { isDatabaseInitialized, recordedDatabase } from "../databaseState";

/**
 * Returns true if the local database is known to be open.
 *
 * BACKLOG-3321: reads the database fact the machine RECORDS
 * (`databaseState.ts`), not the machine's position. Before this, any
 * `onboarding` or `ready` state read as open, which was false on the pre-auth
 * route that keeps the database closed (`AUTH_PRE_VALIDATED` with
 * `offline_grace_expired` / `session_clear_failed`, then a sign-in).
 *
 * `"unknown"` is false. An `error` state answers with the state it was raised
 * from.
 *
 * @param state - Current application state
 * @returns true if database is initialized
 *
 * @example
 * ```ts
 * const isDbReady = selectIsDatabaseInitialized(state);
 * if (!isDbReady) {
 *   // Show loading or wait for initialization
 * }
 * ```
 */
export function selectIsDatabaseInitialized(state: AppState): boolean {
  return isDatabaseInitialized(recordedDatabase(state));
}

/**
 * Returns true if currently checking secure storage.
 * This is the first phase of initialization.
 *
 * @param state - Current application state
 * @returns true if currently in checking-storage phase
 */
export function selectIsCheckingSecureStorage(state: AppState): boolean {
  return state.status === "loading" && state.phase === "checking-storage";
}

/**
 * Returns true if currently initializing database.
 * This may trigger OS prompts on macOS for keychain access.
 *
 * @param state - Current application state
 * @returns true if currently in initializing-db phase
 */
export function selectIsInitializingDatabase(state: AppState): boolean {
  return state.status === "loading" && state.phase === "initializing-db";
}

/**
 * Returns true if currently loading authentication state.
 *
 * @param state - Current application state
 * @returns true if currently in loading-auth phase
 */
export function selectIsLoadingAuth(state: AppState): boolean {
  return state.status === "loading" && state.phase === "loading-auth";
}

/**
 * Returns true if currently loading user data.
 * This is the final phase before entering ready or onboarding state.
 *
 * @param state - Current application state
 * @returns true if currently in loading-user-data phase
 */
export function selectIsLoadingUserData(state: AppState): boolean {
  return state.status === "loading" && state.phase === "loading-user-data";
}
