/**
 * @jest-environment node
 */

/**
 * BACKLOG-4075: session restore must not re-point one account's local rows to
 * a DIFFERENT account the Supabase SDK holds.
 *
 * REAL driver + REAL shipped schema (schema.sql, :memory:) behind the REAL
 * databaseService/userDbService/sessionDbService; only the SDK, session.json
 * and the side services are doubles. Rows are seeded by the real producers
 * (createUserSync, createSessionSync — what provisionDeepLinkLogin calls) and
 * the session file's `user` is the row re-read by getUserById, as main.ts
 * builds it after provisioning (main.ts saveSignInSession({ user: localUser })).
 * Every assertion reads raw SQL, never the code under test.
 */

import * as fs from "fs";
import * as nodePath from "path";
import type { Database as DatabaseType } from "better-sqlite3";

const mockIpcHandle = jest.fn();
jest.mock("electron", () => ({
  ipcMain: { handle: mockIpcHandle },
  shell: { openExternal: jest.fn() },
  app: { getPath: jest.fn(() => "/tmp/keepr-4075-test-never-written"), isPackaged: false },
}));

const mockSetSession = jest.fn();
const mockGetUser = jest.fn();
const mockGetSession = jest.fn();
const mockGetAuthUserId = jest.fn();
jest.mock("../services/supabaseService", () => ({
  __esModule: true,
  default: {
    getClient: () => ({ auth: { setSession: mockSetSession, getUser: mockGetUser, getSession: mockGetSession } }),
    getAuthUserId: mockGetAuthUserId,
    getUserById: jest.fn().mockResolvedValue(null),
    signOut: jest.fn(),
    signOutGlobal: jest.fn(),
    syncTermsAcceptance: jest.fn(),
    completeEmailOnboarding: jest.fn(),
    getPreferences: jest.fn(),
    syncPreferences: jest.fn(),
  },
}));

const mockLoadSession = jest.fn();
const mockClearSession = jest.fn().mockResolvedValue(true);
const mockUpdateSession = jest.fn().mockResolvedValue(true);
jest.mock("../services/sessionService", () => ({
  __esModule: true,
  default: {
    loadSession: mockLoadSession,
    clearSession: mockClearSession,
    updateSession: mockUpdateSession,
    getSessionExpirationMs: () => 24 * 60 * 60 * 1000,
  },
}));

jest.mock("../services/sessionSecurityService", () => ({
  __esModule: true,
  default: {
    checkSessionValidity: jest.fn().mockResolvedValue({ valid: true }),
    recordActivity: jest.fn(),
    cleanupSession: jest.fn(),
  },
}));
jest.mock("../services/databaseEncryptionService", () => {
  const m = {
    initialize: jest.fn(),
    getEncryptionKey: jest.fn().mockResolvedValue("k"),
    isDatabaseEncrypted: jest.fn().mockResolvedValue(false),
    getKeyMetadata: jest.fn().mockResolvedValue({}),
  };
  return { __esModule: true, default: m, databaseEncryptionService: m };
});
// recordInTransaction/recordFailure: SR-C11's re-sign-in runs the real provisioning writer.
jest.mock("../services/auditService", () => ({
  __esModule: true,
  default: { log: jest.fn(), recordInTransaction: jest.fn(() => ({})), recordFailure: jest.fn() },
}));
const mockWarn = jest.fn();
const mockError = jest.fn();
jest.mock("../services/logService", () => ({
  __esModule: true,
  default: { debug: jest.fn(), info: jest.fn(), warn: mockWarn, error: mockError },
}));
/** The handler's outer catch (sessionHandlers.ts "trying Supabase session fallback"). */
const fellBack = () =>
  mockError.mock.calls.filter((c) => String(c[0]).startsWith("Get current user failed")).map((c) => JSON.stringify(c[2]));
