/**
 * Tests for User-Facing Error Message Formatters (TASK-2276)
 *
 * Verifies that each formatter:
 * - Returns the correct shape (title, description, actionSuggestion, code)
 * - Has non-empty values for all fields
 * - Uses correct error codes
 * - Includes specific numbers in disk space error messages
 */

import {
  formatDiskSpaceError,
  formatMissingDriversError,
  formatDriverServiceStoppedError,
  formatDeviceNotDetectedError,
  formatSyncFailedError,
  formatUnknownBackupSizeError,
} from "../diagnostics/userFacingErrors";
import type { UserFacingError } from "../diagnostics/userFacingErrors";

/**
 * Helper to verify a UserFacingError has all required non-empty fields
 */
function expectValidUserError(error: UserFacingError): void {
  expect(error.title).toBeTruthy();
  expect(error.title.length).toBeGreaterThan(0);
  expect(error.description).toBeTruthy();
  expect(error.description.length).toBeGreaterThan(0);
  expect(error.actionSuggestion).toBeTruthy();
  expect(error.actionSuggestion.length).toBeGreaterThan(0);
  expect(error.code).toBeTruthy();
  expect(error.code.length).toBeGreaterThan(0);
}

describe("userFacingErrors", () => {
  describe("formatDiskSpaceError", () => {
    it("returns correct shape and code", () => {
      const error = formatDiskSpaceError(192, 2048);
      expectValidUserError(error);
      expect(error.code).toBe("INSUFFICIENT_DISK_SPACE");
    });

    it("includes actual MB numbers in description when under 1GB", () => {
      const error = formatDiskSpaceError(192, 512);
      expect(error.description).toContain("192MB");
      expect(error.description).toContain("512MB");
    });

    it("formats large values as GB", () => {
      const error = formatDiskSpaceError(512, 2048);
      expect(error.description).toContain("512MB");
      expect(error.description).toContain("2.0GB");
    });

    it("formats both values as GB when both are >= 1024 MB", () => {
      const error = formatDiskSpaceError(1536, 4096);
      expect(error.description).toContain("1.5GB");
      expect(error.description).toContain("4.0GB");
    });

    it("handles zero available space", () => {
      const error = formatDiskSpaceError(0, 2048);
      expectValidUserError(error);
      expect(error.description).toContain("0MB");
      expect(error.description).toContain("2.0GB");
    });

    it("handles exact threshold (available equals required)", () => {
      const error = formatDiskSpaceError(2048, 2048);
      expectValidUserError(error);
      expect(error.description).toContain("2.0GB");
    });

    it("has an actionable suggestion", () => {
      const error = formatDiskSpaceError(192, 2048);
      expect(error.actionSuggestion.toLowerCase()).toContain("free up");
    });
  });

  describe("formatMissingDriversError", () => {
    it("returns correct shape and code", () => {
      const error = formatMissingDriversError();
      expectValidUserError(error);
      expect(error.code).toBe("MISSING_DRIVERS");
    });

    it("mentions Sync Tools in suggestion", () => {
      const error = formatMissingDriversError();
      expect(error.actionSuggestion).toContain("Sync Tools");
    });

    it("mentions Apple Mobile Device Support", () => {
      const error = formatMissingDriversError();
      expect(error.description).toContain("Apple Mobile Device Support");
    });
  });

  describe("formatDriverServiceStoppedError", () => {
    it("returns correct shape and code", () => {
      const error = formatDriverServiceStoppedError();
      expectValidUserError(error);
      expect(error.code).toBe("DRIVER_SERVICE_STOPPED");
    });

    it("mentions the service is not running", () => {
      const error = formatDriverServiceStoppedError();
      expect(error.description.toLowerCase()).toContain("not currently running");
    });

    it("suggests restarting or repairing", () => {
      const error = formatDriverServiceStoppedError();
      expect(error.actionSuggestion.toLowerCase()).toContain("restart");
    });
  });

  describe("formatDeviceNotDetectedError", () => {
    it("returns correct shape and code", () => {
      const error = formatDeviceNotDetectedError();
      expectValidUserError(error);
      expect(error.code).toBe("DEVICE_NOT_DETECTED");
    });

    it("mentions USB and Trust", () => {
      const error = formatDeviceNotDetectedError();
      expect(error.description).toContain("USB");
      expect(error.description).toContain("Trust");
    });

    it("provides step-by-step instructions", () => {
      const error = formatDeviceNotDetectedError();
      expect(error.actionSuggestion).toContain("1.");
      expect(error.actionSuggestion).toContain("2.");
      expect(error.actionSuggestion).toContain("3.");
    });
  });

  describe("formatSyncFailedError", () => {
    it("returns correct shape and code without message", () => {
      const error = formatSyncFailedError();
      expectValidUserError(error);
      expect(error.code).toBe("SYNC_FAILED");
    });

    it("includes custom message when provided", () => {
      const error = formatSyncFailedError("Connection timed out");
      expect(error.description).toContain("Connection timed out");
    });

    it("uses generic description when no message provided", () => {
      const error = formatSyncFailedError();
      expect(error.description).toContain("unexpected error");
    });

    it("suggests reconnecting and restarting", () => {
      const error = formatSyncFailedError();
      expect(error.actionSuggestion.toLowerCase()).toContain("reconnecting");
      expect(error.actionSuggestion.toLowerCase()).toContain("restart");
    });
  });

  describe("all error formatters", () => {
    const allErrors: [string, UserFacingError][] = [
      ["diskSpace", formatDiskSpaceError(100, 2048)],
      ["missingDrivers", formatMissingDriversError()],
      ["driverServiceStopped", formatDriverServiceStoppedError()],
      ["deviceNotDetected", formatDeviceNotDetectedError()],
      ["syncFailed", formatSyncFailedError()],
      ["syncFailedWithMessage", formatSyncFailedError("test error")],
    ];

    it.each(allErrors)("%s has non-empty title", (_, error) => {
      expect(error.title.trim().length).toBeGreaterThan(0);
    });

    it.each(allErrors)("%s has non-empty description", (_, error) => {
      expect(error.description.trim().length).toBeGreaterThan(0);
    });

    it.each(allErrors)("%s has non-empty actionSuggestion", (_, error) => {
      expect(error.actionSuggestion.trim().length).toBeGreaterThan(0);
    });

    it.each(allErrors)("%s has non-empty code", (_, error) => {
      expect(error.code.trim().length).toBeGreaterThan(0);
    });

    it.each(allErrors)("%s does not contain stack traces", (_, error) => {
      expect(error.description).not.toMatch(/at\s+\w+.*\(.*:\d+:\d+\)/);
      expect(error.actionSuggestion).not.toMatch(/at\s+\w+.*\(.*:\d+:\d+\)/);
    });
  });

  /**
   * BACKLOG-3443. This message is shown to every user whose iPhone backup size
   * could not be read, and 22 of 24 recorded syncs are Windows. Telling a
   * Windows user their backup may not fit on "this Mac" reads as a message
   * meant for somebody else.
   */
  describe("formatUnknownBackupSizeError", () => {
    it("returns correct shape and code", () => {
      const error = formatUnknownBackupSizeError();
      expectValidUserError(error);
      expect(error.code).toBe("BACKUP_SIZE_UNKNOWN");
    });

    it("names no platform the user may not be on", () => {
      expect(formatUnknownBackupSizeError().description).not.toMatch(
        /\bmac\b|macos/i,
      );
    });

    it("still says what the space is being checked against", () => {
      // Paired with the negative: dropping the clause would pass "no Mac"
      // while losing the reason the sync refuses to start.
      expect(formatUnknownBackupSizeError().description).toContain(
        "whether it fits on this computer",
      );
    });
  });
});
