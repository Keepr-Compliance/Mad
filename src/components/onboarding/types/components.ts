/**
 * Onboarding Step Component Type Definitions
 *
 * Props and component types for step rendering.
 *
 * @module onboarding/types/components
 */

import type { ComponentType } from "react";
import type { StepAction } from "./actions";
import type { OnboardingStepMeta } from "./config";
import type { OnboardingContext } from "./context";

// =============================================================================
// STEP COMPONENTS
// =============================================================================

/**
 * Props passed to all onboarding step content components.
 * Provides access to context and action dispatch.
 */
export interface OnboardingStepContentProps {
  /**
   * The current onboarding context with all state.
   * Use this to conditionally render UI based on previous selections.
   */
  context: OnboardingContext;

  /**
   * Dispatch function to trigger step actions.
   * Call this when user interactions require state changes or navigation.
   *
   * @param action - The action to dispatch
   *
   * @example
   * onAction({ type: 'SELECT_PHONE', payload: { phoneType: 'iphone' } })
   */
  onAction: (action: StepAction) => void;

  /**
   * Optional loading state for steps that have async operations.
   * Used by SecureStorageStep to show loading UI during DB initialization.
   */
  isLoading?: boolean;

  /**
   * BACKLOG-2289: Rendering surface for step content.
   *
   * - `'onboarding'` (default): full first-run onboarding behavior.
   * - `'settings'`: the step is reused inside the guided Android Sync wizard in
   *   Settings (`AndroidSyncSetup`). Steps use this to drop first-run-only
   *   affordances (e.g. AndroidDownloadStep's 60s auto-advance, or
   *   AndroidComingSoonStep's "Go Back & Select iPhone" affordance) while
   *   keeping the core content — QR/pairing logic — identical.
   *
   * Presentational only. Omit for the onboarding flow; the queue never sets it.
   */
  variant?: "onboarding" | "settings";
}

/**
 * Complete onboarding step definition.
 * Combines metadata configuration with the content component.
 */
export interface OnboardingStep {
  /**
   * Step metadata defining behavior and configuration.
   */
  meta: OnboardingStepMeta;

  /**
   * React component that renders the step content.
   * Receives context and action dispatch as props.
   */
  Content: ComponentType<OnboardingStepContentProps>;
}
