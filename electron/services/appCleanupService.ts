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
 * Lifecycle & ordering (why it is built this way):
 *   - Paths are derived from app.getPath(...) at runtime — NOT hardcoded
 *     home-dir paths — wherever an app.getPath equivalent exists.
 *   - Secrets are cleared IN-PROCESS before the detached helper runs, because
 *     only the running app has keychain/Credential Manager access.
 *   - The wipe happens in a DETACHED platform helper so the running app can exit
 *     and get its own files deleted. The path list is injected INTO the script
 *     from enumerateArtifacts() — there is no duplicated list.
 *   - We exit via app.exit(0), NOT app.quit(): main.ts installs a window "close"
 *     handler that preventDefault()s while a submission is uploading (and on
 *     macOS only calls mainWindow.destroy(), leaving the process alive). A wipe
 *     must not be left half-committed under a live app, so we take the
 *     guaranteed-exit path. The UI confirmation modal (BACKLOG-2114) owns
 *     warning the user before this point.
 *   - The helper TREATS A PID-WAIT TIMEOUT AS "ABORT", not "proceed": if the app
 *     is still alive when the wait elapses it deletes NOTHING, writes a failure
 *     marker, and self-deletes. Deleting under a live app corrupts the DB.
 *   - RELAUNCH is owned by the HELPER, not this service. Calling app.relaunch()
 *     here would start a new instance at the exact moment the helper begins
 *     deleting — a race that either resurrects userData mid-delete (Windows
 *     locked-file skips → "reset" silently keeps the old DB) or deletes the new
 *     instance's fresh files (macOS). The helper deletes → verifies → THEN
 *     launches the app binary (reset mode only). Sequential, no race.
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
import * as fs from "fs";
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

/**
 * Windows user folders the install-dir fallback must NEVER recursively delete.
 * If the resolved install dir IS one of these (or a filesystem root), we skip
 * app removal entirely. Compared case-insensitively on basename + full path.
 */
const WINDOWS_PROTECTED_BASENAMES = [
  "desktop",
  "downloads",
  "documents",
  "pictures",
  "music",
  "videos",
  "onedrive",
  "public",
  "users",
  "program files",
  "program files (x86)",
  "windows",
  "appdata",
  "roaming",
  "local",
];

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
  /** True if the wipe was initiated (helper spawned, app exiting). */
  success: boolean;
  /** The mode that was requested. */
  mode: CleanupMode;
  /** Absolute paths handed to the detached helper for deletion. */
  removedPaths?: string[];
  /**
   * True when uninstall was requested but app removal was skipped because the
   * resolved install location failed sanity checks (never deletes an unscoped
   * dir like Downloads / a drive root). App data is still wiped.
   */
  appRemovalSkipped?: boolean;
  /** Error message if cleanup could not be initiated. */
  error?: string;
}

/**
 * The complete set of artifacts a cleanup owns, split by concern so the helper
 * script and the secret-clearing step consume the same enumeration.
 */
export interface CleanupArtifacts {
  /** Per-user app data / caches / logs / updater-cache dirs (deleted both modes). */
  dataPaths: string[];
  /** The installed application bundle/dir (deleted only in uninstall mode). */
  appPath: string | null;
  /**
   * Windows NSIS uninstaller executable, if found. When present the helper runs
   * it silently instead of blindly deleting the install dir.
   */
  windowsUninstaller: string | null;
  /**
   * True when appPath was resolved but failed the Windows install-dir sanity
   * checks — the helper must NOT recursively delete it. (Always false on mac,
   * where a null-vs-.app resolution already gates removal.)
   */
  appPathUnsafe: boolean;
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
    // path parser explicitly so this is correct regardless of the HOST OS.
    return path.win32.dirname(exePath);
  }
  return null;
}

/**
 * Locate the Windows NSIS uninstaller in the install dir. electron-builder emits
 * "Uninstall <ProductName>.exe" (productName is "Keepr"). Returns the first that
 * exists, or null.
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
 * Sanity-check a resolved Windows install dir before we allow the no-uninstaller
 * fallback to Remove-Item it recursively. This prevents catastrophic deletes
 * when a win-unpacked build is run from Downloads (isPackaged is true there) or
 * an exe sits at a drive root. ALL checks must pass:
 *   - the running exe lives directly inside the dir, AND
 *   - the electron-builder app.asar exists under resources\, AND
 *   - the basename contains "keepr" (case-insensitive), AND
 *   - the dir is not a filesystem root, AND
 *   - the basename is not a known user/system folder.
 */
