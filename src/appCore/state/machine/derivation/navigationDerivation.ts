/**
 * Navigation Derivation Module
 *
 * Pure functions for deriving navigation targets from state.
 * These functions determine WHAT screen to show, not HOW to navigate.
 * Side effects (actual navigation) are handled by hooks using these derivations.
 *
 * @module appCore/state/machine/derivation/navigationDerivation
 */

import type {
  AppState,
  AppError,
  LoadingPhase,
  OnboardingStep,
} from "../types";
import type { AppStep } from "../../types";

// =============================================================================
// NAVIGATION TARGET TYPES
// =============================================================================

/**
 * Possible screen targets for navigation.
 */
export type NavigationScreen =
  | "loading"
  | "login"
  | "onboarding"
  | "dashboard"
  | "error";

/**
 * Navigation target with optional parameters.
 * Represents the screen that should be shown for the current state.
 */
export interface NavigationTarget {
  /** Screen to navigate to */
  screen: NavigationScreen;
  /** Optional parameters for the screen */
  params?: NavigationParams;
}

/**
 * Parameters that may accompany a navigation target.
 */
export interface NavigationParams {
  /** Loading phase (for loading screen) */
  phase?: LoadingPhase;
  /** Progress percentage 0-100 (for loading screen) */
  progress?: number;
  /** Current onboarding step (for onboarding screen) */
  step?: OnboardingStep;
  /** Error details (for error screen) */
  error?: AppError;
  /** Whether error is recoverable */
  recoverable?: boolean;
}

// =============================================================================
// NAVIGATION DERIVATION FUNCTIONS
// =============================================================================

/**
 * Derives the navigation target from current state.
 * This is a pure function that returns WHAT to show, not HOW to navigate.
 *
 * @param state - Current application state
 * @returns Navigation target with screen and optional params
 *
 * @example
 * ```ts
 * const target = deriveNavigationTarget(state);
 * switch (target.screen) {
 *   case 'loading':
 *     return <LoadingScreen phase={target.params?.phase} />;
 *   case 'onboarding':
 *     return <OnboardingFlow step={target.params?.step} />;
 *   // ...
 * }
 * ```
 */
export function deriveNavigationTarget(state: AppState): NavigationTarget {
  switch (state.status) {
    case "loading":
      return {
        screen: "loading",
        params: {
          phase: state.phase,
          progress: state.progress,
        },
      };

    case "unauthenticated":
      return {
        screen: "login",
      };

    case "onboarding":
      return {
        screen: "onboarding",
        params: {
          step: state.step,
        },
      };

    case "ready":
      return {
        screen: "dashboard",
      };

    case "error":
      return {
        screen: "error",
        params: {
          error: state.error,
          recoverable: state.recoverable,
        },
      };
  }
}

// =============================================================================
// STATUS CHECK FUNCTIONS
// =============================================================================

/**
 * Determines if onboarding should be shown.
 *
 * @param state - Current application state
 * @returns true if status is 'onboarding'
 */
export function shouldShowOnboarding(state: AppState): boolean {
  return state.status === "onboarding";
}

/**
 * Determines if the app is ready for normal use.
 *
 * @param state - Current application state
 * @returns true if status is 'ready'
 */
export function isAppReady(state: AppState): boolean {
  return state.status === "ready";
}

/**
 * Determines if we're in any loading state.
 *
 * @param state - Current application state
 * @returns true if status is 'loading'
 */
export function isLoading(state: AppState): boolean {
  return state.status === "loading";
}

/**
 * Determines if we're in an error state.
 *
 * @param state - Current application state
 * @returns true if status is 'error'
 */
export function isError(state: AppState): boolean {
  return state.status === "error";
}

/**
 * Determines if user is authenticated.
 * True for onboarding and ready states (both require authentication).
 *
 * @param state - Current application state
 * @returns true if user is authenticated
 */
export function isAuthenticated(state: AppState): boolean {
  return state.status === "onboarding" || state.status === "ready";
}

/**
 * Determines if user is unauthenticated.
 *
 * @param state - Current application state
 * @returns true if status is 'unauthenticated'
 */
export function isUnauthenticated(state: AppState): boolean {
  return state.status === "unauthenticated";
}

// =============================================================================
// SCREEN COMPARISON UTILITIES
// =============================================================================

/**
 * Determines if navigation is needed based on current and target screens.
 * Useful for avoiding unnecessary navigation calls.
 *
 * @param currentScreen - Currently displayed screen
 * @param targetScreen - Target screen from derivation
 * @returns true if navigation is needed
 */
export function needsNavigation(
  currentScreen: NavigationScreen,
  targetScreen: NavigationScreen
): boolean {
  return currentScreen !== targetScreen;
}

/**
 * Derives the navigation screen name for the current state.
 * Convenience function when only the screen name is needed.
 *
 * @param state - Current application state
 * @returns Screen name without params
 */
export function deriveScreen(state: AppState): NavigationScreen {
  return deriveNavigationTarget(state).screen;
}

// =============================================================================
// APP STEP DERIVATION (for legacy component compatibility)
// =============================================================================

/**
 * Maps OnboardingStep (state machine) to AppStep (legacy UI route).
 *
 * The state machine uses OnboardingStep values that are semantic ("phone-type"),
 * while the legacy UI uses AppStep values that are route-based ("phone-type-selection").
 *
 * @param step - OnboardingStep from state machine
 * @returns Corresponding AppStep for UI routing
 */
function mapOnboardingStepToAppStep(step: OnboardingStep): AppStep {
  switch (step) {
    case "phone-type":
      return "phone-type-selection";
    case "secure-storage":
      return "keychain-explanation";
    case "account-verification":
    case "contact-source":
    case "data-sync":
      // These steps are rendered by the queue-based OnboardingFlow,
      // not legacy routes. Map to loading as a fallback.
      return "loading";
    case "email-connect":
      return "email-onboarding";
    case "permissions":
      return "permissions";
    case "apple-driver":
      return "apple-driver-setup";
    case "android-coming-soon":
      return "android-coming-soon";
  }
}

/**
 * Derives the AppStep (legacy UI route) from current application state.
 * This bridges the gap between the state machine's semantic steps and
 * the legacy component's route-based navigation.
 *
 * @param state - Current application state
 * @returns AppStep for legacy component compatibility
 *
 * @example
 * ```ts
 * const appStep = deriveAppStep(state);
 * // Can be used directly with legacy components expecting AppStep
 * ```
 */
export function deriveAppStep(state: AppState): AppStep {
  switch (state.status) {
    case "loading":
      return "loading";

    case "unauthenticated":
      return "login";

    case "onboarding":
      return mapOnboardingStepToAppStep(state.step);

    case "ready":
      return "dashboard";

    case "error":
      // TASK-2278: Error state shows error screen (not loading/onboarding)
      return "error";
  }
}

/**
 * Derives the page title based on the current AppStep.
 * Pure function for getting the window/page title.
 *
 * @param appStep - Current AppStep
 * @returns Page title string
 */
export function derivePageTitle(appStep: AppStep): string {
  switch (appStep) {
    case "login":
      return "Welcome";
    case "dashboard":
      return "Keepr.";
    case "error":
      return "Error";
    // Onboarding steps: show generic "Setup" since the queue manages
    // step-specific titles via each step's content component.
    case "phone-type-selection":
    case "keychain-explanation":
    case "email-onboarding":
    case "permissions":
    case "apple-driver-setup":
    case "android-coming-soon":
      return "Setup";
    default:
      return "Keepr.";
  }
}
