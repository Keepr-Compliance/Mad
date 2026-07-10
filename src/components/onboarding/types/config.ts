/**
 * Onboarding Step Configuration Type Definitions
 *
 * Configuration types for step behavior and navigation.
 *
 * @module onboarding/types/config
 */

import type { OnboardingContext } from "./context";
import type { OnboardingStepId, Platform } from "./steps";

// =============================================================================
// STEP CONFIGURATION
// =============================================================================

/**
 * Configuration for skippable onboarding steps.
 * Defines whether a step can be skipped and the associated UI text.
 */
export interface SkipConfig {
  /**
   * Whether the skip option is enabled for this step.
   * When true, users can bypass this step in the onboarding flow.
   */
  enabled: boolean;

  /**
   * Label text for the skip button.
   * @example "Skip for now"
   */
  label: string;

  /**
   * Optional description explaining the implications of skipping.
   * Displayed below the skip button to inform users of what they'll miss.
   * @example "You can connect your email later from Settings"
   */
  description?: string;

  /**
   * BACKLOG-1919: When true, skipping requires an explicit confirmation click
   * (a two-step skip) instead of a single tap. Used for the Apple-driver step so
   * iPhone users can't trivially bypass driver installation — skipping stays
   * possible, just not the path of least resistance. The confirmation prompt is
   * rendered by NavigationButtons.
   */
  requireConfirm?: boolean;

  /**
   * BACKLOG-1919: Warning text shown in the confirmation prompt when
   * `requireConfirm` is true.
   * @example "Without this, your iPhone can't be detected. Skip anyway?"
   */
  confirmWarning?: string;

  /**
   * BACKLOG-1919: Label for the button that confirms the skip.
   * @default "Skip anyway"
   */
  confirmLabel?: string;
}

/**
 * Navigation configuration for an onboarding step.
 * Controls how users move through the onboarding flow.
 */
export interface StepNavigationConfig {
  /**
   * Whether a back button should be displayed.
   * @default true
   */
  showBack?: boolean;

  /**
   * Custom label for the back button.
   * @default "Back"
   */
  backLabel?: string;

  /**
   * Custom label for the continue/next button.
   * @default "Continue"
   */
  continueLabel?: string;

  /**
   * Whether the continue button should be hidden.
   * Useful for steps that auto-advance or have custom navigation.
   * @default false
   */
  hideContinue?: boolean;
}

/**
 * Metadata describing an onboarding step's configuration and behavior.
 * This is the primary configuration object for defining onboarding steps.
 */
export interface OnboardingStepMeta {
  /**
   * Unique identifier for this step.
   * Used for step lookup, navigation, and state persistence.
   */
  id: OnboardingStepId;

  /**
   * Human-readable label displayed in the progress indicator.
   * @example "Phone Type", "Connect Email"
   */
  progressLabel: string;

  /**
   * List of platforms where this step should be displayed.
   * If empty or undefined, the step is shown on all platforms.
   * @example ["macos"] - Only shown on macOS
   * @example ["macos", "windows"] - Shown on macOS and Windows
   */
  platforms?: Platform[];

  /**
   * Navigation configuration for this step.
   * Controls back/continue button visibility and labels.
   */
  navigation?: StepNavigationConfig;

  /**
   * Skip configuration for this step.
   * If undefined, the step cannot be skipped.
   */
  skip?: SkipConfig;

  /**
   * Function to determine if this step should be considered complete.
   * Used for progress tracking and determining the initial step on resume.
   *
   * @param context - The current onboarding context
   * @returns true if the step is complete, false otherwise
   *
   * @example
   * isStepComplete: (ctx) => ctx.phoneType !== null
   */
  isStepComplete?: (context: OnboardingContext) => boolean;

  /**
   * Function to determine if this step should be shown.
   * Allows dynamic step visibility based on previous selections.
   *
   * @param context - The current onboarding context
   * @returns true if the step should be shown, false to skip it
   *
   * @example
   * // Only show driver setup for iPhone users on macOS
   * shouldShow: (ctx) => ctx.phoneType === 'iphone' && ctx.platform === 'macos'
   */
  shouldShow?: (context: OnboardingContext) => boolean;

  /**
   * Optional custom validation before allowing progression.
   * If provided, the step won't advance until this returns true.
   *
   * @param context - The current onboarding context
   * @returns true if the step can be completed, false to prevent advancement
   */
  canProceed?: (context: OnboardingContext) => boolean;

  /**
   * Queue predicate: determines if this step is applicable given current context.
   * Platform filtering is handled by the flow arrays (macOS vs Windows).
   * Use this for runtime conditions (e.g., DB not ready, phone type not selected).
   *
   * If not provided, the step is always applicable.
   *
   * @param context - The current onboarding context
   * @returns true if the step should be included in the queue
   */
  isApplicable?: (context: OnboardingContext) => boolean;

  /**
   * Queue predicate: determines if this step has been completed.
   * Used by the queue builder to mark steps as complete and find the active step.
   *
   * If not provided, the step is never auto-completed (user must interact).
   *
   * @param context - The current onboarding context
   * @returns true if the step is complete
   */
  isComplete?: (context: OnboardingContext) => boolean;
}
