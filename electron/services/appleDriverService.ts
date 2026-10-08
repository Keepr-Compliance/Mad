/**
 * Apple Driver Service
 *
 * Detects and installs Apple Mobile Device Support drivers on Windows.
 * These drivers are required for USB communication with iPhones.
 *
 * The drivers are bundled with the app but only installed with user consent.
 */

import { exec, execFile, spawn } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs";
import { app } from "electron";
import log from "electron-log";
import * as Sentry from "@sentry/electron/main";
import { isWindowsArm64 } from "../utils/windowsArm64";
import { mainNetFetch } from "./mainNetFetch";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// Apple iTunes download URL (contains the drivers we need)
const ITUNES_DOWNLOAD_URL = "https://www.apple.com/itunes/download/win64";

// Directory to store downloaded drivers
function getDownloadedDriversPath(): string {
  return path.join(app.getPath("userData"), "apple-drivers");
}

/**
 * Status of Apple drivers on the system
 */
export interface AppleDriverStatus {
  /** Whether Apple Mobile Device Support is installed */
  isInstalled: boolean;
  /** Version of installed drivers, if available */
  version: string | null;
  /** Whether the Apple Mobile Device Service is running */
  serviceRunning: boolean;
  /** Error message if check failed */
  error: string | null;
}

/**
 * Result of driver installation attempt
 */
export interface DriverInstallResult {
  success: boolean;
  error: string | null;
  /** Whether a reboot is required */
  rebootRequired: boolean;
  /** Whether the user cancelled the installation (e.g., declined UAC) */
  cancelled?: boolean;
}

/**
 * Comprehensive driver diagnostics for display in Settings UI.
 * Consumed by TASK-2277 (Sync Tools UI).
 */
export interface DriverDiagnostics {
  isInstalled: boolean;
  version: string | null;
  serviceRunning: boolean;
  bundledDriverAvailable: boolean;
  lastError: string | null;
  lastCheckTimestamp: string;
}

/** Classification of driver install failure reasons */
export type DriverFailureReason =
  | "insufficient_storage"
  | "permissions_denied"
  | "network_error"
  | "extraction_failed"
  | "msi_not_found"
  | "user_cancelled"
  | "unknown";

/**
 * Classify the reason for a driver installation failure.
 * Used for Sentry tagging and user-facing error messages (TASK-2276).
 */
export function classifyInstallFailure(
  result: DriverInstallResult,
  msiPath: string | null,
): DriverFailureReason {
  if (result.cancelled) return "user_cancelled";
  if (!msiPath) return "msi_not_found";
  if (result.error?.includes("1603")) return "permissions_denied";
  if (result.error?.includes("disk") || result.error?.includes("space"))
    return "insufficient_storage";
  return "unknown";
}

/**
 * Report a driver installation failure to Sentry with classification and context.
 * Does not report on non-Windows platforms (drivers are N/A on macOS).
 */
function reportInstallFailure(
  result: DriverInstallResult,
  msiPath: string | null,
): void {
  if (process.platform !== "win32") return;

  const reason = classifyInstallFailure(result, msiPath);
  Sentry.captureMessage("Apple driver installation failed", {
    level: reason === "user_cancelled" ? "info" : "error",
    tags: {
      component: "apple_driver",
      platform: "win32",
      failureReason: reason,
    },
    extra: {
      error: result.error,
      rebootRequired: result.rebootRequired,
      msiPathAvailable: !!msiPath,
    },
  });
}

/**
 * Get comprehensive driver diagnostics for display in Settings.
 * Called by TASK-2277 (Sync Tools UI).
 */
export async function getDriverDiagnostics(): Promise<DriverDiagnostics> {
  const status = await checkAppleDrivers();
  const hasBundled = hasBundledDrivers();

  Sentry.addBreadcrumb({
    category: "diagnostics.driver",
    message: `Driver check: installed=${status.isInstalled}, service=${status.serviceRunning}`,
    level: "info",
    data: { ...status, bundledAvailable: hasBundled },
  });

  return {
    isInstalled: status.isInstalled,
    version: status.version,
    serviceRunning: status.serviceRunning,
    bundledDriverAvailable: hasBundled,
    lastError: status.error,
    lastCheckTimestamp: new Date().toISOString(),
  };
}

