/**
 * BACKLOG-3927 (Microsoft Store build only): is Apple's "Apple Devices" app
 * ready to carry an iPhone sync?
 *
 * Measured on a real Windows 11 x64 PC on 2026-10-12 (pm_comments on
 * BACKLOG-3927, "PC TEST" rows):
 *  - Apple Devices is the MSIX package `AppleInc.AppleDevices`. It runs Apple
 *    Mobile Device Support as PER-USER processes (AppleMobileDeviceProcess.exe,
 *    AppleMobileDeviceLauncher.exe). There is NO Windows service, NO HKLM
 *    "Apple Mobile Device Support" key and NO Common Files path — so the
 *    website build's registry / `sc query` checks never see it.
 *  - The package carries no USB driver. The iPhone stays on Microsoft's
 *    wpdmtp.inf until the Windows Update optional driver "Apple, Inc. -
 *    USBDevice" (appleusb.inf) is installed. With that driver the composite
 *    device and MI_01 bind to Apple's driver; MI_00 STAYS on Microsoft's WPD
 *    driver. So "an Apple-VID device on a Microsoft driver" is present in both
 *    the good and the bad state; the missing-driver signal is "Apple-VID
 *    devices are present and NONE is on an Apple driver".
 *
 * One PowerShell spawn answers all three questions. Every failure reads as
 * "not found".
 */

import { execFile } from "child_process";
import { promisify } from "util";
import log from "electron-log";
import { powershellPath } from "./appleInstallerSignature";

const execFileAsync = promisify(execFile);

export const APPLE_STORE_PACKAGE_NAMES = ["AppleInc.AppleDevices", "AppleInc.iTunes"] as const;

/** The Apple Mobile Device Support process Apple Devices runs per user. */
export const APPLE_DEVICES_AMDS_PROCESS = "AppleMobileDeviceProcess";

/**
 * iPhone / iPad USB nodes only (SR review D2). Apple's vendor id 05AC is also on
 * Apple keyboards, mice, trackpads and adapters; iOS devices use product ids
 * 0x12xx. Matched with PowerShell `-like` (case-insensitive wildcard).
 */
export const APPLE_IOS_USB_INSTANCE_PATTERN = "USB\\VID_05AC&PID_12*";

/**
 * JS mirror of the script's `-like` filter, for tests only: the filter itself
 * runs inside PowerShell, so a stdout fixture cannot exercise it.
 */
export function matchesAppleIosUsbInstance(instanceId: string): boolean {
  const escaped = APPLE_IOS_USB_INSTANCE_PATTERN.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(instanceId);
}

/**
 * The probe script. No parameter takes a comma list: `Get-AppxPackage -Name`
 * is typed String, and an array there is a binding error (SR review B1).
 * Ends with `exit 0` (SR review D1): `powershell -Command` exits 1 when the last
 * statement leaves `$?` false — e.g. Get-PnpDeviceProperty failing on a
 * driverless interface — even though `SilentlyContinue` hid the error and the
 * lines above it are good.
 */
export const APPLE_DEVICES_PROBE_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  `$names = @(${APPLE_STORE_PACKAGE_NAMES.map((n) => `'${n}'`).join(", ")})`,
  // BACKLOG-3927: Get-AppxPackage can throw (measured on a PC: "Illegal operation
  // attempted on a registry key that has been marked for deletion"). Under
  // SilentlyContinue that printed an empty `packages=` with the cause hidden.
  // Stop + catch, and report the message on its own line.
  "$pkgErr = ''",
  "try { $pkgs = @(Get-AppxPackage -ErrorAction Stop | Where-Object { $names -contains $_.Name } | ForEach-Object { $_.Name }) } catch { $pkgs = @(); $pkgErr = [string]$_.Exception.Message }",
  "'packages=' + ($pkgs -join ';')",
  "if ($pkgErr) { 'packagesError=' + ($pkgErr -replace '[\\r\\n]+', ' ') }",
  `'amds=' + [bool](Get-Process -Name ${APPLE_DEVICES_AMDS_PROCESS} -ErrorAction SilentlyContinue)`,
  `Get-PnpDevice -PresentOnly | Where-Object { $_.InstanceId -like '${APPLE_IOS_USB_INSTANCE_PATTERN}' } | ForEach-Object { 'usbProvider=' + (Get-PnpDeviceProperty -InstanceId $_.InstanceId -KeyName 'DEVPKEY_Device_DriverProvider').Data }`,
  "exit 0",
].join("; ");