export function isWindowsInstallDirSafeToDelete(
  installDir: string | null,
  exePath: string,
  existsSync: (p: string) => boolean,
): boolean {
  if (!installDir) return false;

  // Not a filesystem root (e.g. "C:\", "C:", "\\", "\\server\share").
  const parsed = path.win32.parse(installDir);
  if (parsed.dir === "" || parsed.base === "") return false;
  const rootLike = /^[a-zA-Z]:\\?$/.test(installDir) || installDir === parsed.root;
  if (rootLike) return false;

  const base = parsed.base.toLowerCase();
  if (WINDOWS_PROTECTED_BASENAMES.includes(base)) return false;
  if (!base.includes("keepr")) return false;

  // Running exe must live directly in this dir.
  if (path.win32.dirname(exePath) !== installDir) return false;

  // electron-builder layout marker: resources\app.asar.
  const asar = path.win32.join(installDir, "resources", "app.asar");
  if (!existsSync(asar)) return false;

  return true;
}

/**
 * Existence-checked candidate data paths beyond app.getPath(userData). These
 * cover artifacts the OLD scripts + the NSIS uninstall macro remove that
 * app.getPath does not surface, so our enumeration remains a SUPERSET:
 *   - Windows: %LOCALAPPDATA%\keepr and %LOCALAPPDATA%\keepr-updater
 *     (electron-updater download cache; can hold a full installer).
 *   - macOS: ~/Library/Caches/keepr and ~/Library/Caches/keepr-updater
 *     (electron-updater cache uses "<appName>-updater").
 * Only paths that exist are returned, so we never inject phantom targets.
 */
function extraDataPaths(
  platform: NodeJS.Platform,
  homeDir: string,
  localAppData: string | undefined,
  existsSync: (p: string) => boolean,
): string[] {
  const out: string[] = [];
  if (platform === "win32") {
    if (localAppData) {
      out.push(
        path.win32.join(localAppData, "keepr"),
        path.win32.join(localAppData, "keepr-updater"),
      );
    }
  } else if (platform === "darwin") {
    out.push(
      path.posix.join(homeDir, "Library", "Caches", "keepr"),
      path.posix.join(homeDir, "Library", "Caches", "keepr-updater"),
    );
  }
  return out.filter((p) => existsSync(p));
}

/**
 * Enumerate every artifact Keepr owns. Derived from app.getPath(...) at runtime,
 * plus existence-checked extras (updater cache, %LOCALAPPDATA%\keepr) so this is
 * a superset of the scripts it replaces.
 *
 * @param deps injectable seams for deterministic testing.
 */
export function enumerateArtifacts(deps?: {
  platform?: NodeJS.Platform;
  exePath?: string;
  getPath?: (name: "userData" | "sessionData" | "logs" | "home") => string;
  existsSync?: (p: string) => boolean;
  localAppData?: string;
}): CleanupArtifacts {
  const platform = deps?.platform ?? process.platform;
  const getPath =
    deps?.getPath ??
    ((name: "userData" | "sessionData" | "logs" | "home") => app.getPath(name));
  const existsSync = deps?.existsSync ?? ((p: string): boolean => fs.existsSync(p));
  const exePath = deps?.exePath ?? app.getPath("exe");
  const localAppData =
    deps?.localAppData ?? (platform === "win32" ? process.env.LOCALAPPDATA : undefined);

  const homeDir = safeGetPath(getPath, "home");

  // Separator for the target platform — NOT the host's path.sep, so Windows
  // enumeration is correct even when this code runs on macOS/CI Linux.
  const sep = platform === "win32" ? "\\" : "/";

  // Per-user data paths from Electron, then existence-checked extras.
  const rawDataPaths = [
    safeGetPath(getPath, "userData"),
    safeGetPath(getPath, "sessionData"),
    safeGetPath(getPath, "logs"),
    ...extraDataPaths(platform, homeDir, localAppData, existsSync),
  ];

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
    platform === "win32" ? resolveWindowsUninstaller(appPath, existsSync) : null;

  // appPathUnsafe only meaningful on Windows for the no-uninstaller fallback.
  // If we have an uninstaller, safety of the raw dir doesn't matter (we run the
  // uninstaller, not a blind delete). Otherwise gate on the sanity checks.
  const appPathUnsafe =
    platform === "win32" && appPath !== null && windowsUninstaller === null
      ? !isWindowsInstallDirSafeToDelete(appPath, exePath, existsSync)
      : false;

  return { dataPaths, appPath, windowsUninstaller, appPathUnsafe };
}

