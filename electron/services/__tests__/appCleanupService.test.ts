/**
 * App Cleanup Service Tests
 * BACKLOG-2111: App-data cleanup engine + detached uninstall helper.
 *
 * These tests exercise the pure logic (enumeration, script generation, secret
 * clearing, mode matrix, isPackaged guard, beforeWipe timeout) via injected
 * dependency seams. NO real filesystem is wiped and no real process is spawned.
 */

// Mock electron: app.getPath is driven per-test; isPackaged defaults true.
const mockGetPath = jest.fn();
const mockRelaunch = jest.fn();
const mockQuit = jest.fn();
jest.mock("electron", () => ({
  app: {
    get isPackaged() {
      return true;
    },
    getPath: (...args: unknown[]) => mockGetPath(...args),
    relaunch: (...args: unknown[]) => mockRelaunch(...args),
    quit: (...args: unknown[]) => mockQuit(...args),
  },
}));

jest.mock("../logService", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

import {
  enumerateArtifacts,
  clearSecrets,
  generateHelperScript,
  runCleanup,
} from "../appCleanupService";

describe("AppCleanupService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // enumerateArtifacts — per-platform path enumeration (exact ID set, not counts)
  // ---------------------------------------------------------------------------
  describe("enumerateArtifacts", () => {
    it("macOS: derives data paths from getPath and resolves the .app bundle from exe ancestry", () => {
      const getPath = (name: string): string => {
        const map: Record<string, string> = {
          userData: "/Users/me/Library/Application Support/keepr",
          sessionData: "/Users/me/Library/Application Support/keepr/session",
          logs: "/Users/me/Library/Logs/keepr",
        };
        return map[name];
      };

      const result = enumerateArtifacts({
        platform: "darwin",
        exePath: "/Applications/Keepr.app/Contents/MacOS/Keepr",
        getPath: getPath as never,
      });

      // sessionData is nested under userData → deduped away. logs is separate.
      expect(new Set(result.dataPaths)).toEqual(
        new Set([
          "/Users/me/Library/Application Support/keepr",
          "/Users/me/Library/Logs/keepr",
        ]),
      );
      expect(result.appPath).toBe("/Applications/Keepr.app");
      expect(result.windowsUninstaller).toBeNull();
    });

    it("macOS: returns null appPath when exe is not inside a .app bundle", () => {
      const getPath = (name: string): string =>
        ({ userData: "/data", sessionData: "/data", logs: "/data" }[name] ?? "");
      const result = enumerateArtifacts({
        platform: "darwin",
        exePath: "/usr/local/bin/keepr",
        getPath: getPath as never,
      });
      expect(result.appPath).toBeNull();
    });

    it("Windows: derives data paths and resolves install dir + NSIS uninstaller", () => {
      const getPath = (name: string): string => {
        const map: Record<string, string> = {
          userData: "C:\\Users\\me\\AppData\\Roaming\\keepr",
          sessionData: "C:\\Users\\me\\AppData\\Roaming\\keepr\\session",
          logs: "C:\\Users\\me\\AppData\\Roaming\\keepr\\logs",
        };
        return map[name];
      };
      const existsSync = (p: string): boolean =>
        p === "C:\\Program Files\\Keepr\\Uninstall Keepr.exe";

      const result = enumerateArtifacts({
        platform: "win32",
        exePath: "C:\\Program Files\\Keepr\\Keepr.exe",
        getPath: getPath as never,
        existsSync,
      });

      // sessionData + logs nested under userData → deduped to just userData.
      expect(new Set(result.dataPaths)).toEqual(
        new Set(["C:\\Users\\me\\AppData\\Roaming\\keepr"]),
      );
      expect(result.appPath).toBe("C:\\Program Files\\Keepr");
      expect(result.windowsUninstaller).toBe(
        "C:\\Program Files\\Keepr\\Uninstall Keepr.exe",
      );
    });

    it("Windows: windowsUninstaller is null when no uninstaller exists", () => {
      const getPath = (name: string): string =>
        ({
          userData: "C:\\data",
          sessionData: "C:\\data",
          logs: "C:\\data",
        }[name] ?? "");
      const result = enumerateArtifacts({
        platform: "win32",
        exePath: "C:\\Program Files\\Keepr\\Keepr.exe",
        getPath: getPath as never,
        existsSync: () => false,
      });
      expect(result.windowsUninstaller).toBeNull();
      expect(result.appPath).toBe("C:\\Program Files\\Keepr");
    });
  });

  // ---------------------------------------------------------------------------
  // clearSecrets — in-process OS secret clearing
  // ---------------------------------------------------------------------------
  describe("clearSecrets", () => {
    it("macOS: runs `security delete-generic-password` for the keepr Safe Storage service", async () => {
      const runCommand = jest.fn().mockResolvedValue(undefined);
      await clearSecrets("darwin", runCommand);
      expect(runCommand).toHaveBeenCalledTimes(1);
      expect(runCommand).toHaveBeenCalledWith("security", [
        "delete-generic-password",
        "-s",
        "keepr Safe Storage",
      ]);
    });

    it("macOS: swallows a non-zero exit (entry absent) without throwing", async () => {
      const runCommand = jest.fn().mockRejectedValue(new Error("exit 44"));
      await expect(clearSecrets("darwin", runCommand)).resolves.toBeUndefined();
    });

    it("Windows: runs cmdkey /delete for each credential target", async () => {
      const runCommand = jest.fn().mockResolvedValue(undefined);
      await clearSecrets("win32", runCommand);
      const targets = runCommand.mock.calls.map((c) => c[1][0]);
      expect(new Set(targets)).toEqual(
        new Set([
          "/delete:keepr",
          "/delete:Keepr",
          "/delete:Keepr Safe Storage",
        ]),
      );
      expect(runCommand.mock.calls.every((c) => c[0] === "cmdkey")).toBe(true);
    });

    it("Windows: continues clearing remaining targets when one fails", async () => {
      const runCommand = jest
        .fn()
        .mockRejectedValueOnce(new Error("not found"))
        .mockResolvedValue(undefined);
      await clearSecrets("win32", runCommand);
      expect(runCommand).toHaveBeenCalledTimes(3);
    });
  });

  // ---------------------------------------------------------------------------
  // generateHelperScript — assert exact injected path SET, quoting, self-delete
  // ---------------------------------------------------------------------------
  describe("generateHelperScript", () => {
    it("macOS reset: deletes exactly the data paths, quotes spaces, waits on pid, self-deletes, NOT the app", () => {
      const script = generateHelperScript({
        platform: "darwin",
        pid: 4242,
        mode: "reset",
        dataPaths: [
          "/Users/me/Library/Application Support/keepr",
          "/Users/me/Library/Logs/keepr",
        ],
        appPath: "/Applications/Keepr.app",
        windowsUninstaller: null,
        selfPath: "/tmp/keepr-cleanup-reset-4242.sh",
      });

      expect(script).toContain("#!/bin/bash");
      expect(script).toContain("APP_PID=4242");
      expect(script).toContain('kill -0 "$APP_PID"');
      // Exact quoted path set present.
      expect(script).toContain("'/Users/me/Library/Application Support/keepr'");
      expect(script).toContain("'/Users/me/Library/Logs/keepr'");
      // Reset must NOT remove the app bundle.
      expect(script).not.toContain("rm -rf '/Applications/Keepr.app'");
      // Self-delete present.
      expect(script).toContain("rm -f '/tmp/keepr-cleanup-reset-4242.sh'");
    });

    it("macOS uninstall: additionally removes the .app bundle", () => {
      const script = generateHelperScript({
        platform: "darwin",
        pid: 1,
        mode: "uninstall",
        dataPaths: ["/data/keepr"],
        appPath: "/Applications/Keepr.app",
        windowsUninstaller: null,
        selfPath: "/tmp/x.sh",
      });
      expect(script).toContain("rm -rf '/Applications/Keepr.app'");
    });

    it("does not delete anything outside the injected path list", () => {
      const dataPaths = ["/data/keepr"];
      const script = generateHelperScript({
        platform: "darwin",
        pid: 1,
        mode: "reset",
        dataPaths,
        appPath: "/Applications/Keepr.app",
        windowsUninstaller: null,
        selfPath: "/tmp/x.sh",
      });
      // Only rm targets are: each data path, and the self script. (reset → no app)
      const rmTargets = [...script.matchAll(/rm -[rf]+ (.+)/g)].map((m) =>
        m[1].trim(),
      );
      // The array-based loop rm's "$p"; the explicit rm's are self only for reset.
      expect(script).toContain('rm -rf "$p"');
      expect(rmTargets).toContain("'/tmp/x.sh'");
      expect(rmTargets).not.toContain("'/Applications/Keepr.app'");
    });

    it("Windows uninstall with NSIS uninstaller: runs it silently instead of blind delete", () => {
      const script = generateHelperScript({
        platform: "win32",
        pid: 99,
        mode: "uninstall",
        dataPaths: ["C:\\Users\\me\\AppData\\Roaming\\keepr"],
        appPath: "C:\\Program Files\\Keepr",
        windowsUninstaller: "C:\\Program Files\\Keepr\\Uninstall Keepr.exe",
        selfPath: "C:\\Temp\\keepr-cleanup.ps1",
      });
      expect(script).toContain("$appPid = 99");
      expect(script).toContain("Get-Process -Id $appPid");
      expect(script).toContain(
        "'C:\\Users\\me\\AppData\\Roaming\\keepr'",
      );
      expect(script).toContain("'C:\\Program Files\\Keepr\\Uninstall Keepr.exe'");
      expect(script).toContain("-ArgumentList '/S'");
      expect(script).toContain("Remove-Item -LiteralPath 'C:\\Temp\\keepr-cleanup.ps1'");
    });

    it("Windows uninstall without NSIS uninstaller: deletes the install dir", () => {
      const script = generateHelperScript({
        platform: "win32",
        pid: 5,
        mode: "uninstall",
        dataPaths: ["C:\\data"],
        appPath: "C:\\Program Files\\Keepr",
        windowsUninstaller: null,
        selfPath: "C:\\Temp\\x.ps1",
      });
      expect(script).toContain(
        "$installDir = 'C:\\Program Files\\Keepr'",
      );
      expect(script).not.toContain("-ArgumentList '/S'");
    });

    it("Windows reset: does NOT touch the install dir", () => {
      const script = generateHelperScript({
        platform: "win32",
        pid: 5,
        mode: "reset",
        dataPaths: ["C:\\data"],
        appPath: "C:\\Program Files\\Keepr",
        windowsUninstaller: "C:\\Program Files\\Keepr\\Uninstall Keepr.exe",
        selfPath: "C:\\Temp\\x.ps1",
      });
      expect(script).not.toContain("$installDir");
      expect(script).not.toContain("$uninstaller");
    });

    it("single-quotes with embedded apostrophe are escaped (bash)", () => {
      const script = generateHelperScript({
        platform: "darwin",
        pid: 1,
        mode: "reset",
        dataPaths: ["/Users/O'Brien/data"],
        appPath: null,
        windowsUninstaller: null,
        selfPath: "/tmp/x.sh",
      });
      expect(script).toContain("'/Users/O'\\''Brien/data'");
    });
  });

  // ---------------------------------------------------------------------------
  // runCleanup — isPackaged guard, mode matrix, orchestration order
  // ---------------------------------------------------------------------------
  describe("runCleanup", () => {
    const baseArtifacts = {
      dataPaths: ["/data/keepr"],
      appPath: "/Applications/Keepr.app",
      windowsUninstaller: null,
    };

    function makeDeps(overrides: Record<string, unknown> = {}) {
      return {
        isPackaged: true,
        platform: "darwin" as NodeJS.Platform,
        pid: 1234,
        tmpdir: () => "/tmp",
        enumerate: jest.fn().mockReturnValue(baseArtifacts),
        clearSecretsFn: jest.fn().mockResolvedValue(undefined),
        writeScript: jest.fn().mockResolvedValue(undefined),
        spawnHelper: jest.fn(),
        relaunch: jest.fn(),
        quit: jest.fn(),
        ...overrides,
      };
    }

    it("refuses (no wipe) when the app is not packaged", async () => {
      const deps = makeDeps({ isPackaged: false });
      const result = await runCleanup({ mode: "uninstall" }, deps);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/development/i);
      expect(deps.clearSecretsFn).not.toHaveBeenCalled();
      expect(deps.writeScript).not.toHaveBeenCalled();
      expect(deps.spawnHelper).not.toHaveBeenCalled();
      expect(deps.quit).not.toHaveBeenCalled();
      expect(deps.relaunch).not.toHaveBeenCalled();
    });

    it("reset mode: clears secrets, writes+spawns helper, relaunches AND quits", async () => {
      const deps = makeDeps();
      const result = await runCleanup({ mode: "reset" }, deps);
      expect(result.success).toBe(true);
      expect(result.mode).toBe("reset");
      expect(deps.clearSecretsFn).toHaveBeenCalledWith("darwin");
      expect(deps.writeScript).toHaveBeenCalledTimes(1);
      expect(deps.spawnHelper).toHaveBeenCalledTimes(1);
      expect(deps.relaunch).toHaveBeenCalledTimes(1);
      expect(deps.quit).toHaveBeenCalledTimes(1);
      // reset does not report the app path as removed.
      expect(result.removedPaths).toEqual(["/data/keepr"]);
    });

    it("uninstall mode: quits WITHOUT relaunch and reports the app path removed", async () => {
      const deps = makeDeps();
      const result = await runCleanup({ mode: "uninstall" }, deps);
      expect(result.success).toBe(true);
      expect(result.mode).toBe("uninstall");
      expect(deps.relaunch).not.toHaveBeenCalled();
      expect(deps.quit).toHaveBeenCalledTimes(1);
      expect(result.removedPaths).toEqual([
        "/data/keepr",
        "/Applications/Keepr.app",
      ]);
    });

    it("writes the helper script into os.tmpdir with a mode/pid-stamped name", async () => {
      const deps = makeDeps();
      await runCleanup({ mode: "reset" }, deps);
      const scriptPath = (deps.writeScript as jest.Mock).mock.calls[0][0];
      expect(scriptPath).toMatch(/^\/tmp\/keepr-cleanup-reset-1234-\d+\.sh$/);
    });

    it("passes the enumerated path set (not a duplicated list) into the generated script", async () => {
      const deps = makeDeps();
      await runCleanup({ mode: "uninstall" }, deps);
      const scriptContents = (deps.writeScript as jest.Mock).mock.calls[0][1];
      expect(scriptContents).toContain("'/data/keepr'");
      expect(scriptContents).toContain("rm -rf '/Applications/Keepr.app'");
    });

    it("returns a typed error result if the helper cannot be written (no crash)", async () => {
      const deps = makeDeps({
        writeScript: jest.fn().mockRejectedValue(new Error("disk full")),
      });
      const result = await runCleanup({ mode: "reset" }, deps);
      expect(result.success).toBe(false);
      expect(result.error).toBe("disk full");
      // Must not have proceeded to spawn/relaunch/quit.
      expect(deps.spawnHelper).not.toHaveBeenCalled();
      expect(deps.relaunch).not.toHaveBeenCalled();
    });

    // -------------------------------------------------------------------------
    // beforeWipe seam (BACKLOG-2113) timeout behavior
    // -------------------------------------------------------------------------
    it("awaits the beforeWipe hook before clearing secrets", async () => {
      const order: string[] = [];
      const deps = makeDeps({
        clearSecretsFn: jest.fn().mockImplementation(async () => {
          order.push("clearSecrets");
        }),
      });
      const beforeWipe = jest.fn().mockImplementation(async () => {
        order.push("beforeWipe");
      });
      await runCleanup({ mode: "reset", beforeWipe }, deps);
      expect(order).toEqual(["beforeWipe", "clearSecrets"]);
    });

    it("does not block the wipe when beforeWipe hangs (3s timeout guard)", async () => {
      jest.useFakeTimers();
      try {
        const deps = makeDeps();
        // A hook that never resolves — the timeout must release the wipe.
        const beforeWipe = jest.fn().mockImplementation(
          () => new Promise<void>(() => {}),
        );
        const promise = runCleanup({ mode: "reset", beforeWipe }, deps);
        // Advance past the 3s timeout guard.
        await jest.advanceTimersByTimeAsync(3000);
        const result = await promise;
        expect(result.success).toBe(true);
        expect(deps.spawnHelper).toHaveBeenCalledTimes(1);
      } finally {
        jest.useRealTimers();
      }
    });

    it("does not abort the wipe when beforeWipe throws", async () => {
      const deps = makeDeps();
      const beforeWipe = jest.fn().mockRejectedValue(new Error("logging down"));
      const result = await runCleanup({ mode: "reset", beforeWipe }, deps);
      expect(result.success).toBe(true);
      expect(deps.clearSecretsFn).toHaveBeenCalled();
    });
  });
});
