/**
 * Device Detection Service
 *
 * Detects connected iOS devices via USB using libimobiledevice CLI tools.
 * Emits events when devices are connected or disconnected.
 */

import { spawn, exec } from "child_process";
import { promisify } from "util";
import { EventEmitter } from "events";
import log from "electron-log";
import * as Sentry from "@sentry/electron/main";
import { iOSDevice, DeviceStorageInfo } from "../types/device";
import { getCommand, canUseLibimobiledevice } from "./libimobiledeviceService";
import { validateDeviceUdid, isValidDeviceUdid, ValidationError } from "../utils/validation";

const execAsync = promisify(exec);

/** Minimum polling interval in milliseconds */
const MIN_POLL_INTERVAL_MS = 2000;

/** Slow polling interval when tools are confirmed missing (BACKLOG-1621) */
const TOOLS_MISSING_POLL_INTERVAL_MS = 60000;

/** BACKLOG-1627: Back-off interval for trust-pending devices (ms) */
const TRUST_PENDING_BACKOFF_MS = 8000;

/**
 * BACKLOG-1627: Trust error reason parsed from libimobiledevice stderr.
 * - "locked": iPhone is locked, needs unlock + trust (error -17)
 * - "trust_pending": Trust dialog is showing on iPhone, waiting for user (error -19)
 * - "unknown": getDeviceInfo failed but error doesn't match known trust patterns
 */
export type TrustErrorReason = "locked" | "trust_pending" | "unknown";

/**
 * BACKLOG-1627: Parse libimobiledevice stderr to detect trust-related errors.
 */
function parseTrustError(errorMessage: string): TrustErrorReason | null {
  if (errorMessage.includes("Password protected")) {
    return "locked";
  }
  if (errorMessage.includes("Pairing dialog response pending")) {
    return "trust_pending";
  }
  // Other lockdownd connection failures may also be trust-related
  if (errorMessage.includes("Could not connect to lockdownd")) {
    return "unknown";
  }
  return null;
}

/** Mock device for development without Windows/iPhone */
const MOCK_DEVICE: iOSDevice = {
  udid: "00000000-0000000000000000",
  name: "Mock iPhone",
  productType: "iPhone14,2",
  productVersion: "17.0",
  serialNumber: "MOCK123456789",
  isConnected: true,
};

/**
 * Structured result from a single diagnostic step.
 */
export interface DiagnosticStep {
  name: string;
  status: "pass" | "fail" | "skip";
  durationMs: number;
  detail?: string;
  error?: string;
}

/**
 * Full diagnostic chain result for device detection troubleshooting.
 * Used by startup health checks and settings diagnostic panels.
 */
export interface DeviceDetectionDiagnostic {
  timestamp: string;
  platform: string;
  steps: DiagnosticStep[];
  overallStatus: "success" | "partial" | "failed";
  connectedDeviceCount: number;
}

/**
 * BACKLOG-1918: Result of the Windows corporate/USB-driver probe.
 * Windows-only signals used to distinguish "device physically mounted at the
 * OS/USB level" from "device detected by libimobiledevice".
 */
export interface UsbRestrictionResult {
  /** Apple Mobile Device (USB) driver service state, per `sc query`. */
  appleUsbDriverService: "running" | "stopped" | "other" | "not_found";
  /** Whether Windows PnP enumerates any Apple/iPhone USB device. */
  pnpDeviceFound: boolean;
  /** Truncated PnP status detail (or a marker like "query_failed"). */
  pnpStatus: string;
}

/**
 * BACKLOG-1918: PII-safe iPhone-sync diagnostic snapshot for support tickets.
 * Contains only status enums/booleans/counts — never a UDID or serial.
 *
 * Reports BOTH the OS/USB-level signal (`deviceMounted`) and the
 * libimobiledevice signal (`deviceDetected`). They diverge exactly when the
 * Apple Mobile Device driver is missing (Windows sees the iPhone as a
 * camera/MTP device the instant it's plugged in, but idevice_id -l returns 0),
 * which is surfaced as `driverMissingSuspected` — Zoe's exact fingerprint
 * (support ticket #64).
 */
export interface IphoneSyncDiagnostic {
  /** libimobiledevice CLI tools available (idevice_id --version succeeds). */
  libimobiledeviceAvailable: boolean;
  /** libimobiledevice reachable on PATH/bundled — mirrors availability; kept as a distinct signal for macOS. */
  libimobiledeviceInPath: boolean;
  /** Count of devices from `idevice_id -l` (source of deviceDetected). */
  connectedDeviceCount: number;
  /** OS/USB level: Windows PnP sees an iPhone (or, on non-Windows, a device was detected). */
  deviceMounted: boolean;
  /** libimobiledevice level: connectedDeviceCount > 0. */
  deviceDetected: boolean;
  /** deviceMounted && !deviceDetected → Apple driver likely missing. */
  driverMissingSuspected: boolean;
  /** Trust/lock state when a device is present-but-unusable; null otherwise. */
  trustState: TrustErrorReason | null;
  /** Windows-only USB/driver/PnP block; null on other platforms. */
  windows: UsbRestrictionResult | null;
}

