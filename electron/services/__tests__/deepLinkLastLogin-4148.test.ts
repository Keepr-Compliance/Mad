/**
 * @jest-environment node
 */
/*
 * BACKLOG-4148 — the browser (deep-link) sign-in stamps users_local.last_login_at.
 *
 *   - exactly one stamp per sign-in, for a NEW user and for a RETURNING user
 *     (found by email, by (provider, Supabase id), or under a legacy id);
 *   - the stamp is the SYNC write, made while the provisioning transaction body
 *     runs, so a failed stamp rolls the sign-in back (it is never swallowed);
 *   - the returned user is the row re-read AFTER the stamp (main.ts saves it to
 *     session.json and sends its dates to the renderer).
 *
 * The db layer is mocked (runs without the native module) with a tiny row store,
 * so a stamp is visible on the re-read. The real-driver twin is
 * deepLinkProvisioningAtomicity-3322 (D14-D16). `dbTransaction` is emulated as
 * "run the body; a throw means rollback", and each stamp records whether a body
 * was running when it was made.
 *
 * Fixture provenance:
 *   - the sign-in user is the `deepLinkUserData: PendingDeepLinkUser` main.ts
 *     builds in handleDeepLinkCallback (copied from deepLinkSignInAudit-3340);
 *   - rows carry the columns `getUserByIdSync` returns (`SELECT * FROM
 *     users_local`, userDbService.ts) that this item reads: id, email,
 *     oauth_provider, oauth_id, created_at, last_login_at; the stamp value is the
 *     shape SQLite's CURRENT_TIMESTAMP writes ("YYYY-MM-DD HH:MM:SS", UTC).
 */

let inTx = false;
const STAMP = "2026-11-05 03:30:00";
const rows = new Map<string, Record<string, unknown>>();
const stamps: Array<{ id: string; inTx: boolean }> = [];

