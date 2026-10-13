/**
 * BACKLOG-3927: read Apple Mobile Device Support readiness from the main
 * process's driver status (`drivers.checkApple()`).
 */
import type { AppleDevicesState, AppleUsbDriverState } from "../types/iphone";

export type AppleDriverInstalledVia = "msi" | "apple-devices";

export interface DriverStatusLike {
  isInstalled?: boolean;
  serviceRunning?: boolean;
  installedVia?: AppleDriverInstalledVia | null;
  appleDevices?: { state?: AppleDevicesState; usbDriver?: AppleUsbDriverState } | null;
}

/**
 * BACKLOG-3927: the iPhone's USB driver from the probe, or null when the probe
 * did not run (the MSI route answered on its own) — never read as "bound".
 */
export function appleUsbDriverOf(
  status: DriverStatusLike | null | undefined,
): AppleUsbDriverState | null {
  return status?.appleDevices?.usbDriver ?? null;
}

export function appleDevicesStateOf(
  status: DriverStatusLike | null | undefined,
): AppleDevicesState {
  const state = status?.appleDevices?.state;
  if (state) return state;
  // No probe result: the MSI route answered on its own, or no status at all.
  if (status?.isInstalled !== true) return "not-installed";
  if (status.serviceRunning === false) {
    return status.installedVia === "apple-devices" ? "not-running" : "msi-service-stopped";
  }
  return "ready";
}

/** BACKLOG-3927: Settings > Sync Tools label for the detected source. */
export const DRIVER_SOURCE_LABELS: Record<AppleDriverInstalledVia | "none", string> = {
  "apple-devices": "Apple Devices app",
  msi: "Apple Mobile Device Support",
  none: "None found",
};

export function driverSourceLabel(installedVia: AppleDriverInstalledVia | null | undefined): string {
  return DRIVER_SOURCE_LABELS[installedVia ?? "none"];
}
