/**
 * BACKLOG-3555 controls P-NEW, P-FAIL, P-KEEP, P-LOGOUT: a fresh sign-in on the
 * closed-database pre-auth route opens the database first, as the user who
 * just signed in, and only then loads user data.
 *
 * Fixture provenance (transcribed from the producers, not invented):
 * - AUTH_PRE_VALIDATED reasons: electron/handlers/preAuthValidationHandler.ts
 *   :184 `{ valid: false, reason: "session_clear_failed" }` and :255
 *   `{ valid: false, reason: "offline_grace_expired" }`. `database` is what
 *   LoadingOrchestrator.tsx probeDatabase (:75-84) adds: databaseFromProbe of
 *   `system:is-database-initialized` ("not-initialized" when main reports
 *   closed, "initialized" after a renderer reload), "unknown" when the call
 *   rejects or the bridge is missing.
 * - LOGIN_SUCCESS: src/appCore/state/flows/auth/useLoginHandlers.ts:44-46,
 *   the only producer -- `platform.hasIPhone` is always false and `isNewUser`
 *   is always present.
 * - USER_DATA_LOADED: the BACKLOG-3321 C1 shape (reducer.recordedDatabase.test.ts),
 *   the object LoadingOrchestrator loadUserData() returns.
 * - DB_INIT_COMPLETE(false): LoadingOrchestrator Phase 2 on a failed open.
 */
import { appStateReducer } from "./reducer";
import { selectIsDatabaseInitialized } from "./selectors/databaseSelectors";
import { INITIAL_APP_STATE } from "./types";
import type { AppAction, AppState, PlatformInfo, User, UserData } from "./types";
import type { AccountSetup } from "./routing/routeAccount";

const user: User = { id: "user-123", email: "test@example.com", displayName: "Test User", avatarUrl: undefined };
const mac: PlatformInfo = { isMacOS: true, isWindows: false, hasIPhone: false };
const win: PlatformInfo = { isMacOS: false, isWindows: true, hasIPhone: false };
const login = (p: PlatformInfo): AppAction => ({ type: "LOGIN_SUCCESS", user, platform: p, isNewUser: false });
const data = (setup: AccountSetup, p: PlatformInfo): UserData => ({
  phoneType: null, hasCompletedEmailOnboarding: false, hasEmailConnected: false, hasRecordedEmailProvider: false,
  needsDriverSetup: false, fda: p.isMacOS ? "not-asked" : "not-applicable", setup, contactSourceAnswered: false,
});
const loaded = (setup: AccountSetup, p: PlatformInfo): AppAction =>
  ({ type: "USER_DATA_LOADED", data: data(setup, p), user, platform: p } as unknown as AppAction);
const R = (s: AppState, a: AppAction) => appStateReducer(s, a as never);
const validating = () => R(INITIAL_APP_STATE, { type: "STORAGE_CHECKED", hasKeyStore: true } as never);
const closedLogin = (reason: string, database: string) =>
  R(validating(), { type: "AUTH_PRE_VALIDATED", valid: false, reason, database } as unknown as AppAction);
const normalLogin = () => {
  let s = R(validating(), { type: "AUTH_PRE_VALIDATED", valid: true } as AppAction);
  s = R(s, { type: "DB_INIT_COMPLETE", success: true } as AppAction);
  return R(s, { type: "AUTH_LOADED", user: null, isNewUser: false, platform: mac } as AppAction);
};

const cases: Array<[string, string, string, PlatformInfo, AccountSetup, string]> = [];
for (const reason of ["offline_grace_expired", "session_clear_failed"])
  for (const db of ["not-initialized", "unknown"])
    for (const [pn, p] of [["mac", mac], ["win", win]] as const)
      for (const [setup, dest] of [["not-finished", "onboarding"], ["finished", "ready"]] as const)
        cases.push([`${reason}/${db}/${pn}/${setup}`, reason, db, p, setup, dest]);

describe("P-NEW: closed-route sign-in opens the DB, keeps the signed-in user", () => {
  it.each(cases)("%s", (_l, reason, db, p, setup, dest) => {
    const s1 = R(closedLogin(reason, db), login(p));
    expect(s1).toMatchObject({ status: "loading", phase: "initializing-db", user, platform: p });
    const s2 = R(s1, { type: "DB_INIT_COMPLETE", success: true } as AppAction);
    expect(s2).toMatchObject({ status: "loading", phase: "loading-user-data", user, platform: p, database: "initialized" });
    const s3 = R(s2, loaded(setup, p));
    expect(s3.status).toBe(dest);
    expect(selectIsDatabaseInitialized(s3)).toBe(true);
  });
});

describe("P-FAIL: failed open on this route -> recoverable error; RETRY keeps the user", () => {
  it("error then RETRY", () => {
    const s1 = R(closedLogin("offline_grace_expired", "not-initialized"), login(mac));
    const e = R(s1, { type: "DB_INIT_COMPLETE", success: false, error: "x" } as AppAction);
    expect(e).toMatchObject({ status: "error", recoverable: true });
    const r = R(e, { type: "RETRY" } as AppAction);
    expect(r).toMatchObject({ status: "loading", phase: "initializing-db", user, platform: mac });
    expect(selectIsDatabaseInitialized(r)).toBe(false);
  });
});

describe("P-KEEP: routes that must not change", () => {
  it("normal Login -> LOGIN_SUCCESS goes straight to loading-user-data", () => {
    const s = R(normalLogin(), login(mac));
    expect(s).toMatchObject({ status: "loading", phase: "loading-user-data", database: "initialized" });
  });
  it("renderer reload (probe says initialized) -> loading-user-data, no second open", () => {
    const s = R(closedLogin("offline_grace_expired", "initialized"), login(win));
    expect(s).toMatchObject({ status: "loading", phase: "loading-user-data", database: "initialized" });
  });
  it("normal startup open (no user) still goes to loading-auth", () => {
    const s = R(R(validating(), { type: "AUTH_PRE_VALIDATED", valid: true } as AppAction), { type: "DB_INIT_COMPLETE", success: true } as AppAction);
    expect(s).toMatchObject({ status: "loading", phase: "loading-auth", database: "initialized" });
    expect((s as { user?: User }).user).toBeUndefined();
  });
});

describe("P-LOGOUT: a failed open, sign-out, then a new sign-in opens again", () => {
  it("closed -> LOGIN_SUCCESS -> DB_INIT_COMPLETE(false) -> LOGOUT -> LOGIN_SUCCESS -> initializing-db", () => {
    const s1 = R(closedLogin("session_clear_failed", "not-initialized"), login(win));
    const e = R(s1, { type: "DB_INIT_COMPLETE", success: false, error: "x" } as AppAction);
    expect(e).toMatchObject({ status: "error", recoverable: true });
    const out = R(e, { type: "LOGOUT" } as AppAction);
    expect(out.status).toBe("unauthenticated");
    expect(selectIsDatabaseInitialized(out)).toBe(false);
    const again = R(out, login(win));
    expect(again).toMatchObject({ status: "loading", phase: "initializing-db", user, platform: win });
  });
});