/** getPath that never throws (some paths can be unavailable early). */
function safeGetPath(
  getPath: (name: never) => string,
  name: string,
): string {
  try {
    return (getPath as (n: string) => string)(name) ?? "";
  } catch {
    return "";
  }
}

/**
 * Clear OS-level secret stores in-process. Best-effort: failures are logged but
 * never abort the wipe (the encrypted key FILES inside userData are removed by
 * the helper regardless, so secrets cannot be decrypted after cleanup).
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
 * as in "Application Support". POSIX uses single quotes (with the '\'' escape);
 * Windows PowerShell single-quotes double an embedded apostrophe.
 */
function shQuote(p: string): string {
  return `'${p.replace(/'/g, "'\\''")}'`;
}

function psQuote(p: string): string {
  return `'${p.replace(/'/g, "''")}'`;
}

/**
 * Parameters injected into the generated helper. `relaunchTarget` is the app
 * binary/bundle the helper launches AFTER a successful reset wipe (null for
 * uninstall). `failureMarker` is written when the helper aborts (pid still
 * alive at timeout) so callers/telemetry can observe a non-clean run.
 */
export interface HelperScriptParams {
  platform: NodeJS.Platform;
  pid: number;
  mode: CleanupMode;
  dataPaths: string[];
  /** App bundle/dir to remove on uninstall (null = skip; e.g. unsafe/unknown). */
  appPath: string | null;
  windowsUninstaller: string | null;
  /** True to forbid the blind install-dir delete fallback (Windows). */
  appPathUnsafe: boolean;
  /** App binary to relaunch after a successful reset wipe (null = no relaunch). */
  relaunchTarget: string | null;
  selfPath: string;
  failureMarker: string;
}

/**
 * Generate the detached helper script that outlives the app process. It:
 *   1. waits for the app pid to exit (poll, ~30s),
 *   2. IF STILL ALIVE at timeout → writes the failure marker, self-deletes,
 *      deletes NOTHING (never wipe under a live app),
 *   3. otherwise deletes exactly the injected paths (Windows: a reparse-point
 *      pre-pass removes junctions/symlinks LINK-ONLY first so Remove-Item does
 *      not follow them into a target's contents),
 *   4. on uninstall, removes the app (NSIS uninstaller if given — guarded — else
 *      the install dir only when appPathUnsafe is false),
 *   5. on reset, launches relaunchTarget,
 *   6. self-deletes.
 *
 * The path list is INJECTED — the script never re-derives paths.
 */
