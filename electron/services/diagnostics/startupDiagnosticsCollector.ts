/**
 * Startup Diagnostics Collector (TASK-2275)
 *
 * Collects an environment snapshot on app launch: disk space, OS version,
 * app version, memory, network status, and (on Windows) Apple driver status.
 * The snapshot is stored in memory and sent to Sentry as context/tags for
 * enrichment of all subsequent events.
 *
 * Collection NEVER blocks startup -- all errors are caught and logged.
 * Called unconditionally from startupHealthCheck.ts (even when health checks fail).
 *
 * Usage:
 *   import { collectStartupDiagnostics, getLatestDiagnostics } from "./diagnostics";
 *   await collectStartupDiagnostics(); // fire and forget
 *   const snapshot = getLatestDiagnostics(); // retrieve later
 */

import * as Sentry from "@sentry/electron/main";
import { app, net } from "electron";
import os from "os";
import checkDiskSpace from "check-disk-space";
import log from "electron-log";

export interface StartupDiagnostics {
  timestamp: string;
  app: {
    version: string;
    electronVersion: string;
    nodeVersion: string;
    isPackaged: boolean;
  };
  system: {
    platform: NodeJS.Platform;
    osRelease: string;
    osType: string;
    arch: string;
    totalMemoryMB: number;
    freeMemoryMB: number;
  };
  disk: {
    availableMB: number;
    totalMB: number;
    path: string;
  };
  network: {
    status: "online" | "offline" | "unknown";
  };
  // Windows-only
  appleDrivers?: {
    isInstalled: boolean;
    version: string | null;
    serviceRunning: boolean;
    /** BACKLOG-3927: msi | apple-devices (Store build). */
    installedVia?: "msi" | "apple-devices" | null;
    /** BACKLOG-3927: Store build Apple Devices state. */
    appleDevicesState?: string | null;
  };
}

let latestDiagnostics: StartupDiagnostics | null = null;

/**
 * Collect startup diagnostics. Called unconditionally after health checks.
 * Never throws -- all errors are caught and logged.
 */
export async function collectStartupDiagnostics(): Promise<StartupDiagnostics> {
  const startTime = Date.now();

  try {
    const userDataPath = app.getPath("userData");
    const diskInfo = await checkDiskSpace(userDataPath).catch(() => ({
      free: 0,
      size: 0,
    }));

    // Determine network status
    let networkStatus: "online" | "offline" | "unknown" = "unknown";
    try {
      networkStatus = net.isOnline() ? "online" : "offline";
    } catch {
      // net.isOnline() may not be available in all contexts
    }

    const diagnostics: StartupDiagnostics = {
      timestamp: new Date().toISOString(),
      app: {
        version: app.getVersion(),
        electronVersion: process.versions.electron,
        nodeVersion: process.version,
        isPackaged: app.isPackaged,
      },
      system: {
        platform: process.platform,
        osRelease: os.release(),
        osType: os.type(),
        arch: os.arch(),
        totalMemoryMB: Math.round(os.totalmem() / (1024 * 1024)),
        freeMemoryMB: Math.round(os.freemem() / (1024 * 1024)),
      },
      disk: {
        availableMB: Math.round(diskInfo.free / (1024 * 1024)),
        totalMB: Math.round(diskInfo.size / (1024 * 1024)),
        path: userDataPath,
      },
      network: {
        status: networkStatus,
      },
    };

    // Windows: check Apple driver status
    if (process.platform === "win32") {
      try {
        const { checkAppleDrivers } = await import("../appleDriverService");
        const driverStatus = await checkAppleDrivers();
        diagnostics.appleDrivers = {
          isInstalled: driverStatus.isInstalled,
          version: driverStatus.version,
          serviceRunning: driverStatus.serviceRunning,
          // BACKLOG-3927: only when known, so a website build's payload is unchanged.
          ...(driverStatus.installedVia ? { installedVia: driverStatus.installedVia } : {}),
          ...(driverStatus.appleDevices ? { appleDevicesState: driverStatus.appleDevices.state } : {}),
        };
      } catch (err) {
        log.warn("[StartupDiagnostics] Failed to check Apple drivers:", err);
      }
    }

    // Store for later retrieval
    latestDiagnostics = diagnostics;

    // Set Sentry context so all future events include diagnostics
    Sentry.setContext("startup_diagnostics", {
      diskAvailableMB: diagnostics.disk.availableMB,
      osRelease: diagnostics.system.osRelease,
      appVersion: diagnostics.app.version,
      platform: diagnostics.system.platform,
      appleDriversInstalled: diagnostics.appleDrivers?.isInstalled ?? "n/a",
    });

    Sentry.setTag(
      "disk.available_gb",
      String(Math.round(diagnostics.disk.availableMB / 1024)),
    );

    const durationMs = Date.now() - startTime;
    log.info(`[StartupDiagnostics] Collected in ${durationMs}ms`);
    log.info(
      `[StartupDiagnostics] Disk: ${diagnostics.disk.availableMB}MB free`,
    );

    return diagnostics;
  } catch (error) {
    log.error("[StartupDiagnostics] Collection failed:", error);
    Sentry.captureException(error, {
      tags: { component: "startup_diagnostics" },
    });

    // Return minimal diagnostics on failure
    const fallback: StartupDiagnostics = {
      timestamp: new Date().toISOString(),
      app: {
        version: app.getVersion(),
        electronVersion: process.versions.electron,
        nodeVersion: process.version,
        isPackaged: app.isPackaged,
      },
      system: {
        platform: process.platform,
        osRelease: os.release(),
        osType: os.type(),
        arch: os.arch(),
        totalMemoryMB: 0,
        freeMemoryMB: 0,
      },
      disk: { availableMB: -1, totalMB: -1, path: "" },
      network: { status: "unknown" },
    };
    latestDiagnostics = fallback;
    return fallback;
  }
}

/**
 * Get the most recently collected diagnostics. Returns null if not yet collected.
 */
export function getLatestDiagnostics(): StartupDiagnostics | null {
  return latestDiagnostics;
}

/**
 * Reset diagnostics state (for testing only).
 * @internal
 */
export function _resetDiagnosticsForTesting(): void {
  latestDiagnostics = null;
}
