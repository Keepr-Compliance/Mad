/**
 * @jest-environment node
 */

/**
 * Unit tests for MacOSPermissionHelper
 * Tests macOS-specific permission handling with mocked system calls
 */

import { jest } from "@jest/globals";
import path from "path";

// Set HOME environment variable before imports
process.env.HOME = "/Users/testuser";

// Track mock state
let mockFsAccessShouldFail = false;
let mockFsAccessError: Error | null = null;
let mockShellShouldFail = false;
let mockShellError: Error | null = null;

// Mock electron
const mockNotificationShow = jest.fn();
const mockNotificationConstructor = jest.fn().mockImplementation(() => ({
  show: mockNotificationShow,
}));
(mockNotificationConstructor as any).isSupported = jest
  .fn()
  .mockReturnValue(true);

const mockShellOpenExternal = jest.fn().mockImplementation(async () => {
  if (mockShellShouldFail) {
    throw mockShellError || new Error("Shell error");
  }
  return undefined;
});

jest.mock("electron", () => ({
  app: {
    getPath: jest.fn((pathType: string) => {
      if (pathType === "exe")
        return "/Applications/Keepr.app/Contents/MacOS/Keepr";
      return "/mock/path";
    }),
  },
  shell: {
    openExternal: mockShellOpenExternal,
  },
  Notification: mockNotificationConstructor,
}));

// Mock fs/promises
const mockFsAccess = jest.fn().mockImplementation(async () => {
  if (mockFsAccessShouldFail) {
    throw mockFsAccessError || new Error("Access denied");
  }
  return undefined;
});

jest.mock("fs", () => ({
  promises: {
    access: mockFsAccess,
    constants: { R_OK: 4 },
  },
}));

