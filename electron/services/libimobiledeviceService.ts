/**
 * libimobiledevice Service
 * Locates and provides paths to libimobiledevice Windows binaries
 *
 * This service is compatible with TASK-002 specification and extends it
 * with additional utilities for the backup service.
 */

import path from "path";
import fs from "fs";
import { app } from "electron";
import log from "electron-log";
import * as Sentry from "@sentry/electron/main";

/**
 * List of required executable names for libimobiledevice functionality
 */
export const REQUIRED_EXECUTABLES = [
  "idevice_id",
  "ideviceinfo",
  "idevicebackup2",
  // BACKLOG-2908: pairDevice validates and, when needed, re-pairs through idevicepair
  "idevicepair",
] as const;

export type LibimobiledeviceExecutable = (typeof REQUIRED_EXECUTABLES)[number];

/**
 * Check if running in mock mode for development without actual device
 */
export function isMockMode(): boolean {
  return process.env.MOCK_DEVICE === "true";
}

/**
 * Get the base path to the libimobiledevice binaries directory
 * @returns The absolute path to the libimobiledevice binaries directory
 * @throws Error if not running on Windows
 */
export function getLibimobiledevicePath(): string {
  if (process.platform !== "win32") {
    throw new Error("libimobiledevice binaries only available on Windows");
  }

  const isDev = !app.isPackaged;

  if (isDev) {
    return path.join(__dirname, "../../resources/win/libimobiledevice");
  }

  return path.join(process.resourcesPath, "win/libimobiledevice");
}

/**
 * Get the full path to a specific libimobiledevice executable
 * @param name - The name of the executable (without .exe extension)
 * @returns The absolute path to the executable
 * @throws Error if not running on Windows
 */
// Cache to avoid logging the same path repeatedly
const loggedPaths = new Set<string>();

export function getExecutablePath(name: string): string {
  const basePath = getLibimobiledevicePath();
  const exePath = path.join(basePath, `${name}.exe`);
  // Only log each unique path once to reduce noise
  if (!loggedPaths.has(exePath)) {
    log.debug(`[libimobiledeviceService] Resolved executable path: ${exePath}`);
    loggedPaths.add(exePath);
  }
  return exePath;
}

/**
 * Check if libimobiledevice binaries are available
 * @returns True if binaries directory exists and contains expected files
 */
export function areBinariesAvailable(): boolean {
  if (process.platform !== "win32") {
    return false;
  }

  try {
    const basePath = getLibimobiledevicePath();
    return fs.existsSync(basePath);
  } catch (error) {
    log.error(
      "[libimobiledeviceService] Error checking binaries availability:",
      error,
    );
    return false;
  }
}

/**
 * Get the command to execute for a libimobiledevice tool
 * On Windows, returns the full path. On other platforms, returns command name for PATH lookup.
 * @param name - Name of the executable (e.g., 'idevice_id', 'idevicebackup2')
 * @returns Command string suitable for spawn/exec
 */
export function getCommand(name: string): string {
  if (process.platform === "win32") {
    try {
      return getExecutablePath(name);
    } catch {
      // Fall through to return just the name
      return name;
    }
  }

  // On macOS/Linux, tools are expected to be in PATH
  return name;
}

/**
 * Check if we can use libimobiledevice commands
 * Returns true in mock mode or if platform is supported
 *
 * BACKLOG-1354: Logs Sentry breadcrumb + captureMessage when binaries are missing
 * on Windows, including which specific binaries are absent.
 */
export function canUseLibimobiledevice(): boolean {
  if (isMockMode()) {
    return true;
  }

  if (process.platform === "win32") {
    const available = areBinariesAvailable();
    if (!available) {
      // BACKLOG-1354: Detailed diagnostics for missing binaries
      let basePath = "(unknown)";
      let directoryExists = false;
      const missingBinaries: string[] = [];
      const presentBinaries: string[] = [];

      try {
        basePath = getLibimobiledevicePath();
        directoryExists = fs.existsSync(basePath);

        if (directoryExists) {
          // Directory exists but check individual binaries
          for (const exe of REQUIRED_EXECUTABLES) {
            const exePath = path.join(basePath, `${exe}.exe`);
            if (fs.existsSync(exePath)) {
              presentBinaries.push(exe);
            } else {
              missingBinaries.push(exe);
            }
          }
        }
      } catch {
        // Non-fatal — we'll log whatever we have
      }

      Sentry.addBreadcrumb({
        category: "iphone.sync",
        message: "libimobiledevice binaries not available",
        level: "warning",
        data: {
          basePath,
          directoryExists,
          missingBinaries,
          presentBinaries,
          hint: directoryExists && missingBinaries.length > 0
            ? "Directory exists but binaries missing — possible antivirus removal"
            : "Binary directory not found",
        },
      });

      Sentry.captureMessage("libimobiledevice binaries missing on Windows", {
        level: "warning",
        tags: { component: "libimobiledevice", platform: "win32" },
        extra: {
          basePath,
          directoryExists,
          missingBinaries,
          presentBinaries,
        },
      });
    }
    return available;
  }

  // On macOS/Linux, assume commands are available in PATH
  // (actual availability will be checked at runtime)
  return true;
}
