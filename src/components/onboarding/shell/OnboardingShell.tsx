import React from 'react';

interface OnboardingShellProps {
  /** Progress indicator component (rendered above card) */
  progressSlot?: React.ReactNode;
  /** Navigation buttons component (rendered below content) */
  navigationSlot?: React.ReactNode;
  /** Step content (rendered inside card) */
  children: React.ReactNode;
  /** Optional custom max-width class (default: 'max-w-xl') */
  maxWidth?: string;
  /**
   * BACKLOG-2289: Classes for the outermost wrapper. Defaults to the full-screen
   * onboarding background. Override (e.g. drop `min-h-screen`/gradient) when the
   * shell is embedded in another surface such as the Settings Android Sync
   * wizard, so it renders as a compact card instead of a full viewport.
   */
  containerClassName?: string;
}

/**
 * Unified layout wrapper for all onboarding steps.
 * Provides consistent background, centering, and card structure.
 *
 * Layout structure:
 * ```
 * ┌─────────────────────────────────────┐
 * │         [progressSlot]              │
 * │  ┌───────────────────────────────┐  │
 * │  │                               │  │
 * │  │         {children}            │  │
 * │  │                               │  │
 * │  └───────────────────────────────┘  │
 * │         [navigationSlot]            │
 * └─────────────────────────────────────┘
 * ```
 */
export function OnboardingShell({
  progressSlot,
  navigationSlot,
  children,
  maxWidth = 'max-w-xl',
  containerClassName = 'min-h-screen bg-gradient-to-br from-slate-50 to-blue-50',
}: OnboardingShellProps) {
  return (
    <div className={containerClassName}>
      {/* Progress indicator spans full viewport width — no padding */}
      {progressSlot}

      <div className={`${maxWidth} w-full mx-auto px-4 sm:px-6 lg:px-8`}>
        {/* Card with responsive gap from progress bar */}
        <div className="mt-4 sm:mt-6">
          {/* Main card container */}
          <div className="bg-white rounded-2xl shadow-xl p-4 sm:p-6">
            {children}
          </div>

          {/* Navigation buttons slot */}
          {navigationSlot}
        </div>
      </div>
    </div>
  );
}