describe("MacOSPermissionHelper", () => {
  let macOSPermissionHelper: typeof import("../macOSPermissionHelper").default;

  beforeEach(async () => {
    // Reset mock state
    mockFsAccessShouldFail = false;
    mockFsAccessError = null;
    mockShellShouldFail = false;
    mockShellError = null;

    jest.clearAllMocks();
    jest.resetModules();

    // Re-import to get fresh instance
    const module = await import("../macOSPermissionHelper");
    macOSPermissionHelper = module.default;
  });

  describe("requestContactsPermission", () => {
    it("should return success since contacts are included with Full Disk Access", async () => {
      const result = await macOSPermissionHelper.requestContactsPermission();

      expect(result.success).toBe(true);
      expect(result.message).toBe("Contacts access included with Full Disk Access");
    });
  });

  describe("setupFullDiskAccess", () => {
    it("should open System Preferences to Full Disk Access", async () => {
      const result = await macOSPermissionHelper.setupFullDiskAccess();

      expect(mockShellOpenExternal).toHaveBeenCalledWith(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
      );
      expect(result.success).toBe(true);
      expect(result.message).toBe(
        "System Preferences opened to Full Disk Access",
      );
      expect(result.appPath).toContain("Keepr");
      // BACKLOG-1816: Keepr auto-lists in FDA (triggerFullDiskAccess reads chat.db),
      // so guidance is toggle-on, not "click the + button".
      expect(result.nextStep).toContain("already listed");
      expect(result.nextStep).not.toContain("+ button");
    });

    it("should handle shell.openExternal failure", async () => {
      mockShellShouldFail = true;
      mockShellError = new Error("Failed to open System Preferences");

      // Re-import to pick up new mock state
      jest.resetModules();
      const module = await import("../macOSPermissionHelper");
      const helper = module.default;

      const result = await helper.setupFullDiskAccess();

      expect(result.success).toBe(false);
      expect(result.error).toBe("Failed to open System Preferences");
      expect(result.appPath).toBe("");
    });
  });

  describe("openPrivacyPane", () => {
    it("should open Full Disk Access pane by default", async () => {
      const result = await macOSPermissionHelper.openPrivacyPane();

      expect(mockShellOpenExternal).toHaveBeenCalledWith(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
      );
      expect(result.success).toBe(true);
    });

    it("should open Contacts privacy pane", async () => {
      const result = await macOSPermissionHelper.openPrivacyPane("contacts");

      expect(mockShellOpenExternal).toHaveBeenCalledWith(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Contacts",
      );
      expect(result.success).toBe(true);
    });

    it("should open Calendar privacy pane", async () => {
      const result = await macOSPermissionHelper.openPrivacyPane("calendar");

      expect(mockShellOpenExternal).toHaveBeenCalledWith(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars",
      );
      expect(result.success).toBe(true);
    });

    it("should open Accessibility privacy pane", async () => {
      const result =
        await macOSPermissionHelper.openPrivacyPane("accessibility");

      expect(mockShellOpenExternal).toHaveBeenCalledWith(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
      );
      expect(result.success).toBe(true);
    });

    it("should use custom pane ID if not in predefined list", async () => {
      const result =
        await macOSPermissionHelper.openPrivacyPane("Privacy_CustomPane");

      expect(mockShellOpenExternal).toHaveBeenCalledWith(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_CustomPane",
      );
      expect(result.success).toBe(true);
    });

    it("should handle failure to open pane", async () => {
      mockShellShouldFail = true;
      mockShellError = new Error("Failed to open");

      // Re-import to pick up new mock state
      jest.resetModules();
      const module = await import("../macOSPermissionHelper");
      const helper = module.default;

      const result = await helper.openPrivacyPane("contacts");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Failed to open");
    });
  });

  describe("checkFullDiskAccessStatus", () => {
    it("should return granted when chat.db is accessible", async () => {
      const result = await macOSPermissionHelper.checkFullDiskAccessStatus();

      expect(mockFsAccess).toHaveBeenCalledWith(
        path.join("/Users/testuser/Library/Messages", "chat.db"),
        4, // fs.constants.R_OK
      );
      expect(result.granted).toBe(true);
      expect(result.message).toBe("Full Disk Access is enabled");
    });

    it("should return not granted when chat.db is not accessible", async () => {
      const accessError = new Error(
        "EACCES: permission denied",
      ) as NodeJS.ErrnoException;
      accessError.code = "EACCES";
      mockFsAccessShouldFail = true;
      mockFsAccessError = accessError;

      // Re-import to pick up new mock state
      jest.resetModules();
      const module = await import("../macOSPermissionHelper");
      const helper = module.default;

      const result = await helper.checkFullDiskAccessStatus();

      expect(result.granted).toBe(false);
      expect(result.message).toBe("Full Disk Access is not enabled");
      expect(result.error).toBe("EACCES");
    });

    it("should handle ENOENT error (file not found)", async () => {
      const accessError = new Error(
        "ENOENT: no such file",
      ) as NodeJS.ErrnoException;
      accessError.code = "ENOENT";
      mockFsAccessShouldFail = true;
      mockFsAccessError = accessError;

      // Re-import to pick up new mock state
      jest.resetModules();
      const module = await import("../macOSPermissionHelper");
      const helper = module.default;

      const result = await helper.checkFullDiskAccessStatus();

      expect(result.granted).toBe(false);
      expect(result.error).toBe("ENOENT");
    });
  });

  describe("showPermissionNotification", () => {
    it("should show notification when supported", async () => {
      (mockNotificationConstructor as any).isSupported.mockReturnValue(true);

      await macOSPermissionHelper.showPermissionNotification(
        "Test Title",
        "Test Body",
      );

      expect(mockNotificationConstructor).toHaveBeenCalledWith({
        title: "Test Title",
        body: "Test Body",
      });
      expect(mockNotificationShow).toHaveBeenCalled();
    });

    it("should not show notification when not supported", async () => {
      (mockNotificationConstructor as any).isSupported.mockReturnValue(false);
      mockNotificationConstructor.mockClear();

      await macOSPermissionHelper.showPermissionNotification(
        "Test Title",
        "Test Body",
      );

      expect(mockNotificationConstructor).not.toHaveBeenCalled();
    });
  });

  describe("runPermissionSetupFlow", () => {
    it("should run complete permission setup flow successfully", async () => {
      (mockNotificationConstructor as any).isSupported.mockReturnValue(true);

      const result = await macOSPermissionHelper.runPermissionSetupFlow();

      expect(result.contacts).toBeDefined();
      expect(result.contacts?.success).toBe(true);
      expect(result.fullDiskAccess).toBeDefined();
      expect(result.fullDiskAccess?.success).toBe(true);
      expect(result.overallSuccess).toBe(true);
    });

    it("should report partial success when Full Disk Access setup fails", async () => {
      mockShellShouldFail = true;
      mockShellError = new Error("FDA failed");

      // Re-import to pick up new mock state
      jest.resetModules();
      const module = await import("../macOSPermissionHelper");
      const helper = module.default;

      const result = await helper.runPermissionSetupFlow();

      expect(result.contacts?.success).toBe(true);
      expect(result.fullDiskAccess?.success).toBe(false);
      expect(result.overallSuccess).toBe(false);
    });
  });
});
