/**
 * BACKLOG-3792: license:get must wait for the database before reading.
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
jest.mock("../../services/db/userDbService", () => ({ getUserById: jest.fn() }));
jest.mock("../../services/db/core/dbConnection", () => ({ dbRun: jest.fn() }));
jest.mock("../../services/logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock("../../services/supabaseService", () => ({
  __esModule: true,
  default: { getActiveOrganizationMembership: jest.fn() },
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
const mockWhenDbReady = jest.fn();
jest.mock("../../services/initializationBroadcaster", () => ({
  initializationBroadcaster: { whenDbReady: (...a: unknown[]) => mockWhenDbReady(...a) },
}));

import { registerLicenseHandlers } from "../licenseHandlers";
import logService from "../../services/logService";

describe("license:get waits for the database (BACKLOG-3792)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    registerLicenseHandlers();
  });

  it("reads the session only after db-ready, then succeeds", async () => {
    dbInitialized = false;
    let release!: () => void;
    mockWhenDbReady.mockReturnValue(
      new Promise((res) => {
        release = () => {
          dbInitialized = true;
          res({ ready: true, timedOut: false });
        };
      })
    );
    // Mirrors the real failure: the read throws until the DB is up.
    mockLoadSession.mockImplementation(async () => {
      if (!dbInitialized) throw new Error("Database is not initialized");
      return null;
    });

    const pending = registeredHandlers["license:get"]({});
    await Promise.resolve();
    expect(mockLoadSession).not.toHaveBeenCalled();

    release();
    const result = await pending;
    expect(mockLoadSession).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(logService.error).not.toHaveBeenCalled();
  });

  it("returns a failure without reading when the database never becomes ready", async () => {
    dbInitialized = false;
    mockWhenDbReady.mockResolvedValue({ ready: false, timedOut: true });
    const result = await registeredHandlers["license:get"]({});
    expect(result.success).toBe(false);
    expect(mockLoadSession).not.toHaveBeenCalled();
  });

  it("does not wait when the database is already initialized", async () => {
    dbInitialized = true;
    mockLoadSession.mockResolvedValue(null);
    const result = await registeredHandlers["license:get"]({});
    expect(mockWhenDbReady).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });
});