/**
 * Check if Apple Mobile Device Support drivers are installed
 */
export async function checkAppleDrivers(): Promise<AppleDriverStatus> {
  if (process.platform !== "win32") {
    return {
      isInstalled: true, // Not needed on non-Windows
      version: null,
      serviceRunning: true,
      error: null,
    };
  }

  try {
    // Check if Apple Mobile Device Support is installed via registry
    const registryCheck = await checkRegistry();

    // Check if the service exists and is running
    const serviceStatus = await checkAppleMobileDeviceService();

    const result: AppleDriverStatus = {
      isInstalled: registryCheck.installed,
      version: registryCheck.version,
      serviceRunning: serviceStatus,
      error: null,
    };

    // Persist driver state on Sentry scope for enrichment of future events
    Sentry.setContext("apple_drivers", {
      isInstalled: result.isInstalled,
      version: result.version,
      serviceRunning: result.serviceRunning,
    });

    // BACKLOG-1354: Enhanced breadcrumb with full driver diagnostic context
    // for remote troubleshooting of iPhone sync issues on Windows
    const serviceStatusLabel = result.serviceRunning
      ? "running"
      : result.isInstalled
        ? "stopped"
        : "not-found";

    Sentry.addBreadcrumb({
      category: "iphone.driver",
      message: `Apple driver check: installed=${result.isInstalled}, version=${result.version}, service=${serviceStatusLabel}`,
      level: "info",
      data: {
        registryFound: result.isInstalled,
        driverVersion: result.version,
        serviceStatus: serviceStatusLabel,
        installationPathFound: result.isInstalled,
      },
    });

    return result;
  } catch (error) {
    log.error("[AppleDriverService] Error checking drivers:", error);

    Sentry.setContext("apple_drivers", {
      isInstalled: false,
      version: null,
      serviceRunning: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });

    Sentry.addBreadcrumb({
      category: "driver.check",
      message: "Apple driver check failed",
      level: "error",
      data: {
        error: error instanceof Error ? error.message : "Unknown error",
      },
    });

    return {
      isInstalled: false,
      version: null,
      serviceRunning: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Check Windows registry for Apple Mobile Device Support
 */
async function checkRegistry(): Promise<{
  installed: boolean;
  version: string | null;
}> {
  try {
    // Check 64-bit registry
    const { stdout } = await execAsync(
      'reg query "HKLM\\SOFTWARE\\Apple Inc.\\Apple Mobile Device Support" /v Version',
      { timeout: 5000 },
    );

    const versionMatch = stdout.match(/Version\s+REG_SZ\s+(.+)/);
    if (versionMatch) {
      return {
        installed: true,
        version: versionMatch[1].trim(),
      };
    }
  } catch {
    // Registry key doesn't exist - not installed
  }

  try {
    // Check 32-bit registry (WOW6432Node)
    const { stdout } = await execAsync(
      'reg query "HKLM\\SOFTWARE\\WOW6432Node\\Apple Inc.\\Apple Mobile Device Support" /v Version',
      { timeout: 5000 },
    );

    const versionMatch = stdout.match(/Version\s+REG_SZ\s+(.+)/);
    if (versionMatch) {
      return {
        installed: true,
        version: versionMatch[1].trim(),
      };
    }
  } catch {
    // Registry key doesn't exist - not installed
  }

  // Alternative check: look for the service executable
  try {
    const programFiles = process.env["ProgramFiles"] || "C:\\Program Files";
    const servicePath = path.join(
      programFiles,
      "Common Files",
      "Apple",
      "Mobile Device Support",
      "AppleMobileDeviceService.exe",
    );

    if (fs.existsSync(servicePath)) {
      return { installed: true, version: null };
    }
  } catch {
    // File check failed
  }

  return { installed: false, version: null };
}

/**
 * Check if Apple Mobile Device Service is running
 */
async function checkAppleMobileDeviceService(): Promise<boolean> {
  try {
    const { stdout } = await execAsync(
      'sc query "Apple Mobile Device Service"',
      { timeout: 5000 },
    );

    return stdout.includes("RUNNING");
  } catch {
    return false;
  }
}

/**
 * Get path to bundled Apple driver MSI
 * Checks both bundled resources and previously downloaded drivers
 */
export function getBundledDriverPath(): string | null {
  // First, check for previously downloaded drivers
  const downloadedPath = getDownloadedDriverPath();
  if (downloadedPath) {
    log.info(
      "[AppleDriverService] Using downloaded driver at:",
      downloadedPath,
    );
    return downloadedPath;
  }

  // Then check bundled resources
  const isDev = !app.isPackaged;

  let basePath: string;
  if (isDev) {
    basePath = path.join(__dirname, "../../resources/win/apple-drivers");
  } else {
    basePath = path.join(process.resourcesPath, "win/apple-drivers");
  }

  const msiPath = path.join(basePath, "AppleMobileDeviceSupport64.msi");

  if (fs.existsSync(msiPath)) {
    return msiPath;
  }

  // Try alternative name
  const altPath = path.join(basePath, "AppleMobileDeviceSupport.msi");
  if (fs.existsSync(altPath)) {
    return altPath;
  }

  log.warn("[AppleDriverService] No driver MSI found (bundled or downloaded)");
  return null;
}

/**
 * Check if bundled drivers are available
 */
export function hasBundledDrivers(): boolean {
  return getBundledDriverPath() !== null;
}

/**
 * Install Apple Mobile Device Support drivers
 * Requires user consent before calling this function
 *
 * @returns Installation result
 */
export async function installAppleDrivers(): Promise<DriverInstallResult> {
  if (process.platform !== "win32") {
    return {
      success: false,
      error: "Driver installation only supported on Windows",
      rebootRequired: false,
    };
  }

  // BACKLOG-3363: Apple's driver is x64-only and cannot load on Windows on ARM.
  // Refuse before any installer runs. Not a driver failure, so nothing is
  // reported to Sentry and no install breadcrumb is emitted. The renderer
  // never offers Install on these PCs; this is the main-process backstop.
  if (
    isWindowsArm64(
      process.platform,
      process.arch,
      app?.runningUnderARM64Translation,
    )
  ) {
    log.info(
      "[AppleDriverService] Windows on ARM: Apple driver install not supported, skipping",
    );
    return {
      success: false,
      error: "iPhone USB sync isn't supported on this PC",
      rebootRequired: false,
    };
  }

  Sentry.addBreadcrumb({
    category: "driver.install",
    message: "Starting Apple driver installation",
    level: "info",
  });

  const msiPath = getBundledDriverPath();
  if (!msiPath) {
    Sentry.addBreadcrumb({
      category: "driver.install",
      message: "MSI package not found",
      level: "warning",
    });
    const failResult: DriverInstallResult = {
      success: false,
      error:
        "Apple driver package not found. Please install iTunes from the Microsoft Store.",
      rebootRequired: false,
    };
    reportInstallFailure(failResult, msiPath);
    return failResult;
  }

  log.info("[AppleDriverService] Installing Apple drivers from:", msiPath);

  Sentry.addBreadcrumb({
    category: "driver.install",
    message: "Running MSI installer",
    level: "info",
    data: { msiPathAvailable: true },
  });

  try {
    // Run MSI installer silently
    // /qn = quiet, no UI
    // /norestart = don't restart automatically
    // REBOOT=ReallySuppress = suppress reboot prompts
    const result = await runMsiInstaller(msiPath);

    if (result.success) {
      log.info("[AppleDriverService] Installer reported success, verifying...");

      Sentry.addBreadcrumb({
        category: "driver.install",
        message: "MSI installer succeeded, verifying installation",
        level: "info",
      });

      // Verify that drivers are actually installed
      // This catches cases where UAC was declined but exit code was 0
      const verification = await checkAppleDrivers();

      if (!verification.isInstalled) {
        log.warn("[AppleDriverService] Verification failed - drivers not installed despite success code");
        Sentry.addBreadcrumb({
          category: "driver.install",
          message: "Post-install verification failed - drivers not detected",
          level: "warning",
        });
        const cancelledResult: DriverInstallResult = {
          success: false,
          error: null,
          rebootRequired: false,
          cancelled: true, // Assume user cancelled UAC
        };
        reportInstallFailure(cancelledResult, msiPath);
        return cancelledResult;
      }

      log.info("[AppleDriverService] Driver installation verified successfully");

      Sentry.addBreadcrumb({
        category: "driver.install",
        message: "Driver installation verified successfully",
        level: "info",
      });

      // Start the service if it's not running
      await startAppleMobileDeviceService();
    }

    if (!result.success) {
      Sentry.addBreadcrumb({
        category: "driver.install",
        message: `MSI installer failed: ${result.error ?? "unknown"}`,
        level: "error",
        data: { cancelled: result.cancelled },
      });
      reportInstallFailure(result, msiPath);
    }

    return result;
  } catch (error) {
    log.error("[AppleDriverService] Installation failed:", error);

    Sentry.addBreadcrumb({
      category: "driver.install",
      message: "Driver installation threw exception",
      level: "error",
      data: {
        error: error instanceof Error ? error.message : "Unknown error",
      },
    });

    const errorResult: DriverInstallResult = {
      success: false,
      error: error instanceof Error ? error.message : "Installation failed",
      rebootRequired: false,
    };
    reportInstallFailure(errorResult, msiPath);
    return errorResult;
  }
}

/**
 * Run MSI installer with elevated privileges using PowerShell
 * This triggers the UAC prompt for admin elevation
 *
 * SECURITY AUDIT (TASK-601):
 * This function uses spawn("powershell", ...) with msiPath embedded in the command.
 *
 * RISK ANALYSIS:
 * - msiPath comes from getBundledDriverPath() which returns paths from:
 *   1. getDownloadedDriverPath() - paths within app.getPath("userData")
 *   2. Bundled resources (process.resourcesPath or __dirname)
 * - The path is NOT user-controlled - it's constructed internally from known directories
 * - The path is validated by fs.existsSync() before being used
 *
 * CONCLUSION: SAFE - No user-controlled input flows into the spawn command.
 * The msiPath is always from trusted internal sources (bundled resources or app's
 * userData directory with fixed subdirectory structure).
 *
 * DEFENSE-IN-DEPTH: The path is quoted in the PowerShell command to handle
 * paths with spaces, and msiexec.exe is the target executable (a known Windows binary).
 */
function runMsiInstaller(msiPath: string): Promise<DriverInstallResult> {
  return new Promise((resolve) => {
    // Build msiexec arguments
    // SECURITY: msiPath is from trusted internal sources (bundled or userData)
    const msiArgs = `/i "${msiPath}" /qn /norestart REBOOT=ReallySuppress`;

    // Use PowerShell Start-Process with -Verb RunAs to trigger UAC elevation
    // -Wait ensures we wait for the installation to complete
    // -PassThru returns the process object so we can get the exit code
    // Wrap in try-catch to properly handle UAC decline (which throws an exception)
    const psCommand = `
      try {
        $process = Start-Process -FilePath "msiexec.exe" -ArgumentList '${msiArgs}' -Verb RunAs -Wait -PassThru -ErrorAction Stop
        exit $process.ExitCode
      } catch {
        # UAC declined or other error starting the elevated process
        # Exit with 1602 (ERROR_INSTALL_USEREXIT) to indicate user cancellation
        exit 1602
      }
    `.trim();

    log.info("[AppleDriverService] Running elevated installer via PowerShell");
    log.info("[AppleDriverService] msiexec args:", msiArgs);

    const installer = spawn("powershell", ["-Command", psCommand], {
      shell: false,
    });

    let stderr = "";
    let stdout = "";

    installer.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    installer.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    installer.on("close", (code) => {
      log.info("[AppleDriverService] Installer exited with code:", code);
      log.info("[AppleDriverService] stdout:", stdout);
      if (stderr) log.info("[AppleDriverService] stderr:", stderr);

      // BACKLOG-1354: Breadcrumb with full MSI installer result for remote diagnostics
      const uacDenied = code === 1602 || code === 1;
      Sentry.addBreadcrumb({
        category: "iphone.driver",
        message: `MSI installer exited with code ${code}`,
        level: code === 0 || code === 3010 ? "info" : "warning",
        data: {
          exitCode: code,
          uacDenied,
          stderr: stderr.substring(0, 300) || "(none)",
          stdout: stdout.substring(0, 200) || "(none)",
        },
      });

      if (code === 0) {
        resolve({
          success: true,
          error: null,
          rebootRequired: false,
        });
      } else if (code === 3010) {
        // 3010 = ERROR_SUCCESS_REBOOT_REQUIRED
        resolve({
          success: true,
          error: null,
          rebootRequired: true,
        });
      } else if (code === 1602 || code === 1) {
        // 1602 = ERROR_INSTALL_USEREXIT (user cancelled UAC or installer)
        // 1 = PowerShell error, often from cancelled UAC
        resolve({
          success: false,
          error: null,
          rebootRequired: false,
          cancelled: true,
        });
      } else if (code === 1603) {
        // 1603 = ERROR_INSTALL_FAILURE
        resolve({
          success: false,
          error: "Installation failed. The installer encountered an error.",
          rebootRequired: false,
        });
      } else {
        resolve({
          success: false,
          error: `Installation failed with code ${code}. ${stderr}`.trim(),
          rebootRequired: false,
        });
      }
    });

    installer.on("error", (error) => {
      log.error("[AppleDriverService] Failed to start installer:", error);
      resolve({
        success: false,
        error: `Failed to start installer: ${error.message}`,
        rebootRequired: false,
      });
    });
  });
}

/**
 * Start Apple Mobile Device Service
 */
async function startAppleMobileDeviceService(): Promise<void> {
  try {
    await execAsync('net start "Apple Mobile Device Service"', {
      timeout: 30000,
    });
    log.info("[AppleDriverService] Apple Mobile Device Service started");
  } catch (error) {
    // Service might already be running or might need a reboot
    log.warn("[AppleDriverService] Could not start service:", error);
  }
}

/**
 * Download a file from URL to destination.
 *
 * BACKLOG-3799: over Electron net.fetch (Chromium TLS + OS certificate
 * store), not Node's `https`, so a TLS-inspecting antivirus does not break
 * the driver download. Redirects are followed by the transport.
 */
async function downloadFile(
  url: string,
  destPath: string,
  onProgress?: (percent: number) => void,
): Promise<void> {
  const response = await mainNetFetch(url, { redirect: "follow" });
  if (response.status !== 200 || !response.body) {
    throw new Error(`Failed to download: HTTP ${response.status}`);
  }

  const totalSize = parseInt(response.headers.get("content-length") || "0", 10);
  let downloadedSize = 0;
  const file = fs.createWriteStream(destPath);
  const reader = response.body.getReader();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      downloadedSize += value.length;
      if (!file.write(value)) {
        await new Promise<void>((resolve) => file.once("drain", resolve));
      }
      if (onProgress && totalSize > 0) {
        onProgress(Math.round((downloadedSize / totalSize) * 100));
      }
    }
    await new Promise<void>((resolve, reject) => {
      file.once("error", reject);
      file.end(() => resolve());
    });
  } catch (err) {
    file.destroy();
    fs.unlink(destPath, () => {}); // Delete partial file
    throw err;
  }
}

/**
 * Get path to bundled 7za.exe (standalone 7-Zip CLI)
 */
function getBundled7za(): string | null {
  const isDev = !app.isPackaged;

  let basePath: string;
  if (isDev) {
    basePath = path.join(__dirname, "../../resources/win");
  } else {
    basePath = path.join(process.resourcesPath, "win");
  }

  const sevenZaPath = path.join(basePath, "7za.exe");
  if (fs.existsSync(sevenZaPath)) {
    return sevenZaPath;
  }

  return null;
}

/**
 * Find 7-zip executable on the system
 * Checks bundled 7za.exe first, then system installations
 */
function find7Zip(): string | null {
  // First check for bundled 7za.exe
  const bundled = getBundled7za();
  if (bundled) {
    log.info("[AppleDriverService] Using bundled 7za.exe");
    return bundled;
  }

  // Then check system installations
  const possiblePaths = [
    "C:\\Program Files\\7-Zip\\7z.exe",
    "C:\\Program Files (x86)\\7-Zip\\7z.exe",
    path.join(process.env.LOCALAPPDATA || "", "7-Zip", "7z.exe"),
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  return null;
}

/**
 * Recursively find files matching a pattern
 */
function findFilesRecursive(
  dir: string,
  pattern: RegExp,
  maxDepth = 3,
  currentDepth = 0,
): string[] {
  const results: string[] = [];

  if (currentDepth > maxDepth || !fs.existsSync(dir)) {
    return results;
  }

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isFile() && pattern.test(entry.name)) {
        results.push(fullPath);
      } else if (entry.isDirectory()) {
        results.push(
          ...findFilesRecursive(fullPath, pattern, maxDepth, currentDepth + 1),
        );
      }
    }
  } catch {
    // Ignore permission errors
  }

  return results;
}