jest.mock("../handlers/syncHandlers", () => ({ setSyncUserId: jest.fn() }));
jest.mock("../services/failureLogService", () => ({ __esModule: true, default: { logFailure: jest.fn() } }));
jest.mock("../services/shadowDeltaSyncService", () => ({ maybeStartShadowDeltaSync: jest.fn() }));
jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  setUser: jest.fn(),
}));
jest.mock("../constants/legalVersions", () => ({
  CURRENT_TERMS_VERSION: "1.0",
  CURRENT_PRIVACY_POLICY_VERSION: "1.0",
}));

import databaseService from "../services/databaseService";
import { setDb } from "../services/db/core/dbConnection";
import { createUserSync } from "../services/db/userDbService";
import { createSessionSync } from "../services/db/sessionDbService";
import { registerSessionHandlers } from "../handlers/sessionHandlers";
import { markSignInSessionWritten } from "../services/signInState";
import { initializationBroadcaster } from "../services/initializationBroadcaster";
import { provisionDeepLinkSignIn } from "../services/loginProvisioningService";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  nodePath.join(__dirname, "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
const SCHEMA = fs.readFileSync(nodePath.join(__dirname, "..", "database", "schema.sql"), "utf8");

// Invented ids and addresses.
const A = "40750000-0000-4000-8000-0000000000a1"; // pii-allow-uuid: invented fixture id
const B = "40750000-0000-4000-8000-0000000000b1"; // pii-allow-uuid: invented fixture id
const LEGACY = "40750000-0000-4000-8000-0000000000c9"; // pii-allow-uuid: invented fixture id (pre-1507G local id)
const A_EMAIL = "agent-a-4075@example.test";
const B_EMAIL = "agent-b-4075@example.test";

let db: DatabaseType;
const handlers: Record<string, () => Promise<{ success: boolean; user?: { id: string }; error?: string }>> = {};

/** auth-js User (types.d.ts `interface User`) as the SDK holds it after setSession. */
function sdkUser(id: string, email: string) {
  return {
    id,
    aud: "authenticated",
    role: "authenticated",
    email,
    app_metadata: { provider: "google", providers: ["google"] },
    user_metadata: { email, full_name: "Fixture Agent", sub: "google-sub-" + id.slice(-2) },
    identities: [],
    created_at: "2026-01-01T00:00:00Z",
  };
}

/** SDK holds `user` (cache + in-memory session), as the auth listener leaves it. */
function sdkHolds(user: ReturnType<typeof sdkUser> | null) {
  mockGetAuthUserId.mockReturnValue(user ? user.id : null);
  mockGetSession.mockResolvedValue({ data: { session: user ? { user, access_token: "at", refresh_token: "rt" } : null }, error: null });
  mockGetUser.mockResolvedValue(user ? { data: { user }, error: null } : { data: { user: null }, error: null });
}

/**
 * Cold start: the SDK holds nothing until the handler's setSession(file tokens);
 * the auth listener then mirrors the account those tokens belong to
 * (supabaseService.ts _setupAuthStateListener, SIGNED_IN).
 */
function coldStartRestoresTo(user: ReturnType<typeof sdkUser>, after?: () => void) {
  sdkHolds(null);
  mockSetSession.mockImplementation(async () => {
    sdkHolds(user);
    after?.();
    return { data: { session: {}, user: {} }, error: null };
  });
}

/** Local user + one session row, by the producers provisionDeepLinkLogin calls. */
function provision(id: string, email: string, oauthId = id): string {
  createUserSync({
    id,
    email,
    display_name: email.split("@")[0],
    oauth_provider: "google",
    oauth_id: oauthId,
    subscription_tier: "free",
    subscription_status: "trial",
    is_active: true,
  } as never);
  return createSessionSync(id);
}

function seedRows(userId: string): void {
  db.prepare("INSERT INTO transactions (id, user_id, property_address) VALUES (?, ?, ?)").run("tx-" + userId.slice(-2), userId, "1 Fixture Way");
  db.prepare("INSERT INTO contacts (id, user_id, display_name, source, is_imported) VALUES (?, ?, 'Fixture Contact', 'manual', 1)").run("ct-" + userId.slice(-2), userId);
}

/** SessionData (sessionService.ts SessionData) as main.ts saveSignInSession writes it. */
async function sessionFile(userId: string, token: string, overrides: Record<string, unknown> = {}) {
  const user = await databaseService.getUserById(userId);
  const now = Date.now();
  return {
    user,
    sessionToken: token,
    provider: "google",
    subscription: { tier: "free", status: "trial", isActive: true, isTrial: true, trialEnded: false, trialDaysRemaining: 14 },
    expiresAt: now + 24 * 60 * 60 * 1000,
    createdAt: now,
    savedAt: now,
    supabaseTokens: { access_token: "file-at", refresh_token: "file-rt" },
    ...overrides,
  };
}

const usersIds = () => (db.prepare("SELECT id FROM users_local ORDER BY id").all() as { id: string }[]).map((r) => r.id);
const ownedBy = (uid: string) =>
  ["transactions", "contacts", "sessions"].map(
    (t) => (db.prepare(`SELECT count(*) AS n FROM ${t} WHERE user_id = ?`).get(uid) as { n: number }).n,
  );

beforeAll(() => {
  registerSessionHandlers();
  for (const [channel, handler] of mockIpcHandle.mock.calls) handlers[channel] = handler;
});

beforeEach(() => {
  jest.clearAllMocks();
  markSignInSessionWritten();
  initializationBroadcaster.reset();
  db = new Database(":memory:") as unknown as DatabaseType;
  db.exec(SCHEMA);
  setDb(db);
  jest.spyOn(databaseService, "getRawDatabase").mockImplementation(() => db as never);
  jest.spyOn(databaseService, "isInitialized").mockImplementation(() => true);
  mockSetSession.mockResolvedValue({ data: { session: {}, user: {} }, error: null });
});

afterEach(() => {
  jest.restoreAllMocks();
  db.close();
});

const run = () => handlers["auth:get-current-user"]();

describe("BACKLOG-4075: session restore vs the account the SDK holds", () => {
  it("C1 cold start, file = A carrying B's tokens: no row moves, A stays, signed out", async () => {
    const tok = provision(A, A_EMAIL);
    seedRows(A);
    mockLoadSession.mockResolvedValue(await sessionFile(A, tok));
    coldStartRestoresTo(sdkUser(B, B_EMAIL));
    const before = ownedBy(A);
    const r = await run();
    expect(usersIds()).toEqual([A]);
    expect(ownedBy(A).slice(0, 2)).toEqual(before.slice(0, 2));
    expect(ownedBy(B)).toEqual([0, 0, 0]);
    expect(r.success).toBe(false);
    expect(mockClearSession).toHaveBeenCalledTimes(1);
    expect(ownedBy(A)[2]).toBe(0); // the file's session row is deleted
    expect(fellBack()).toEqual([]);
  });

  it("C1b cold start, file = A carrying B's tokens, and B already has a local row (two accounts on one Mac): A's rows stay, not signed in as B", async () => {
    const tok = provision(A, A_EMAIL);
    seedRows(A);
    provision(B, B_EMAIL);
    mockLoadSession.mockResolvedValue(await sessionFile(A, tok));
    coldStartRestoresTo(sdkUser(B, B_EMAIL));
    const r = await run();
    expect(r.success).toBe(false);
    expect(r.user?.id).toBeUndefined();
    expect(usersIds()).toEqual([A, B]);
    expect(ownedBy(A).slice(0, 2)).toEqual([1, 1]);
    expect(ownedBy(B).slice(0, 2)).toEqual([0, 0]);
    expect(mockClearSession).toHaveBeenCalledTimes(1);
  });

  it("C2 IN-PROCESS: SDK already holds B, A's restore would fail on the network: no restore attempted, nothing moves, file kept", async () => {
    const tok = provision(A, A_EMAIL);
    seedRows(A);
    mockLoadSession.mockResolvedValue(await sessionFile(A, tok));
    sdkHolds(sdkUser(B, B_EMAIL));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AuthRetryableFetchError } = require("@supabase/supabase-js");
    mockSetSession.mockResolvedValue({ data: { session: null, user: null }, error: new AuthRetryableFetchError("fetch failed", 0) });
    const r = await run();
    expect(mockSetSession).not.toHaveBeenCalled();
    expect(usersIds()).toEqual([A]);
    expect(ownedBy(A)).toEqual([1, 1, 1]);
    expect(ownedBy(B)).toEqual([0, 0, 0]);
    expect(r.success).toBe(false);
    expect(mockClearSession).not.toHaveBeenCalled();
  });

  it("C3 same person, pre-1507G local id, SDK = that person: migrates (TASK-1507G kept)", async () => {
    const tok = provision(LEGACY, A_EMAIL, "google-sub-legacy");
    seedRows(LEGACY);
    mockLoadSession.mockResolvedValue(await sessionFile(LEGACY, tok));
    coldStartRestoresTo(sdkUser(A, A_EMAIL));
    const r = await run();
    expect(r.success).toBe(true);
    expect(r.user?.id).toBe(A);
    expect(usersIds()).toEqual([A]);
    expect(ownedBy(A)).toEqual([1, 1, 1]);
    expect(ownedBy(LEGACY)).toEqual([0, 0, 0]);
    expect(mockClearSession).not.toHaveBeenCalled();
    expect(fellBack()).toEqual([]);
  });

  it("C3b IN-PROCESS same person: SDK already holds the account, file has its pre-1507G local id: restored and unified, not refused", async () => {
    const tok = provision(LEGACY, A_EMAIL, "google-sub-legacy");
    seedRows(LEGACY);
    mockLoadSession.mockResolvedValue(await sessionFile(LEGACY, tok));
    sdkHolds(sdkUser(A, A_EMAIL));
    const r = await run();
    expect(mockSetSession).toHaveBeenCalledTimes(1);
    expect(r.success).toBe(true);
    expect(r.user?.id).toBe(A);
    expect(usersIds()).toEqual([A]);
    expect(ownedBy(A)).toEqual([1, 1, 1]);
  });

  it("C4 same person, email differs only in case/space: migrates", async () => {
    const tok = provision(LEGACY, A_EMAIL, "google-sub-legacy");
    seedRows(LEGACY);
    mockLoadSession.mockResolvedValue(await sessionFile(LEGACY, tok));
    coldStartRestoresTo(sdkUser(A, " " + A_EMAIL.toUpperCase()));
    const r = await run();
    expect(r.success).toBe(true);
    expect(usersIds()).toEqual([A]);
  });

  it("C5 ordinary same-user restore (ids equal): nothing moves, nothing cleared", async () => {
    const tok = provision(A, A_EMAIL);
    seedRows(A);
    mockLoadSession.mockResolvedValue(await sessionFile(A, tok));
    coldStartRestoresTo(sdkUser(A, A_EMAIL));
    const r = await run();
    expect(r.success).toBe(true);
    expect(r.user?.id).toBe(A);
    expect(ownedBy(A)).toEqual([1, 1, 1]);
    expect(mockClearSession).not.toHaveBeenCalled();
  });

  it("C6 no SDK session, no tokens in file: falls back to the file's user, nothing moves", async () => {
    const tok = provision(A, A_EMAIL);
    seedRows(A);
    mockLoadSession.mockResolvedValue(await sessionFile(A, tok, { supabaseTokens: undefined }));
    sdkHolds(null);
    const r = await run();
    expect(mockSetSession).not.toHaveBeenCalled();
    expect(r.success).toBe(true);
    expect(r.user?.id).toBe(A);
    expect(usersIds()).toEqual([A]);
    expect(ownedBy(A)).toEqual([1, 1, 1]);
  });

  it("C7 no SDK session, file id = Supabase id, local row found by OAuth id under a legacy id: migrates to the file's id", async () => {
    const tok = provision(LEGACY, "renamed-4075@example.test", "google-sub-a");
    seedRows(LEGACY);
    const file = await sessionFile(LEGACY, tok, { supabaseTokens: undefined });
    mockLoadSession.mockResolvedValue({ ...file, user: { ...file.user, id: A, email: A_EMAIL, oauth_id: "google-sub-a" } });
    sdkHolds(null);
    const r = await run();
    expect(r.success).toBe(true);
    expect(usersIds()).toEqual([A]);
    expect(ownedBy(A).slice(0, 2)).toEqual([1, 1]);
  });

  it("C8 SDK id cached but its in-memory session is gone (identity unknown): no row moves, signed out", async () => {
    const tok = provision(A, A_EMAIL);
    seedRows(A);
    mockLoadSession.mockResolvedValue(await sessionFile(A, tok));
    coldStartRestoresTo(sdkUser(B, B_EMAIL), () =>
      mockGetSession.mockResolvedValue({ data: { session: null }, error: null }),
    );
    const r = await run();
    expect(r.success).toBe(false);
    expect(usersIds()).toEqual([A]);
    expect(ownedBy(A).slice(0, 2)).toEqual([1, 1]);
  });

  it("C9 cached SDK id = B but the SDK's session user is A (stale cache; producer UNTRACED, defensive): no row moves to B", async () => {
    const tok = provision(LEGACY, A_EMAIL, "google-sub-legacy");
    seedRows(LEGACY);
    mockLoadSession.mockResolvedValue(await sessionFile(LEGACY, tok));
    sdkHolds(sdkUser(A, A_EMAIL));
    mockGetAuthUserId.mockReturnValue(B);
    const r = await run();
    expect(r.success).toBe(false);
    expect(ownedBy(B)).toEqual([0, 0, 0]);
    expect(ownedBy(LEGACY).slice(0, 2)).toEqual([1, 1]);
  });
});

