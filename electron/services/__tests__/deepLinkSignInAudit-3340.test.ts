/**
 * @jest-environment node
 */
/*
 * BACKLOG-3340 — the browser (deep-link) sign-in writes its audit entries.
 *
 *   - exactly one LOGIN per successful sign-in, written INSIDE the provisioning
 *     transaction (auditService.recordInTransaction while the body runs);
 *   - a failed provisioning writes exactly one LOGIN_FAILED, after the
 *     rollback, for the LOCAL user found then, and no LOGIN;
 *   - no local user row -> no audit write at all (foreign key), one Sentry report;
 *   - the session-file retries never write a second LOGIN or a LOGIN_FAILED.
 *
 * The db layer is mocked here (jsdom-safe, runs without the native module); the
 * real-driver twin of these controls is deepLinkProvisioningAtomicity-3322.
 * `dbTransaction` is emulated as "run the body; a throw means rollback", and
 * each audit call records whether a body was running when it was made.
 *
 * Fixture provenance:
 *   - the sign-in user is the `deepLinkUserData: PendingDeepLinkUser` main.ts
 *     builds in handleDeepLinkCallback (provider already normalized there, no
 *     trialEndsAt);
 *   - the audit call shapes are auditService.recordInTransaction /
 *     recordFailure's parameter types (auditService.ts);
 *   - the session data is the object main.ts passes to saveSignInSession.
 */