export function generateHelperScript(params: HelperScriptParams): string {
  const {
    platform,
    pid,
    mode,
    dataPaths,
    appPath,
    windowsUninstaller,
    appPathUnsafe,
    relaunchTarget,
    selfPath,
    failureMarker,
  } = params;

  const removeAppInUninstall = mode === "uninstall" && appPath !== null;

  if (platform === "win32") {
    const dataList = dataPaths.map(psQuote).join(",\n  ");
    const lines: string[] = [];
    lines.push("# Keepr detached cleanup helper (BACKLOG-2111)");
    lines.push("$ErrorActionPreference = 'SilentlyContinue'");
    lines.push(`$appPid = ${pid}`);
    lines.push(`$deadline = (Get-Date).AddSeconds(${HELPER_PID_WAIT_SECONDS})`);
    lines.push("$alive = $true");
    lines.push("while ($true) {");
    lines.push("  if (-not (Get-Process -Id $appPid -ErrorAction SilentlyContinue)) { $alive = $false; break }");
    lines.push("  if ((Get-Date) -gt $deadline) { $alive = $true; break }");
    lines.push("  Start-Sleep -Milliseconds 250");
    lines.push("}");
    // ABORT if the app is still alive — delete nothing, mark failure, self-delete.
    lines.push("if ($alive) {");
    lines.push(`  Set-Content -LiteralPath ${psQuote(failureMarker)} -Value 'app-still-alive-at-timeout' -Force`);
    lines.push(`  Remove-Item -LiteralPath ${psQuote(selfPath)} -Force`);
    lines.push("  exit 1");
    lines.push("}");
    lines.push("$paths = @(");
    lines.push(`  ${dataList}`);
    lines.push(")");
    // Reparse-point pre-pass: PS 5.1 Remove-Item -Recurse FOLLOWS junctions/
    // symlinks and destroys the TARGET's contents (PowerShell #16664/#19714/
    // #26913). We must never recurse THROUGH a reparse point.
    //   - If the target dir itself is a reparse point → delete the LINK only and
    //     stop (never enumerate into its target).
    //   - Otherwise scan for nested reparse points, delete each LINK-ONLY, then
    //     recursively delete the (now link-free) real tree.
    lines.push("foreach ($p in $paths) {");
    lines.push("  if (Test-Path -LiteralPath $p) {");
    lines.push("    $top = Get-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue");
    lines.push("    if ($top -and ($top.Attributes -band [IO.FileAttributes]::ReparsePoint)) {");
    lines.push("      try { [IO.Directory]::Delete($p, $false) } catch { cmd /c rmdir \"$p\" 2>$null }");
    lines.push("    } else {");
    lines.push("      $nested = Get-ChildItem -LiteralPath $p -Recurse -Force -Attributes ReparsePoint -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }");
    lines.push("      foreach ($rp in $nested) {");
    lines.push("        try { [IO.Directory]::Delete($rp, $false) } catch { cmd /c rmdir \"$rp\" 2>$null }");
    lines.push("      }");
    lines.push("      if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force }");
    lines.push("    }");
    lines.push("  }");
    lines.push("}");
    if (removeAppInUninstall) {
      if (windowsUninstaller) {
        lines.push(`$uninstaller = ${psQuote(windowsUninstaller)}`);
        lines.push("$uninstalled = $false");
        lines.push("if (Test-Path -LiteralPath $uninstaller) {");
        lines.push("  try {");
        lines.push("    $proc = Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait -PassThru -ErrorAction Stop");
        lines.push("    if ($proc.ExitCode -eq 0) { $uninstalled = $true }");
        lines.push("  } catch { $uninstalled = $false }");
        lines.push("}");
        // Fall back to a GUARDED install-dir delete only when safe; else mark failure.
        lines.push("if (-not $uninstalled) {");
        if (appPathUnsafe) {
          lines.push(`  Set-Content -LiteralPath ${psQuote(failureMarker)} -Value 'uninstaller-failed-and-dir-unsafe' -Force`);
        } else {
          lines.push(`  $installDir = ${psQuote(appPath as string)}`);
          lines.push("  if (Test-Path -LiteralPath $installDir) { Remove-Item -LiteralPath $installDir -Recurse -Force }");
        }
        lines.push("}");
      } else if (!appPathUnsafe) {
        lines.push(`$installDir = ${psQuote(appPath as string)}`);
        lines.push("if (Test-Path -LiteralPath $installDir) { Remove-Item -LiteralPath $installDir -Recurse -Force }");
      } else {
        // appPath resolved but unsafe and no uninstaller — skip removal entirely.
        lines.push(`Set-Content -LiteralPath ${psQuote(failureMarker)} -Value 'install-dir-unsafe-skipped' -Force`);
      }
    }
    // Reset: relaunch AFTER the wipe (helper owns relaunch — no race).
    if (mode === "reset" && relaunchTarget) {
      lines.push(`Start-Process -FilePath ${psQuote(relaunchTarget)}`);
    }
    // Self-delete last.
    lines.push(`Remove-Item -LiteralPath ${psQuote(selfPath)} -Force`);
    return lines.join("\n") + "\n";
  }

  // macOS / Linux (bash). rm -rf does NOT follow symlinks, so no pre-pass needed.
  const dataList = dataPaths.map(shQuote).join(" \\\n  ");
  const lines: string[] = [];
  lines.push("#!/bin/bash");
  lines.push("# Keepr detached cleanup helper (BACKLOG-2111)");
  lines.push(`APP_PID=${pid}`);
  lines.push("ALIVE=1");
  lines.push(`for i in $(seq 1 ${HELPER_PID_WAIT_SECONDS * 4}); do`);
  lines.push('  if ! kill -0 "$APP_PID" 2>/dev/null; then ALIVE=0; break; fi');
  lines.push("  sleep 0.25");
  lines.push("done");
  // ABORT if the app is still alive — delete nothing, mark failure, self-delete.
  lines.push('if [ "$ALIVE" -eq 1 ]; then');
  lines.push(`  echo 'app-still-alive-at-timeout' > ${shQuote(failureMarker)}`);
  lines.push(`  rm -f ${shQuote(selfPath)}`);
  lines.push("  exit 1");
  lines.push("fi");
  lines.push("PATHS=(\\");
  lines.push(`  ${dataList}`);
  lines.push(")");
  lines.push('for p in "${PATHS[@]}"; do');
  lines.push('  rm -rf "$p"');
  lines.push("done");
  if (removeAppInUninstall) {
    lines.push(`rm -rf ${shQuote(appPath as string)}`);
  }
  if (mode === "reset" && relaunchTarget) {
    lines.push(`open ${shQuote(relaunchTarget)}`);
  }
  // Self-delete last.
  lines.push(`rm -f ${shQuote(selfPath)}`);
  return lines.join("\n") + "\n";
}

