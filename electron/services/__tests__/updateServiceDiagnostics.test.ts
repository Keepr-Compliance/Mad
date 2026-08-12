/**
 * Tests for auto-update failure tracking and Sentry reporting (TASK-2274)
 *
 * Verifies:
 * - classifyUpdateError maps error messages to correct failure reasons
 * - Sentry breadcrumbs are recorded on status transitions
 * - Sentry captureMessage is called on errors with correct tags
 */

// Mock Sentry
const mockCaptureMessage = jest.fn();
const mockAddBreadcrumb = jest.fn();

jest.mock("@sentry/electron/main", () => ({
  captureMessage: mockCaptureMessage,
  addBreadcrumb: mockAddBreadcrumb,
}));

// Mock logService (used by emit error handler)
jest.mock("../logService", () => ({
  __esModule: true,
  default: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

import {
  classifyUpdateError,
  UpdateService,
  UpdateFailureReason,
} from "../updateService";

describe("classifyUpdateError", () => {
  const cases: Array<{ input: string | Error; expected: UpdateFailureReason }> =
    [
      // insufficient_storage
      { input: new Error("ENOSPC: no space left on device"), expected: "insufficient_storage" },
      { input: new Error("Not enough disk space"), expected: "insufficient_storage" },
      { input: new Error("Insufficient space available"), expected: "insufficient_storage" },

      // permissions_error
      { input: new Error("EACCES: permission denied"), expected: "permissions_error" },
      { input: new Error("Permission denied writing to /usr/local"), expected: "permissions_error" },

      // network_error
      { input: new Error("Network request failed"), expected: "network_error" },
      { input: new Error("Connection timeout"), expected: "network_error" },
      { input: new Error("ECONNREFUSED 127.0.0.1:443"), expected: "network_error" },

      // download_failed
      { input: new Error("Download interrupted"), expected: "download_failed" },

      // install_failed
      { input: new Error("Install verification failed"), expected: "install_failed" },

      // unknown
      { input: new Error("Something unexpected happened"), expected: "unknown" },
      { input: new Error(""), expected: "unknown" },
    ];

  it.each(cases)(
    "classifies '$input' as '$expected'",
    ({ input, expected }) => {
      expect(classifyUpdateError(input)).toBe(expected);
    },
  );

  it("handles non-Error values (string)", () => {
    expect(classifyUpdateError("network failure")).toBe("network_error");
  });

  it("handles non-Error values (number)", () => {
    expect(classifyUpdateError(42)).toBe("unknown");
  });

  it("handles null/undefined", () => {
    expect(classifyUpdateError(null)).toBe("unknown");
    expect(classifyUpdateError(undefined)).toBe("unknown");
  });
});

describe("UpdateService Sentry integration", () => {
  let service: UpdateService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new UpdateService("1.0.0", { channel: "stable" });
  });

  describe("checkForUpdates", () => {
    it("records a breadcrumb when checking for updates", async () => {
      await service.checkForUpdates();

      expect(mockAddBreadcrumb).toHaveBeenCalledWith(
        expect.objectContaining({
          category: "update.check",
          level: "info",
          data: expect.objectContaining({
            channel: "stable",
            currentVersion: "1.0.0",
          }),
        }),
      );
    });

    it("records a breadcrumb when no update is available", async () => {
      await service.checkForUpdates();

      expect(mockAddBreadcrumb).toHaveBeenCalledWith(
        expect.objectContaining({
          category: "update.status",
          message: "No update available",
          level: "info",
        }),
      );
    });

    it("captures a Sentry message on error with classified reason", async () => {
      const networkError = new Error("Network request failed");
      jest
        .spyOn(
          service as unknown as { simulateUpdateCheck: () => Promise<void> },
          "simulateUpdateCheck",
        )
        .mockRejectedValue(networkError);

      await expect(service.checkForUpdates()).rejects.toThrow(
        "Network request failed",
      );

      expect(mockCaptureMessage).toHaveBeenCalledWith(
        "Auto-update check failed",
        expect.objectContaining({
          level: "error",
          tags: expect.objectContaining({
            component: "auto_update",
            failureReason: "network_error",
            currentVersion: "1.0.0",
          }),
          extra: expect.objectContaining({
            channel: "stable",
            errorMessage: "Network request failed",
          }),
        }),
      );
    });

    it("tags errors with correct failure reason for storage errors", async () => {
      const storageError = new Error("ENOSPC: no space left on device");
      jest
        .spyOn(
          service as unknown as { simulateUpdateCheck: () => Promise<void> },
          "simulateUpdateCheck",
        )
        .mockRejectedValue(storageError);

      await expect(service.checkForUpdates()).rejects.toThrow();

      expect(mockCaptureMessage).toHaveBeenCalledWith(
        "Auto-update check failed",
        expect.objectContaining({
          tags: expect.objectContaining({
            failureReason: "insufficient_storage",
          }),
        }),
      );
    });
  });

  describe("downloadUpdate", () => {
    it("records breadcrumbs for download start and completion", async () => {
      // Set up the service with an available update by accessing private field
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (service as any).availableUpdate = {
        version: "2.0.0",
        releaseDate: "2026-01-01",
        size: 50000000,
      };

      await service.downloadUpdate();

      expect(mockAddBreadcrumb).toHaveBeenCalledWith(
        expect.objectContaining({
          category: "update.download",
          message: "Downloading update 2.0.0",
          level: "info",
          data: expect.objectContaining({
            version: "2.0.0",
            size: 50000000,
          }),
        }),
      );

      expect(mockAddBreadcrumb).toHaveBeenCalledWith(
        expect.objectContaining({
          category: "update.download",
          message: "Download completed",
          level: "info",
        }),
      );
    });

    it("captures Sentry message on download failure", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (service as any).availableUpdate = {
        version: "2.0.0",
        releaseDate: "2026-01-01",
        size: 50000000,
      };

      const permError = new Error("EACCES: permission denied");
      jest
        .spyOn(
          service as unknown as { simulateDownload: () => Promise<void> },
          "simulateDownload",
        )
        .mockRejectedValue(permError);

      await expect(service.downloadUpdate()).rejects.toThrow(
        "EACCES: permission denied",
      );

      expect(mockCaptureMessage).toHaveBeenCalledWith(
        "Auto-update download failed",
        expect.objectContaining({
          level: "error",
          tags: expect.objectContaining({
            component: "auto_update",
            failureReason: "permissions_error",
            currentVersion: "1.0.0",
          }),
          extra: expect.objectContaining({
            version: "2.0.0",
            errorMessage: "EACCES: permission denied",
          }),
        }),
      );
    });
  });

  describe("installUpdate", () => {
    it("records breadcrumb when installing", async () => {
      // Set up service in downloaded state
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (service as any).status = "downloaded";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (service as any).availableUpdate = {
        version: "2.0.0",
        releaseDate: "2026-01-01",
      };

      await service.installUpdate();

      expect(mockAddBreadcrumb).toHaveBeenCalledWith(
        expect.objectContaining({
          category: "update.install",
          message: "Installing update",
          level: "info",
          data: expect.objectContaining({
            version: "2.0.0",
            currentVersion: "1.0.0",
          }),
        }),
      );
    });
  });

  describe("event listeners still work with Sentry instrumentation", () => {
    it("emits error event alongside Sentry reporting", async () => {
      const errorCallback = jest.fn();
      service.on("error", errorCallback);

      const error = new Error("ECONNREFUSED");
      jest
        .spyOn(
          service as unknown as { simulateUpdateCheck: () => Promise<void> },
          "simulateUpdateCheck",
        )
        .mockRejectedValue(error);

      await expect(service.checkForUpdates()).rejects.toThrow();

      // Both Sentry and event listener should fire
      expect(mockCaptureMessage).toHaveBeenCalled();
      expect(errorCallback).toHaveBeenCalledWith(error);
    });
  });
});
