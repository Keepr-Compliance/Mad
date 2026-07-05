/**
 * License Handlers Tests
 *
 * BACKLOG-1783 (CRITICAL security): the dev-only license-manipulation channels
 * (`license:dev:toggle-ai-addon`, `license:dev:set-license-type`) must ONLY be
 * registered in development builds. In packaged builds they must never be wired
 * up, so a production app cannot self-upgrade its entitlements. Also verifies
 * the spoofable `license:canPerformAction` handler was removed.
 */

const registeredHandlers: Record<string, Function> = {};
const mockIpcHandle = jest.fn((channel: string, handler: Function) => {
  registeredHandlers[channel] = handler;
});

// Mutable dev/packaged flag toggled per-test to simulate dev vs packaged builds.
const mockApp = { isPackaged: false };

const mockDbRun = jest.fn();

jest.mock("electron", () => ({
  app: mockApp,
  ipcMain: {
    handle: (...args: unknown[]) =>
      mockIpcHandle(...(args as [string, Function])),
  },
}));

jest.mock("../../services/sessionService", () => ({
  __esModule: true,
  default: { loadSession: jest.fn().mockResolvedValue(null) },
}));

jest.mock("../../services/db/userDbService", () => ({
  getUserById: jest.fn(),
}));

jest.mock("../../services/db/core/dbConnection", () => ({
  dbRun: (...args: unknown[]) => mockDbRun(...args),
}));

jest.mock("../../services/logService", () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock("../../services/supabaseService", () => ({
  __esModule: true,
  default: { getActiveOrganizationMembership: jest.fn() },
}));

jest.mock("../../services/licenseService", () => ({
  validateLicense: jest.fn(),
  createUserLicense: jest.fn(),
  incrementTransactionCount: jest.fn(),
  clearLicenseCache: jest.fn(),
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

const DEV_CHANNELS = [
  "license:dev:toggle-ai-addon",
  "license:dev:set-license-type",
];

describe("LicenseHandlers", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.keys(registeredHandlers).forEach(
      (key) => delete registeredHandlers[key]
    );
    mockApp.isPackaged = false;
  });

  describe("development builds (app.isPackaged = false)", () => {
    it("registers the dev license-manipulation channels", () => {
      mockApp.isPackaged = false;
      registerLicenseHandlers();

      for (const channel of DEV_CHANNELS) {
        expect(registeredHandlers[channel]).toBeDefined();
      }
    });

    it("still registers the standard license channels", () => {
      mockApp.isPackaged = false;
      registerLicenseHandlers();

      expect(registeredHandlers["license:get"]).toBeDefined();
      expect(registeredHandlers["license:validate"]).toBeDefined();
      expect(registeredHandlers["license:clearCache"]).toBeDefined();
    });

    it("dev toggle-ai-addon handler updates the local database", async () => {
      mockApp.isPackaged = false;
      registerLicenseHandlers();

      const handler = registeredHandlers["license:dev:toggle-ai-addon"];
      const result = await handler({}, "user-1", true);

      expect(mockDbRun).toHaveBeenCalledWith(
        "UPDATE users_local SET ai_detection_enabled = ? WHERE id = ?",
        [1, "user-1"]
      );
      expect(result).toEqual({ success: true });
    });
  });

  describe("packaged builds (app.isPackaged = true)", () => {
    it("does NOT register the dev license-manipulation channels", () => {
      mockApp.isPackaged = true;
      registerLicenseHandlers();

      for (const channel of DEV_CHANNELS) {
        expect(registeredHandlers[channel]).toBeUndefined();
      }
      // And the mock was never asked to register them.
      for (const channel of DEV_CHANNELS) {
        expect(mockIpcHandle).not.toHaveBeenCalledWith(
          channel,
          expect.any(Function)
        );
      }
    });

    it("still registers the standard license channels", () => {
      mockApp.isPackaged = true;
      registerLicenseHandlers();

      expect(registeredHandlers["license:get"]).toBeDefined();
      expect(registeredHandlers["license:validate"]).toBeDefined();
      expect(registeredHandlers["license:clearCache"]).toBeDefined();
    });
  });

  describe("license:canPerformAction removal (BACKLOG-1783)", () => {
    it("is NOT registered in development builds", () => {
      mockApp.isPackaged = false;
      registerLicenseHandlers();

      expect(registeredHandlers["license:canPerformAction"]).toBeUndefined();
    });

    it("is NOT registered in packaged builds", () => {
      mockApp.isPackaged = true;
      registerLicenseHandlers();

      expect(registeredHandlers["license:canPerformAction"]).toBeUndefined();
    });
  });
});
