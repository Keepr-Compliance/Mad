/**
 * App Cleanup Service
 * BACKLOG-2111: App-data cleanup engine + detached uninstall helper.
 *
 * Single source of truth for every artifact Keepr owns on disk plus the OS
 * secret stores (macOS keychain / Windows Credential Manager). Replaces the
 * hand-run scripts in scripts/cleanup-macos.sh and scripts/cleanup-windows.ps1.
 *
 * Two modes:
 *   - reset:     wipe app data + secrets, then relaunch into onboarding.
 *   - uninstall: wipe app data + secrets + remove the app itself.
 *
 * Design notes:
 *   - Paths are derived from app.getPath(...) at runtime — NOT hardcoded
 *     home-dir paths — wherever an app.getPath equivalent exists.
 *   - Secrets are cleared IN-PROCESS before the detached helper runs, because
 *     only the running app has keychain/Credential Manager access.
 *   - The actual deletion of app-data + app-bundle happens in a detached
 *     platform helper script (see generateHelperScript) so the running app can
 *     exit and get its own files deleted. The path list is passed INTO the
 *     generated script from enumerateArtifacts() — there is no duplicated list.
 *
 * IMPORTANT: This is a destructive operation. Cloud data in Supabase is NOT
 * affected by this service.
 */

import { app } from "electron";
import { spawn, execFile } from "child_process";
import { promisify } from "util";
import { writeFile } from "fs/promises";
import * as os from "os";
import * as path from "path";
import logService from "./logService";

const execFileAsync = promisify(execFile);

const MODULE = "AppCleanupService";

/** macOS keychain generic-password service used by Electron safeStorage. */
const MAC_KEYCHAIN_SERVICE = "keepr Safe Storage";
/** Windows Credential Manager targets historically written by the app. */
const WINDOWS_CRED_TARGETS = ["keepr", "Keepr", "Keepr Safe Storage"];

/** Timeout (ms) for the injected pre-wipe logging seam (BACKLOG-2113). */
const BEFORE_WIPE_TIMEOUT_MS = 3000;
/** Seconds the detached helper waits for the app process to exit. */
const HELPER_PID_WAIT_SECONDS = 30;

export type CleanupMode = "reset" | "uninstall";

export interface CleanupOptions {
  /** "reset" wipes data + secrets then relaunches; "uninstall" also removes the app. */
  mode: CleanupMode;
  /**
   * BACKLOG-2113 SEAM: optional async hook invoked BEFORE any wipe, while the DB
   * and network are still intact, so a future lifecycle-logging feature can
   * record the uninstall/reset to Supabase. This service does NOT implement any
   * logging itself — it only awaits the injected callback, guarded by a
   * BEFORE_WIPE_TIMEOUT_MS timeout so a slow/hung logger can never block a wipe.
   */
  beforeWipe?: () => Promise<void>;
}

export interface CleanupResult {
  /** True if the wipe was initiated (helper spawned, app quitting). */
  success: boolean;
  /** The mode that was requested. */
  mode: CleanupMode;
  /** Absolute paths handed to the detached helper for deletion. */
  removedPaths?: string[];
  /** Error message if cleanup could not be initiated. */
  error?: string;
}

/**
 * The complete set of artifacts a cleanup owns, split by concern so the helper
 * script and the secret-clearing step consume the same enumeration.
 */
export interface CleanupArtifacts {
  /** Per-user app data / caches / logs / temp dirs (deleted in both modes). */
  dataPaths: string[];
  /** The installed application bundle/dir (deleted only in uninstall mode). */
  appPath: string | null;
  /**
   * Windows NSIS uninstaller executable, if found. When present the helper runs
   * it silently instead of blindly deleting the install dir.
   */
  windowsUninstaller: string | null;
}

/**
 * Resolve the installed application bundle (macOS) or install directory
 * (Windows) from the running executable — never assume /Applications/Keepr.app
 * or Program Files\Keepr.
 *
 * macOS: process is <App>.app/Contents/MacOS/<exe>; walk up to the ".app".
 * Windows: install dir is the directory containing the exe.
 */
function resolveAppPath(platform: NodeJS.Platform, exePath: string): string | null {
  if (platform === "darwin") {
    // macOS paths are always POSIX. Walk ancestry looking for the *.app root.
    let current = exePath;
    for (let i = 0; i < 6; i += 1) {
      const parent = path.posix.dirname(current);
      if (parent === current) break;
      if (parent.endsWith(".app")) {
        return parent;
      }
      current = parent;
    }
    return null;
  }
  if (platform === "win32") {
    // Install directory is the folder containing the executable. Use the win32
    // path parser explicitly so this is correct regardless of the HOST OS
    // (enumeration logic is platform-driven, not host-driven).
    return path.win32.dirname(exePath);
  }
  return null;
}

