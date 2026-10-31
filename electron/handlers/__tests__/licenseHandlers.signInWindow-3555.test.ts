/**
 * @jest-environment node
 */
/**
 * BACKLOG-3555: license:get must not hand the PREVIOUS user's license and
 * organization to a user whose deep-link sign-in is not written to session.json yet.
 *
 * Harness = licenseHandlers.waitsForDb-3792.test.ts, with the initializationBroadcaster
 * REAL (whenDbReady answers {ready:false} at once from idle; it parks only while an
 * open is in flight).
 */
const registeredHandlers: Record<string, Function> = {};

jest.mock("electron", () => ({
  app: { isPackaged: true },
  ipcMain: {
    handle: (channel: string, handler: Function) => {
      registeredHandlers[channel] = handler;
    },
  },
}));

const mockLoadSession = jest.fn();
jest.mock("../../services/sessionService", () => ({
  __esModule: true,
  default: { loadSession: (...a: unknown[]) => mockLoadSession(...a) },
}));
const mockGetUserById = jest.fn();
jest.mock("../../services/db/userDbService", () => ({ getUserById: (...a: unknown[]) => mockGetUserById(...a) }));
jest.mock("../../services/db/core/dbConnection", () => ({ dbRun: jest.fn() }));
jest.mock("../../services/logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const mockGetMembership = jest.fn();
jest.mock("../../services/supabaseService", () => ({
  __esModule: true,
  default: { getActiveOrganizationMembership: (...a: unknown[]) => mockGetMembership(...a) },
}));
jest.mock("../../services/featureGateService", () => ({
  __esModule: true,
  default: { noteMembership: jest.fn() },
}));
jest.mock("../../services/licenseService", () => ({
  validateLicense: jest.fn(),
  createUserLicense: jest.fn(),
  incrementTransactionCount: jest.fn(),
  clearLicenseCache: jest.fn(),
  ensurePersonalOrganization: jest.fn(),
}));
jest.mock("../../services/deviceService", () => ({
  registerDevice: jest.fn(),
  getUserDevices: jest.fn(),
  deactivateDevice: jest.fn(),
  deleteDevice: jest.fn(),
  getDeviceId: jest.fn(),
  isDeviceRegistered: jest.fn(),
  updateDeviceHeartbeat: jest.fn(),
}));

let dbInitialized = false;
jest.mock("../../services/databaseService", () => ({
  __esModule: true,
  default: { isInitialized: () => dbInitialized },
}));

import { registerLicenseHandlers } from "../licenseHandlers";
import { initializationBroadcaster as b } from "../../services/initializationBroadcaster";

import * as G from "../../services/signInState";
const PENDING = { supabaseId: "new-user", email: "new@example.com", displayName: "New", provider: "google" as const };
const signInWhileDbClosed = () => { G.noteSignIn(); G.setPendingDeepLinkUser(PENDING); };
const signInWhileDbOpen = () => { G.noteSignIn(); };
const tick = () => new Promise((r) => setImmediate(r));

// The placeholder licenseHandlers.ts returns when there is no session (BACKLOG-2885).
const PLACEHOLDER = {
  success: true,
  sessionBacked: false,
  license: { license_type: "individual", ai_detection_enabled: false, organization_id: undefined },
};

describe("BACKLOG-3555: license:get vs a sign-in whose session is not written yet (REAL broadcaster)", () => {
  beforeAll(() => { registerLicenseHandlers(); });
  beforeEach(() => {
    jest.clearAllMocks();
    b.reset();
    G.getAndClearPendingDeepLinkUser();
    G.markSignInSessionWritten();
    dbInitialized = false;
    // session.json = the OLD user, who is on a team.
    mockLoadSession.mockResolvedValue({ user: { id: "old-user" } });
    mockGetMembership.mockResolvedValue({ organization_id: "org-old", organization_name: "Old Org", is_personal: false });
    mockGetUserById.mockResolvedValue({ license_type: "team", ai_detection_enabled: true, organization_id: "org-old" });
  });
  const get = () => registeredHandlers["license:get"]({}) as Promise<any>;
  async function parkedCall() {
    let done = false;
    const p = get().then((r) => { done = true; return r; });
    await tick(); await tick();
    expect(done).toBe(false);
    return { p };
  }
  async function unparkedCall() {
    let done = false;
    const p = get().then((r) => { done = true; return r; });
    await tick(); await tick();
    expect(done).toBe(true);
    return p;
  }
  const dbReady = () => { dbInitialized = true; b.broadcast({ stage: "db-ready" }); };
  const oldUserNotRead = () => {
    expect(mockLoadSession).not.toHaveBeenCalled();
    expect(mockGetMembership).not.toHaveBeenCalled();
    expect(mockGetUserById).not.toHaveBeenCalled();
  };

  it("L1: parked during the open, closed-DB sign-in lands before db-ready -> the old user's license is not read; no-session placeholder", async () => {
    b.broadcast({ stage: "starting" });
    const h = await parkedCall();
    signInWhileDbClosed();
    dbReady();
    const r = await h.p;
    oldUserNotRead();
    expect(r).toEqual(PLACEHOLDER);
  });

  it("L2: parked, a sign-in takes the DB-open branch while it waits (generation only) -> placeholder", async () => {
    b.broadcast({ stage: "migrating" });
    const h = await parkedCall();
    dbInitialized = true;
    signInWhileDbOpen();
    b.broadcast({ stage: "db-ready" });
    const r = await h.p;
    oldUserNotRead();
    expect(r).toEqual(PLACEHOLDER);
  });

  it("L3: DB handle set, deferred persist not run, call never parks -> placeholder (the :354-to-persist gap)", async () => {
    signInWhileDbClosed();
    dbInitialized = true;
    b.broadcast({ stage: "db-ready" });
    const r = await unparkedCall();
    oldUserNotRead();
    expect(r).toEqual(PLACEHOLDER);
  });

  it("L4: call ARRIVES during the open after the sign-in (LicenseContext focus refetch), parks, db-ready before the write -> placeholder", async () => {
    signInWhileDbClosed();
    b.broadcast({ stage: "starting" });
    const h = await parkedCall();
    dbReady();
    const r = await h.p;
    oldUserNotRead();
    expect(r).toEqual(PLACEHOLDER);
  });

  it("L5 KEEP: parked during a normal open, no sign-in -> today's answer (reads the session, sessionBacked true)", async () => {
    b.broadcast({ stage: "starting" });
    const h = await parkedCall();
    dbReady();
    const r = await h.p;
    expect(mockLoadSession).toHaveBeenCalledTimes(1);
    expect(r.sessionBacked).toBe(true);
    expect(r.license.license_type).toBe("team");
  });

  it("L6 KEEP: the deferred persist wrote the session (flag cleared) -> reads session.json again", async () => {
    signInWhileDbClosed();
    dbInitialized = true;
    b.broadcast({ stage: "db-ready" });
    G.markSignInSessionWritten();
    const r = await unparkedCall();
    expect(mockLoadSession).toHaveBeenCalledTimes(1);
    expect(r.sessionBacked).toBe(true);
  });

  it("L7 KEEP: the open fails while parked -> failure, session never read (unchanged)", async () => {
    b.broadcast({ stage: "starting" });
    const h = await parkedCall();
    b.broadcast({ stage: "error", message: "open failed", error: { message: "open failed", retryable: true } });
    const r = await h.p;
    expect(r).toEqual({ success: false, error: "Database is starting up" });
    expect(mockLoadSession).not.toHaveBeenCalled();
  });
});
