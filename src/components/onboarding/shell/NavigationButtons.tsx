/**
 * Navigation buttons component for onboarding steps.
 *
 * Renders Back, Next, and Skip buttons based on configuration.
 * This is a pure presentation component - all navigation logic
 * is handled via callbacks.
 *
 * @module onboarding/shell/NavigationButtons
 */

import React, { useState } from "react";
import type { SkipConfig } from "../types";

/**
 * Props for the NavigationButtons component.
 */
export interface NavigationButtonsProps {
  /** Show back button */
  showBack: boolean;
  /** Show next/continue button */
  showNext: boolean;
  /** Skip configuration (false = no skip button) */
  skipConfig?: SkipConfig | false;
  /** Custom label for back button */
  backLabel?: string;
  /** Custom label for next button */
  nextLabel?: string;
  /** Disable next button (explicit override) */
  nextDisabled?: boolean;
  /** Whether step is complete (enables Next when true) */
  isStepComplete?: boolean;
  /** Callback when back button is clicked */
  onBack?: () => void;
  /** Callback when next button is clicked */
  onNext?: () => void;
  /** Callback when skip button is clicked */
  onSkip?: () => void;
}

/**
 * Navigation buttons for onboarding steps.
 *
 * Renders Back, Next, and Skip buttons based on configuration.
 * All navigation logic is handled via callbacks provided by the parent.
 *
 * @example
 * ```tsx
 * <NavigationButtons
 *   showBack={true}
 *   showNext={true}
 *   isStepComplete={context.phoneType !== null}
 *   onBack={() => goBack()}
 *   onNext={() => goNext()}
 * />
 * ```
 */
export function NavigationButtons({
  showBack,
  showNext,
  skipConfig,
  backLabel = "Back",
  nextLabel = "Continue",
  nextDisabled = false,
  isStepComplete = true,
  onBack,
  onNext,
  onSkip,
}: NavigationButtonsProps) {
  // Narrow to a concrete SkipConfig (or null) so downstream reads are typed.
  const skip: SkipConfig | null =
    skipConfig !== undefined && skipConfig !== false ? skipConfig : null;
  // Check if skip should be shown (skipConfig is SkipConfig, not false or undefined)
  const showSkip = skip !== null;

  // BACKLOG-1919: two-step skip confirmation. When skip.requireConfirm is set
  // (Apple-driver step for iPhone users), the first click reveals a warning +
  // explicit "Skip anyway" button rather than skipping immediately. Local value
  // state (not a didMount guard) → StrictMode-safe.
  const [confirmingSkip, setConfirmingSkip] = useState(false);
  const requireConfirm = skip?.requireConfirm === true;

  // Next is disabled if explicitly disabled OR if step is not complete
  const isNextDisabled = nextDisabled || !isStepComplete;

  return (
    <div className="mt-4">
      {/* Main navigation buttons */}
      <div className="flex gap-3">
        {showBack && (
          <button
            type="button"
            onClick={onBack}
            data-testid="onboarding-back"
            className="flex-1 min-h-[44px] px-4 py-2.5 bg-gray-100 text-gray-700 rounded-lg font-medium hover:bg-gray-200 active:bg-gray-300 transition-colors"
          >
            {backLabel}
          </button>
        )}
        {showNext && (
          <button
            type="button"
            onClick={onNext}
            disabled={isNextDisabled}
            data-testid="onboarding-continue"
            className="flex-1 min-h-[44px] px-4 py-2.5 bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 active:from-blue-700 active:to-purple-800 text-white text-sm font-semibold rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-md"
          >
            {nextLabel}
          </button>
        )}
      </div>

      {/* Skip section (below main buttons) */}
      {showSkip && skip && (
        <div className="text-center mt-3">
          {requireConfirm && confirmingSkip ? (
            // BACKLOG-1919: Confirmation step — require an explicit second click
            // so the driver step isn't the path of least resistance.
            <div className="flex flex-col items-center gap-2">
              <p className="text-xs text-amber-600 max-w-xs">
                {skip.confirmWarning ??
                  "Without this, your iPhone can't be detected. You can install it later from Settings."}
              </p>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setConfirmingSkip(false)}
                  className="text-sm text-gray-600 hover:text-gray-800 underline"
                >
                  Go back
                </button>
                <button
                  type="button"
                  onClick={onSkip}
                  data-testid="onboarding-skip-confirm"
                  className="text-sm text-amber-700 hover:text-amber-900 underline"
                >
                  {skip.confirmLabel ?? "Skip anyway"}
                </button>
              </div>
            </div>
          ) : (
            <>
              <button
                type="button"
                onClick={
                  requireConfirm ? () => setConfirmingSkip(true) : onSkip
                }
                data-testid="onboarding-skip"
                className="text-sm text-gray-500 hover:text-gray-700 underline"
              >
                {skip.label}
              </button>
              {skip.description && (
                <p className="text-xs text-gray-400 mt-1">
                  {skip.description}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
