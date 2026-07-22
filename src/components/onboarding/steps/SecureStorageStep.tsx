/**
 * SecureStorageStep - macOS Keychain Setup Step
 *
 * This step explains the keychain access requirement for macOS users.
 *
 * Platform: macOS ONLY
 *
 * @module onboarding/steps/SecureStorageStep
 */

import React from "react";
import type {
  OnboardingStep,
  OnboardingStepMeta,
  OnboardingStepContentProps,
  SecureStorageSetupAction,
} from "../types";
import logger from '../../../utils/logger';
import { KeychainDialogGraphic } from "./KeychainDialogGraphic";

// =============================================================================
// STEP METADATA
// =============================================================================

/**
 * Step metadata for the secure storage step.
 * This step is macOS only and explains keychain access.
 */
export const meta: OnboardingStepMeta = {
  id: "secure-storage",
  progressLabel: "Secure Storage",
  platforms: ["macos"],
  navigation: {
    showBack: true,
    hideContinue: true, // Shell won't render Continue - step handles its own Continue button
    continueLabel: "Continue",
  },
  // This step is required for macOS users
  skip: undefined,
  // Show only if database not initialized
  // The secure-storage step explains keychain access - if DB is initialized, keychain is already set up
  shouldShow: (context) => {
    const shouldShow = !context.isDatabaseInitialized;
    logger.debug(
      `%c[STEP] secure-storage: ${shouldShow ? 'SHOW' : 'HIDE'}`,
      `background: ${shouldShow ? '#DAA520' : '#228B22'}; color: white; font-weight: bold; padding: 2px 8px;`,
      { isDatabaseInitialized: context.isDatabaseInitialized }
    );
    return shouldShow;
  },
  // Queue predicates
  isApplicable: () => true, // Platform filtering via flow array (macOS only)
  isComplete: (context) => context.isDatabaseInitialized,
};

// =============================================================================
// ICONS
// =============================================================================

/**
 * Lock icon SVG component
 */
function LockIcon(): React.ReactElement {
  return (
    <svg
      className="w-7 h-7 text-white"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
        d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
      />
    </svg>
  );
}

/**
 * Spinner icon for loading state
 */
function SpinnerIcon(): React.ReactElement {
  return (
    <svg
      className="w-7 h-7 text-white animate-spin"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  );
}

/**
 * Info icon for the info box
 */
function InfoIcon(): React.ReactElement {
  return (
    <svg
      className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
      />
    </svg>
  );
}

// =============================================================================
// CONTENT COMPONENT
// =============================================================================

/**
 * Extended props for SecureStorageStep content.
 * Includes loading state for keychain prompt.
 */
interface SecureStorageContentProps extends OnboardingStepContentProps {
  /**
   * Whether waiting for keychain system dialog
   */
  isLoading?: boolean;
}

/**
 * Content component for the secure storage step.
 * Displays keychain explanation and handles user preferences.
 */
export function SecureStorageContent({
  context,
  onAction,
  isLoading = false,
}: SecureStorageContentProps): React.ReactElement {
  const handleContinue = () => {
    const action: SecureStorageSetupAction = {
      type: "SECURE_STORAGE_SETUP",
    };
    onAction(action);
  };

  const bodyText = context.isNewUser
    ? "Keepr uses your Mac's Keychain to encrypt and protect your data locally. " +
      "When you click Continue, a system dialog will appear asking for your Mac password."
    : "Keepr needs to access your Mac's Keychain to decrypt your local database. This keeps your contacts and messages secure.";

  return (
    <div className="text-center">
      {/* Icon with gradient background */}
      <div className="inline-flex items-center justify-center w-14 h-14 bg-gradient-to-br from-blue-500 to-purple-600 rounded-full mb-4 shadow-lg">
        {isLoading ? <SpinnerIcon /> : <LockIcon />}
      </div>

      {/* Title and subtitle */}
      <h2 className="text-xl font-bold text-gray-900 mb-2">
        {isLoading ? "Waiting for Authorization" : "Secure Storage Setup"}
      </h2>
      <p className="text-gray-600 text-sm mb-5">
        {isLoading
          ? "Please enter your password in the system dialog."
          : "Protect your data with macOS Keychain"}
      </p>

      {isLoading ? (
        <div className="text-center py-4">
          <p className="text-gray-500 text-sm">
            A system dialog should appear. If you don&apos;t see it, check
            behind this window.
          </p>
        </div>
      ) : (
        <>
          {/* What to expect - only for new users */}
          {context.isNewUser && (
            <div className="mb-4 bg-amber-50 rounded-xl p-3 text-left">
              <p className="text-sm text-amber-800">
                <strong>What to expect:</strong> A system dialog will appear asking for your
                Mac login password. This is macOS protecting your data - not Keepr.
              </p>
            </div>
          )}

          {/* Info box */}
          <div className="mb-4 bg-blue-50 rounded-xl p-3 text-left">
            <p className="text-gray-700 text-sm mb-2">{bodyText}</p>
            <div className="flex items-start gap-2">
              <InfoIcon />
              <p className="text-sm text-blue-700">
                Click <strong>&quot;Always Allow&quot;</strong> on the system
                dialog to avoid entering your password each time.
              </p>
            </div>
          </div>

          {/* Preview of the actual macOS Keychain dialog the user will see, so
              they recognize the real prompt when it appears. Rendered inline
              like the FDA step shows its ported system-dialog graphics. */}
          <div className="mb-4">
            <p className="text-xs text-gray-500 mb-2 text-left">
              It&rsquo;ll look exactly like this:
            </p>
            <KeychainDialogGraphic />
          </div>

          {/* Continue button - Back is handled by shell */}
          <button
            onClick={handleContinue}
            data-testid="onboarding-secure-storage-continue"
            className="w-full px-4 py-2.5 bg-gradient-to-r from-blue-500 to-purple-600 text-white rounded-lg font-semibold hover:from-blue-600 hover:to-purple-700 transition-colors min-h-[44px]"
          >
            Continue
          </button>
        </>
      )}
    </div>
  );
}

// =============================================================================
// STEP DEFINITION & REGISTRATION
// =============================================================================

/**
 * Complete step definition for the secure storage step.
 */
const SecureStorageStep: OnboardingStep = {
  meta,
  Content: SecureStorageContent,
};

export default SecureStorageStep;
