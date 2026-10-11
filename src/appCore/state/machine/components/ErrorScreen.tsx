/**
 * Error Screen Component
 * TASK-1800: Enhanced with error reporting to Supabase
 * TASK-1802: Added Reset App Data self-healing feature
 * BACKLOG-1629: Improved UX — friendly message, SupportWidget integration,
 *   collapsible technical details, Sentry logging, streamlined reset dialog
 * BACKLOG-3673: ACCOUNT_SETUP_UNAVAILABLE variant — "Couldn't load your account
 *   settings" with Retry and Sign out; Reset App Data hidden for that code only
 *
 * Displays error information when the application encounters
 * a non-recoverable error during initialization.
 *
 * @module appCore/state/machine/components/ErrorScreen
 */

import React, { useEffect, useState } from "react";
import * as Sentry from "@sentry/electron/renderer";
import { ResponsiveModal } from "../../../../components/common/ResponsiveModal";
import type { AppError } from "../types";
import { OfflineNotice } from "../../../../components/common/OfflineNotice";
import { SupportWidget } from "../../../../components/support/SupportWidget";

interface ErrorScreenProps {
  /** Error details to display */
  error: AppError;
  /** Callback when user clicks retry (optional) */
  onRetry?: () => void;
  /** Callback when user clicks Sign out (optional; shown only when given) */
  onSignOut?: () => void;
}

/** Dispatch the 'open-support-widget' custom event to open the SupportWidget dialog. */
function openSupportWidget(subject: string): void {
  window.dispatchEvent(
    new CustomEvent("open-support-widget", { detail: { subject } }),
  );
}

/**
 * Error screen shown when app encounters a non-recoverable error.
 * Displays a user-friendly message, optional retry button, contact support,
 * collapsible technical details, and a reset app data option for self-healing.
 */
export function ErrorScreen({
  error,
  onRetry,
  onSignOut,
}: ErrorScreenProps): React.ReactElement {
  // BACKLOG-3673: the account's setup record could not be read.
  const accountVariant = error.code === "ACCOUNT_SETUP_UNAVAILABLE";

  // Reset dialog state
  const [showResetDialog, setShowResetDialog] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  // Log the full technical error to Sentry on mount
  useEffect(() => {
    Sentry.captureException(
      error.details instanceof Error
        ? error.details
        : new Error(error.message),
      {
        tags: { error_code: error.code },
        extra: {
          errorCode: error.code,
          errorMessage: error.message,
          errorDetails:
            typeof error.details === "string"
              ? error.details
              : String(error.details ?? ""),
        },
      },
    );
  }, [error]);

  const handleContactSupport = () => {
    openSupportWidget(`${error.code} error encountered`);
  };

  const handleReset = async () => {
    setIsResetting(true);
    setResetError(null);

    try {
      const result = await window.api.app.reset();
      if (!result.success) {
        setResetError(result.error || "Reset failed. Please try again.");
        setIsResetting(false);
      }
      // If successful, app will quit and relaunch - this code won't execute
    } catch {
      setResetError("An unexpected error occurred during reset.");
      setIsResetting(false);
    }
  };

  const handleCloseResetDialog = () => {
    setShowResetDialog(false);
    setResetError(null);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-indigo-50 to-purple-50 flex flex-col">
      <OfflineNotice />
      {/* BACKLOG-1629: SupportWidget included directly because ErrorScreen replaces
          the normal App component tree (rendered by LoadingOrchestrator), so the
          SupportWidget in App.tsx is never mounted when this screen is visible.
          SupportWidget handles no-DB/unauthenticated states gracefully. */}
      <SupportWidget />
      <div className="flex-1 flex items-center justify-center p-4">
      <div className="text-center max-w-md w-full">
        {/* Error icon */}
        <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
          <svg
            className="w-8 h-8 text-red-600"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
        </div>

        {/* User-friendly error message */}
        <h1 className="text-xl font-semibold text-gray-900 mb-2">
          {accountVariant
            ? "Couldn't load your account settings"
            : "Something went wrong"}
        </h1>
        {accountVariant ? (
          <p className="text-gray-600 mb-4">
            Keepr couldn&apos;t reach the server to check your account. Check
            your internet connection, then try again.
          </p>
        ) : (
          <p className="text-gray-600 mb-4">
            Keepr couldn&apos;t start because the local database failed to
            initialize. This is usually fixed by restarting the app. If the
            problem persists, please contact support.
          </p>
        )}
        <p className="text-xs text-gray-400 mb-4">
          Error code: {error.code}
        </p>

        {/* Collapsible technical details */}
        {(error.message || Boolean(error.details)) && (
          <details className="text-left mb-6 bg-gray-50 rounded-lg p-4">
            <summary className="text-sm font-medium text-gray-700 cursor-pointer">
              Technical Details
            </summary>
            <div className="mt-2 text-xs font-mono text-gray-600 overflow-auto max-h-32">
              <p className="font-semibold text-red-600 mb-2">
                {error.message}
              </p>
              {typeof error.details === "string" && error.details && (
                <pre className="whitespace-pre-wrap text-gray-500 text-[10px]">
                  {error.details}
                </pre>
              )}
            </div>
          </details>
        )}

        {/* Action buttons */}
        <div className="space-y-3">
          {/* Retry button */}
          {onRetry && (
            <button
              onClick={onRetry}
              className="w-full px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
              type="button"
            >
              {accountVariant ? "Retry" : "Try Again"}
            </button>
          )}

          {/* Sign out button (BACKLOG-3673: account-settings variant only) */}
          {onSignOut && (
            <button
              onClick={onSignOut}
              className="w-full px-6 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
              type="button"
            >
              Sign out
            </button>
          )}

          {/* Contact Support button (opens SupportWidget) */}
          <button
            onClick={handleContactSupport}
            className="w-full px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700 transition-colors text-sm"
            type="button"
          >
            Contact Support
          </button>

          {/* Reset App Data button. BACKLOG-3673: hidden when the account
              record could not be read -- deleting local data does not fix a
              server read. */}
          {!accountVariant && (
            <button
              onClick={() => setShowResetDialog(true)}
              className="w-full px-6 py-2 border border-red-300 text-red-600 rounded-lg hover:bg-red-50 transition-colors text-sm"
              type="button"
            >
              Reset App Data
            </button>
          )}
        </div>
      </div>

      {/* Reset Confirmation Dialog */}
      {showResetDialog && (
        <ResponsiveModal onClose={handleCloseResetDialog} overlayClassName="bg-black bg-opacity-50" panelClassName="max-w-md p-6">
            <h2 className="text-xl font-bold text-red-600 mb-4">
              Reset App Data
            </h2>
            <p className="text-gray-600 mb-4">
              This will delete your local database. You will need to sign in
              again and run an initial sync to restore your data.
            </p>
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-4">
              <p className="text-amber-800 text-sm">
                We recommend only using this option if instructed by Keepr
                Support.
              </p>
            </div>
            {resetError && (
              <p className="text-red-500 text-sm mb-4">{resetError}</p>
            )}
            <div className="flex flex-col space-y-3">
              <button
                onClick={() => {
                  handleCloseResetDialog();
                  handleContactSupport();
                }}
                className="w-full px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm"
                disabled={isResetting}
                type="button"
              >
                Contact Support
              </button>
              <button
                onClick={handleReset}
                disabled={isResetting}
                className="w-full px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm"
                type="button"
              >
                {isResetting ? "Resetting..." : "Delete My Data"}
              </button>
            </div>
        </ResponsiveModal>
      )}
      </div>
    </div>
  );
}