const seedSettings = (uid: string) => {
  db.prepare("INSERT INTO llm_settings (id, user_id) VALUES (?, ?)").run("llm-" + uid.slice(-2), uid);
  db.prepare("INSERT INTO learn_mode_settings (id, user_id, enabled, created_at, updated_at) VALUES (?, ?, 1, 'x', 'x')").run("lm-" + uid.slice(-2), uid);
};
const settingsOwnedBy = (uid: string) =>
  ["llm_settings", "learn_mode_settings"].map(
    (t) => (db.prepare(`SELECT count(*) AS n FROM ${t} WHERE user_id = ?`).get(uid) as { n: number }).n,
  );
const fkViolations = () => (db.prepare("PRAGMA foreign_key_check").all() as { table: string }[]).map((r) => r.table);
const tick = () => new Promise((r) => setImmediate(r));

describe("BACKLOG-4075: SR review controls", () => {
  it("SR-C10 same person, legacy id: rows in tables the old writers never listed move too (no orphans)", async () => {
    const tok = provision(LEGACY, A_EMAIL, "google-sub-legacy");
    seedRows(LEGACY);
    seedSettings(LEGACY);
    mockLoadSession.mockResolvedValue(await sessionFile(LEGACY, tok));
    coldStartRestoresTo(sdkUser(A, A_EMAIL));
    const r = await run();
    expect(r.success).toBe(true);
    expect(usersIds()).toEqual([A]);
    expect(settingsOwnedBy(A)).toEqual([1, 1]);
    expect(settingsOwnedBy(LEGACY)).toEqual([0, 0]);
    expect(fkViolations()).toEqual([]);
  });

  it("SR-C11 a mismatch leaves ALL of A's rows untouched, and A's next real sign-in gets them back", async () => {
    const tok = provision(A, A_EMAIL);
    seedRows(A);
    seedSettings(A);
    mockLoadSession.mockResolvedValue(await sessionFile(A, tok));
    coldStartRestoresTo(sdkUser(B, B_EMAIL));
    const r = await run();
    expect(r.success).toBe(false);
    expect(ownedBy(A).slice(0, 2)).toEqual([1, 1]);
    expect(settingsOwnedBy(A)).toEqual([1, 1]);
    expect(fkViolations()).toEqual([]);
    const p = await provisionDeepLinkSignIn({ supabaseId: A, email: A_EMAIL, provider: "google", subscriptionTier: "free", subscriptionStatus: "trial" });
    expect(p.user.id).toBe(A);
    expect(usersIds()).toEqual([A]);
    expect(ownedBy(A)).toEqual([1, 1, 1]);
    expect(settingsOwnedBy(A)).toEqual([1, 1]);
  });

  it("SR-C12 IN-PROCESS: SDK already holds B, file = A with A's own tokens: the SDK is not switched back to A and A is not returned", async () => {
    const tok = provision(A, A_EMAIL);
    seedRows(A);
    mockLoadSession.mockResolvedValue(await sessionFile(A, tok));
    sdkHolds(sdkUser(B, B_EMAIL));
    mockSetSession.mockImplementation(async () => {
      sdkHolds(sdkUser(A, A_EMAIL));
      return { data: { session: {}, user: {} }, error: null };
    });
    const r = await run();
    expect(mockSetSession).not.toHaveBeenCalled();
    expect(r.success).toBe(false);
    expect(mockClearSession).not.toHaveBeenCalled();
    expect(ownedBy(A)).toEqual([1, 1, 1]);
  });

  it("SR-C13 cold start offline, file = A carrying B's tokens: returns A, clears nothing, moves nothing (residual: caught on the next online launch)", async () => {
    const tok = provision(A, A_EMAIL);
    seedRows(A);
    mockLoadSession.mockResolvedValue(await sessionFile(A, tok));
    sdkHolds(null);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AuthRetryableFetchError } = require("@supabase/supabase-js");
    mockSetSession.mockResolvedValue({ data: { session: null, user: null }, error: new AuthRetryableFetchError("fetch failed", 0) });
    const r = await run();
    expect(r.success).toBe(true);
    expect(r.user?.id).toBe(A);
    expect(mockClearSession).not.toHaveBeenCalled();
    expect(usersIds()).toEqual([A]);
    expect(ownedBy(A)).toEqual([1, 1, 1]);
    expect(ownedBy(B)).toEqual([0, 0, 0]);
  });
});