/**
 * Service for detecting connected iOS devices via USB.
 *
 * Events:
 * - 'device-connected': Emitted when a new device is connected
 * - 'device-disconnected': Emitted when a device is disconnected
 *
 * @example
 * ```typescript
 * const service = new DeviceDetectionService();
 * service.on('device-connected', (device) => {
 *   console.log('Device connected:', device.name);
 * });
 * service.start();
 * ```
 */
export class DeviceDetectionService extends EventEmitter {
  private pollInterval: NodeJS.Timeout | null = null;
  private connectedDevices: Map<string, iOSDevice> = new Map();
  private isPolling: boolean = false;
  private mockMode: boolean = false;
  private libimobiledeviceAvailable: boolean | null = null;
  /** BACKLOG-1354: Tracks whether we've already sent a Sentry warning for 0 devices found.
   *  Resets when devices are found, so we only fire once per "no devices" period. */
  private sentZeroDevicesWarning: boolean = false;
  /** BACKLOG-1582: Track UDIDs we've already attempted to auto-pair, to avoid spamming every poll */
  private autoPairAttempted: Set<string> = new Set();
  /** BACKLOG-1621: Whether we've already emitted tools-missing and backed off polling */
  private toolsMissingEmitted: boolean = false;
  /** BACKLOG-1621: Current polling interval (may be elevated when tools are missing) */
  private currentPollIntervalMs: number = MIN_POLL_INTERVAL_MS;
  /** BACKLOG-1627: Track trust-pending devices with last-attempt timestamp for back-off */
  private trustPendingDevices: Map<string, number> = new Map();

  constructor() {
    super();
    this.mockMode = process.env.MOCK_DEVICE === "true";

    if (this.mockMode) {
      log.info("[DeviceDetection] Running in mock mode");
    }
  }

  /**
   * Checks if libimobiledevice CLI tools are available.
   * @returns Promise that resolves to true if available
   */
  async checkLibimobiledeviceAvailable(): Promise<boolean> {
    // BACKLOG-1621: When tools were previously missing, always re-check
    // so we detect when the user installs iTunes mid-session.
    if (this.libimobiledeviceAvailable !== null && !this.toolsMissingEmitted) {
      return this.libimobiledeviceAvailable;
    }

    // First check if we can use libimobiledevice at all (platform/mock check)
    if (!canUseLibimobiledevice()) {
      this.libimobiledeviceAvailable = false;
      log.warn(
        "[DeviceDetection] libimobiledevice not available on this platform",
      );
      return false;
    }

    try {
      const ideviceIdCmd = getCommand("idevice_id");
      log.info(`[DeviceDetection] Checking libimobiledevice at: ${ideviceIdCmd}`);
      await execAsync(`"${ideviceIdCmd}" --version`);
      this.libimobiledeviceAvailable = true;

      // BACKLOG-1621: Tools became available after being missing — resume
      if (this.toolsMissingEmitted) {
        this.toolsMissingEmitted = false;
        log.info("[DeviceDetection] Tools now available after previously missing");
        this.emit("tools-available");
        this.resumeNormalPolling();
      }

      log.info("[DeviceDetection] libimobiledevice is available");
      return true;
    } catch (err) {
      this.libimobiledeviceAvailable = false;
      log.warn(
        "[DeviceDetection] libimobiledevice is not available - device detection will not work",
        err,
      );
      return false;
    }
  }

  /**
   * Starts polling for connected devices.
   * @param intervalMs Polling interval in milliseconds (minimum 2000)
   */
  start(intervalMs: number = 2000): void {
    if (this.pollInterval) {
      log.warn("[DeviceDetection] Already running, stopping first");
      this.stop();
    }

    const actualInterval = Math.max(intervalMs, MIN_POLL_INTERVAL_MS);
    this.currentPollIntervalMs = actualInterval;
    log.info(
      `[DeviceDetection] Starting device polling (interval: ${actualInterval}ms)`,
    );

    // Do an immediate check
    this.pollDevices();

    // Set up regular polling
    this.pollInterval = setInterval(() => {
      this.pollDevices();
    }, actualInterval);
  }

