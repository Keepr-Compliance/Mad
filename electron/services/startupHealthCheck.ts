/**
 * Startup Health Checks (Phase 1 -- Pre-Auth)
 *
 * Runs before createWindow() to catch system-level failures early
 * with actionable user-facing error messages instead of cryptic crashes.
 *
 * Check priorities:
 *   P0: Native module load validation (blocks startup)
 *   P1: safeStorage, app dir writable, disk space (blocks startup)
 *   P2: OS version (warning only)
 *
 * All checks run in < 100ms total. No network calls.
 */

import * as Sentry from "@sentry/electron/main";
import { app, dialog } from "electron";
import { hostSecretStore } from "../capabilities/secretStoreProvider";
import * as fs from "fs";
import * as os from "os";
import checkDiskSpace from "check-disk-space";
import { collectStartupDiagnostics } from "./diagnostics/startupDiagnosticsCollector";

export interface HealthCheckResult {
  passed: boolean;
  checks: {
    nativeModules: { passed: boolean; error?: string };
    safeStorage: { passed: boolean; error?: string };
    appDirWritable: { passed: boolean; error?: string; path?: string };
    diskSpace: { passed: boolean; warning?: boolean; availableMB?: number };
    osVersion: { passed: boolean; warning?: boolean; version?: string };
  };
}

/**
 * P0: Verify native SQLite module loads correctly.
 * A failed native module means the DB engine is broken -- unrecoverable.
 */
export function checkNativeModules(): { passed: boolean; error?: string } {
  try {
    require("better-sqlite3-multiple-ciphers");
    return { passed: true };
  } catch (error) {
    const message = `Database engine failed to load. Please reinstall the application.\n\nError: ${error instanceof Error ? error.message : String(error)}`;
    dialog.showErrorBox("Startup Error", message);
    Sentry.captureException(error, {
      tags: { check: "native_module", nodeVersion: process.version },
      extra: { electronVersion: process.versions.electron },
    });
    return { passed: false, error: message };
  }
}

/**
 * P1: Verify system encryption (keychain/credential store) is available.
 * Without safeStorage, the DB encryption key cannot be stored securely.
 */
export function checkSafeStorage(): { passed: boolean; error?: string } {
  if (!hostSecretStore.isEncryptionAvailable()) {
    const message =
      "Encryption not available. Please check your system keychain.\n\nThe app requires system encryption to protect your data.";
    dialog.showErrorBox("Encryption Unavailable", message);
    Sentry.captureMessage("safeStorage unavailable at startup", {
      level: "error",
      tags: { check: "safe_storage", platform: process.platform },
    });
    return { passed: false, error: message };
  }
  return { passed: true };
}

/**
 * P1: Verify the app data directory exists and is writable.
 * If the directory is not writable, the DB cannot be created or updated.
 */
export async function checkAppDirWritable(): Promise<{
  passed: boolean;
  error?: string;
  path?: string;
}> {
  const userDataPath = app.getPath("userData");
  try {
    await fs.promises.access(userDataPath, fs.constants.W_OK);
    return { passed: true, path: userDataPath };
  } catch {
    const message = `Application data directory is not writable.\n\nExpected path: ${userDataPath}\n\nPlease check directory permissions.`;
    dialog.showErrorBox("Directory Error", message);
    Sentry.captureMessage("userData directory not writable", {
      level: "error",
      tags: { check: "app_dir_writable" },
      extra: { path: userDataPath },
    });
    return { passed: false, error: message, path: userDataPath };
  }
}

/**
 * P1: Check available disk space.
 * Warns at <100MB, blocks at <10MB to prevent DB corruption from full disk.
 */
export async function checkDiskSpaceAvailable(): Promise<{
  passed: boolean;
  warning?: boolean;
  availableMB?: number;
}> {
  try {
    const userDataPath = app.getPath("userData");
    const { free } = await checkDiskSpace(userDataPath);
    const availableMB = Math.round(free / (1024 * 1024));

    if (availableMB < 10) {
      dialog.showErrorBox(
        "Insufficient Disk Space",
        `Only ${availableMB}MB available. The app requires at least 10MB to operate.\n\nPlease free up disk space and try again.`
      );
      Sentry.captureMessage("Critically low disk space at startup", {
        level: "error",
        tags: { check: "disk_space" },
        extra: { availableMB },
      });
      return { passed: false, availableMB };
    }

    if (availableMB < 100) {
      Sentry.addBreadcrumb({
        category: "startup",
        message: `Low disk space warning: ${availableMB}MB available`,
        level: "warning",
      });
      return { passed: true, warning: true, availableMB };
    }

    return { passed: true, availableMB };
  } catch {
    // Non-critical: if we can't check disk space, proceed anyway
    return { passed: true };
  }
}

/**
 * P2: Log OS version for unsupported platforms (warning only).
 * macOS < 12 (Darwin < 21) and Windows < 10 are unsupported.
 */
export function checkOsVersion(): {
  passed: boolean;
  warning?: boolean;
  version?: string;
} {
  const release = os.release();
  const platform = process.platform;

  if (platform === "darwin") {
    const major = parseInt(release.split(".")[0], 10);
    // macOS 12 Monterey = Darwin 21.x
    if (major < 21) {
      Sentry.addBreadcrumb({
        category: "startup",
        message: `Unsupported macOS version: Darwin ${release}`,
        level: "warning",
      });
      return { passed: true, warning: true, version: release };
    }
  } else if (platform === "win32") {
    const major = parseInt(release.split(".")[0], 10);
    // Windows 10 = 10.x
    if (major < 10) {
      Sentry.addBreadcrumb({
        category: "startup",
        message: `Unsupported Windows version: ${release}`,
        level: "warning",
      });
      return { passed: true, warning: true, version: release };
    }
  }

  return { passed: true, version: release };
}

/**
 * Run all pre-auth health checks. Call before createWindow().
 * Returns result. If any critical check fails, shows dialog and returns passed=false.
 *
 * Checks run in priority order: P0 -> P1 -> P2
 * P0/P1 failures block startup. P2 is warning-only.
 */
export async function runStartupHealthChecks(): Promise<HealthCheckResult> {
  // P0: Native module validation
  const nativeModules = checkNativeModules();

  // P1: safeStorage preflight
  const safeStorageResult = checkSafeStorage();

  // P1: App data directory writable
  const appDirWritable = await checkAppDirWritable();

  // P1: Disk space check
  const diskSpace = await checkDiskSpaceAvailable();

  // P2: OS version (warning only)
  const osVersion = checkOsVersion();

  const passed =
    nativeModules.passed &&
    safeStorageResult.passed &&
    appDirWritable.passed &&
    diskSpace.passed;

  // Collect diagnostics unconditionally (fire and forget).
  // Called even when health checks fail -- that's when diagnostics are most valuable.
  collectStartupDiagnostics().catch((err) => {
    // Should never throw, but safety net
    console.error("[StartupDiagnostics] Unexpected error:", err);
  });

  return {
    passed,
    checks: {
      nativeModules,
      safeStorage: safeStorageResult,
      appDirWritable,
      diskSpace,
      osVersion,
    },
  };
}
