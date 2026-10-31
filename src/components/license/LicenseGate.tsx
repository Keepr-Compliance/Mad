/**
 * LicenseGate Component
 * SPRINT-062: License Validation Gate
 *
 * Blocks access to the app when the license is invalid (expired, at limit, etc.)
 * Shows appropriate screens for each block reason.
 *
 * NOTE: This is different from src/components/common/LicenseGate.tsx which
 * gates individual features based on license type. This component gates the
 * entire app based on license validation status.
 */

import React from "react";
import { useLicense } from "../../contexts/LicenseContext";
import { UpgradeScreen, upgradeReasonFor } from "./UpgradeScreen";
import { DeviceLimitScreen } from "./DeviceLimitScreen";

interface LicenseGateProps {
  children: React.ReactNode;
}

/**
 * LicenseGate wraps the app content and shows blocking screens when license is invalid
 *
 * SPRINT-066: Only show loading screen on initial load (before first successful validation).
 * Background refreshes (e.g., on window focus) no longer show loading screen or unmount children.
 * This fixes the bug where modals would close when switching apps.
 */
export function LicenseGate({ children }: LicenseGateProps): React.ReactElement {
  const { validationStatus, isLoading, hasInitialized, isValid, blockReason } = useLicense();

  // Show loading ONLY on initial load (before first successful validation)
  // Once initialized, background refreshes happen silently without unmounting children
  if (isLoading && !hasInitialized) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 via-indigo-50 to-purple-50">
        <div className="text-center">
          <div
            className="w-12 h-12 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto mb-4"
            role="status"
            aria-label="Loading"
          />
          <p className="text-gray-600 text-lg">Checking license...</p>
        </div>
      </div>
    );
  }

  // If no validation status yet (user not logged in), allow access
  // The auth flow will handle login requirements separately
  if (!validationStatus) {
    return <>{children}</>;
  }

  // License is valid, render children
  if (isValid) {
    return <>{children}</>;
  }

  // License is blocked - show appropriate screen based on reason
  // BACKLOG-4038: expired (admin-set expired/cancelled) -> ended, suspended ->
  // suspended, every other reason -> the fallback variant.
  switch (blockReason) {
    case "expired":
    case "suspended":
    case "limit_reached":
    case "no_license":
      return <UpgradeScreen reason={upgradeReasonFor(blockReason)} />;

    default:
      // Check if it's a device limit issue by looking at the validation status
      if (
        validationStatus.deviceCount >= validationStatus.deviceLimit &&
        validationStatus.deviceLimit > 0
      ) {
        return <DeviceLimitScreen />;
      }
      return <UpgradeScreen reason="unknown" />;
  }
}