describe("BACKLOG-3555 KEEP-2 (rebuilt on the real driver for BACKLOG-4075)", () => {
  it("KEEP-2: a call parked during a normal open, TASK-1507G legacy local id -> the unification runs once the DB is ready", async () => {
    const tok = provision(LEGACY, A_EMAIL, "google-sub-legacy");
    seedRows(LEGACY);
    mockLoadSession.mockResolvedValue(await sessionFile(LEGACY, tok));
    coldStartRestoresTo(sdkUser(A, A_EMAIL));
    // The DB handle is not set yet and the open is in progress: the call parks on the REAL broadcaster.
    (databaseService.isInitialized as jest.Mock).mockImplementation(() => false);
    initializationBroadcaster.broadcast({ stage: "starting" } as never);
    let done = false;
    const p = run().then((r) => { done = true; return r; });
    await tick(); await tick();
    expect(done).toBe(false);
    (databaseService.isInitialized as jest.Mock).mockImplementation(() => true);
    initializationBroadcaster.broadcast({ stage: "db-ready" } as never);
    const r = await p;
    expect(r.success).toBe(true);
    expect(r.user?.id).toBe(A);
    expect(usersIds()).toEqual([A]);
    expect(ownedBy(A)).toEqual([1, 1, 1]);
    expect(fkViolations()).toEqual([]);
  });
});