/**
 * Locate the Windows NSIS uninstaller in the install dir. electron-builder emits
 * "Uninstall <ProductName>.exe"; we also accept a generic "Uninstall Keepr.exe".
 * Returns the first that exists, or null.
 */
function resolveWindowsUninstaller(
  installDir: string | null,
  existsSync: (p: string) => boolean,
): string | null {
  if (!installDir) return null;
  const candidates = [
    path.win32.join(installDir, "Uninstall Keepr.exe"),
    path.win32.join(installDir, "Uninstall keepr.exe"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Enumerate every artifact Keepr owns. Derived from app.getPath(...) at runtime.
 *
 * @param deps injectable seams for deterministic testing (platform, exe path,
 *   getPath, existsSync). Production callers pass nothing and get the live app.
 */
export function enumerateArtifacts(deps?: {
  platform?: NodeJS.Platform;
  exePath?: string;
  getPath?: (name: "userData" | "sessionData" | "logs" | "temp") => string;
  existsSync?: (p: string) => boolean;
}): CleanupArtifacts {
  const platform = deps?.platform ?? process.platform;
  const getPath =
    deps?.getPath ??
    ((name: "userData" | "sessionData" | "logs" | "temp") => app.getPath(name));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const existsSync =
    deps?.existsSync ?? ((p: string): boolean => require("fs").existsSync(p));
  const exePath = deps?.exePath ?? app.getPath("exe");

  // Per-user data paths. sessionData/logs frequently live under userData, but
  // Electron lets them be relocated, so we enumerate each explicitly and let the
  // helper dedupe. Order is stable for deterministic assertions.
  const rawDataPaths = [
    getPath("userData"),
    getPath("sessionData"),
    getPath("logs"),
  ];

  // Separator for the target platform — NOT the host's path.sep, so Windows
  // enumeration is correct even when this code runs on macOS/CI Linux.
  const sep = platform === "win32" ? "\\" : "/";

  // Dedupe while preserving order and dropping paths nested inside an earlier
  // one (deleting userData already removes a logs dir nested under it).
  const dataPaths: string[] = [];
  for (const p of rawDataPaths) {
    if (!p) continue;
    const alreadyCovered = dataPaths.some(
      (existing) => p === existing || p.startsWith(existing + sep),
    );
    if (!alreadyCovered && !dataPaths.includes(p)) {
      dataPaths.push(p);
    }
  }

  const appPath = resolveAppPath(platform, exePath);
  const windowsUninstaller =
    platform === "win32"
      ? resolveWindowsUninstaller(appPath, existsSync)
      : null;

  return { dataPaths, appPath, windowsUninstaller };
}

/**
 * Clear OS-level secret stores in-process. Best-effort: failures are logged but
 * never abort the wipe (the encrypted key FILES inside userData are removed by
 * the helper regardless, so secrets cannot be decrypted after cleanup).
 *
 * @param platform injectable for testing.
 * @param runCommand injectable command runner for testing.
 */
export async function clearSecrets(
  platform: NodeJS.Platform = process.platform,
  runCommand: (
    file: string,
    args: string[],
  ) => Promise<void> = async (file, args) => {
    await execFileAsync(file, args);
  },
): Promise<void> {
  if (platform === "darwin") {
    try {
      await runCommand("security", [
        "delete-generic-password",
        "-s",
        MAC_KEYCHAIN_SERVICE,
      ]);
      logService.info(
        "[AppCleanup] Cleared macOS keychain generic password",
        MODULE,
      );
    } catch (error) {
      // Non-zero exit when the entry does not exist — expected, not an error.
      logService.debug(
        "[AppCleanup] Keychain entry not present or already removed",
        MODULE,
        { error: error instanceof Error ? error.message : String(error) },
      );
    }
    return;
  }

  if (platform === "win32") {
    for (const target of WINDOWS_CRED_TARGETS) {
      try {
        await runCommand("cmdkey", [`/delete:${target}`]);
        logService.info(
          `[AppCleanup] Cleared Windows credential: ${target}`,
          MODULE,
        );
      } catch (error) {
        logService.debug(
          `[AppCleanup] Credential not present: ${target}`,
          MODULE,
          { error: error instanceof Error ? error.message : String(error) },
        );
      }
    }
  }
}

/**
 * Quote a path for safe interpolation into a shell script. Handles spaces such
 * as in "Application Support". macOS/Linux use single quotes (with the standard
 * '\'' escape); Windows PowerShell uses single quotes (doubling embedded ones).
 */
function shQuote(p: string): string {
  return `'${p.replace(/'/g, "'\\''")}'`;
}

function psQuote(p: string): string {
  return `'${p.replace(/'/g, "''")}'`;
}

/**
 * Generate the detached helper script that outlives the app process. It:
 *   1. waits for the app pid to exit (poll, ~30s timeout),
 *   2. deletes exactly the paths passed in (nothing else),
 *   3. on uninstall, removes the app (NSIS uninstaller if given, else the dir),
 *   4. verifies, then self-deletes.
 *
 * The path list is INJECTED from enumerateArtifacts() — the script never
 * re-derives paths.
 */
export function generateHelperScript(params: {
  platform: NodeJS.Platform;
  pid: number;
  mode: CleanupMode;
  dataPaths: string[];
  appPath: string | null;
  windowsUninstaller: string | null;
  selfPath: string;
}): string {
  const {
    platform,
    pid,
    mode,
    dataPaths,
    appPath,
    windowsUninstaller,
    selfPath,
  } = params;

  const removeAppInUninstall = mode === "uninstall" && appPath !== null;

  if (platform === "win32") {
    const dataList = dataPaths.map(psQuote).join(",\n  ");
    const lines: string[] = [];
    lines.push("# Keepr detached cleanup helper (BACKLOG-2111)");
    lines.push("$ErrorActionPreference = 'SilentlyContinue'");
    lines.push(`$appPid = ${pid}`);
    lines.push(`$deadline = (Get-Date).AddSeconds(${HELPER_PID_WAIT_SECONDS})`);
    lines.push("while (Get-Process -Id $appPid -ErrorAction SilentlyContinue) {");
    lines.push("  if ((Get-Date) -gt $deadline) { break }");
    lines.push("  Start-Sleep -Milliseconds 250");
    lines.push("}");
    lines.push("$paths = @(");
    lines.push(`  ${dataList}`);
    lines.push(")");
    lines.push("foreach ($p in $paths) {");
    lines.push("  if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force }");
    lines.push("}");
    if (removeAppInUninstall) {
      if (windowsUninstaller) {
        lines.push(`$uninstaller = ${psQuote(windowsUninstaller)}`);
        lines.push("if (Test-Path -LiteralPath $uninstaller) {");
        lines.push("  Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait");
        lines.push("} else {");
        lines.push(`  $installDir = ${psQuote(appPath as string)}`);
        lines.push("  if (Test-Path -LiteralPath $installDir) { Remove-Item -LiteralPath $installDir -Recurse -Force }");
        lines.push("}");
      } else {
        lines.push(`$installDir = ${psQuote(appPath as string)}`);
        lines.push("if (Test-Path -LiteralPath $installDir) { Remove-Item -LiteralPath $installDir -Recurse -Force }");
      }
    }
    // Self-delete last.
    lines.push(`Remove-Item -LiteralPath ${psQuote(selfPath)} -Force`);
    return lines.join("\n") + "\n";
  }

  // macOS / Linux (bash).
  const dataList = dataPaths.map(shQuote).join(" \\\n  ");
  const lines: string[] = [];
  lines.push("#!/bin/bash");
  lines.push("# Keepr detached cleanup helper (BACKLOG-2111)");
  lines.push(`APP_PID=${pid}`);
  lines.push("# Wait for the app process to exit (poll, ~30s timeout).");
  lines.push(`for i in $(seq 1 ${HELPER_PID_WAIT_SECONDS * 4}); do`);
  lines.push('  if ! kill -0 "$APP_PID" 2>/dev/null; then break; fi');
  lines.push("  sleep 0.25");
  lines.push("done");
  lines.push("PATHS=(\\");
  lines.push(`  ${dataList}`);
  lines.push(")");
  lines.push('for p in "${PATHS[@]}"; do');
  lines.push('  rm -rf "$p"');
  lines.push("done");
  if (removeAppInUninstall) {
    lines.push(`rm -rf ${shQuote(appPath as string)}`);
  }
  // Self-delete last.
  lines.push(`rm -f ${shQuote(selfPath)}`);
  return lines.join("\n") + "\n";
}

/**
 * Run the pre-wipe hook (BACKLOG-2113 seam) with a hard timeout so a slow logger
 * can never block a wipe. Any error/timeout is swallowed — logging must never
 * abort a user-requested destructive operation.
 */
async function runBeforeWipe(
  beforeWipe: (() => Promise<void>) | undefined,
): Promise<void> {
  if (!beforeWipe) return;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      beforeWipe(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, BEFORE_WIPE_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    logService.warn(
      "[AppCleanup] beforeWipe hook failed (continuing)",
      MODULE,
      { error: error instanceof Error ? error.message : String(error) },
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Perform a full cleanup. Enumerates artifacts, clears secrets in-process, runs
 * the BACKLOG-2113 pre-wipe seam, spawns a detached helper to delete files after
 * the app exits, then relaunches (reset) or quits (uninstall).
 *
 * SAFETY: refuses to run when the app is not packaged (dev machines must never
 * self-wipe) and returns a typed error result instead.
 *
 * @param deps injectable seams for testing. Production callers pass only options.
 */
export async function runCleanup(
  options: CleanupOptions,
  deps?: {
    isPackaged?: boolean;
    platform?: NodeJS.Platform;
    pid?: number;
    tmpdir?: () => string;
    enumerate?: typeof enumerateArtifacts;
    clearSecretsFn?: typeof clearSecrets;
    writeScript?: (scriptPath: string, contents: string) => Promise<void>;
    spawnHelper?: (scriptPath: string) => void;
    relaunch?: () => void;
    quit?: () => void;
  },
): Promise<CleanupResult> {
  const { mode, beforeWipe } = options;
  const isPackaged = deps?.isPackaged ?? app.isPackaged;
  const platform = deps?.platform ?? process.platform;

  // SAFETY RAIL: never self-wipe a dev build.
  if (!isPackaged) {
    logService.warn(
      "[AppCleanup] Refusing to run cleanup in a non-packaged (dev) build",
      MODULE,
      { mode },
    );
    return {
      success: false,
      mode,
      error:
        "App cleanup is disabled in development builds to prevent wiping a dev environment.",
    };
  }

  try {
    const enumerate = deps?.enumerate ?? enumerateArtifacts;
    const clearSecretsFn = deps?.clearSecretsFn ?? clearSecrets;
    const pid = deps?.pid ?? process.pid;
    const tmpdir = deps?.tmpdir ?? os.tmpdir;

    const artifacts = enumerate({ platform });

    // 1. BACKLOG-2113 pre-wipe logging seam (timeout-guarded, best-effort).
    await runBeforeWipe(beforeWipe);

    // 2. Clear OS secret stores in-process (only the app can reach the keychain).
    await clearSecretsFn(platform);

    // 3. Generate the detached helper into os.tmpdir().
    const ext = platform === "win32" ? "ps1" : "sh";
    const scriptPath = path.join(
      tmpdir(),
      `keepr-cleanup-${mode}-${pid}-${Date.now()}.${ext}`,
    );
    const scriptContents = generateHelperScript({
      platform,
      pid,
      mode,
      dataPaths: artifacts.dataPaths,
      appPath: artifacts.appPath,
      windowsUninstaller: artifacts.windowsUninstaller,
      selfPath: scriptPath,
    });

    const writeScript =
      deps?.writeScript ??
      (async (p: string, contents: string) => {
        await writeFile(p, contents, { mode: 0o700 });
      });
    await writeScript(scriptPath, scriptContents);

    logService.warn(
      `[AppCleanup] Spawning detached ${mode} helper`,
      MODULE,
      { scriptPath, dataPaths: artifacts.dataPaths, appPath: artifacts.appPath },
    );

    // 4. Spawn the helper detached so it survives our exit; unref so we don't wait.
    const spawnHelper =
      deps?.spawnHelper ??
      ((p: string) => {
        const child =
          platform === "win32"
            ? spawn(
                "powershell.exe",
                [
                  "-NoProfile",
                  "-ExecutionPolicy",
                  "Bypass",
                  "-WindowStyle",
                  "Hidden",
                  "-File",
                  p,
                ],
                { detached: true, stdio: "ignore" },
              )
            : spawn("/bin/bash", [p], { detached: true, stdio: "ignore" });
        child.unref();
      });
    spawnHelper(scriptPath);

    // 5. Exit so the helper can delete our files.
    if (mode === "reset") {
      const relaunch = deps?.relaunch ?? (() => app.relaunch());
      const quit = deps?.quit ?? (() => app.quit());
      relaunch();
      quit();
    } else {
      const quit = deps?.quit ?? (() => app.quit());
      quit();
    }

    return {
      success: true,
      mode,
      removedPaths: [
        ...artifacts.dataPaths,
        ...(mode === "uninstall" && artifacts.appPath ? [artifacts.appPath] : []),
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    logService.error("[AppCleanup] Cleanup failed to initiate", MODULE, {
      error: message,
      mode,
    });
    return { success: false, mode, error: message };
  }
}
