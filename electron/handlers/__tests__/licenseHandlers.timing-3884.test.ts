/**
 * @jest-environment node
 *
 * BACKLOG-3884 follow-up — license:get (re-read by the renderer on window
 * focus) logs one timing line per call: total, session read, Supabase
 * membership round trip, local row. ms only.
 */
const registeredHandlers: Record<string, (...args: unknown[]) => unknown> = {};

jest.mock("electron", () => ({
  app: { isPackaged: true },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      registeredHandlers[channel] = handler;
    },
  },
}));

const mockLoadSession = jest.fn();
jest.mock("../../services/sessionService", () => ({
  __esModule: true,
  default: { loadSession: (...args: unknown[]) => mockLoadSession(...args) },
}));

const mockGetUserById = jest.fn();
jest.mock("../../services/db/userDbService", () => ({
  getUserById: (...args: unknown[]) => mockGetUserById(...args),
}));

jest.mock("../../services/db/core/dbConnection", () => ({ dbRun: jest.fn() }));
// BACKLOG-3792 (2.41): license:get waits for the database first; it is ready here.
jest.mock("../../services/databaseService", () => ({
  __esModule: true,
  default: { isInitialized: jest.fn().mockReturnValue(true) },
}));
jest.mock("../../services/initializationBroadcaster", () => ({
  initializationBroadcaster: { whenDbReady: jest.fn() },
}));

const mockInfo = jest.fn();
jest.mock("../../services/logService", () => ({
  __esModule: true,
  default: { info: (...a: unknown[]) => mockInfo(...a), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockMembership = jest.fn();
jest.mock("../../services/supabaseService", () => ({
  __esModule: true,
  default: { getActiveOrganizationMembership: (...a: unknown[]) => mockMembership(...a) },
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

import { registerLicenseHandlers } from "../licenseHandlers";

const timingLines = () =>
  mockInfo.mock.calls.map(([m]) => String(m)).filter((m) => m.startsWith("[License] timing"));

describe("BACKLOG-3884: license:get timing line", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    registerLicenseHandlers();
  });

  it("logs every step for a signed-in user, ms only", async () => {
    mockLoadSession.mockResolvedValue({ user: { id: "user-secret" } });
    mockMembership.mockResolvedValue(null);
    mockGetUserById.mockResolvedValue({ id: "user-secret", license_type: "individual" });
    await registeredHandlers["license:get"]({});
    expect(timingLines()).toEqual([
      expect.stringMatching(/^\[License\] timing totalMs=\d+ loadSessionMs=\d+ membershipMs=\d+ dbMs=\d+$/),
    ]);
    expect(timingLines().join("\n")).not.toContain("secret");
  });

  it("marks steps that did not run when there is no session", async () => {
    mockLoadSession.mockResolvedValue(null);
    await registeredHandlers["license:get"]({});
    expect(timingLines()).toEqual([
      expect.stringMatching(/^\[License\] timing totalMs=\d+ loadSessionMs=\d+ membershipMs=- dbMs=-$/),
    ]);
  });
});
