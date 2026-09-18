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

/**
 * Returns true if database is initialized.
 * In loading state, checks if we've passed the 'initializing-db' phase.
 *
 * Note: `deferredDbInit` has had no producer since BACKLOG-3253 deleted the
 * first-run-macOS deferral, so the branches below that read it are inert.
 *
 * KNOWN LIMIT, recorded rather than fixed here: for `status: "onboarding"` this
 * returns `true` on machine POSITION, not on a database fact. BACKLOG-3321
 * replaces the inference with a recorded fact. Four things its engineer should
 * not have to rediscover:
 *
 * 1. Every producer of `onboarding` bar one arrives via DB_INIT_COMPLETE(success).
 *    The exception is LOGIN_SUCCESS from an `unauthenticated` state produced by
 *    AUTH_PRE_VALIDATED(valid:false), which never opened the database.
 * 2. LOGOUT is a second, STRUCTURAL producer of `unauthenticated` that also drops
 *    every flag. It is only dispatched from a user action today, so it is not
 *    reachable pre-DB -- but it is one programmatic sign-out away from being so.
 * 3. The apparent second guard on this selector is inert. `OnboardingFlow.tsx`
 *    ANDs it with `(!waitingForDbInit || dbInitConfirmed)`; `waitingForDbInit`
 *    has exactly one setter, the SECURE_STORAGE_SETUP action, i.e. a Continue
 *    click on a screen that no reachable route renders since BACKLOG-3253. The
 *    conjunct is permanently true and this selector stands alone. It READS like
 *    a guard and guards nothing.
 * 4. The fact is derived in TWO independent places. `useAppStateMachine.ts`
 *    negates `deferredDbInit` across three statuses and so now returns an
 *    unconditional `true` for every state; it feeds `useAuthFlow`, NOT the
 *    ~10 components, which reach the answer through this selector. A fix applied
 *    only here leaves that one inferring exactly as before.
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
  let result: boolean;
  switch (state.status) {
    case "loading":
      // Inert since BACKLOG-3253 removed the flag's only producer.
      if (state.deferredDbInit) {
        result = false;
        break;
      }
      // DB is initialized if we're past the initializing-db phase
      result = !["checking-storage", "initializing-db"].includes(state.phase);
      break;
    case "ready":
      result = true;
      break;
    case "onboarding":
      // Inert since BACKLOG-3253 removed the flag's only producer. See the
      // KNOWN LIMIT note above: this `true` is machine position, not a fact.
      if (state.deferredDbInit) {
        result = false;
        break;
      }
      result = true;
      break;
    case "unauthenticated":
      // Inert since BACKLOG-3253 removed the flag's only producer.
      if (state.deferredDbInit) {
        result = false;
        break;
      }
      result = false;
      break;
    case "error":
      result = false;
      break;
    default:
      result = false;
  }

  return result;
}

/**
 * Returns true if DB initialization was deferred for first-time macOS users.
 *
 * BACKLOG-3253 deleted the only producer of `deferredDbInit`, so this always
 * returns false. Kept until the flag itself is removed.
 *
 * This flag is preserved through state transitions:
 * loading -> unauthenticated -> onboarding
 *
 * @param state - Current application state
 * @returns true if DB init is deferred
 */
export function selectIsDeferredDbInit(state: AppState): boolean {
  switch (state.status) {
    case "loading":
      return state.deferredDbInit === true;
    case "unauthenticated":
      return state.deferredDbInit === true;
    case "onboarding":
      return state.deferredDbInit === true;
    default:
      return false;
  }
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