/**
 * Resolve the target the helper launches after a successful reset wipe.
 * macOS: the *.app bundle (opened via `open`). Windows: the running exe.
 * Returns null when we cannot resolve it (reset then simply won't relaunch).
 */
function resolveRelaunchTarget(
  platform: NodeJS.Platform,
  appPath: string | null,
  exePath: string,
): string | null {
  if (platform === "darwin") return appPath; // `open <bundle>`
  if (platform === "win32") return exePath; // Start-Process <exe>
  return null;
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
 * the app exits, then exits via app.exit(0) (guaranteed exit — bypasses the
 * submission-in-progress close guard in main.ts). The helper owns relaunch.
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
    exePath?: string;
    tmpdir?: () => string;
    enumerate?: typeof enumerateArtifacts;
    clearSecretsFn?: typeof clearSecrets;
    writeScript?: (scriptPath: string, contents: string) => Promise<void>;
    spawnHelper?: (scriptPath: string) => void;
    exit?: (code: number) => void;
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
    const exePath = deps?.exePath ?? app.getPath("exe");

    const artifacts = enumerate({ platform });

    // 1. BACKLOG-2113 pre-wipe logging seam (timeout-guarded, best-effort).
    await runBeforeWipe(beforeWipe);

    // 2. Clear OS secret stores in-process (only the app can reach the keychain).
    await clearSecretsFn(platform);

    // 3. Generate the detached helper into os.tmpdir().
    const ext = platform === "win32" ? "ps1" : "sh";
    const stamp = `${mode}-${pid}-${Date.now()}`;
    const scriptPath = path.join(tmpdir(), `keepr-cleanup-${stamp}.${ext}`);
    const failureMarker = path.join(tmpdir(), `keepr-cleanup-${stamp}.failed`);

    // On uninstall, only ask the helper to remove the app when it is safe to do
    // so; otherwise skip and report appRemovalSkipped (mirrors mac null-skip).
    const willSkipAppRemoval =
      mode === "uninstall" &&
      (artifacts.appPath === null ||
        (artifacts.appPathUnsafe && artifacts.windowsUninstaller === null));

    const relaunchTarget =
      mode === "reset"
        ? resolveRelaunchTarget(platform, artifacts.appPath, exePath)
        : null;

    const scriptContents = generateHelperScript({
      platform,
      pid,
      mode,
      dataPaths: artifacts.dataPaths,
      appPath: mode === "uninstall" ? artifacts.appPath : null,
      windowsUninstaller: artifacts.windowsUninstaller,
      appPathUnsafe: artifacts.appPathUnsafe,
      relaunchTarget,
      selfPath: scriptPath,
      failureMarker,
    });

    const writeScript =
      deps?.writeScript ??
      (async (p: string, contents: string) => {
        await writeFile(p, contents, { mode: 0o700 });
      });
    await writeScript(scriptPath, scriptContents);

    logService.warn(`[AppCleanup] Spawning detached ${mode} helper`, MODULE, {
      scriptPath,
      dataPaths: artifacts.dataPaths,
      appPath: artifacts.appPath,
      appRemovalSkipped: willSkipAppRemoval,
    });

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

    // 5. GUARANTEED exit so the helper can delete our files. app.exit(0) bypasses
    //    the window "close" handler (submission-in-progress guard) which would
    //    otherwise leave a headless process alive mid-wipe on macOS. The helper
    //    owns relaunch — we never call app.relaunch() (avoids the reset race).
    const exit = deps?.exit ?? ((code: number) => app.exit(code));
    exit(0);

    const removedPaths = [
      ...artifacts.dataPaths,
      ...(mode === "uninstall" && artifacts.appPath && !willSkipAppRemoval
        ? [artifacts.appPath]
        : []),
    ];

    return {
      success: true,
      mode,
      removedPaths,
      ...(willSkipAppRemoval ? { appRemovalSkipped: true } : {}),
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
