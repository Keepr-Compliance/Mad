/**
 * Backup/Restore Handlers Tests
 * TASK-2254: Verify handler registration and IPC channel wiring
 */

// Track registered handlers
const registeredHandlers: Record<string, Function> = {};
const mockIpcHandle = jest.fn((channel: string, handler: Function) => {
  registeredHandlers[channel] = handler;
});

jest.mock("electron", () => ({
  ipcMain: {
    // BACKLOG-2414: the forwarder's rest tuple is taken from the mock it calls,
    // so the spread is a tuple rather than `unknown[]` (TS2556). Runtime is
    // unchanged — a rest parameter captures the same arguments either way.
    handle: (...args: Parameters<typeof mockIpcHandle>) => mockIpcHandle(...args),
  },
  dialog: {
    showSaveDialog: jest.fn(),
    showOpenDialog: jest.fn(),
    showMessageBox: jest.fn(),
  },
  BrowserWindow: {
    getFocusedWindow: jest.fn().mockReturnValue(null),
  },
}));

jest.mock("../../services/logService", () => ({
  __esModule: true,
  default: {
    info: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock("../../services/sqliteBackupService", () => ({
  backupDatabase: jest.fn().mockResolvedValue({ success: true, path: "/mock/backup.db" }),
  restoreDatabase: jest.fn().mockResolvedValue({ success: true }),
  getDatabaseInfo: jest.fn().mockResolvedValue({ size: 1024, lastModified: "2024-01-01" }),
  generateBackupFilename: jest.fn().mockReturnValue("keepr-backup-2024-01-01.db"),
}));

jest.mock("../../utils/wrapHandler", () => ({
  wrapHandler: (fn: Function) => fn,
}));

import { registerBackupRestoreHandlers } from "../backupRestoreHandlers";

describe("BackupRestoreHandlers", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Clear tracked handlers
    Object.keys(registeredHandlers).forEach((key) => delete registeredHandlers[key]);
  });

  describe("registerBackupRestoreHandlers", () => {
    it("should register all expected IPC channels", () => {
      registerBackupRestoreHandlers();

      expect(mockIpcHandle).toHaveBeenCalledWith("db:backup", expect.any(Function));
      expect(mockIpcHandle).toHaveBeenCalledWith("db:restore", expect.any(Function));
      expect(mockIpcHandle).toHaveBeenCalledWith("db:get-backup-info", expect.any(Function));
    });

    it("should register exactly 3 handlers", () => {
      registerBackupRestoreHandlers();

      // 3 IPC handlers
      expect(mockIpcHandle).toHaveBeenCalledTimes(3);
    });
  });

  describe("db:backup handler", () => {
    it("should return cancelled when user cancels save dialog", async () => {
      const { dialog } = require("electron");
      (dialog.showSaveDialog as jest.Mock).mockResolvedValue({
        canceled: true,
        filePath: undefined,
      });

      registerBackupRestoreHandlers();
      const handler = registeredHandlers["db:backup"];
      const result = await handler({} as any);

      expect(result).toEqual({ success: false, cancelled: true });
    });

    it("should call backupDatabase with selected path", async () => {
      const { dialog } = require("electron");
      const { backupDatabase } = require("../../services/sqliteBackupService");

      (dialog.showSaveDialog as jest.Mock).mockResolvedValue({
        canceled: false,
        filePath: "/user/chosen/backup.db",
      });

      registerBackupRestoreHandlers();
      const handler = registeredHandlers["db:backup"];
      await handler({} as any);

      expect(backupDatabase).toHaveBeenCalledWith("/user/chosen/backup.db");
    });
  });

  describe("db:restore handler", () => {
    it("should return cancelled when user cancels open dialog", async () => {
      const { dialog } = require("electron");
      (dialog.showOpenDialog as jest.Mock).mockResolvedValue({
        canceled: true,
        filePaths: [],
      });

      registerBackupRestoreHandlers();
      const handler = registeredHandlers["db:restore"];
      const result = await handler({} as any);

      expect(result).toEqual({ success: false, cancelled: true });
    });

    it("should return cancelled when user declines confirmation", async () => {
      const { dialog } = require("electron");
      (dialog.showOpenDialog as jest.Mock).mockResolvedValue({
        canceled: false,
        filePaths: ["/user/chosen/backup.db"],
      });
      // response 0 = Cancel
      (dialog.showMessageBox as jest.Mock).mockResolvedValue({ response: 0 });

      registerBackupRestoreHandlers();
      const handler = registeredHandlers["db:restore"];
      const result = await handler({} as any);

      expect(result).toEqual({ success: false, cancelled: true });
    });

    it("should call restoreDatabase when user confirms", async () => {
      const { dialog } = require("electron");
      const { restoreDatabase } = require("../../services/sqliteBackupService");

      (dialog.showOpenDialog as jest.Mock).mockResolvedValue({
        canceled: false,
        filePaths: ["/user/chosen/backup.db"],
      });
      // response 1 = Restore
      (dialog.showMessageBox as jest.Mock).mockResolvedValue({ response: 1 });

      registerBackupRestoreHandlers();
      const handler = registeredHandlers["db:restore"];
      await handler({} as any);

      expect(restoreDatabase).toHaveBeenCalledWith("/user/chosen/backup.db");
    });
  });

  describe("db:get-backup-info handler", () => {
    it("should return database info", async () => {
      registerBackupRestoreHandlers();
      const handler = registeredHandlers["db:get-backup-info"];
      const result = await handler({} as any);

      expect(result).toEqual({
        success: true,
        info: { size: 1024, lastModified: "2024-01-01" },
      });
    });
  });
});
