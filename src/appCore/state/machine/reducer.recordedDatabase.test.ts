/**
 * BACKLOG-3321 controls C1, C2, C3a/b/c: the machine records what happened to
 * the local database, and selectIsDatabaseInitialized reads that record.
 *
 * Fixture provenance (transcribed from the producers, not invented):
 * - AUTH_PRE_VALIDATED: preAuthValidationHandler.ts returns
 *   `{ valid: false, reason: "session_clear_failed" }` and
 *   `{ valid: false, reason: "offline_grace_expired" }` -- the two reasons
 *   reducer.ts keeps closed. `database` is what LoadingOrchestrator Phase 1.5
 *   adds from `system:is-database-initialized` -> databaseFromProbe.
 *   Reachability at HEAD: offline_grace_expired is reached only through the
 *   pre-auth handler's catch (a throw inside its try with the last server
 *   check older than the grace window); its offline branch is dead until
 *   BACKLOG-3691. Not producible on demand by a user at HEAD.
 * - LOGIN_SUCCESS: useLoginHandlers.ts dispatchLoginSuccess, the only
 *   producer -- `platform.hasIPhone` is always false and `isNewUser` is always
 *   present.
 * - USER_DATA_LOADED: the object LoadingOrchestrator loadUserData() returns,
 *   dispatched with `user` and `platform`.
 * - DB_INIT_COMPLETE(success): LoadingOrchestrator Phase 2 after the open
 *   that BACKLOG-3555 routes a closed-route sign-in through.
 * - Normal route: INITIAL_APP_STATE -> STORAGE_CHECKED -> AUTH_PRE_VALIDATED
 *   (valid) -> DB_INIT_COMPLETE(success) -> AUTH_LOADED(no user) = Login.
 */
import { appStateReducer } from "./reducer";
import { selectIsDatabaseInitialized } from "./selectors/databaseSelectors";
import { INITIAL_APP_STATE } from "./types";
import type { AppAction, AppState, PlatformInfo, User, UserData } from "./types";
import type { AccountSetup } from "./routing/routeAccount";

const user: User = { id: "user-123", email: "test@example.com", displayName: "Test User", avatarUrl: undefined };

// useLoginHandlers.ts dispatchLoginSuccess: hasIPhone is always false.
const macLogin: PlatformInfo = { isMacOS: true, isWindows: false, hasIPhone: false };
const winLogin: PlatformInfo = { isMacOS: false, isWindows: true, hasIPhone: false };

function loginSuccess(platform: PlatformInfo, isNewUser: boolean): AppAction {
  return { type: "LOGIN_SUCCESS", user, platform, isNewUser };
}

function userData(setup: AccountSetup, platform: PlatformInfo): UserData {
  return {
    phoneType: null,
    hasCompletedEmailOnboarding: false,
    hasEmailConnected: false,
    hasRecordedEmailProvider: false,
    needsDriverSetup: false,
    fda: platform.isMacOS ? "not-asked" : "not-applicable",
    setup,
    contactSourceAnswered: false,
  };
}

function userDataLoaded(setup: AccountSetup, platform: PlatformInfo): AppAction {
  return {
    type: "USER_DATA_LOADED",
    data: userData(setup, platform),
    user,
    platform,
  } as unknown as AppAction;
}

function run(start: AppState, actions: AppAction[]): AppState[] {
  let s = start;
  const seen: AppState[] = [];
  for (const a of actions) {
    s = appStateReducer(s, a as never);
    seen.push(s);
  }
  return seen;
}

function last(states: AppState[]): AppState {
  return states[states.length - 1];
}

/** INITIAL_APP_STATE -> validating-auth, as the orchestrator drives it. */
function validating(): AppState {
  return appStateReducer(INITIAL_APP_STATE, { type: "STORAGE_CHECKED", hasKeyStore: true } as never);
}

/** Login screen after a normal start: the database was opened. */
function normalLogin(): AppState {
  return last(
    run(validating(), [
      { type: "AUTH_PRE_VALIDATED", valid: true } as AppAction,
      { type: "DB_INIT_COMPLETE", success: true } as AppAction,
      { type: "AUTH_LOADED", user: null, isNewUser: false, platform: macLogin } as AppAction,
    ])
  );
}

