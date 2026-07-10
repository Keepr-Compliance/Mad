/**
 * AppleDriverStep - Windows iPhone Driver Installation Step
 *
 * Guides Windows + iPhone users through Apple driver installation.
 * This step is Windows-only and only shown for iPhone users.
 *
 * @module onboarding/steps/AppleDriverStep
 */

import React, { useState, useEffect, useCallback, useRef } from "react";
import type {
  OnboardingStep,
  OnboardingStepMeta,
  OnboardingStepContentProps,
} from "../types";
import logger from '../../../utils/logger';
import { reportOnboardingFailure } from '../sentryOnboarding';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Type for the drivers API (accessed via type assertion)
 */
interface DriversAPI {
  checkApple: () => Promise<{
    isInstalled: boolean;
    version?: string;
    serviceRunning: boolean;
    error?: string | null;
  }>;
  hasBundled: () => Promise<{ hasBundled: boolean }>;
  installApple: () => Promise<{
    success: boolean;
    cancelled?: boolean;
    error?: string | null;
    rebootRequired?: boolean;
  }>;
  openITunesStore: () => Promise<{ success: boolean; error?: string }>;
  checkUpdate?: () => Promise<{
    updateAvailable: boolean;
    installedVersion: string | null;
    bundledVersion: string | null;
  }>;
}

type InstallStatus =
  | "checking"
  | "not-installed"
  | "needs-update"
  | "installing"
  | "installed"
  | "already-installed"
  | "error"
  | "cancelled";

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Get the drivers API with proper typing
 */
function getDriversAPI(): DriversAPI | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (window.api as any)?.drivers as DriversAPI | null;
}

// =============================================================================
// STEP METADATA
// =============================================================================

/**
 * Step metadata - Windows only, skippable
 */
export const meta: OnboardingStepMeta = {
  id: "apple-driver",
  progressLabel: "Install Tools",
  platforms: ["windows"], // NOT macOS
  navigation: {
    showBack: true,
    continueLabel: "Continue",
    hideContinue: false,
  },
  skip: {
    enabled: true,
    label: "Skip for now",
    description: "You can install iTunes later to sync iPhone messages",
    // BACKLOG-1919: This step only renders for iPhone users, and skipping it is
    // the root cause of users landing on "Connect Your iPhone" with no driver
    // and no recovery path. Require an explicit confirmation so the skip isn't
    // the path of least resistance — but keep it possible.
    requireConfirm: true,
    confirmWarning:
      "Without Apple Mobile Device Support, your iPhone can't be detected and sync won't work. You can install it later from Settings, or install it now.",
    confirmLabel: "Skip anyway",
  },
  // Only show for iPhone users who need driver setup (skip if already installed)
  shouldShow: (context) => context.phoneType === "iphone" && !context.driverSetupComplete,
  // Complete when driver is installed or skipped
  isStepComplete: (context) =>
    context.driverSetupComplete || context.driverSkipped,
  // Queue predicates
  isApplicable: (context) => context.phoneType === "iphone",
  isComplete: (context) => context.driverSetupComplete || context.driverSkipped,
};

// =============================================================================
// CONTENT COMPONENT
// =============================================================================

/**
 * AppleDriverStep Content Component
 *
 * Renders the Apple driver installation interface including:
 * - Driver status check
 * - Installation UI with consent
 * - Download links (bundled installer or Microsoft Store)
 * - Installation progress and results
 */