/** Apple's USB driver for this iPhone. */
export type AppleUsbDriverState = "bound" | "missing" | "no-device";

export interface AppleDevicesProbeResult {
  /** Apple Devices (or Store iTunes) package installed for this user. */
  packageInstalled: boolean;
  /** AppleMobileDeviceProcess is running. */
  amdsRunning: boolean;
  /** Present Apple-VID USB devices vs Apple's own USB driver. */
  usbDriver: AppleUsbDriverState;
  /**
   * BACKLOG-3927: Get-AppxPackage failed with this message, so `packageInstalled`
   * is unknown rather than false. Absent when the package query ran.
   */
  packagesError?: string;
}

/** Parse the probe's `key=value` lines. Exported for tests. */
export function parseAppleDevicesProbe(stdout: string): AppleDevicesProbeResult {
  let packageInstalled = false;
  let amdsRunning = false;
  let packagesError: string | undefined;
  const providers: string[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1).trim();
    if (key === "packages") {
      packageInstalled = value
        .split(";")
        .some((n) => (APPLE_STORE_PACKAGE_NAMES as readonly string[]).includes(n.trim()));
    } else if (key === "packagesError") {
      if (value !== "") packagesError = value;
    } else if (key === "amds") {
      amdsRunning = value.toLowerCase() === "true";
    } else if (key === "usbProvider") {
      providers.push(value);
    }
  }
  let usbDriver: AppleUsbDriverState = "no-device";
  if (providers.length > 0) {
    usbDriver = providers.some((p) => /apple/i.test(p)) ? "bound" : "missing";
  }
  const result: AppleDevicesProbeResult = { packageInstalled, amdsRunning, usbDriver };
  if (packagesError !== undefined) result.packagesError = packagesError;
  return result;
}

function logPackagesError(result: AppleDevicesProbeResult): AppleDevicesProbeResult {
  if (result.packagesError) {
    log.warn(`[AppleDevicesProbe] Get-AppxPackage failed: ${result.packagesError}`);
  }
  return result;
}

export async function probeAppleDevices(): Promise<AppleDevicesProbeResult> {
  try {
    const { stdout } = await execFileAsync(
      powershellPath(),
      ["-NoProfile", "-NonInteractive", "-Command", APPLE_DEVICES_PROBE_SCRIPT],
      { timeout: 15000, windowsHide: true },
    );
    return logPackagesError(parseAppleDevicesProbe(String(stdout)));
  } catch (error) {
    log.warn("[AppleDevicesProbe] Probe failed:", error);
    // SR review D1: a non-zero exit still carries the lines printed before the
    // failing statement. Use them rather than reading everything as absent.
    const partial = (error as { stdout?: unknown } | null)?.stdout;
    if (partial !== undefined && partial !== null && String(partial).trim() !== "") {
      return logPackagesError(parseAppleDevicesProbe(String(partial)));
    }
    return { packageInstalled: false, amdsRunning: false, usbDriver: "no-device" };
  }
}

/**
 * Does usbmux list an iPhone? `idevice_id -l` through deviceDetectionService
 * (`probeConnectedUdids`, BACKLOG-3598). Measured on the PC (BACKLOG-3927 "REAL
 * PROBE OUTPUT" row): the bundled Windows binary exits 0 both with a phone
 * (one UDID line) and without one (empty stdout), so neither the exit code nor
 * "a list came back" says anything. Only a NON-EMPTY list counts, and callers
 * ask only when an iPhone is plugged in (the probe saw an iOS USB node).
 * BACKLOG-3418: the iPhone helper runs only while iPhone checking is on; when
 * it is off this answers false without spawning anything, so a Settings or
 * Connect-screen check with checking off relies on the process check alone.
 */
export async function probeUsbmux(): Promise<boolean> {
  try {
    const { deviceDetectionService } = await import("./deviceDetectionService");
    if (!deviceDetectionService.isDetectionRequested()) return false;
    const udids = await deviceDetectionService.probeConnectedUdids();
    return Array.isArray(udids) && udids.length > 0;
  } catch (error) {
    log.warn("[AppleDevicesProbe] usbmux probe failed:", error);
    return false;
  }
}