/** Login screen on the closed pre-auth route, main reporting the DB closed. */
function closedLogin(reason: "offline_grace_expired" | "session_clear_failed"): AppState {
  return last(
    run(validating(), [
      { type: "AUTH_PRE_VALIDATED", valid: false, reason, database: "not-initialized" } as AppAction,
    ])
  );
}

const CLOSED_REASONS = ["offline_grace_expired", "session_clear_failed"] as const;
const PLATFORMS: Array<[string, PlatformInfo]> = [["mac", macLogin], ["win", winLogin]];
const SETUPS: Array<[AccountSetup, "onboarding" | "ready"]> = [["not-finished", "onboarding"], ["finished", "ready"]];

const dbOpened = { type: "DB_INIT_COMPLETE", success: true } as AppAction;

// BACKLOG-3555: a sign-in on the closed route opens the database before user
// data loads, so the account reaches onboarding / ready with it open.
describe("BACKLOG-3321 C1 (rewritten for BACKLOG-3555): closed pre-auth route reads closed until the sign-in opens it", () => {
  const cases: Array<[string, (typeof CLOSED_REASONS)[number], PlatformInfo, AccountSetup, string]> = [];
  for (const reason of CLOSED_REASONS) {
    for (const [pName, platform] of PLATFORMS) {
      for (const [setup, dest] of SETUPS) {
        cases.push([`${reason} / ${pName} / ${setup}`, reason, platform, setup, dest]);
      }
    }
  }
  it.each(cases)("%s", (_label, reason, platform, setup, dest) => {
    const states = [
      closedLogin(reason),
      ...run(closedLogin(reason), [loginSuccess(platform, false), dbOpened, userDataLoaded(setup, platform)]),
    ];
    expect(states.map((s) => s.status)).toEqual(["unauthenticated", "loading", "loading", dest]);
    expect(states[1]).toMatchObject({ phase: "initializing-db", user, platform });
    expect(states[2]).toMatchObject({ phase: "loading-user-data", user, platform });
    expect(states.map((s) => selectIsDatabaseInitialized(s))).toEqual([false, false, true, true]);
  });

  it("no probe answer (database omitted) is recorded as unknown, read as closed", () => {
    const [s1] = run(validating(), [
      { type: "AUTH_PRE_VALIDATED", valid: false, reason: "session_clear_failed" } as AppAction,
    ]);
    expect(s1).toEqual({ status: "unauthenticated", reason: "session_clear_failed", database: "unknown" });
    expect(selectIsDatabaseInitialized(s1)).toBe(false);
  });

  it("a renderer reload (main reports open) is recorded as open", () => {
    const [s1] = run(validating(), [
      { type: "AUTH_PRE_VALIDATED", valid: false, reason: "offline_grace_expired", database: "initialized" } as AppAction,
    ]);
    expect(selectIsDatabaseInitialized(s1)).toBe(true);
  });
});

describe("BACKLOG-3321 C2: normal route reads open from DB_INIT_COMPLETE on", () => {
  const cases: Array<[string, PlatformInfo, AccountSetup, string]> = [];
  for (const [pName, platform] of PLATFORMS) {
    for (const [setup, dest] of SETUPS) {
      cases.push([`${pName} / ${setup}`, platform, setup, dest]);
    }
  }
  it.each(cases)("%s", (_label, platform, setup, dest) => {
    const states = run(validating(), [
      { type: "AUTH_PRE_VALIDATED", valid: true } as AppAction,
      { type: "DB_INIT_COMPLETE", success: true } as AppAction,
      { type: "AUTH_LOADED", user, isNewUser: false, platform } as AppAction,
      userDataLoaded(setup, platform),
    ]);
    expect(states.map((s) => s.status)).toEqual(["loading", "loading", "loading", dest]);
    expect(states.map((s) => selectIsDatabaseInitialized(s))).toEqual([false, true, true, true]);
  });

  it("a failed open is a recoverable error that reads closed, and RETRY returns to initializing-db", () => {
    const states = run(validating(), [
      { type: "AUTH_PRE_VALIDATED", valid: true } as AppAction,
      { type: "DB_INIT_COMPLETE", success: false, error: "boom" } as AppAction,
      { type: "RETRY" } as AppAction,
    ]);
    const [, err, retried] = states;
    expect(err.status).toBe("error");
    if (err.status === "error") {
      expect(err.error.code).toBe("DB_INIT_FAILED");
      expect(err.recoverable).toBe(true);
    }
    expect(selectIsDatabaseInitialized(err)).toBe(false);
    expect(retried).toMatchObject({ status: "loading", phase: "initializing-db" });
  });
});