jest.mock("../db/core/dbConnection", () => ({
  dbTransaction: <T,>(fn: () => T): T => {
    inTx = true;
    try {
      return fn();
    } finally {
      inTx = false;
    }
  },
  isInitialized: jest.fn(() => true),
}));
const mockUsers = {
  createUserSync: jest.fn(),
  getUserByEmailSync: jest.fn(),
  getUserByIdSync: jest.fn(),
  getUserByOAuthIdSync: jest.fn(),
  migrateUserIdForUnification: jest.fn(),
  updateLastLoginSync: jest.fn(),
  // The promise export, mocked as what it is (a wrapper that can reject), so a
  // `void updateLastLogin()` in the body would be seen as "no sync stamp".
  updateLastLogin: jest.fn(),
  updateUserSync: jest.fn(),
};
jest.mock("../db/userDbService", () => mockUsers);
jest.mock("../db/oauthTokenDbService", () => ({ saveOAuthToken: jest.fn() }));
const mockCreateSessionSync = jest.fn();
jest.mock("../db/sessionDbService", () => ({ createSessionSync: (...a: unknown[]) => mockCreateSessionSync(...a) }));
jest.mock("../logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock("@sentry/electron/main", () => ({ captureMessage: jest.fn(), captureException: jest.fn() }));
jest.mock("../auditService", () => ({
  __esModule: true,
  default: { recordInTransaction: jest.fn(), recordFailure: jest.fn(), log: jest.fn() },
}));

import { provisionDeepLinkLogin, provisionDeepLinkSignIn } from "../loginProvisioningService";
import type { PendingDeepLinkUser } from "../signInState";

const SUPABASE_ID = "41480000-0000-4000-8000-0000000000a1"; // pii-allow-uuid: invented fixture id
const LEGACY_ID = "41480000-0000-4000-8000-0000000000b1"; // pii-allow-uuid: invented fixture id
const TOKEN = "session-token-4148";

const u: PendingDeepLinkUser = {
  supabaseId: SUPABASE_ID,
  email: "signin-4148@example.test",
  displayName: "Sign In",
  avatarUrl: undefined,
  provider: "google",
  subscriptionTier: "free",
  subscriptionStatus: "trial",
};
const seed = (id: string, lastLogin: string | null) => {
  const row = {
    id,
    email: u.email,
    oauth_provider: "google",
    oauth_id: SUPABASE_ID,
    created_at: "2026-01-02 03:04:05",
    last_login_at: lastLogin,
  };
  rows.set(id, row);
  return { ...row };
};

beforeEach(() => {
  jest.clearAllMocks();
  rows.clear();
  stamps.length = 0;
  inTx = false;
  mockUsers.getUserByEmailSync.mockReturnValue(null);
  mockUsers.getUserByOAuthIdSync.mockReturnValue(null);
  mockUsers.createUserSync.mockImplementation((r: { id: string }) => seed(r.id, null));
  mockUsers.getUserByIdSync.mockImplementation((id: string) => (rows.has(id) ? { ...rows.get(id) } : null));
  mockUsers.updateLastLoginSync.mockImplementation((id: string) => {
    stamps.push({ id, inTx });
    const row = rows.get(id);
    if (row) row.last_login_at = STAMP;
  });
  mockUsers.updateLastLogin.mockImplementation(async (id: string) => mockUsers.updateLastLoginSync(id));
  mockUsers.migrateUserIdForUnification.mockResolvedValue(undefined);
  mockCreateSessionSync.mockReturnValue(TOKEN);
});

describe("BACKLOG-4148 the browser sign-in stamps last_login_at", () => {
  it("L1 a new user: one sync stamp inside the body, and the returned row carries it", async () => {
    const r = await provisionDeepLinkSignIn(u);
    expect(r.isNewUser).toBe(true);
    expect(stamps).toEqual([{ id: SUPABASE_ID, inTx: true }]);
    expect(r.user.last_login_at).toBe(STAMP);
    expect(mockUsers.updateLastLogin).not.toHaveBeenCalled();
  });

  it("L2 a returning user found by email: one stamp on that row, returned row carries the NEW value", async () => {
    mockUsers.getUserByEmailSync.mockReturnValue(seed(SUPABASE_ID, "2026-01-27 09:00:00"));
    const r = await provisionDeepLinkSignIn(u);
    expect(r.isNewUser).toBe(false);
    expect(stamps).toEqual([{ id: SUPABASE_ID, inTx: true }]);
    expect(r.user.last_login_at).toBe(STAMP);
  });

  it("L3 a returning user found by (provider, Supabase id) only: stamped too", async () => {
    mockUsers.getUserByOAuthIdSync.mockReturnValue(seed(SUPABASE_ID, null));
    const r = await provisionDeepLinkSignIn(u);
    expect(stamps).toEqual([{ id: SUPABASE_ID, inTx: true }]);
    expect(r.user.last_login_at).toBe(STAMP);
  });

  it("L4 a legacy-id user whose migration failed: the stamp lands on the id the row really has", async () => {
    mockUsers.getUserByEmailSync.mockReturnValue(seed(LEGACY_ID, null));
    mockUsers.migrateUserIdForUnification.mockRejectedValue(new Error("UNIQUE"));
    const r = await provisionDeepLinkSignIn(u);
    expect(stamps).toEqual([{ id: LEGACY_ID, inTx: true }]);
    expect(r.user.id).toBe(LEGACY_ID);
    expect(r.user.last_login_at).toBe(STAMP);
  });

  it("L5 the stamp throws: the throw propagates out of the body (the sign-in rolls back)", () => {
    mockUsers.updateLastLoginSync.mockImplementationOnce(() => {
      throw new Error("INJECTED last-login update");
    });
    expect(() => provisionDeepLinkLogin(u)).toThrow("INJECTED last-login update");
  });

  it("L6 the row cannot be re-read after the stamp: the sign-in fails rather than returning a stale row", () => {
    mockUsers.getUserByIdSync.mockReturnValue(null);
    expect(() => provisionDeepLinkLogin(u)).toThrow(/after the last-login stamp/);
  });
});
