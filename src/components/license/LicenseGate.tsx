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
import { UpgradeScreen } from "./UpgradeScreen";
import { DeviceLimitScreen } from "./DeviceLimitScreen";
import { logger } from "../../utils/logger";

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

  // TEST INSTRUMENTATION: report the license-gate verdict the user is subject to
  // (checking / pass-through / valid / blocked with reason). Ref-compare so we
  // only log when the verdict changes.
  const lbGateVerdict =
    isLoading && !hasInitialized
      ? "CHECKING (license loading)"
      : !validationStatus
        ? "PASS-THROUGH (no validationStatus / not logged in)"
        : isValid
          ? "VALID"
          : `BLOCKED reason=${blockReason ?? "none"}`;
  const lbGateRef = React.useRef<string | null>(null);
  if (lbGateRef.current !== lbGateVerdict) {
    logger.info(`[LB-TRACE] license-gate: ${lbGateVerdict}`);
    lbGateRef.current = lbGateVerdict;
  }

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
  switch (blockReason) {
    case "expired":
      return <UpgradeScreen reason="trial_expired" />;

    case "limit_reached":
      return <UpgradeScreen reason="transaction_limit" />;

    case "no_license":
      // This shouldn't happen since we auto-create licenses, but handle it
      return <UpgradeScreen reason="unknown" />;

    case "suspended":
      return <UpgradeScreen reason="suspended" />;

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