/**
 * Extract MSI from iTunes installer
 * iTunes installer is an EXE that contains multiple MSI files
 */
/**
 * Validate that a file path is safe for use in shell commands.
 * Rejects paths containing shell metacharacters that could enable injection
 * and path traversal sequences that could escape the intended directory.
 *
 * BACKLOG-1085: Added path traversal check for consistent validation.
 */
function validateShellPath(p: string): string {
  // Only allow alphanumeric, path separators, dots, hyphens, underscores, spaces
  if (/[`$|;&<>(){}!\[\]'"\\*?~#]/.test(p)) {
    throw new Error(`Unsafe characters in path: ${p}`);
  }
  // Reject path traversal sequences (.. as a path component)
  if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(p)) {
    throw new Error(`Path traversal detected in path: ${p}`);
  }
  return p;
}

async function extractMsiFromInstaller(
  installerPath: string,
  outputDir: string,
): Promise<string | null> {
  try {
    // Validate paths before shell usage to prevent command injection and traversal
    // BACKLOG-1085: Consistent validation for all paths before any extraction method
    const safeInstallerPath = validateShellPath(installerPath);
    const safeOutputDir = validateShellPath(outputDir);

    // Verify installer file exists before attempting extraction
    if (!fs.existsSync(safeInstallerPath)) {
      throw new Error(`Installer file does not exist: ${safeInstallerPath}`);
    }

    // Create output directory
    if (!fs.existsSync(safeOutputDir)) {
      fs.mkdirSync(safeOutputDir, { recursive: true });
    }

    log.info("[AppleDriverService] Extracting iTunes installer...");

    // Method 1: Try 7-Zip (most reliable for iTunes installer)
    // Uses execFileAsync (argument array) instead of execAsync (shell string)
    // to avoid shell interpretation of interpolated paths (CodeQL: js/shell-command-injection-from-environment).
    const sevenZipPath = find7Zip();
    if (sevenZipPath) {
      log.info("[AppleDriverService] Found 7-Zip at:", sevenZipPath);
      try {
        await execFileAsync(
          sevenZipPath,
          ["x", safeInstallerPath, `-o${safeOutputDir}`, "-y"],
          { timeout: 120000 },
        );
        log.info("[AppleDriverService] 7-Zip extraction successful");
      } catch (err) {
        log.warn("[AppleDriverService] 7-Zip extraction failed:", err);
      }
    } else {
      log.info(
        "[AppleDriverService] 7-Zip not found, trying alternative methods...",
      );

      // Method 2: Try running installer with /extract (some Apple installers support this)
      try {
        await execFileAsync(
          safeInstallerPath,
          ["/extract", safeOutputDir],
          { timeout: 120000 },
        );
        log.info("[AppleDriverService] /extract flag worked");
      } catch {
        log.info("[AppleDriverService] /extract flag not supported");

        // Method 3: Try expand command (works for some archive types)
        try {
          await execFileAsync(
            "expand",
            [safeInstallerPath, "-F:*", safeOutputDir],
            { timeout: 120000 },
          );
          log.info("[AppleDriverService] expand command worked");
        } catch {
          log.info("[AppleDriverService] expand command failed");

          // Method 4: Try 7z command from PATH
          try {
            await execFileAsync(
              "7z",
              ["x", safeInstallerPath, `-o${safeOutputDir}`, "-y"],
              { timeout: 120000 },
            );
            log.info("[AppleDriverService] 7z from PATH worked");
          } catch {
            log.error("[AppleDriverService] No extraction method available");
            log.error(
              "[AppleDriverService] 7-Zip is required to extract Apple drivers.",
            );
            log.error(
              "[AppleDriverService] Either bundle 7za.exe in resources/win/ or install 7-Zip from https://7-zip.org/",
            );
            throw new Error(
              "7-Zip is required to extract the driver installer. Please install 7-Zip from https://7-zip.org/ and try again.",
            );
          }
        }
      }
    }

    // Look for the AppleMobileDeviceSupport MSI anywhere in the extracted files
    const msiPattern = /AppleMobileDeviceSupport(64)?\.msi$/i;
    const foundMsis = findFilesRecursive(outputDir, msiPattern);

    if (foundMsis.length > 0) {
      // Prefer 64-bit version
      const msi64 = foundMsis.find((f) => f.toLowerCase().includes("64"));
      const selectedMsi = msi64 || foundMsis[0];
      log.info("[AppleDriverService] Found MSI:", selectedMsi);
      return selectedMsi;
    }

    // List what we did extract for debugging
    log.warn("[AppleDriverService] MSI not found. Extracted contents:");
    try {
      const extracted = fs.readdirSync(outputDir);
      log.warn(
        "[AppleDriverService] Files in output dir:",
        extracted.slice(0, 20),
      ); // First 20 files
    } catch {
      log.warn("[AppleDriverService] Could not list output directory");
    }

    log.error(
      "[AppleDriverService] AppleMobileDeviceSupport MSI not found in extracted files",
    );
    log.error(
      "[AppleDriverService] The iTunes installer format may have changed.",
    );
    return null;
  } catch (error) {
    log.error("[AppleDriverService] Failed to extract installer:", error);
    return null;
  }
}

/**
 * Download and extract Apple drivers on-demand
 * Call this after user consents to installation
 */
export async function downloadAppleDrivers(
  onProgress?: (status: {
    phase: "downloading" | "extracting" | "complete";
    percent: number;
  }) => void,
): Promise<{ success: boolean; msiPath?: string; error?: string }> {
  const driversDir = getDownloadedDriversPath();
  const installerPath = path.join(driversDir, "iTunes64Setup.exe");
  const extractDir = path.join(driversDir, "extracted");

  try {
    // Create directory if needed
    if (!fs.existsSync(driversDir)) {
      fs.mkdirSync(driversDir, { recursive: true });
    }

    // Check if we already have the extracted MSI
    const existingMsi = getDownloadedDriverPath();
    if (existingMsi) {
      log.info("[AppleDriverService] Using previously downloaded drivers");
      onProgress?.({ phase: "complete", percent: 100 });
      return { success: true, msiPath: existingMsi };
    }

    // Download iTunes installer
    log.info("[AppleDriverService] Downloading iTunes installer...");
    onProgress?.({ phase: "downloading", percent: 0 });

    await downloadFile(ITUNES_DOWNLOAD_URL, installerPath, (percent) =>
      onProgress?.({ phase: "downloading", percent }),
    );

    log.info("[AppleDriverService] Download complete, extracting...");
    onProgress?.({ phase: "extracting", percent: 0 });

    // Extract the MSI
    const msiPath = await extractMsiFromInstaller(installerPath, extractDir);

    // Clean up installer to save space
    try {
      fs.unlinkSync(installerPath);
    } catch {
      // Ignore cleanup errors
    }

    if (!msiPath) {
      if (process.platform === "win32") {
        Sentry.captureMessage("Apple driver extraction failed", {
          level: "error",
          tags: {
            component: "apple_driver",
            platform: "win32",
            failureReason: "extraction_failed",
          },
          extra: {
            phase: "extracting",
          },
        });
      }
      return {
        success: false,
        error:
          "Could not extract Apple drivers from installer. Please install iTunes manually.",
      };
    }

    onProgress?.({ phase: "complete", percent: 100 });
    return { success: true, msiPath };
  } catch (error) {
    log.error("[AppleDriverService] Failed to download drivers:", error);

    if (process.platform === "win32") {
      const errorMsg =
        error instanceof Error ? error.message : "Download failed";
      const isNetworkError =
        errorMsg.includes("ECONNREFUSED") ||
        errorMsg.includes("ENOTFOUND") ||
        errorMsg.includes("ETIMEDOUT") ||
        errorMsg.includes("Failed to download");
      Sentry.captureMessage("Apple driver download failed", {
        level: "error",
        tags: {
          component: "apple_driver",
          platform: "win32",
          failureReason: isNetworkError ? "network_error" : "unknown",
        },
        extra: {
          error: errorMsg,
          phase: "downloading",
        },
      });
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : "Download failed",
    };
  }
}

/**
 * Get path to downloaded (on-demand) driver MSI
 */
function getDownloadedDriverPath(): string | null {
  const extractDir = path.join(getDownloadedDriversPath(), "extracted");

  if (!fs.existsSync(extractDir)) {
    return null;
  }

  // Use recursive search to find the MSI anywhere in the extracted folder
  const msiPattern = /AppleMobileDeviceSupport(64)?\.msi$/i;
  const foundMsis = findFilesRecursive(extractDir, msiPattern);

  if (foundMsis.length > 0) {
    // Prefer 64-bit version
    const msi64 = foundMsis.find((f) => f.toLowerCase().includes("64"));
    return msi64 || foundMsis[0];
  }

  return null;
}

/**
 * Get iTunes download URL
 */
export function getITunesDownloadUrl(): string {
  // Microsoft Store link - easiest for users
  return "ms-windows-store://pdp/?ProductId=9PB2MZ1ZMB1S";
}

/**
 * Get iTunes web download URL (fallback)
 */
export function getITunesWebUrl(): string {
  return "https://www.apple.com/itunes/download/win64";
}

/**
 * Compare two version strings
 * @returns negative if a < b, 0 if a == b, positive if a > b
 */
export function compareVersions(a: string | null, b: string | null): number {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;

  const partsA = a.split(".").map(Number);
  const partsB = b.split(".").map(Number);

  const maxLength = Math.max(partsA.length, partsB.length);

  for (let i = 0; i < maxLength; i++) {
    const numA = partsA[i] || 0;
    const numB = partsB[i] || 0;
    if (numA !== numB) {
      return numA - numB;
    }
  }

  return 0;
}

/**
 * Get the bundled driver version from a version file
 * We store this in a version.txt file alongside the MSI
 */
export function getBundledDriverVersion(): string | null {
  const driverPath = getBundledDriverPath();
  if (!driverPath) return null;

  const versionFilePath = path.join(path.dirname(driverPath), "version.txt");

  try {
    if (fs.existsSync(versionFilePath)) {
      const version = fs.readFileSync(versionFilePath, "utf-8").trim();
      return version || null;
    }
  } catch (error) {
    log.warn("[AppleDriverService] Could not read bundled version:", error);
  }

  return null;
}

/**
 * Check if a driver update is available
 */
export async function checkForDriverUpdate(): Promise<{
  updateAvailable: boolean;
  installedVersion: string | null;
  bundledVersion: string | null;
}> {
  const status = await checkAppleDrivers();
  const bundledVersion = getBundledDriverVersion();

  // If not installed, definitely needs installation (not an "update" per se)
  if (!status.isInstalled) {
    return {
      updateAvailable: false, // It's a fresh install, not an update
      installedVersion: null,
      bundledVersion,
    };
  }

  // If we don't know the bundled version, can't determine if update is available
  if (!bundledVersion) {
    return {
      updateAvailable: false,
      installedVersion: status.version,
      bundledVersion: null,
    };
  }

  // Compare versions
  const needsUpdate = compareVersions(status.version, bundledVersion) < 0;

  return {
    updateAvailable: needsUpdate,
    installedVersion: status.version,
    bundledVersion,
  };
}
