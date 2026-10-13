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
 * The probe script. No parameter takes a comma list: `Get-AppxPackage -Name`
 * is typed String, and an array there is a binding error (SR review B1).
 */
export const APPLE_DEVICES_PROBE_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  `$names = @(${APPLE_STORE_PACKAGE_NAMES.map((n) => `'${n}'`).join(", ")})`,
  "$pkgs = @(Get-AppxPackage | Where-Object { $names -contains $_.Name } | ForEach-Object { $_.Name })",
  "'packages=' + ($pkgs -join ';')",
  `'amds=' + [bool](Get-Process -Name ${APPLE_DEVICES_AMDS_PROCESS} -ErrorAction SilentlyContinue)`,
  "Get-PnpDevice -PresentOnly | Where-Object { $_.InstanceId -like 'USB\\VID_05AC*' } | ForEach-Object { 'usbProvider=' + (Get-PnpDeviceProperty -InstanceId $_.InstanceId -KeyName 'DEVPKEY_Device_DriverProvider').Data }",
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
}

/** Parse the probe's `key=value` lines. Exported for tests. */
export function parseAppleDevicesProbe(stdout: string): AppleDevicesProbeResult {
  let packageInstalled = false;
  let amdsRunning = false;
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
  return { packageInstalled, amdsRunning, usbDriver };
}

export async function probeAppleDevices(): Promise<AppleDevicesProbeResult> {
  try {
    const { stdout } = await execFileAsync(
      powershellPath(),
      ["-NoProfile", "-NonInteractive", "-Command", APPLE_DEVICES_PROBE_SCRIPT],
      { timeout: 15000, windowsHide: true },
    );
    return parseAppleDevicesProbe(String(stdout));
  } catch (error) {
    log.warn("[AppleDevicesProbe] Probe failed:", error);
    return { packageInstalled: false, amdsRunning: false, usbDriver: "no-device" };
  }
}

/**
 * Does usbmux answer? `idevice_id -l` through deviceDetectionService
 * (`probeConnectedUdids`, BACKLOG-3598): a list (even empty) means usbmux
 * answered; null means it could not. NOTE: the bundled Windows binary's exit
 * code on an EMPTY list is unmeasured — with no phone attached this may read
 * false even when usbmux is fine, so it is only a second signal after the
 * process check. BACKLOG-3418: the iPhone helper runs only while iPhone
 * checking is on; when it is off this answers false without spawning anything.
 */
export async function probeUsbmux(): Promise<boolean> {
  try {
    const { deviceDetectionService } = await import("./deviceDetectionService");
    if (!deviceDetectionService.isDetectionRequested()) return false;
    return (await deviceDetectionService.probeConnectedUdids()) !== null;
  } catch (error) {
    log.warn("[AppleDevicesProbe] usbmux probe failed:", error);
    return false;
  }
}