let inTx = false;
const auditCalls: Array<{ method: string; inTx: boolean; entry: Record<string, unknown> }> = [];

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
  updateUserSync: jest.fn(),
};
jest.mock("../db/userDbService", () => mockUsers);
const mockCreateSessionSync = jest.fn();
jest.mock("../db/sessionDbService", () => ({ createSessionSync: (...a: unknown[]) => mockCreateSessionSync(...a) }));
jest.mock("../logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const mockCaptureMessage = jest.fn();
jest.mock("@sentry/electron/main", () => ({
  captureMessage: (...a: unknown[]) => mockCaptureMessage(...a),
  captureException: jest.fn(),
}));
const mockRecordInTransaction = jest.fn((entry: Record<string, unknown>) => {
  auditCalls.push({ method: "recordInTransaction", inTx, entry });
});
const mockRecordFailure = jest.fn((entry: Record<string, unknown>) => {
  auditCalls.push({ method: "recordFailure", inTx, entry });
});
const mockAuditLog = jest.fn();
jest.mock("../auditService", () => ({
  __esModule: true,
  default: {
    recordInTransaction: (e: Record<string, unknown>) => mockRecordInTransaction(e),
    recordFailure: (e: Record<string, unknown>) => mockRecordFailure(e),
    log: (...a: unknown[]) => mockAuditLog(...a),
  },
}));
const mockSaveSession = jest.fn();
jest.mock("../sessionService", () => ({
  __esModule: true,
  default: { saveSession: (...a: unknown[]) => mockSaveSession(...a) },
}));
const mockGetAuthSession = jest.fn();
jest.mock("../supabaseService", () => ({
  __esModule: true,
  default: { getAuthSession: (...a: unknown[]) => mockGetAuthSession(...a) },
}));

import { isInitialized } from "../db/core/dbConnection";
import {
  provisionDeepLinkLogin,
  provisionDeepLinkSignIn,
  recordDeepLinkSignInFailure,
} from "../loginProvisioningService";
import { saveSignInSession, markSignInSessionWritten } from "../signInState";
import type { PendingDeepLinkUser } from "../signInState";

const SUPABASE_ID = "33400000-0000-4000-8000-0000000000a1"; // pii-allow-uuid: invented fixture id
const LEGACY_ID = "33400000-0000-4000-8000-0000000000b1"; // pii-allow-uuid: invented fixture id
const TOKEN = "session-token-3340";

const u: PendingDeepLinkUser = {
  supabaseId: SUPABASE_ID,
  email: "signin-3340@example.test",
  displayName: "Sign In",
  avatarUrl: undefined,
  provider: "google",
  subscriptionTier: "free",
  subscriptionStatus: "trial",
};
const userRow = (id: string) => ({ id, email: u.email, oauth_provider: "google", oauth_id: SUPABASE_ID });

const logins = () => auditCalls.filter((c) => c.entry.action === "LOGIN");
const failures = () => auditCalls.filter((c) => c.entry.action === "LOGIN_FAILED");

beforeEach(() => {
  jest.clearAllMocks();
  auditCalls.length = 0;
  inTx = false;
  (isInitialized as jest.Mock).mockReturnValue(true);
  mockUsers.getUserByEmailSync.mockReturnValue(null);
  mockUsers.getUserByOAuthIdSync.mockReturnValue(null);
  mockUsers.createUserSync.mockImplementation((row: { id: string }) => userRow(row.id));
  // BACKLOG-4148: provisionDeepLinkLogin re-reads the row after the last-login stamp.
  mockUsers.getUserByIdSync.mockImplementation((id: string) => userRow(id));
  mockUsers.migrateUserIdForUnification.mockResolvedValue(undefined);
  mockCreateSessionSync.mockReturnValue(TOKEN);
});

describe("BACKLOG-3340 LOGIN is written inside the provisioning transaction", () => {
  it("A1 a new user: exactly one LOGIN, inside the body, for the new user and its session", async () => {
    const r = await provisionDeepLinkSignIn(u);
    expect(r.isNewUser).toBe(true);
    expect(logins()).toEqual([
      {
        method: "recordInTransaction",
        inTx: true,
        entry: {
          userId: SUPABASE_ID,
          action: "LOGIN",
          resourceType: "SESSION",
          metadata: { provider: "google", isNewUser: true, method: "browser" },
        },
      },
    ]);
    // The entry carries no session id and no resource id: the session token
    // appears nowhere in it.
    expect(logins()[0].entry).not.toHaveProperty("sessionId");
    expect(logins()[0].entry).not.toHaveProperty("resourceId");
    expect(JSON.stringify(logins()[0].entry)).not.toContain(TOKEN);
    expect(failures()).toEqual([]);
    expect(mockAuditLog).not.toHaveBeenCalled();
  });

  it("A2 an existing user: one LOGIN for that user, isNewUser false", async () => {
    mockUsers.getUserByEmailSync.mockReturnValue(userRow(SUPABASE_ID));
    await provisionDeepLinkSignIn(u);
    expect(logins().map((c) => [c.inTx, c.entry.userId, (c.entry.metadata as { isNewUser: boolean }).isNewUser])).toEqual([
      [true, SUPABASE_ID, false],
    ]);
  });

  it("A3 the legacy-id migration runs and still exactly one LOGIN (on the migrated id)", async () => {
    // Before the migration the row has the legacy id; after it, the Supabase id.
    mockUsers.getUserByEmailSync
      .mockReturnValueOnce(userRow(LEGACY_ID))
      .mockReturnValue(userRow(SUPABASE_ID));
    await provisionDeepLinkSignIn(u);
    expect(mockUsers.migrateUserIdForUnification).toHaveBeenCalledTimes(1);
    expect(logins().map((c) => [c.inTx, c.entry.userId])).toEqual([[true, SUPABASE_ID]]);
  });

  it("A4 the audit insert throws: the throw propagates out of the body (the sign-in rolls back)", () => {
    mockRecordInTransaction.mockImplementationOnce(() => {
      throw new Error("audit insert failed");
    });
    expect(() => provisionDeepLinkLogin(u)).toThrow("audit insert failed");
  });
});

describe("BACKLOG-3340 LOGIN_FAILED after a failed provisioning", () => {
  it("F1 existing user, session insert throws: one LOGIN_FAILED after the rollback for that user, no LOGIN, rethrown", async () => {
    mockUsers.getUserByEmailSync.mockReturnValue(userRow(SUPABASE_ID));
    mockCreateSessionSync.mockImplementation(() => {
      throw new Error("INJECTED session insert");
    });
    await expect(provisionDeepLinkSignIn(u)).rejects.toThrow("INJECTED session insert");
    expect(logins()).toEqual([]);
    expect(failures()).toEqual([
      {
        method: "recordFailure",
        inTx: false,
        entry: {
          userId: SUPABASE_ID,
          action: "LOGIN_FAILED",
          resourceType: "SESSION",
          metadata: { provider: "google", reason: "provisioning_failed", method: "browser" },
          errorMessage: "INJECTED session insert",
        },
      },
    ]);
  });

  it("F2 legacy user whose migration failed: LOGIN_FAILED carries the id the local row really has", async () => {
    mockUsers.getUserByEmailSync.mockReturnValue(userRow(LEGACY_ID));
    mockUsers.migrateUserIdForUnification.mockRejectedValue(new Error("UNIQUE"));
    mockCreateSessionSync.mockImplementation(() => {
      throw new Error("INJECTED");
    });
    await expect(provisionDeepLinkSignIn(u)).rejects.toThrow("INJECTED");
    expect(failures().map((c) => c.entry.userId)).toEqual([LEGACY_ID]);
  });

  it("F3 a first sign-in that rolled back (no local row): no audit write at all, one Sentry report", async () => {
    mockUsers.createUserSync.mockImplementation(() => {
      throw new Error("CHECK constraint failed: oauth_provider");
    });
    await expect(provisionDeepLinkSignIn({ ...u, provider: "email" as never })).rejects.toThrow(/CHECK/);
    expect(auditCalls).toEqual([]);
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      "Sign-in failure not written to the audit log",
      expect.objectContaining({ tags: expect.objectContaining({ reason: "provisioning_failed", why: "no_local_user" }) }),
    );
  });

  it("F4 database closed (a denial before the DB opened): no audit write, one Sentry report", () => {
    (isInitialized as jest.Mock).mockReturnValue(false);
    recordDeepLinkSignInFailure(u, "license_blocked");
    expect(auditCalls).toEqual([]);
    expect(mockUsers.getUserByEmailSync).not.toHaveBeenCalled();
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      "Sign-in failure not written to the audit log",
      expect.objectContaining({ tags: expect.objectContaining({ reason: "license_blocked", why: "database_closed" }) }),
    );
  });

  it("F5 denial for a known local user (license blocked / device limit): one LOGIN_FAILED with the fixed reason", () => {
    mockUsers.getUserByEmailSync.mockReturnValue(userRow(SUPABASE_ID));
    recordDeepLinkSignInFailure(u, "device_limit");
    expect(failures().map((c) => [c.entry.userId, (c.entry.metadata as { reason: string }).reason])).toEqual([
      [SUPABASE_ID, "device_limit"],
    ]);
  });

  it("F6 the lookup itself throws: never throws to the caller, nothing written", () => {
    mockUsers.getUserByEmailSync.mockImplementation(() => {
      throw new Error("disk I/O error");
    });
    expect(() => recordDeepLinkSignInFailure(u, "no_auth_session")).not.toThrow();
    expect(auditCalls).toEqual([]);
  });
});

