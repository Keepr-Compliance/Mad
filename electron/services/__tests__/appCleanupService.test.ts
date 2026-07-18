/**
 * App Cleanup Service Tests
 * BACKLOG-2111: App-data cleanup engine + detached uninstall helper.
 *
 * Exercises pure logic (enumeration incl. superset extras, script generation
 * incl. timeout-abort / helper-owned relaunch / Windows reparse pre-pass,
 * install-dir sanity matrix, secret clearing, isPackaged guard, exit(0)
 * ordering, beforeWipe timeout) via injected dependency seams. NO real
 * filesystem is wiped and no real process is spawned.
 */

const mockExit = jest.fn();
jest.mock("electron", () => ({
  app: {
    get isPackaged() {
      return true;
    },
    getPath: jest.fn(() => "/tmp/test"),
    exit: (...args: unknown[]) => mockExit(...args),
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
  isWindowsInstallDirSafeToDelete,
  runCleanup,
  type HelperScriptParams,
} from "../appCleanupService";

/** Base params for generateHelperScript; override per test. */
function helperParams(over: Partial<HelperScriptParams>): HelperScriptParams {
  return {
    platform: "darwin",
    pid: 4242,
    mode: "reset",
    dataPaths: ["/data/keepr"],
    appPath: null,
    windowsUninstaller: null,
    appPathUnsafe: false,
    relaunchTarget: null,
    selfPath: "/tmp/keepr-cleanup.sh",
    failureMarker: "/tmp/keepr-cleanup.failed",
    ...over,
  };
}

describe("AppCleanupService", () => {
  beforeEach(() => jest.clearAllMocks());

  // ---------------------------------------------------------------------------
  // enumerateArtifacts — per-platform + SUPERSET extras (exact-ID sets)
  // ---------------------------------------------------------------------------
  describe("enumerateArtifacts", () => {
    it("macOS: userData + separate logs + existence-checked updater caches (superset)", () => {
      const getPath = (name: string): string =>
        ({
          userData: "/Users/me/Library/Application Support/keepr",
          sessionData: "/Users/me/Library/Application Support/keepr/session",
          logs: "/Users/me/Library/Logs/keepr",
          home: "/Users/me",
        }[name] ?? "");
      // Both mac updater caches exist.
      const existsSync = (p: string): boolean =>
        p === "/Users/me/Library/Caches/keepr" ||
        p === "/Users/me/Library/Caches/keepr-updater";

      const result = enumerateArtifacts({
        platform: "darwin",
        exePath: "/Applications/Keepr.app/Contents/MacOS/Keepr",
        getPath: getPath as never,
        existsSync,
      });

      expect(new Set(result.dataPaths)).toEqual(
        new Set([
          "/Users/me/Library/Application Support/keepr",
          "/Users/me/Library/Logs/keepr",
          "/Users/me/Library/Caches/keepr",
          "/Users/me/Library/Caches/keepr-updater",
        ]),
      );
      expect(result.appPath).toBe("/Applications/Keepr.app");
      expect(result.windowsUninstaller).toBeNull();
      expect(result.appPathUnsafe).toBe(false);
    });

    it("macOS: non-existent updater caches are NOT injected", () => {
      const getPath = (name: string): string =>
        ({
          userData: "/data/keepr",
          sessionData: "/data/keepr",
          logs: "/data/keepr",
          home: "/Users/me",
        }[name] ?? "");
      const result = enumerateArtifacts({
        platform: "darwin",
        exePath: "/Applications/Keepr.app/Contents/MacOS/Keepr",
        getPath: getPath as never,
        existsSync: () => false,
      });
      expect(new Set(result.dataPaths)).toEqual(new Set(["/data/keepr"]));
    });

    it("Windows: userData + %LOCALAPPDATA%\\keepr + keepr-updater (existence-checked superset)", () => {
      const getPath = (name: string): string =>
        ({
          userData: "C:\\Users\\me\\AppData\\Roaming\\keepr",
          sessionData: "C:\\Users\\me\\AppData\\Roaming\\keepr\\session",
          logs: "C:\\Users\\me\\AppData\\Roaming\\keepr\\logs",
          home: "C:\\Users\\me",
        }[name] ?? "");
      const localAppData = "C:\\Users\\me\\AppData\\Local";
      const existsSync = (p: string): boolean =>
        p === "C:\\Users\\me\\AppData\\Local\\keepr" ||
        p === "C:\\Users\\me\\AppData\\Local\\keepr-updater" ||
        p === "C:\\Program Files\\Keepr\\Uninstall Keepr.exe" ||
        p === "C:\\Program Files\\Keepr\\resources\\app.asar";

      const result = enumerateArtifacts({
        platform: "win32",
        exePath: "C:\\Program Files\\Keepr\\Keepr.exe",
        getPath: getPath as never,
        existsSync,
        localAppData,
      });

      expect(new Set(result.dataPaths)).toEqual(
        new Set([
          "C:\\Users\\me\\AppData\\Roaming\\keepr",
          "C:\\Users\\me\\AppData\\Local\\keepr",
          "C:\\Users\\me\\AppData\\Local\\keepr-updater",
        ]),
      );
      expect(result.appPath).toBe("C:\\Program Files\\Keepr");
      expect(result.windowsUninstaller).toBe(
        "C:\\Program Files\\Keepr\\Uninstall Keepr.exe",
      );
    });

    it("Windows: no uninstaller + safe install dir → appPathUnsafe false", () => {
      const getPath = (name: string): string =>
        ({ userData: "C:\\d", sessionData: "C:\\d", logs: "C:\\d", home: "C:\\Users\\me" }[
          name
        ] ?? "");
      const existsSync = (p: string): boolean =>
        p === "C:\\Program Files\\Keepr\\resources\\app.asar";
      const result = enumerateArtifacts({
        platform: "win32",
        exePath: "C:\\Program Files\\Keepr\\Keepr.exe",
        getPath: getPath as never,
        existsSync,
        localAppData: undefined,
      });
      expect(result.windowsUninstaller).toBeNull();
      expect(result.appPathUnsafe).toBe(false);
    });

    it("Windows: no uninstaller + UNSAFE dir (Downloads, no asar) → appPathUnsafe true", () => {
      const getPath = (name: string): string =>
        ({ userData: "C:\\d", sessionData: "C:\\d", logs: "C:\\d", home: "C:\\Users\\me" }[
          name
        ] ?? "");
      const result = enumerateArtifacts({
        platform: "win32",
        exePath: "C:\\Users\\me\\Downloads\\Keepr.exe",
        getPath: getPath as never,
        existsSync: () => false,
        localAppData: undefined,
      });
      expect(result.appPath).toBe("C:\\Users\\me\\Downloads");
      expect(result.appPathUnsafe).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // isWindowsInstallDirSafeToDelete — fallback sanity matrix
  // ---------------------------------------------------------------------------
  describe("isWindowsInstallDirSafeToDelete", () => {
    const asarExists = (dir: string) => (p: string): boolean =>
      p === `${dir}\\resources\\app.asar`;

    it("safe: proper per-user install dir with exe + asar + 'keepr' basename", () => {
      const dir = "C:\\Users\\me\\AppData\\Local\\Programs\\keepr";
      expect(
        isWindowsInstallDirSafeToDelete(dir, `${dir}\\Keepr.exe`, asarExists(dir)),
      ).toBe(true);
    });

    it("safe: Program Files\\Keepr per-machine", () => {
      const dir = "C:\\Program Files\\Keepr";
      expect(
        isWindowsInstallDirSafeToDelete(dir, `${dir}\\Keepr.exe`, asarExists(dir)),
      ).toBe(true);
    });

    it("UNSAFE: Downloads (no asar, basename not keepr)", () => {
      const dir = "C:\\Users\\me\\Downloads";
      expect(
        isWindowsInstallDirSafeToDelete(dir, `${dir}\\Keepr.exe`, () => false),
      ).toBe(false);
    });

    it("UNSAFE: drive root C:\\", () => {
      expect(
        isWindowsInstallDirSafeToDelete("C:\\", "C:\\Keepr.exe", () => true),
      ).toBe(false);
    });

    it("UNSAFE: keepr-named dir but exe lives elsewhere", () => {
      const dir = "C:\\Program Files\\Keepr";
      expect(
        isWindowsInstallDirSafeToDelete(
          dir,
          "C:\\Users\\me\\Downloads\\Keepr.exe",
          asarExists(dir),
        ),
      ).toBe(false);
    });

    it("UNSAFE: keepr-named dir but no resources\\app.asar", () => {
      const dir = "C:\\Program Files\\Keepr";
      expect(
        isWindowsInstallDirSafeToDelete(dir, `${dir}\\Keepr.exe`, () => false),
      ).toBe(false);
    });

    it("UNSAFE: protected user folder even if it contained keepr string", () => {
      const dir = "C:\\Users\\me\\Documents";
      expect(
        isWindowsInstallDirSafeToDelete(dir, `${dir}\\Keepr.exe`, () => true),
      ).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // clearSecrets
  // ---------------------------------------------------------------------------
  describe("clearSecrets", () => {
    it("macOS: security delete-generic-password for keepr Safe Storage", async () => {
      const runCommand = jest.fn().mockResolvedValue(undefined);
      await clearSecrets("darwin", runCommand);
      expect(runCommand).toHaveBeenCalledWith("security", [
        "delete-generic-password",
        "-s",
        "keepr Safe Storage",
      ]);
    });

    it("macOS: swallows non-zero exit (entry absent)", async () => {
      const runCommand = jest.fn().mockRejectedValue(new Error("exit 44"));
      await expect(clearSecrets("darwin", runCommand)).resolves.toBeUndefined();
    });

    it("Windows: cmdkey /delete for each target, continues on failure", async () => {
      const runCommand = jest
        .fn()
        .mockRejectedValueOnce(new Error("not found"))
        .mockResolvedValue(undefined);
      await clearSecrets("win32", runCommand);
      const targets = runCommand.mock.calls.map((c) => c[1][0]);
      expect(new Set(targets)).toEqual(
        new Set(["/delete:keepr", "/delete:Keepr", "/delete:Keepr Safe Storage"]),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // generateHelperScript — timeout-abort, reparse pre-pass, helper-owned relaunch
  // ---------------------------------------------------------------------------
  describe("generateHelperScript", () => {
    it("bash: ABORTS (deletes nothing, writes failure marker) when app still alive at timeout", () => {
      const script = generateHelperScript(
        helperParams({ platform: "darwin", mode: "reset" }),
      );
      // The abort branch runs BEFORE any rm of the PATHS array.
      expect(script).toContain('if [ "$ALIVE" -eq 1 ]; then');
      expect(script).toContain(
        "echo 'app-still-alive-at-timeout' > '/tmp/keepr-cleanup.failed'",
      );
      // Abort self-deletes and exits before the delete loop.
      const abortIdx = script.indexOf("$ALIVE");
      const rmLoopIdx = script.indexOf('for p in "${PATHS[@]}"');
      const exitIdx = script.indexOf("exit 1");
      expect(exitIdx).toBeGreaterThan(abortIdx);
      expect(exitIdx).toBeLessThan(rmLoopIdx);
    });

    it("bash reset: relaunches via `open` AFTER the wipe (helper owns relaunch)", () => {
      const script = generateHelperScript(
        helperParams({
          platform: "darwin",
          mode: "reset",
          appPath: "/Applications/Keepr.app",
          relaunchTarget: "/Applications/Keepr.app",
        }),
      );
      const rmIdx = script.indexOf('rm -rf "$p"');
      const openIdx = script.indexOf("open '/Applications/Keepr.app'");
      expect(openIdx).toBeGreaterThan(rmIdx);
      // reset must NOT remove the app bundle.
      expect(script).not.toContain("rm -rf '/Applications/Keepr.app'");
    });

    it("bash uninstall: removes the .app and does NOT relaunch", () => {
      const script = generateHelperScript(
        helperParams({
          platform: "darwin",
          mode: "uninstall",
          appPath: "/Applications/Keepr.app",
          relaunchTarget: null,
        }),
      );
      expect(script).toContain("rm -rf '/Applications/Keepr.app'");
      expect(script).not.toContain("open '/Applications/Keepr.app'");
    });

    it("bash: quotes embedded apostrophes", () => {
      const script = generateHelperScript(
        helperParams({ platform: "darwin", dataPaths: ["/Users/O'Brien/data"] }),
      );
      expect(script).toContain("'/Users/O'\\''Brien/data'");
    });

    it("PS: ABORTS (delete nothing, marker) when app still alive at timeout", () => {
      const script = generateHelperScript(
        helperParams({
          platform: "win32",
          selfPath: "C:\\Temp\\x.ps1",
          failureMarker: "C:\\Temp\\x.failed",
          dataPaths: ["C:\\data\\keepr"],
        }),
      );
      expect(script).toContain("if ($alive) {");
      expect(script).toContain(
        "Set-Content -LiteralPath 'C:\\Temp\\x.failed' -Value 'app-still-alive-at-timeout'",
      );
      const aliveIdx = script.indexOf("if ($alive) {");
      const pathsIdx = script.indexOf("$paths = @(");
      expect(aliveIdx).toBeLessThan(pathsIdx);
    });

    it("PS: reparse-point pre-pass removes junctions LINK-ONLY before recursive delete", () => {
      const script = generateHelperScript(
        helperParams({
          platform: "win32",
          selfPath: "C:\\Temp\\x.ps1",
          failureMarker: "C:\\Temp\\x.failed",
          dataPaths: ["C:\\data\\keepr"],
        }),
      );
      expect(script).toContain("-Attributes ReparsePoint");
      expect(script).toContain("[IO.Directory]::Delete($rp, $false)");
      // The pre-pass must appear before the recursive Remove-Item of the dir.
      const reparseIdx = script.indexOf("-Attributes ReparsePoint");
      const recurseIdx = script.indexOf("Remove-Item -LiteralPath $p -Recurse -Force");
      expect(reparseIdx).toBeLessThan(recurseIdx);
    });

    it("PS uninstall with NSIS uninstaller: try/catch + exit-code check, guarded fallback", () => {
      const script = generateHelperScript(
        helperParams({
          platform: "win32",
          mode: "uninstall",
          appPath: "C:\\Program Files\\Keepr",
          windowsUninstaller: "C:\\Program Files\\Keepr\\Uninstall Keepr.exe",
          appPathUnsafe: false,
          selfPath: "C:\\Temp\\x.ps1",
          failureMarker: "C:\\Temp\\x.failed",
        }),
      );
      expect(script).toContain("-ArgumentList '/S' -Wait -PassThru");
      expect(script).toContain("$proc.ExitCode -eq 0");
      expect(script).toContain("try {");
      expect(script).toContain("if (-not $uninstalled) {");
      // Safe fallback deletes the install dir.
      expect(script).toContain("$installDir = 'C:\\Program Files\\Keepr'");
    });

    it("PS uninstall: uninstaller fails AND dir unsafe → marks failure, NO blind delete", () => {
      const script = generateHelperScript(
        helperParams({
          platform: "win32",
          mode: "uninstall",
          appPath: "C:\\Users\\me\\Downloads",
          windowsUninstaller: "C:\\Users\\me\\Downloads\\Uninstall Keepr.exe",
          appPathUnsafe: true,
          selfPath: "C:\\Temp\\x.ps1",
          failureMarker: "C:\\Temp\\x.failed",
        }),
      );
      expect(script).toContain("uninstaller-failed-and-dir-unsafe");
      expect(script).not.toContain("Remove-Item -LiteralPath $installDir");
    });

    it("PS uninstall: no uninstaller + unsafe dir → skip removal, marker, no delete", () => {
      const script = generateHelperScript(
        helperParams({
          platform: "win32",
          mode: "uninstall",
          appPath: "C:\\Users\\me\\Downloads",
          windowsUninstaller: null,
          appPathUnsafe: true,
          selfPath: "C:\\Temp\\x.ps1",
          failureMarker: "C:\\Temp\\x.failed",
        }),
      );
      expect(script).toContain("install-dir-unsafe-skipped");
      expect(script).not.toContain("Remove-Item -LiteralPath $installDir");
    });

    it("PS reset: relaunches via Start-Process AFTER wipe; no install-dir touch", () => {
      const script = generateHelperScript(
        helperParams({
          platform: "win32",
          mode: "reset",
          appPath: "C:\\Program Files\\Keepr",
          relaunchTarget: "C:\\Program Files\\Keepr\\Keepr.exe",
          selfPath: "C:\\Temp\\x.ps1",
          failureMarker: "C:\\Temp\\x.failed",
        }),
      );
      expect(script).toContain(
        "Start-Process -FilePath 'C:\\Program Files\\Keepr\\Keepr.exe'",
      );
      expect(script).not.toContain("$installDir");
    });
  });

  // ---------------------------------------------------------------------------
  // runCleanup — guard, exit(0) not quit/relaunch, mode matrix, ordering
  // ---------------------------------------------------------------------------
  describe("runCleanup", () => {
    const baseArtifacts = {
      dataPaths: ["/data/keepr"],
      appPath: "/Applications/Keepr.app",
      windowsUninstaller: null,
      appPathUnsafe: false,
    };

    function makeDeps(over: Record<string, unknown> = {}) {
      return {
        isPackaged: true,
        platform: "darwin" as NodeJS.Platform,
        pid: 1234,
        exePath: "/Applications/Keepr.app/Contents/MacOS/Keepr",
        tmpdir: () => "/tmp",
        enumerate: jest.fn().mockReturnValue(baseArtifacts),
        clearSecretsFn: jest.fn().mockResolvedValue(undefined),
        writeScript: jest.fn().mockResolvedValue(undefined),
        spawnHelper: jest.fn(),
        exit: jest.fn(),
        ...over,
      };
    }

    it("refuses (no wipe) when app is not packaged", async () => {
      const deps = makeDeps({ isPackaged: false });
      const result = await runCleanup({ mode: "uninstall" }, deps);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/development/i);
      expect(deps.clearSecretsFn).not.toHaveBeenCalled();
      expect(deps.spawnHelper).not.toHaveBeenCalled();
      expect(deps.exit).not.toHaveBeenCalled();
    });

    it("reset: clears secrets, writes+spawns helper, exits via exit(0) — never relaunches itself", async () => {
      const deps = makeDeps();
      const result = await runCleanup({ mode: "reset" }, deps);
      expect(result.success).toBe(true);
      expect(deps.clearSecretsFn).toHaveBeenCalledWith("darwin");
      expect(deps.writeScript).toHaveBeenCalledTimes(1);
      expect(deps.spawnHelper).toHaveBeenCalledTimes(1);
      expect(deps.exit).toHaveBeenCalledWith(0);
      expect(result.removedPaths).toEqual(["/data/keepr"]);
    });

    it("reset: injects the relaunch target into the generated script (helper owns relaunch)", async () => {
      const deps = makeDeps();
      await runCleanup({ mode: "reset" }, deps);
      const contents = (deps.writeScript as jest.Mock).mock.calls[0][1];
      expect(contents).toContain("open '/Applications/Keepr.app'");
    });

    it("uninstall: reports app path removed, no relaunch target injected", async () => {
      const deps = makeDeps();
      const result = await runCleanup({ mode: "uninstall" }, deps);
      expect(result.removedPaths).toEqual(["/data/keepr", "/Applications/Keepr.app"]);
      const contents = (deps.writeScript as jest.Mock).mock.calls[0][1];
      expect(contents).toContain("rm -rf '/Applications/Keepr.app'");
      expect(contents).not.toContain("open '/Applications/Keepr.app'");
    });

    it("uninstall: appPath null → appRemovalSkipped, data still wiped", async () => {
      const deps = makeDeps({
        enumerate: jest.fn().mockReturnValue({
          ...baseArtifacts,
          appPath: null,
        }),
      });
      const result = await runCleanup({ mode: "uninstall" }, deps);
      expect(result.appRemovalSkipped).toBe(true);
      expect(result.removedPaths).toEqual(["/data/keepr"]);
    });

    it("uninstall (win): unsafe dir + no uninstaller → appRemovalSkipped true", async () => {
      const deps = makeDeps({
        platform: "win32" as NodeJS.Platform,
        exePath: "C:\\Users\\me\\Downloads\\Keepr.exe",
        tmpdir: () => "C:\\Temp",
        enumerate: jest.fn().mockReturnValue({
          dataPaths: ["C:\\data\\keepr"],
          appPath: "C:\\Users\\me\\Downloads",
          windowsUninstaller: null,
          appPathUnsafe: true,
        }),
      });
      const result = await runCleanup({ mode: "uninstall" }, deps);
      expect(result.appRemovalSkipped).toBe(true);
      expect(result.removedPaths).toEqual(["C:\\data\\keepr"]);
    });

    it("script name is mode/pid stamped in tmpdir", async () => {
      const deps = makeDeps();
      await runCleanup({ mode: "reset" }, deps);
      const scriptPath = (deps.writeScript as jest.Mock).mock.calls[0][0];
      expect(scriptPath).toMatch(/^\/tmp\/keepr-cleanup-reset-1234-\d+\.sh$/);
    });

    it("returns typed error if helper cannot be written (no crash, no exit)", async () => {
      const deps = makeDeps({
        writeScript: jest.fn().mockRejectedValue(new Error("disk full")),
      });
      const result = await runCleanup({ mode: "reset" }, deps);
      expect(result.success).toBe(false);
      expect(result.error).toBe("disk full");
      expect(deps.spawnHelper).not.toHaveBeenCalled();
      expect(deps.exit).not.toHaveBeenCalled();
    });

    it("awaits beforeWipe before clearing secrets", async () => {
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

    it("does not block the wipe when beforeWipe hangs (3s timeout)", async () => {
      jest.useFakeTimers();
      try {
        const deps = makeDeps();
        const beforeWipe = jest
          .fn()
          .mockImplementation(() => new Promise<void>(() => {}));
        const promise = runCleanup({ mode: "reset", beforeWipe }, deps);
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
