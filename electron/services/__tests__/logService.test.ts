/**
 * Unit tests for LogService
 * Tests logging functionality with different levels and outputs
 */

import { LogService } from "../logService";
import log from "electron-log";
import * as fs from "fs";
import * as path from "path";

// Mock fs module
jest.mock("fs");

// electron-log is mocked via jest.config.js moduleNameMapper → tests/__mocks__/electron-log.js
// All methods (log.info, log.warn, log.debug, log.error) are jest.fn().

describe("LogService", () => {
  let logService: LogService;

  beforeEach(() => {
    jest.clearAllMocks();

    // Mock fs functions
    (fs.existsSync as jest.Mock).mockReturnValue(false);
    (fs.mkdirSync as jest.Mock).mockImplementation(() => undefined);
    (fs.readdirSync as jest.Mock).mockReturnValue([]);
    (fs.statSync as jest.Mock).mockReturnValue({ mtime: new Date() });
    (fs.unlinkSync as jest.Mock).mockImplementation(() => undefined);
    (fs.appendFile as jest.Mock).mockImplementation((path, data, callback) =>
      callback(null),
    );
    (fs.writeFile as jest.Mock).mockImplementation((path, data, callback) =>
      callback(null),
    );

    logService = new LogService({ logToConsole: true, logToFile: false });
  });

  describe("constructor", () => {
    it("should initialize with default config", () => {
      const service = new LogService();
      expect(service).toBeDefined();
    });

    it("should initialize with custom config", () => {
      const service = new LogService({
        logToFile: true,
        logToConsole: false,
        minLevel: "warn",
      });
      expect(service).toBeDefined();
    });

    it("should create log directory when logToFile is true", () => {
      const logDirectory = "/tmp/logs";
      new LogService({ logToFile: true, logDirectory });

      expect(fs.mkdirSync).toHaveBeenCalledWith(logDirectory, {
        recursive: true,
      });
    });
  });

  describe("log levels", () => {
    it("should log debug messages", async () => {
      // Need to set minLevel to debug since default is info
      logService = new LogService({ logToConsole: true, minLevel: "debug" });
      await logService.debug("Debug message");
      expect(log.debug).toHaveBeenCalled();
    });

    it("should log info messages", async () => {
      await logService.info("Info message");
      expect(log.info).toHaveBeenCalled();
    });

    it("should log warn messages", async () => {
      await logService.warn("Warning message");
      expect(log.warn).toHaveBeenCalled();
    });

    it("should log error messages", async () => {
      await logService.error("Error message");
      expect(log.error).toHaveBeenCalled();
    });
  });

  describe("log filtering by level", () => {
    beforeEach(() => {
      logService = new LogService({ logToConsole: true, minLevel: "warn" });
    });

    it("should not log debug when minLevel is warn", async () => {
      await logService.debug("Debug message");
      expect(log.debug).not.toHaveBeenCalled();
    });

    it("should not log info when minLevel is warn", async () => {
      await logService.info("Info message");
      expect(log.info).not.toHaveBeenCalled();
    });

    it("should log warn when minLevel is warn", async () => {
      await logService.warn("Warning message");
      expect(log.warn).toHaveBeenCalled();
    });

    it("should log error when minLevel is warn", async () => {
      await logService.error("Error message");
      expect(log.error).toHaveBeenCalled();
    });
  });

  describe("context and metadata", () => {
    it("should log with context", async () => {
      await logService.info("Message", "TestContext");
      expect(log.info).toHaveBeenCalled();
      const loggedMessage = (log.info as jest.Mock).mock.calls[0][0] as string;
      expect(loggedMessage).toContain("[TestContext]");
    });

    it("should log with metadata", async () => {
      const metadata = { userId: "123", action: "login" };
      await logService.info("User action", undefined, metadata);
      expect(log.info).toHaveBeenCalled();
      const loggedMessage = (log.info as jest.Mock).mock.calls[0][0] as string;
      expect(loggedMessage).toContain("userId");
      expect(loggedMessage).toContain("123");
    });

    it("should log with both context and metadata", async () => {
      const metadata = { key: "value" };
      await logService.info("Message", "Context", metadata);
      expect(log.info).toHaveBeenCalled();
      const loggedMessage = (log.info as jest.Mock).mock.calls[0][0] as string;
      expect(loggedMessage).toContain("[Context]");
      expect(loggedMessage).toContain("key");
    });
  });

  describe("file logging", () => {
    beforeEach(() => {
      logService = new LogService({
        logToFile: true,
        logToConsole: false,
        logDirectory: "/tmp/logs",
      });
    });

    it("should write to file when logToFile is enabled", async () => {
      await logService.info("Test message");
      expect(fs.appendFile).toHaveBeenCalled();
    });

    it("should not call electron-log when logToConsole is disabled", async () => {
      await logService.info("Test message");
      expect(log.info).not.toHaveBeenCalled();
    });

    it("should handle file write errors gracefully", async () => {
      (fs.appendFile as jest.Mock).mockImplementation((path, data, callback) =>
        callback(new Error("Write failed")),
      );

      await expect(logService.info("Test message")).rejects.toThrow(
        "Write failed",
      );
    });
  });

  describe("packaged build — electron-log file transport routing (BACKLOG-1843)", () => {
    /**
     * In packaged builds, console.* calls from the main process are NOT captured
     * by electron-log v5's file transport (no monkey-patching). logService must
     * route through electron-log so that sync telemetry ([CACHE-HITMISS],
     * [SHADOW-DELTA], ceremony lines) reaches ~/Library/Logs/keepr/main.log.
     *
     * These tests verify the routing contract. The electron-log mock is supplied
     * by tests/__mocks__/electron-log.js (jest.config.js moduleNameMapper).
     */

    it("routes logService.info() through electron-log (not bare console)", async () => {
      await logService.info("Outlook sync: 10 inbox + 5 sent = 15 unique, 3 new stored", "Transactions");
      // Must reach electron-log so the file transport captures it in packaged builds.
      expect(log.info).toHaveBeenCalled();
    });

    it("routes [CACHE-HITMISS] lines through electron-log", async () => {
      await logService.info(
        "[CACHE-HITMISS] transaction=abc reason=auto fetched=20 hits=17 misses=3 hitRate=0.850",
        "Transactions",
      );
      expect(log.info).toHaveBeenCalled();
      const msg = (log.info as jest.Mock).mock.calls[0][0] as string;
      expect(msg).toContain("[CACHE-HITMISS]");
      expect(msg).toContain("[Transactions]");
    });

    it("routes [SHADOW-DELTA] lines through electron-log", async () => {
      await logService.info(
        "[SHADOW-DELTA] account=xyz folders=3 new=5 dupes=2 removedSkipped=0 ms=1234",
        "ShadowDelta",
      );
      expect(log.info).toHaveBeenCalled();
      const msg = (log.info as jest.Mock).mock.calls[0][0] as string;
      expect(msg).toContain("[SHADOW-DELTA]");
      expect(msg).toContain("[ShadowDelta]");
    });

    it("does NOT call electron-log when logToConsole is false", async () => {
      const silentService = new LogService({ logToConsole: false, logToFile: false });
      await silentService.info("should be suppressed");
      expect(log.info).not.toHaveBeenCalled();
    });

    it("respects minLevel gate before reaching electron-log", async () => {
      const warnOnlyService = new LogService({ logToConsole: true, minLevel: "warn" });
      await warnOnlyService.info("below threshold");
      expect(log.info).not.toHaveBeenCalled();

      await warnOnlyService.warn("at threshold");
      expect(log.warn).toHaveBeenCalled();
    });

    it("passes auto-link count telemetry through electron-log", async () => {
      await logService.info("Auto-link complete for contact abc-123", "AutoLinkService", {
        emailsLinked: 5,
        messagesLinked: 2,
        alreadyLinked: 0,
        errors: 0,
        durationMs: 340,
      });
      expect(log.info).toHaveBeenCalled();
      const msg = (log.info as jest.Mock).mock.calls[0][0] as string;
      expect(msg).toContain("Auto-link complete");
      expect(msg).toContain("[AutoLinkService]");
      // Metadata serialized into formattedEntry
      expect(msg).toContain("emailsLinked");
    });
  });

  describe("updateConfig", () => {
    it("should update configuration", async () => {
      await logService.updateConfig({ minLevel: "error" });

      await logService.info("Should not log");
      expect(log.info).not.toHaveBeenCalled();

      await logService.error("Should log");
      expect(log.error).toHaveBeenCalled();
    });

    it("should reinitialize log file when directory changes", async () => {
      await logService.updateConfig({
        logToFile: true,
        logDirectory: "/new/path",
      });

      expect(fs.mkdirSync).toHaveBeenCalledWith("/new/path", {
        recursive: true,
      });
    });
  });

  describe("getConfig", () => {
    it("should return current configuration", async () => {
      const config = await logService.getConfig();
      expect(config).toHaveProperty("logToConsole");
      expect(config).toHaveProperty("minLevel");
    });

    it("should return a copy of config", async () => {
      const config1 = await logService.getConfig();
      const config2 = await logService.getConfig();

      expect(config1).toEqual(config2);
      expect(config1).not.toBe(config2);
    });
  });

  describe("clearLogs", () => {
    beforeEach(() => {
      logService = new LogService({
        logToFile: true,
        logDirectory: "/tmp/logs",
      });
    });

    it("should clear log file", async () => {
      await logService.clearLogs();
      expect(fs.writeFile).toHaveBeenCalled();
    });

    it("should handle clear errors", async () => {
      (fs.writeFile as jest.Mock).mockImplementation((path, data, callback) =>
        callback(new Error("Clear failed")),
      );

      await expect(logService.clearLogs()).rejects.toThrow("Clear failed");
    });
  });

  describe("log rotation", () => {
    beforeEach(() => {
      // Mock multiple log files
      (fs.readdirSync as jest.Mock).mockReturnValue([
        "app-2024-01-01.log",
        "app-2024-01-02.log",
        "app-2024-01-03.log",
        "app-2024-01-04.log",
        "app-2024-01-05.log",
      ]);

      (fs.statSync as jest.Mock).mockImplementation((filePath) => {
        const fileName = path.basename(filePath);
        const dateMatch = fileName.match(/app-(\d{4}-\d{2}-\d{2})/);
        return {
          mtime: dateMatch ? new Date(dateMatch[1]) : new Date(),
        };
      });
    });

    it("should rotate old log files when max count is exceeded", () => {
      new LogService({
        logToFile: true,
        logDirectory: "/tmp/logs",
        maxLogFiles: 3,
      });

      // Should delete older files beyond maxLogFiles
      expect(fs.unlinkSync).toHaveBeenCalled();
    });
  });

  describe("log formatting", () => {
    it("should include timestamp in log entry passed to electron-log", async () => {
      await logService.info("Test");
      const loggedMessage = (log.info as jest.Mock).mock.calls[0][0] as string;
      // Should contain ISO timestamp format
      expect(loggedMessage).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it("should format log level with proper padding in entry passed to electron-log", async () => {
      await logService.info("Test");
      const loggedMessage = (log.info as jest.Mock).mock.calls[0][0] as string;
      expect(loggedMessage).toContain("INFO");
    });

    it("should include the message in entry passed to electron-log", async () => {
      await logService.info("Test message");
      const loggedMessage = (log.info as jest.Mock).mock.calls[0][0] as string;
      expect(loggedMessage).toContain("Test message");
    });
  });
});
