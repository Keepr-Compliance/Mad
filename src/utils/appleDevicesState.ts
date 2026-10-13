/**
 * BACKLOG-3927 (Microsoft Store build): read Apple Devices readiness from the
 * main process's driver status (`drivers.checkApple()`).
 */
import type { AppleDevicesState } from "../types/iphone";

export interface DriverStatusLike {
  isInstalled?: boolean;
  serviceRunning?: boolean;
  appleDevices?: { state?: AppleDevicesState } | null;
}

export function appleDevicesStateOf(
  status: DriverStatusLike | null | undefined,
): AppleDevicesState {
  const state = status?.appleDevices?.state;
  if (state) return state;
  // Found by the MSI route (registry / service), or no status at all.
  if (status?.isInstalled !== true) return "not-installed";
  if (status.serviceRunning === false) return "not-running";
  return "ready";
}