  /**
   * Stops polling for devices.
   */
  stop(): void {
    if (this.pollInterval) {
      log.info("[DeviceDetection] Stopping device polling");
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  /**
   * BACKLOG-1621: Switch polling to a slow interval when tools are confirmed missing.
   * If tools become available later (user installs iTunes), checkLibimobiledeviceAvailable
   * will detect the change and resume normal polling.
   */
  private backOffPolling(): void {
    if (!this.pollInterval) return; // not currently polling
    // Already backed off — nothing to do
    if (this.currentPollIntervalMs === TOOLS_MISSING_POLL_INTERVAL_MS) return;

    clearInterval(this.pollInterval);
    this.currentPollIntervalMs = TOOLS_MISSING_POLL_INTERVAL_MS;
    log.info(
      `[DeviceDetection] Backed off polling to ${TOOLS_MISSING_POLL_INTERVAL_MS}ms`,
    );
    this.pollInterval = setInterval(() => {
      this.pollDevices();
    }, TOOLS_MISSING_POLL_INTERVAL_MS);
  }

  /**
   * BACKLOG-1621: Resume normal-speed polling after tools become available.
   */
  private resumeNormalPolling(): void {
    if (!this.pollInterval) return;
    if (this.currentPollIntervalMs === MIN_POLL_INTERVAL_MS) return;

    clearInterval(this.pollInterval);
    this.currentPollIntervalMs = MIN_POLL_INTERVAL_MS;
    log.info("[DeviceDetection] Resuming normal polling interval");
    this.pollInterval = setInterval(() => {
      this.pollDevices();
    }, MIN_POLL_INTERVAL_MS);
  }

  /**
   * Gets all currently connected devices.
   * @returns Array of connected devices
   */
  getConnectedDevices(): iOSDevice[] {
    return Array.from(this.connectedDevices.values());
  }

  /**
   * Run full diagnostic chain for troubleshooting device detection issues.
   * Reports each step to Sentry as breadcrumbs.
   * Called by startup health checks (TASK-2275) and settings diagnostics (TASK-2276).
   */
  async runDiagnosticChain(): Promise<DeviceDetectionDiagnostic> {
    const steps: DiagnosticStep[] = [];
    let connectedDeviceCount = 0;

    // Step 1: Platform check
    const platformStart = Date.now();
    const platformSupported =
      process.platform === "win32" || process.platform === "darwin";
    const platformStep: DiagnosticStep = {
      name: "platform_check",
      status: platformSupported ? "pass" : "fail",
      durationMs: Date.now() - platformStart,
      detail: `Platform: ${process.platform}`,
    };
    if (!platformSupported) {
      platformStep.error = `Unsupported platform: ${process.platform}`;
    }
    steps.push(platformStep);

    Sentry.addBreadcrumb({
      category: "diagnostics.device",
      message: `Platform check: ${platformStep.status}`,
      level: platformStep.status === "pass" ? "info" : "warning",
      data: { platform: process.platform },
    });

    // Step 2: libimobiledevice availability
    const toolStart = Date.now();
    let toolAvailable = false;
    const toolStep: DiagnosticStep = {
      name: "libimobiledevice_check",
      status: "fail",
      durationMs: 0,
    };

    if (!platformSupported) {
      toolStep.status = "skip";
      toolStep.detail = "Skipped: platform not supported";
    } else {
      try {
        // Reset cached value so we do a fresh check
        this.libimobiledeviceAvailable = null;
        toolAvailable = await this.checkLibimobiledeviceAvailable();
        toolStep.status = toolAvailable ? "pass" : "fail";
        toolStep.detail = toolAvailable
          ? "libimobiledevice is available"
          : "libimobiledevice not found";
        if (!toolAvailable) {
          toolStep.error = "libimobiledevice CLI tools not available";
        }
      } catch (err) {
        toolStep.status = "fail";
        toolStep.error =
          err instanceof Error ? err.message : "Unknown error checking tools";
      }
    }
    toolStep.durationMs = Date.now() - toolStart;
    steps.push(toolStep);

    Sentry.addBreadcrumb({
      category: "diagnostics.device",
      message: `libimobiledevice check: ${toolStep.status}`,
      level: toolStep.status === "pass" ? "info" : "warning",
      data: { available: toolAvailable },
    });

    // Step 3: Device enumeration
    const enumStart = Date.now();
    const enumStep: DiagnosticStep = {
      name: "device_enumeration",
      status: "fail",
      durationMs: 0,
    };
    let deviceUdids: string[] = [];

    if (!toolAvailable) {
      enumStep.status = "skip";
      enumStep.detail = "Skipped: libimobiledevice not available";
    } else {
      try {
        deviceUdids = await this.listDevices();
        enumStep.status = deviceUdids.length > 0 ? "pass" : "fail";
        enumStep.detail = `Found ${deviceUdids.length} device(s)`;
        if (deviceUdids.length === 0) {
          enumStep.error = "No devices detected via USB";
        }
      } catch (err) {
        enumStep.status = "fail";
        enumStep.error =
          err instanceof Error
            ? err.message
            : "Unknown error enumerating devices";
      }
    }
    enumStep.durationMs = Date.now() - enumStart;
    steps.push(enumStep);

    Sentry.addBreadcrumb({
      category: "diagnostics.device",
      message: `Device enumeration: ${enumStep.status}`,
      level: enumStep.status === "pass" ? "info" : "warning",
      data: { deviceCount: deviceUdids.length },
    });

    // Step 4: Device info (if devices found)
    const infoStart = Date.now();
    const infoStep: DiagnosticStep = {
      name: "device_info",
      status: "fail",
      durationMs: 0,
    };

    if (deviceUdids.length === 0) {
      infoStep.status = "skip";
      infoStep.detail = "Skipped: no devices to query";
    } else {
      try {
        let successCount = 0;
        for (const udid of deviceUdids) {
          try {
            await this.getDeviceInfo(udid);
            successCount++;
          } catch {
            // Individual device info failure is non-fatal
          }
        }
        connectedDeviceCount = successCount;
        infoStep.status = successCount > 0 ? "pass" : "fail";
        infoStep.detail = `Got info for ${successCount}/${deviceUdids.length} device(s)`;
        if (successCount === 0) {
          infoStep.error = "Failed to get info for any device";
        }
      } catch (err) {
        infoStep.status = "fail";
        infoStep.error =
          err instanceof Error
            ? err.message
            : "Unknown error getting device info";
      }
    }
    infoStep.durationMs = Date.now() - infoStart;
    steps.push(infoStep);

    Sentry.addBreadcrumb({
      category: "diagnostics.device",
      message: `Device info: ${infoStep.status}`,
      level: infoStep.status === "pass" ? "info" : "warning",
      data: { connectedDeviceCount },
    });

    // Determine overall status
    const passCount = steps.filter((s) => s.status === "pass").length;
    const failCount = steps.filter((s) => s.status === "fail").length;
    let overallStatus: "success" | "partial" | "failed";
    if (failCount === 0) {
      overallStatus = "success";
    } else if (passCount > 0) {
      overallStatus = "partial";
    } else {
      overallStatus = "failed";
    }

    // Summary breadcrumb
    Sentry.addBreadcrumb({
      category: "diagnostics.device",
      message: `Device detection diagnostic: ${overallStatus}`,
      level: overallStatus === "success" ? "info" : "warning",
      data: {
        steps: steps.map((s) => ({ name: s.name, status: s.status })),
      },
    });

    // Report failure to Sentry
    if (overallStatus === "failed") {
      Sentry.captureMessage("Device detection diagnostic failed", {
        level: "warning",
        tags: { platform: process.platform, diagnostic: "device_detection" },
        extra: { steps, connectedDeviceCount: 0 },
      });
    }

    return {
      timestamp: new Date().toISOString(),
      platform: process.platform,
      steps,
      overallStatus,
      connectedDeviceCount,
    };
  }

  /**
   * BACKLOG-1918: Collect a PII-safe iPhone-sync diagnostic snapshot for
   * support tickets. Composes existing plumbing:
   *  - libimobiledevice availability + device enumeration count
   *  - Windows USB/driver/PnP probe (checkCorporateUsbRestrictions) → deviceMounted
   *  - a fresh trust probe (getDeviceInfo error → parseTrustError) when a device
   *    is present-but-unusable
   *
   * `deviceMounted` (OS/USB level) vs `deviceDetected` (idevice_id -l) diverge
   * exactly when the Apple driver is missing → `driverMissingSuspected` (Zoe's
   * fingerprint, support ticket #64). Never returns a UDID or serial.
   */
  async collectIphoneSyncDiagnostics(): Promise<IphoneSyncDiagnostic> {
    const isWindows = process.platform === "win32";

    // libimobiledevice availability (fresh check).
    let libimobiledeviceAvailable = false;
    try {
      // Reset cache so we reflect current reality (e.g. iTunes installed mid-session).
      this.libimobiledeviceAvailable = null;
      libimobiledeviceAvailable = await this.checkLibimobiledeviceAvailable();
    } catch {
      libimobiledeviceAvailable = false;
    }

    // Device enumeration count (idevice_id -l).
    let udids: string[] = [];
    if (libimobiledeviceAvailable) {
      try {
        udids = await this.listDevices();
      } catch {
        udids = [];
      }
    }
    const connectedDeviceCount = udids.length;
    const deviceDetected = connectedDeviceCount > 0;

    // Windows USB/driver/PnP probe — Windows-only shell-outs; skip elsewhere.
    let windows: UsbRestrictionResult | null = null;
    if (isWindows) {
      try {
        windows = await this.checkCorporateUsbRestrictions();
      } catch {
        windows = null;
      }
    }

    // deviceMounted: OS/USB level. On Windows this is Windows PnP visibility.
    // On macOS there is no separate MTP mount, so the libimobiledevice
    // detection is the OS-level signal too.
    const deviceMounted = isWindows
      ? windows?.pnpDeviceFound ?? false
      : deviceDetected;

    // driverMissingSuspected: physically mounted but libimobiledevice can't see it.
    const driverMissingSuspected = deviceMounted && !deviceDetected;

    // Trust/lock state: only meaningful when a device is present-but-unusable.
    // Probe the first enumerated device; getDeviceInfo rejects with the stderr
    // in its message, which parseTrustError classifies.
    let trustState: TrustErrorReason | null = null;
    if (deviceDetected) {
      try {
        await this.getDeviceInfo(udids[0]);
        // Success → device is usable → no trust issue.
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        trustState = parseTrustError(message);
      }
    }

    return {
      libimobiledeviceAvailable,
      // On non-Windows, availability == on-PATH/bundled reachability.
      libimobiledeviceInPath: libimobiledeviceAvailable,
      connectedDeviceCount,
      deviceMounted,
      deviceDetected,
      driverMissingSuspected,
      trustState,
      windows,
    };
  }

  /**
   * Polls for connected devices and emits appropriate events.
   */
  private async pollDevices(): Promise<void> {
    if (this.isPolling) {
      return; // Skip if previous poll is still running
    }

    this.isPolling = true;

    try {
      const currentUdids = await this.listDevices();
      const previousUdids = new Set(this.connectedDevices.keys());

      // BACKLOG-1354: Capture a warning once when polling finds 0 devices
      // but libimobiledevice IS available (suggests device present but untrusted/blocked)
      if (currentUdids.length === 0 && this.libimobiledeviceAvailable && !this.sentZeroDevicesWarning) {
        this.sentZeroDevicesWarning = true;
        Sentry.captureMessage("Device detection found 0 devices with libimobiledevice available", {
          level: "warning",
          tags: { component: "device_detection", platform: process.platform },
          extra: {
            libimobiledeviceAvailable: true,
            hint: "Device may be present but untrusted, locked, or blocked by corporate USB policy",
          },
        });
      } else if (currentUdids.length > 0) {
        // Reset flag when devices are found so we warn again if they disappear
        this.sentZeroDevicesWarning = false;
      }

      // Check for new devices
      for (const udid of currentUdids) {
        if (!previousUdids.has(udid)) {
          // BACKLOG-1627: If this device is trust-pending, back off instead of
          // hammering getDeviceInfo every 2s poll cycle
          const lastTrustAttempt = this.trustPendingDevices.get(udid);
          if (lastTrustAttempt && (Date.now() - lastTrustAttempt) < TRUST_PENDING_BACKOFF_MS) {
            // Still within back-off window — skip this device this cycle
            continue;
          }

          log.info(`[DeviceDetection] New device found: ${udid}, fetching info...`);
          try {
            const deviceInfo = await this.getDeviceInfo(udid);
            this.connectedDevices.set(udid, deviceInfo);

            log.info(
              `[DeviceDetection] Device connected: ${deviceInfo.name} (${udid})`,
            );
            Sentry.addBreadcrumb({
              category: "device.connect",
              message: `Device connected: ${deviceInfo.name} (${deviceInfo.productType})`,
              level: "info",
              data: { udid: udid.substring(0, 8) + "...", productType: deviceInfo.productType },
            });
            this.emit("device-connected", deviceInfo);
            // BACKLOG-1582: Clear auto-pair flag on successful connection
            this.autoPairAttempted.delete(udid);
            // BACKLOG-1627: Clear trust-pending state on successful connection
            this.trustPendingDevices.delete(udid);
          } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);

            // BACKLOG-1627: Parse trust-specific error from libimobiledevice stderr
            const trustReason = parseTrustError(errorMessage);

            if (trustReason) {
              // BACKLOG-1627: Record timestamp for back-off
              this.trustPendingDevices.set(udid, Date.now());

              // BACKLOG-1631: Breadcrumb for trust-related errors
              const truncatedUdid = udid.substring(0, 8) + "...";
              Sentry.addBreadcrumb({
                category: "iphone.sync",
                message: "Device needs trust",
                level: "info",
                data: { reason: trustReason, udid: truncatedUdid },
              });

              log.warn(
                `[DeviceDetection] Device ${udid} trust issue: ${trustReason} (${errorMessage})`,
              );
            } else {
              log.error(
                `[DeviceDetection] Failed to get info for device ${udid}:`,
                err,
              );
            }

            // BACKLOG-1582: Device visible but not trusted — auto-attempt pairing
            if (!this.autoPairAttempted.has(udid)) {
              this.autoPairAttempted.add(udid);
              log.info(`[DeviceDetection] Auto-attempting pair for untrusted device: ${udid}`);
              // BACKLOG-1627: Include trust reason in event so UI can differentiate
              this.emit("device-needs-trust", { udid, reason: trustReason || "unknown" });
              this.pairDevice(udid).catch(() => {
                // Fire-and-forget — pairDevice logs its own errors
              });
            } else if (trustReason) {
              // BACKLOG-1627: Already attempted pair but reason may have changed
              // (e.g., locked -> trust_pending), re-emit event with updated reason
              this.emit("device-needs-trust", { udid, reason: trustReason });
            }
          }
        }
      }

      // Check for disconnected devices
      for (const udid of previousUdids) {
        if (!currentUdids.includes(udid)) {
          const device = this.connectedDevices.get(udid);
          if (device) {
            device.isConnected = false;
            this.connectedDevices.delete(udid);

            log.info(
              `[DeviceDetection] Device disconnected: ${device.name} (${udid})`,
            );
            Sentry.addBreadcrumb({
              category: "device.disconnect",
              message: `Device disconnected: ${device.name} (${device.productType})`,
              level: "info",
              data: { udid: udid.substring(0, 8) + "...", productType: device.productType },
            });
            this.emit("device-disconnected", device);
            // BACKLOG-1582: Clear auto-pair flag so next plug-in can auto-pair
            this.autoPairAttempted.delete(udid);
            // BACKLOG-1627: Clear trust-pending state on disconnect
            this.trustPendingDevices.delete(udid);
          }
        }
      }
    } catch (err) {
      log.error("[DeviceDetection] Error polling devices:", err);
    } finally {
      this.isPolling = false;
    }
  }

