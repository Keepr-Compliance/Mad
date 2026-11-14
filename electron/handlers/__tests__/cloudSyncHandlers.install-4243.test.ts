/**
 * @jest-environment node
 *
 * BACKLOG-4243 — installCloudSync never throws: a failure while installing the
 * Keepr Cloud engine logs one warning and returns null, so app start continues.
 */
const mockHandle = jest.fn();
jest.mock("electron", () => ({
  app: { isPackaged: true, getAppPath: jest.fn(() => "/app") },
  ipcMain: { handle: mockHandle },
  net: { isOnline: jest.fn(() => true) },
  powerMonitor: { on: jest.fn() },
  shell: { openExternal: jest.fn() },
}));
jest.mock("@sentry/electron/main", () => ({ captureMessage: jest.fn() }));
const mockWarn = jest.fn();
jest.mock("../../services/logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: mockWarn, error: jest.fn(), debug: jest.fn() },
}));
jest.mock("../../services/db/core/dbConnection", () => ({ getRawDatabase: jest.fn() }));
jest.mock("../../services/databaseService", () => ({ __esModule: true, default: { isInitialized: jest.fn(() => false) } }));
jest.mock("../../services/initializationBroadcaster", () => ({
  initializationBroadcaster: { whenDbReady: jest.fn(() => new Promise(() => undefined)) },
}));
jest.mock("../../services/supabaseService", () => ({
  __esModule: true,
  default: { getAuthUserId: jest.fn(() => null), getClient: jest.fn() },
}));
jest.mock("../../services/sessionService", () => ({ __esModule: true, default: { loadSession: jest.fn(async () => null) } }));
jest.mock("../../services/sessionSecurityService", () => ({ __esModule: true, default: { getLastActivity: jest.fn(() => null) } }));
jest.mock("../../services/authEvents", () => ({ onSessionChanged: jest.fn(() => () => undefined) }));
jest.mock("../../services/deviceService", () => ({ getDeviceId: jest.fn(() => "device-4243") }));
jest.mock("../featureGateHandlers", () => ({ isStrictFeatureAllowed: jest.fn(async () => false) }));

import { installCloudSync, resetCloudSyncForTests } from "../cloudSyncHandlers";

describe("installCloudSync", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetCloudSyncForTests();
  });

  it("returns null and logs one warning when registering a channel throws", () => {
    mockHandle.mockImplementation(() => {
      throw new Error("Attempted to register a second handler");
    });
    expect(() => installCloudSync()).not.toThrow();
    expect(installCloudSync()).toBeNull();
    expect(mockWarn).toHaveBeenCalledWith("[CloudSync] Not installed this launch", "CloudSync", { code: "Error" });
  });

  it("positive: installs and registers the seven channels when nothing throws", () => {
    mockHandle.mockImplementation(() => undefined);
    expect(installCloudSync()).not.toBeNull();
    expect(mockHandle).toHaveBeenCalledTimes(7);
  });
});
