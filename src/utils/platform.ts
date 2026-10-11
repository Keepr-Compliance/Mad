import logger from './logger';
/**
 * Platform Detection Utility
 *
 * Detects the current operating system and provides feature availability checks.
 * Used to show/hide features based on platform capabilities:
 * - macOS: Can access local Messages.app database directly
 * - Windows: Must sync from iPhone via USB
 * - Linux: Similar to Windows (USB sync)
 */

export type Platform = "macos" | "windows" | "linux";

/**
 * Gets the current platform from Electron's process.platform.
 * Falls back to navigator.platform and navigator.userAgent if Electron API
 * is not yet available (race condition during app initialization).
 * Defaults to 'windows' if platform cannot be determined.
 */
export function getPlatform(): Platform {
  // Try Electron API first (most reliable when available)
  const electronPlatform = window.api?.system?.platform;

  if (electronPlatform) {
    switch (electronPlatform) {
      case "darwin":
        return "macos";
      case "win32":
        return "windows";
      case "linux":
        return "linux";
    }
  }

  // Fallback to navigator.platform (works before window.api is populated)
  const navPlatform = navigator.platform?.toLowerCase() || "";

  if (navPlatform.includes("mac")) return "macos";
  if (navPlatform.includes("win")) return "windows";
  if (navPlatform.includes("linux")) return "linux";

  // Fallback to userAgent as last resort
  const userAgent = navigator.userAgent?.toLowerCase() || "";

  if (userAgent.includes("mac")) return "macos";
  if (userAgent.includes("win")) return "windows";
  if (userAgent.includes("linux")) return "linux";

  // Last resort default - log warning for debugging
  logger.warn(
    `[Platform] Could not detect platform. electronPlatform=${electronPlatform}, ` +
      `navPlatform=${navPlatform}. Defaulting to Windows.`,
  );
  return "windows";
}

/**
 * Returns true if running on macOS
 */
export function isMacOS(): boolean {
  return getPlatform() === "macos";
}

/**
 * Returns true if running on Windows
 */
export function isWindows(): boolean {
  return getPlatform() === "windows";
}

/**
 * Returns true if running on Linux
 */
export function isLinux(): boolean {
  return getPlatform() === "linux";
}

/**
 * BACKLOG-3363: true on a Windows on ARM PC (e.g. Snapdragon), where iPhone
 * USB sync can never work. Read synchronously from the preload bridge (main
 * passes it via argv), so the first render already knows. Absent → false.
 */
export function isWindowsArm64(): boolean {
  return window.api?.system?.isWindowsArm64 === true;
}

/**
 * Returns true if running inside Electron (desktop app).
 * Checks for the presence of the Electron IPC bridge (window.api).
 * Returns false in browser environments (Android WebView, mobile browsers, etc.)
 */
export function isElectron(): boolean {
  return typeof window !== "undefined" && !!window.api;
}

/**
 * Feature availability by platform.
 * Maps feature names to the platforms where they are available.
 */
export const platformFeatures = {
  /** Access to local Messages.app database (macOS only) */
  localMessagesAccess: ["macos"],
  /** Access to local Contacts.app database (macOS only) */
  localContactsAccess: ["macos"],
  /** Sync messages from iPhone via USB (Windows/Linux) */
  iPhoneUSBSync: ["windows", "linux"],
  /** Email integration via OAuth (all platforms) */
  emailIntegration: ["macos", "windows", "linux"],
} as const;

export type FeatureName = keyof typeof platformFeatures;

/**
 * Checks if a feature is available on the current platform.
 * @param feature - The feature name to check
 * @returns true if the feature is available on the current platform
 */
export function isFeatureAvailable(feature: FeatureName): boolean {
  const platform = getPlatform();
  return (platformFeatures[feature] as readonly string[]).includes(platform);
}