function AppleDriverStepContent({
  onAction,
}: OnboardingStepContentProps): React.ReactElement {
  const [status, setStatus] = useState<InstallStatus>("checking");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [hasBundled, setHasBundled] = useState(false);
  const [installedVersion, setInstalledVersion] = useState<string | null>(null);
  const [bundledVersion, setBundledVersion] = useState<string | null>(null);
  // Guard to ensure Sentry event fires only once per error occurrence
  const hasSentryReportedRef = useRef(false);

  // Check driver status on mount
  useEffect(() => {
    const checkDriverStatus = async () => {
      const drivers = getDriversAPI();
      if (!drivers) {
        logger.error("[AppleDriverStep] Drivers API not available");
        setStatus("error");
        setErrorMessage("Driver management is not available on this platform.");
        return;
      }

      try {
        // Check if drivers are already installed
        const driverResult = await drivers.checkApple();

        // Only require isInstalled flag - service might not be running yet after fresh install
        if (driverResult.isInstalled) {
          // Drivers installed - check if update is available
          if (drivers.checkUpdate) {
            try {
              const updateResult = await drivers.checkUpdate();
              setInstalledVersion(updateResult.installedVersion);
              setBundledVersion(updateResult.bundledVersion);

              if (updateResult.updateAvailable) {
                // Update available
                const bundledResult = await drivers.hasBundled();
                setHasBundled(bundledResult.hasBundled);
                setStatus("needs-update");
                return;
              }
            } catch (updateError) {
              logger.warn(
                "[AppleDriverStep] Could not check for updates:",
                updateError
              );
            }
          }
          // Already installed, no update needed
          setInstalledVersion(driverResult.version || null);
          setStatus("already-installed");
          return;
        }

        // Not installed - check if we have bundled MSI
        const bundledResult = await drivers.hasBundled();
        setHasBundled(bundledResult.hasBundled);
        setStatus("not-installed");
      } catch (error) {
        logger.error("[AppleDriverStep] Error checking drivers:", error);
        setStatus("not-installed");
      }
    };

    checkDriverStatus();
  }, []);

  const handleInstall = useCallback(async () => {
    setStatus("installing");
    setErrorMessage(null);
    // Reset Sentry guard so a new failure can report again
    hasSentryReportedRef.current = false;

    const drivers = getDriversAPI();
    if (!drivers) {
      setStatus("error");
      setErrorMessage("Driver management is not available.");
      if (!hasSentryReportedRef.current) {
        hasSentryReportedRef.current = true;
        reportOnboardingFailure({
          step: 'apple_driver',
          reason: 'driver_install_failed',
          dbInitialized: true,
          networkOnline: navigator.onLine,
          hasSession: true,
          errorMessage: 'Driver management is not available.',
        });
      }
      return;
    }

    try {
      const result = await drivers.installApple();

      if (result.success) {
        setStatus("installed");
      } else if (result.cancelled) {
        setStatus("cancelled");
        setErrorMessage(
          "Installation was cancelled. You can try again or skip for now."
        );
        if (!hasSentryReportedRef.current) {
          hasSentryReportedRef.current = true;
          reportOnboardingFailure({
            step: 'apple_driver',
            reason: 'driver_cancelled',
            dbInitialized: true,
            networkOnline: navigator.onLine,
            hasSession: true,
          });
        }
      } else {
        setStatus("error");
        setErrorMessage(
          result.error ||
            "Installation failed. Please try again or install iTunes manually."
        );
        if (!hasSentryReportedRef.current) {
          hasSentryReportedRef.current = true;
          reportOnboardingFailure({
            step: 'apple_driver',
            reason: 'driver_install_failed',
            dbInitialized: true,
            networkOnline: navigator.onLine,
            hasSession: true,
            errorMessage: result.error || undefined,
          });
        }
      }
    } catch (error) {
      setStatus("error");
      setErrorMessage(
        error instanceof Error ? error.message : "An unexpected error occurred"
      );
      if (!hasSentryReportedRef.current) {
        hasSentryReportedRef.current = true;
        reportOnboardingFailure({
          step: 'apple_driver',
          reason: 'driver_install_failed',
          dbInitialized: true,
          networkOnline: navigator.onLine,
          hasSession: true,
          errorMessage:
            error instanceof Error ? error.message : String(error),
        });
      }
    }
  }, []);

  const handleOpenITunesStore = useCallback(async () => {
    const drivers = getDriversAPI();
    if (!drivers) return;

    try {
      await drivers.openITunesStore();
    } catch (error) {
      logger.error("[AppleDriverStep] Error opening iTunes store:", error);
    }
  }, []);

  const handleContinue = useCallback(() => {
    onAction({ type: "DRIVER_SETUP_COMPLETE" });
    // Note: DRIVER_SETUP_COMPLETE already triggers goToNext() in the flow hook
  }, [onAction]);

  return (
    <>
      {/* Header */}
      <div className="text-center mb-5">
          <div
            className={`w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-3 ${
              status === "installed" || status === "already-installed"
                ? "bg-green-100"
                : status === "needs-update"
                  ? "bg-amber-100"
                  : status === "error" || status === "cancelled"
                    ? "bg-red-100"
                    : "bg-blue-100"
            }`}
          >
            {status === "checking" || status === "installing" ? (
              <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            ) : status === "installed" || status === "already-installed" ? (
              <svg
                className="w-7 h-7 text-green-600"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 13l4 4L19 7"
                />
              </svg>
            ) : status === "needs-update" ? (
              <svg
                className="w-7 h-7 text-amber-600"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                />
              </svg>
            ) : status === "error" || status === "cancelled" ? (
              <svg
                className="w-7 h-7 text-red-600"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                />
              </svg>
            ) : (
              <svg
                className="w-7 h-7 text-blue-600"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                />
              </svg>
            )}
          </div>

          <h1 className="text-xl font-bold text-gray-900 mb-2">
            {status === "checking"
              ? "Checking System..."
              : status === "installing"
                ? "Installing Tools..."
                : status === "installed" || status === "already-installed"
                  ? "Tools Ready!"
                  : status === "needs-update"
                    ? "Update Available"
                    : status === "error" || status === "cancelled"
                      ? "Installation Issue"
                      : "Install iPhone Tools"}
          </h1>

          <p className="text-gray-600">
            {status === "checking"
              ? "Checking if Apple tools are already installed..."
              : status === "installing"
                ? "Please approve the installation when prompted..."
                : status === "installed" || status === "already-installed"
                  ? "Your computer is ready to sync with your iPhone."
                  : status === "needs-update"
                    ? "A newer version of Apple tools is available."
                    : status === "error" || status === "cancelled"
                      ? errorMessage
                      : "To sync messages from your iPhone, we need to install Apple's official tools."}
          </p>
        </div>

        {/* Needs Update State */}
        {status === "needs-update" && (
          <>
            {/* Info box with version details and consent notice */}
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-4">
              {/* Version info */}
              <h3 className="font-medium text-gray-900 mb-2 flex items-center gap-2">
                <svg
                  className="w-5 h-5 text-amber-500"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                  />
                </svg>
                Update Details
              </h3>
              <ul className="space-y-1 text-sm text-gray-700 mb-4">
                <li className="flex items-start gap-2">
                  <span className="text-gray-400 mt-0.5">•</span>
                  <span>
                    Current version:{" "}
                    <strong>{installedVersion || "Unknown"}</strong>
                  </span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-green-500 mt-0.5">•</span>
                  <span>
                    New version:{" "}
                    <strong>{bundledVersion || "Available"}</strong>
                  </span>
                </li>
              </ul>

              {/* Consent notice */}
              <div className="border-t border-amber-200 pt-3">
                <p className="text-sm text-amber-800">
                  <strong>Administrator Permission Required</strong> — Your
                  existing settings will be preserved.
                </p>
              </div>
            </div>

            {/* Update Button */}
            {hasBundled ? (
              <button
                onClick={handleInstall}
                className="w-full py-2.5 px-4 bg-blue-500 text-white rounded-lg font-semibold hover:bg-blue-600 transition-all shadow-md hover:shadow-lg mb-3"
              >
                Update Tools
              </button>
            ) : (
              <>
                <p className="text-sm text-amber-600 mb-3 text-center">
                  Bundled update not found. You can update via iTunes from the
                  Microsoft Store.
                </p>
                <button
                  onClick={handleOpenITunesStore}
                  className="w-full py-2.5 px-4 bg-blue-500 text-white rounded-lg font-semibold hover:bg-blue-600 transition-all shadow-md hover:shadow-lg mb-3"
                >
                  Open Microsoft Store (iTunes)
                </button>
              </>
            )}
          </>
        )}

        {/* Not Installed State */}
        {status === "not-installed" && (
          <>
            {/* Info box with what gets installed */}
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-4">
              <h3 className="font-medium text-gray-900 mb-2 flex items-center gap-2">
                <svg
                  className="w-5 h-5 text-blue-500"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
                What gets installed
              </h3>
              <ul className="space-y-2 text-sm text-gray-700">
                <li className="flex items-start gap-2">
                  <svg
                    className="w-4 h-4 text-blue-500 flex-shrink-0 mt-0.5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M5 13l4 4L19 7"
                    />
                  </svg>
                  <span>Apple Mobile Device Support — required to communicate with your iPhone</span>
                </li>
                <li className="flex items-start gap-2">
                  <svg
                    className="w-4 h-4 text-blue-500 flex-shrink-0 mt-0.5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M5 13l4 4L19 7"
                    />
                  </svg>
                  <span>Apple's official software bundled with Keepr</span>
                </li>
              </ul>
            </div>

            {/* Install Button */}
            {hasBundled ? (
              <button
                onClick={handleInstall}
                className="w-full py-2.5 px-4 bg-blue-500 text-white rounded-lg font-semibold hover:bg-blue-600 transition-all shadow-md hover:shadow-lg mb-3"
              >
                Install Tools
              </button>
            ) : (
              <>
                <p className="text-sm text-amber-600 mb-3 text-center">
                  Bundled installer not found. Install iTunes to get the
                  required drivers.
                </p>
                <button
                  onClick={handleOpenITunesStore}
                  className="w-full py-2.5 px-4 bg-blue-500 text-white rounded-lg font-semibold hover:bg-blue-600 transition-all shadow-md hover:shadow-lg mb-3"
                >
                  Open Microsoft Store (iTunes)
                </button>
              </>
            )}
          </>
        )}

        {/* Installing State */}
        {status === "installing" && (
          <div className="py-4">
            {/* Yellow permission warning */}
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-4">
              <div className="flex items-start gap-3">
                <svg
                  className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                  />
                </svg>
                <p className="text-sm text-amber-800">
                  <strong>Administrator Permission Required</strong> — Please approve the Windows permission prompt to continue the installation.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Installed or Already Installed State - show green Continue button */}
        {(status === "installed" || status === "already-installed") && (
          <button
            onClick={handleContinue}
            className="w-full py-2.5 px-4 bg-green-500 text-white rounded-lg font-semibold hover:bg-green-600 transition-all shadow-md hover:shadow-lg"
          >
            Continue
          </button>
        )}

        {/* Error/Cancelled State */}
        {(status === "error" || status === "cancelled") && (
          <button
            onClick={handleInstall}
            className="w-full py-2.5 px-4 bg-blue-500 text-white rounded-lg font-semibold hover:bg-blue-600 transition-all shadow-md hover:shadow-lg mb-3"
          >
            Retry
          </button>
        )}


      {/* Additional info */}
      {status === "not-installed" && (
        <p className="text-xs text-gray-400 text-center mt-4">
          Keepr does not distribute Apple software. We help you install
          Apple's official tools which are required to communicate with iPhone
          devices.
        </p>
      )}
    </>
  );
}

// =============================================================================
// STEP DEFINITION
// =============================================================================

/**
 * Complete AppleDriverStep definition for registration
 */
const AppleDriverStep: OnboardingStep = {
  meta,
  Content: AppleDriverStepContent,
};

export default AppleDriverStep;