describe("BACKLOG-3321 C3: LOGOUT carries the recorded database state", () => {
  // BACKLOG-3555: the closed-route sign-in opened the database, so LOGOUT
  // carries "initialized" and the next sign-in does not open again.
  it("C3a: closed route -> sign in (opens) -> onboarding -> LOGOUT -> sign in -> onboarding reads open", () => {
    const onboarding = last(
      run(closedLogin("offline_grace_expired"), [
        loginSuccess(macLogin, false),
        dbOpened,
        userDataLoaded("not-finished", macLogin),
      ])
    );
    expect(onboarding.status).toBe("onboarding");
    expect(selectIsDatabaseInitialized(onboarding)).toBe(true);
    const states = run(onboarding, [
      { type: "LOGOUT" } as AppAction,
      loginSuccess(macLogin, false),
      userDataLoaded("not-finished", macLogin),
    ]);
    expect(states.map((s) => s.status)).toEqual(["unauthenticated", "loading", "onboarding"]);
    expect(states[1]).toMatchObject({ phase: "loading-user-data" });
    expect(states.map((s) => selectIsDatabaseInitialized(s))).toEqual([true, true, true]);
  });

  it("C3b: normal onboarding -> LOGOUT -> sign in -> onboarding reads open", () => {
    const onboarding = last(
      run(normalLogin(), [loginSuccess(macLogin, false), userDataLoaded("not-finished", macLogin)])
    );
    expect(onboarding.status).toBe("onboarding");
    const states = run(onboarding, [
      { type: "LOGOUT" } as AppAction,
      loginSuccess(macLogin, false),
      userDataLoaded("not-finished", macLogin),
    ]);
    expect(states.map((s) => s.status)).toEqual(["unauthenticated", "loading", "onboarding"]);
    expect(states.map((s) => selectIsDatabaseInitialized(s))).toEqual([true, true, true]);
  });

  // R4: Sign out on the "Couldn't load your account settings" screen
  // (LoadingOrchestrator dispatches LOGOUT from status "error").
  it("C3c: normal route -> account setup unreadable -> Sign out -> sign in -> ready reads open", () => {
    const err = last(run(normalLogin(), [loginSuccess(macLogin, false), userDataLoaded("unknown", macLogin)]));
    expect(err.status).toBe("error");
    if (err.status === "error") expect(err.error.code).toBe("ACCOUNT_SETUP_UNAVAILABLE");
    const states = run(err, [
      { type: "LOGOUT" } as AppAction,
      loginSuccess(macLogin, false),
      userDataLoaded("finished", macLogin),
    ]);
    expect(states.map((s) => s.status)).toEqual(["unauthenticated", "loading", "ready"]);
    expect(states.map((s) => selectIsDatabaseInitialized(s))).toEqual([true, true, true]);
  });

  it("C3c mirror: closed route -> sign in (opens) -> account setup unreadable -> Sign out -> sign in -> ready reads open", () => {
    const err = last(
      run(closedLogin("session_clear_failed"), [
        loginSuccess(winLogin, false),
        dbOpened,
        userDataLoaded("unknown", winLogin),
      ])
    );
    expect(err.status).toBe("error");
    const states = run(err, [
      { type: "LOGOUT" } as AppAction,
      loginSuccess(winLogin, false),
      userDataLoaded("finished", winLogin),
    ]);
    expect(states.map((s) => s.status)).toEqual(["unauthenticated", "loading", "ready"]);
    expect(states[1]).toMatchObject({ phase: "loading-user-data" });
    expect(states.map((s) => selectIsDatabaseInitialized(s))).toEqual([true, true, true]);
  });

  it("C3c nested: an error raised from an error still answers with the original state", () => {
    const err = last(run(normalLogin(), [loginSuccess(macLogin, false), userDataLoaded("unknown", macLogin)]));
    const nested = appStateReducer(err, {
      type: "ERROR",
      error: { code: "UNKNOWN_ERROR", message: "again" },
    } as never);
    expect(nested.status).toBe("error");
    const out = appStateReducer(nested, { type: "LOGOUT" } as never);
    expect(selectIsDatabaseInitialized(out)).toBe(true);
  });
});