describe("BACKLOG-3340 the session-file retries write no audit entry", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    markSignInSessionWritten();
  });
  afterEach(() => {
    jest.useRealTimers();
    markSignInSessionWritten();
  });

  it("R1 provisioning then every session-file attempt fails: still exactly one LOGIN and no LOGIN_FAILED", async () => {
    mockSaveSession.mockResolvedValue(false);
    mockGetAuthSession.mockResolvedValue({ userId: SUPABASE_ID, accessToken: "a1", refreshToken: "r1" });
    const provisioned = await provisionDeepLinkSignIn(u);
    // Shape transcribed from main.ts's saveSignInSession call, typed with
    // saveSignInSession's own parameter type so type-check:tests checks it.
    const sessionData: Parameters<typeof saveSignInSession>[0] = {
      user: provisioned.user,
      sessionToken: provisioned.sessionToken,
      provider: "google",
      subscription: { tier: "free", status: "trial", isActive: true, isTrial: true, trialEnded: false, trialDaysRemaining: 0 },
      expiresAt: 1,
      createdAt: 1,
      supabaseTokens: { access_token: "a0", refresh_token: "r0" },
    };
    const saving = saveSignInSession(sessionData);
    await jest.advanceTimersByTimeAsync(10_000);
    await expect(saving).resolves.toBe(false);
    expect(mockSaveSession).toHaveBeenCalledTimes(4);
    expect(logins()).toHaveLength(1);
    expect(failures()).toEqual([]);
    expect(mockAuditLog).not.toHaveBeenCalled();
  });
});