  /**
   * Lists UDIDs of all connected devices.
   * @returns Promise that resolves to array of device UDIDs
   */
  async listDevices(): Promise<string[]> {
    // Mock mode returns fake device
    if (this.mockMode) {
      return [MOCK_DEVICE.udid];
    }

    // Check if libimobiledevice is available
    const available = await this.checkLibimobiledeviceAvailable();
    if (!available) {
      return [];
    }

    return new Promise((resolve) => {
      const ideviceIdCmd = getCommand("idevice_id");
      // Don't log every poll - too noisy (runs every 2 seconds)
      const proc = spawn(ideviceIdCmd, ["-l"]);
      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (code !== 0) {
          if (stderr.trim()) {
            log.debug(`[DeviceDetection] idevice_id stderr: ${stderr.trim()}`);
            Sentry.addBreadcrumb({
              category: "device.detection",
              message: `idevice_id failed with code ${code}`,
              level: "warning",
              data: { exitCode: code, stderr: stderr.substring(0, 200) },
            });
          }
          // Non-zero exit with no devices is normal
          resolve([]);
          return;
        }

        const rawUdids = stdout
          .trim()
          .split("\n")
          .filter((line) => line.trim().length > 0);

        // SECURITY (TASK-601): Validate UDIDs returned from idevice_id
        // While this command is trusted, we validate its output as defense-in-depth
        // before using these UDIDs in subsequent spawn calls (getDeviceInfo, etc.)
        const validUdids = rawUdids.filter((udid) => {
          const valid = isValidDeviceUdid(udid);
          if (!valid) {
            log.warn(`[DeviceDetection] Ignoring invalid UDID format: ${udid}`);
          }
          return valid;
        });

        // BACKLOG-1354: When idevice_id succeeds but finds 0 devices,
        // add Sentry breadcrumb with diagnostic context for remote troubleshooting
        if (validUdids.length === 0) {
          Sentry.addBreadcrumb({
            category: "iphone.detection",
            message: "idevice_id returned empty device list",
            level: "info",
            data: {
              platform: process.platform,
              libimobiledeviceAvailable: true,
              exitCode: code,
              stderr: stderr.trim().substring(0, 200) || "(none)",
            },
          });

          // BACKLOG-1354: On Windows, check for corporate USB restrictions
          // by probing whether the Apple USB driver is loaded and if the device
          // appears in Windows PnP at all. This runs asynchronously and logs to
          // Sentry breadcrumbs — it does NOT block the resolve.
          if (process.platform === "win32") {
            this.checkCorporateUsbRestrictions().catch(() => {
              // Fire-and-forget diagnostic — errors are non-fatal
            });
          }
        }

        // Only log device count changes, not every poll
        // The pollDevices() method will log when devices connect/disconnect
        resolve(validUdids);
      });

      proc.on("error", (err) => {
        log.error("[DeviceDetection] Failed to spawn idevice_id:", err);
        Sentry.addBreadcrumb({
          category: "iphone.detection",
          message: `Failed to spawn idevice_id: ${err.message}`,
          level: "error",
          data: { platform: process.platform },
        });

        // BACKLOG-1621: Detect ENOENT (executable not found) and mark tools unavailable
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          this.libimobiledeviceAvailable = false;
          if (!this.toolsMissingEmitted) {
            this.toolsMissingEmitted = true;
            log.warn(
              "[DeviceDetection] libimobiledevice tools not found (ENOENT). " +
              "Emitting tools-missing and backing off to 60s polling.",
            );
            // BACKLOG-1631: Alert Sentry when tools are missing
            Sentry.captureMessage("libimobiledevice tools not found (ENOENT)", {
              level: "warning",
              tags: { category: "iphone.sync", operation: "tools-detection" },
            });
            this.emit("tools-missing");
            this.backOffPolling();
          }
        }

        resolve([]);
      });
    });
  }

  /**
   * Gets detailed information about a specific device.
   * @param udid Device unique identifier
   * @returns Promise that resolves to device information
   *
   * SECURITY (TASK-601): UDID is validated before use in spawn() to prevent
   * command injection. The UDID can come from listDevices() output or from
   * external callers via IPC.
   */
  async getDeviceInfo(udid: string): Promise<iOSDevice> {
    // Mock mode returns fake device info
    if (this.mockMode) {
      return { ...MOCK_DEVICE };
    }

    // SECURITY: Validate UDID before spawning process
    let validatedUdid: string;
    try {
      validatedUdid = validateDeviceUdid(udid);
    } catch (error) {
      log.error("[DeviceDetection] Invalid UDID:", error);
      throw new Error(
        error instanceof ValidationError
          ? error.message
          : "Invalid device UDID format",
      );
    }

    return new Promise((resolve, reject) => {
      const ideviceinfoCmd = getCommand("ideviceinfo");
      log.debug(`[DeviceDetection] Running: ${ideviceinfoCmd} -u ${validatedUdid}`);
      const proc = spawn(ideviceinfoCmd, ["-u", validatedUdid]);
      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (code !== 0) {
          // BACKLOG-1354: Breadcrumb when ideviceinfo fails for a specific device
          Sentry.addBreadcrumb({
            category: "iphone.detection",
            message: `ideviceinfo failed for device`,
            level: "warning",
            data: {
              udid: validatedUdid.substring(0, 8) + "...",
              exitCode: code,
              stderr: stderr.trim().substring(0, 200),
              platform: process.platform,
            },
          });
          reject(
            new Error(`ideviceinfo exited with code ${code}: ${stderr.trim()}`),
          );
          return;
        }

        try {
          const device = this.parseDeviceInfo(udid, stdout);
          resolve(device);
        } catch (err) {
          reject(err);
        }
      });

      proc.on("error", (err) => {
        Sentry.addBreadcrumb({
          category: "iphone.detection",
          message: `Failed to spawn ideviceinfo: ${err.message}`,
          level: "error",
          data: { udid: validatedUdid.substring(0, 8) + "...", platform: process.platform },
        });
        reject(new Error(`Failed to spawn ideviceinfo: ${err.message}`));
      });
    });
  }

  /**
   * BACKLOG-1582: Send a pairing request to a device.
   * This triggers the "Trust This Computer?" prompt on the iPhone.
   * @param udid Device UDID
   * @returns Promise that resolves with the pair result
   */
  async pairDevice(udid: string): Promise<{ success: boolean; needsTrust: boolean; error?: string }> {
    // SECURITY: Validate UDID before spawning process
    let validatedUdid: string;
    try {
      validatedUdid = validateDeviceUdid(udid);
    } catch (error) {
      log.error("[DeviceDetection] Invalid UDID for pairing:", error);
      return { success: false, needsTrust: false, error: "Invalid device UDID" };
    }

    return new Promise((resolve) => {
      const idevicepairCmd = getCommand("idevicepair");
      log.info(`[DeviceDetection] Requesting pair for device: ${validatedUdid}`);

      const proc = spawn(idevicepairCmd, ["pair", "-u", validatedUdid]);
      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data) => { stdout += data.toString(); });
      proc.stderr.on("data", (data) => { stderr += data.toString(); });

      proc.on("close", (code) => {
        const output = (stdout + stderr).toLowerCase();
        if (code === 0 && output.includes("success")) {
          log.info(`[DeviceDetection] Pairing successful for device: ${validatedUdid}`);
          resolve({ success: true, needsTrust: false });
        } else if (output.includes("trust") || output.includes("accept")) {
          log.info(`[DeviceDetection] Trust prompt sent to device: ${validatedUdid}`);
          resolve({ success: false, needsTrust: true });
        } else {
          log.warn(`[DeviceDetection] Pair failed: ${stdout.trim()} ${stderr.trim()}`);
          resolve({ success: false, needsTrust: false, error: stdout.trim() || stderr.trim() });
        }
      });

      proc.on("error", (err) => {
        log.error("[DeviceDetection] Failed to spawn idevicepair:", err);
        resolve({ success: false, needsTrust: false, error: err.message });
      });
    });
  }

  /**
   * Parses the output of ideviceinfo command.
   * @param udid Device UDID
   * @param output Raw output from ideviceinfo
   * @returns Parsed device information
   */
  private parseDeviceInfo(udid: string, output: string): iOSDevice {
    const lines = output.split("\n");
    const info: Record<string, string> = {};

    for (const line of lines) {
      const colonIndex = line.indexOf(":");
      if (colonIndex > 0) {
        const key = line.substring(0, colonIndex).trim();
        const value = line.substring(colonIndex + 1).trim();
        info[key] = value;
      }
    }

    return {
      udid,
      name: info["DeviceName"] || "Unknown Device",
      productType: info["ProductType"] || "Unknown",
      productVersion: info["ProductVersion"] || "Unknown",
      serialNumber: info["SerialNumber"] || "Unknown",
      isConnected: true,
    };
  }

  /**
   * BACKLOG-1354 / BACKLOG-1918: Check for corporate USB restrictions on Windows.
   * Probes whether the Apple Mobile Device USB Driver service is queryable
   * and whether Windows PnP sees any Apple/iPhone entries.
   * Results are logged to Sentry breadcrumbs for remote diagnostics AND
   * returned as a structured result so callers (e.g. support diagnostics)
   * can surface the driver-missing fingerprint. Errors are non-fatal — on
   * failure a safe default (`not_found` / no PnP device) is returned.
   *
   * Windows-only: on other platforms the shell-outs (`sc`, `wmic`) do not
   * exist, so callers should not invoke this off win32. It is defensively
   * wrapped so an accidental non-Windows call still resolves to a safe default.
   */
  private async checkCorporateUsbRestrictions(): Promise<UsbRestrictionResult> {
    let usbDriverStatus: UsbRestrictionResult["appleUsbDriverService"] =
      "not_found";
    let pnpDeviceFound = false;
    let pnpStatus = "unknown";

    try {
      // Check Apple Mobile Device USB Driver service status
      try {
        const { stdout: scOutput } = await execAsync(
          'sc query "Apple Mobile Device USB Driver"',
          { timeout: 5000 },
        );
        if (scOutput.includes("RUNNING")) {
          usbDriverStatus = "running";
        } else if (scOutput.includes("STOPPED")) {
          usbDriverStatus = "stopped";
        } else {
          usbDriverStatus = "other";
        }
      } catch {
        usbDriverStatus = "not_found";
      }

      // Check if Windows PnP sees any Apple/iPhone USB device
      try {
        const { stdout: wmicOutput } = await execAsync(
          'wmic path Win32_PnPEntity where "Name like \'%Apple%iPhone%\'" get Name,Status /format:list',
          { timeout: 5000 },
        );
        if (wmicOutput.trim()) {
          pnpDeviceFound = true;
          pnpStatus = wmicOutput.trim().substring(0, 200);
        }
      } catch {
        // wmic may not be available or query may fail — non-fatal
        pnpStatus = "query_failed";
      }

      Sentry.addBreadcrumb({
        category: "iphone.detection",
        message: "Corporate USB restriction check",
        level: "info",
        data: {
          appleUsbDriverService: usbDriverStatus,
          pnpDeviceFound,
          pnpStatus,
          hint: pnpDeviceFound && usbDriverStatus === "not_found"
            ? "Device physically connected but Apple USB driver not installed"
            : !pnpDeviceFound
              ? "No Apple/iPhone USB device visible to Windows — may be blocked by policy"
              : "Device and driver present",
        },
      });
    } catch (err) {
      log.debug("[DeviceDetection] Corporate USB check failed:", err);
    }

    return { appleUsbDriverService: usbDriverStatus, pnpDeviceFound, pnpStatus };
  }

  /**
   * Gets device storage information for estimating backup size.
   * Uses ideviceinfo -q com.apple.disk_usage to query disk usage.
   * @param udid Device UDID
   * @returns Storage info with estimated backup size
   *
   * SECURITY (TASK-601): UDID is validated before use in spawn() to prevent
   * command injection.
   */
  async getDeviceStorageInfo(udid: string): Promise<DeviceStorageInfo | null> {
    try {
      // SECURITY: Validate UDID before spawning process
      let validatedUdid: string;
      try {
        validatedUdid = validateDeviceUdid(udid);
      } catch (error) {
        log.error("[DeviceDetection] Invalid UDID for storage info:", error);
        return null;
      }

      const ideviceinfoCmd = getCommand("ideviceinfo");
      log.debug(`[DeviceDetection] Getting storage info for device: ${validatedUdid}`);

      return new Promise((resolve) => {
        // Query disk usage domain for storage information
        // SECURITY: validatedUdid has been validated
        const proc = spawn(ideviceinfoCmd, ["-u", validatedUdid, "-q", "com.apple.disk_usage"]);
        let stdout = "";
        let stderr = "";

        proc.stdout.on("data", (data) => {
          stdout += data.toString();
        });

        proc.stderr.on("data", (data) => {
          stderr += data.toString();
        });

        proc.on("close", (code) => {
          if (code !== 0) {
            log.warn(`[DeviceDetection] Failed to get storage info: ${stderr}`);
            resolve(null);
            return;
          }

          try {
            const storageInfo = this.parseStorageInfo(stdout);
            log.info(`[DeviceDetection] Storage info: ${JSON.stringify(storageInfo)}`);
            resolve(storageInfo);
          } catch (err) {
            log.error("[DeviceDetection] Failed to parse storage info:", err);
            resolve(null);
          }
        });

        proc.on("error", (err) => {
          log.error("[DeviceDetection] Failed to spawn ideviceinfo for storage:", err);
          resolve(null);
        });
      });
    } catch (err) {
      log.error("[DeviceDetection] Exception getting storage info:", err);
      return null;
    }
  }

  /**
   * Parses storage information from ideviceinfo disk_usage output.
   *
   * Common fields returned by ideviceinfo -q com.apple.disk_usage:
   * - TotalDataCapacity: Total device storage capacity in bytes
   * - TotalDataAvailable: Available free space in bytes
   * - TotalDiskCapacity: Total disk capacity (may be same as TotalDataCapacity)
   * - TotalSystemAvailable: System available space
   * - TotalSystemCapacity: System capacity
   *
   * @param output Raw output from ideviceinfo -q com.apple.disk_usage
   * @returns Parsed storage info with estimated backup size
   */
  private parseStorageInfo(output: string): DeviceStorageInfo {
    const lines = output.split("\n");
    const info: Record<string, string> = {};

    for (const line of lines) {
      const colonIndex = line.indexOf(":");
      if (colonIndex > 0) {
        const key = line.substring(0, colonIndex).trim();
        const value = line.substring(colonIndex + 1).trim();
        info[key] = value;
      }
    }

    // Log all available fields for debugging
    log.debug("[DeviceDetection] Storage info raw fields:", info);

    // Try multiple field names as they may vary by iOS version
    const totalCapacity = parseInt(
      info["TotalDataCapacity"] || info["TotalDiskCapacity"] || "0",
      10
    );
    const availableSpace = parseInt(
      info["TotalDataAvailable"] || info["TotalSystemAvailable"] || "0",
      10
    );
    const usedSpace = totalCapacity - availableSpace;

    log.info(`[DeviceDetection] Storage: total=${Math.round(totalCapacity / 1024 / 1024 / 1024)}GB, available=${Math.round(availableSpace / 1024 / 1024 / 1024)}GB, used=${Math.round(usedSpace / 1024 / 1024 / 1024)}GB`);

    // Estimate backup size based on used space
    // NOTE: This estimate is only used for first-time backups (no existing backup to reference)
    // Real-world observations:
    // - Encrypted backups include much more data than unencrypted
    // - Photos, messages with attachments can be very large
    // - "Used space" from iOS disk_usage may not include all backed-up data
    // Since skipApps is always true, apps (often 60-70% of used space) are excluded.
    // Real backups without apps are typically 15-25% of used space.
    // 25% is conservative enough to avoid underestimates.
    const BACKUP_SIZE_RATIO = 0.25; // 25% of "used" space (apps are skipped)
    const estimatedBackupSize = Math.round(usedSpace * BACKUP_SIZE_RATIO);

    log.info(`[DeviceDetection] Estimated backup size: ${Math.round(estimatedBackupSize / 1024 / 1024)} MB (${BACKUP_SIZE_RATIO * 100}% of used space)`);

    return {
      totalCapacity,
      availableSpace,
      usedSpace,
      estimatedBackupSize,
    };
  }
}

// Export singleton instance
export const deviceDetectionService = new DeviceDetectionService();
