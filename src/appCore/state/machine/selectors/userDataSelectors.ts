/**
 * User Data State Selectors
 *
 * Pure selector functions for deriving user-related state from AppState.
 * These selectors enable hooks to query onboarding progress and user
 * preferences without coupling to the specific state structure.
 *
 * @module appCore/state/machine/selectors/userDataSelectors
 */

import { isFdaGranted } from "../fdaState";
import type { AppState, OnboardingStep, PlatformInfo, UserData } from "../types";
import logger from '../../../../utils/logger';
import type { OnboardingContext, Platform } from "../../../../components/onboarding/types";
import { hasMinimumDataSource } from "../../../../components/onboarding/queue/dataSourceFloor";

/**
 * Step order for comparison.
 * MUST match the order defined in types.ts and the reducer.
 */
const STEP_ORDER: OnboardingStep[] = [
  "phone-type",
  "secure-storage",
  "account-verification",
  "contact-source",
  "email-connect",
  "data-sync",
  "permissions",
  "apple-driver",
  "android-coming-soon",
];

/**
 * Get the index of a step in the order.
 * Returns -1 if step is not found (should not happen with valid steps).
 *
 * @param step - Onboarding step to find
 * @returns Index of the step, or -1 if not found
 */
function getStepIndex(step: OnboardingStep): number {
  return STEP_ORDER.indexOf(step);
}

/**
 * Returns current onboarding step, or null if not in onboarding.
 *
 * @param state - Current application state
 * @returns Current onboarding step, or null if not onboarding
 *
 * @example
 * ```ts
 * const step = selectCurrentOnboardingStep(state);
 * if (step === 'phone-type') {
 *   // Render phone type selection
 * }
 * ```
 */
export function selectCurrentOnboardingStep(
  state: AppState
): OnboardingStep | null {
  if (state.status !== "onboarding") {
    return null;
  }
  return state.step;
}

/**
 * Returns true if email onboarding is complete.
 * Email step is complete if we're past it or app is ready.
 *
 * @param state - Current application state
 * @returns true if email onboarding has been completed
 */
export function selectHasCompletedEmailOnboarding(state: AppState): boolean {
  if (state.status === "ready") {
    return true;
  }
  if (state.status === "onboarding") {
    // Check if we're past the email step
    const emailStepIndex = getStepIndex("email-connect");
    const currentIndex = getStepIndex(state.step);
    return currentIndex > emailStepIndex;
  }
  return false;
}

/**
 * Returns true if phone type has been selected.
 * Phone type is selected if we're past that step or app is ready.
 *
 * @param state - Current application state
 * @returns true if phone type has been selected
 */
export function selectHasSelectedPhoneType(state: AppState): boolean {
  if (state.status === "ready") {
    return true;
  }
  if (state.status === "onboarding") {
    const phoneTypeIndex = getStepIndex("phone-type");
    const currentIndex = getStepIndex(state.step);
    return currentIndex > phoneTypeIndex;
  }
  return false;
}

/**
 * Returns true if the given step has been completed.
 * A step is complete if we're past it in the onboarding flow or app is ready.
 *
 * @param state - Current application state
 * @param step - Step to check completion for
 * @returns true if the step has been completed
 */
export function selectIsStepComplete(
  state: AppState,
  step: OnboardingStep
): boolean {
  if (state.status === "ready") {
    return true;
  }
  if (state.status === "onboarding") {
    const targetIndex = getStepIndex(step);
    const currentIndex = getStepIndex(state.step);
    return currentIndex > targetIndex;
  }
  return false;
}

/**
 * Returns the list of completed onboarding steps.
 *
 * @param state - Current application state
 * @returns Array of completed steps, or empty array if not onboarding
 */
export function selectCompletedSteps(state: AppState): OnboardingStep[] {
  if (state.status === "onboarding") {
    return state.completedSteps;
  }
  if (state.status === "ready") {
    // All steps are complete when ready
    return [...STEP_ORDER];
  }
  return [];
}

/**
 * Returns the user's selected phone type.
 *
 * @param state - Current application state
 * @returns 'iphone', 'android', or null if not yet selected or not in a state with user data
 */
export function selectPhoneType(
  state: AppState
): "iphone" | "android" | null {
  if (state.status === "ready") {
    return state.userData.phoneType;
  }
  if (state.status === "onboarding") {
    // The recorded selection, set by every transition that knows the answer:
    // ONBOARDING_STEP_COMPLETE(phone-type), USER_DATA_LOADED,
    // START_EMAIL_SETUP and RESUME_MARKER_APPLIED.
    //
    // BACKLOG-3276: no platform fallback. It returned "iphone" when
    // platform.hasIPhone was true, which no production producer sets, so it
    // never ran in the app and only let test fixtures answer the question for
    // the user.
    if (state.selectedPhoneType) {
      return state.selectedPhoneType;
    }
  }
  return null;
}

/**
 * Returns true if user has an email connected.
 * Only available from ready state where userData exists.
 *
 * During onboarding, checks the hasEmailConnected flag on the onboarding state.
 * During loading, defaults to true to avoid flicker (matching legacy behavior).
 *
 * @param state - Current application state
 * @returns true if user has connected an email account
 */
export function selectHasEmailConnected(state: AppState): boolean {
  if (state.status === "ready") {
    return state.userData.hasEmailConnected;
  }
  if (state.status === "onboarding") {
    // During onboarding, check if email was connected in this session
    return state.hasEmailConnected ?? false;
  }
  // Loading state - default true to avoid flicker (matching legacy behavior)
  return true;
}

/**
 * Returns true if user has macOS Full Disk Access permissions.
 * Only relevant for macOS; always false for other platforms or during loading.
 *
 * @param state - Current application state
 * @returns true if user has granted permissions
 */
export function selectHasPermissions(state: AppState): boolean {
  if (state.status === "ready") {
    return isFdaGranted(state.userData.fda);
  }
  if (state.status === "onboarding") {
    // Check if permissions were loaded during initialization.
    // This fixes the bug where returning users with FDA granted were stuck.
    // BACKLOG-3275: `fda === undefined` means "not established yet"; this
    // selector's contract is a plain boolean, so unknown reads as not granted.
    return state.fda === undefined ? false : isFdaGranted(state.fda);
  }
  return false;
}

// =============================================================================
// NULLABLE SELECTORS
// =============================================================================
// These selectors return `undefined` for unknown states instead of defensive
// values. Use these in step predicates where unknown should mean "show the step".
// See: Kent C. Dodds "Stop using isLoading booleans"

/**
 * Tri-state selector for email connection status.
 * Returns: true (connected), false (not connected), undefined (unknown/loading)
 *
 * Use this in step predicates: `emailConnected !== true` means show step
 * when either not connected OR unknown (loading).
 *
 * @param state - Current application state
 * @returns true, false, or undefined if state is unknown
 */
export function selectHasEmailConnectedNullable(
  state: AppState
): boolean | undefined {
  let result: boolean | undefined;

  if (state.status === "ready") {
    result = state.userData.hasEmailConnected;
  } else if (state.status === "onboarding") {
    result = state.hasEmailConnected ?? false;
  } else {
    // Loading/unauthenticated/error: state is unknown
    result = undefined;
  }

  logger.debug('[selectHasEmailConnectedNullable]', {
    status: state.status,
    'state.hasEmailConnected': state.status === 'onboarding' ? (state as any).hasEmailConnected : 'N/A',
    result,
  });

  return result;
}

/**
 * Tri-state selector for permissions status.
 * Returns: true (granted), false (not granted), undefined (unknown/loading)
 *
 * @param state - Current application state
 * @returns true, false, or undefined if state is unknown
 */
export function selectHasPermissionsNullable(
  state: AppState
): boolean | undefined {
  if (state.status === "ready") {
    return isFdaGranted(state.userData.fda);
  }
  if (state.status === "onboarding") {
    // BACKLOG-3275: `undefined` must survive. It is the load-bearing third
    // value this selector exists for — `PermissionsStep.tsx:680` (`!== true`)
    // and `dataSourceFloor.ts:67` both depend on unknown reading as neither
    // granted nor explicitly false, so a half-loaded state never satisfies the
    // BACKLOG-1821 floor. Mapping it through `isFdaGranted` would collapse it.
    return state.fda === undefined ? undefined : isFdaGranted(state.fda);
  }
  // Loading/unauthenticated/error: state is unknown
  return undefined;
}

// =============================================================================
// SETUP-INCOMPLETE SELECTOR (BACKLOG-1709 / BACKLOG-1711)
// =============================================================================

/**
 * Maps the machine's `PlatformInfo` (isMacOS/isWindows booleans) onto the
 * onboarding {@link Platform} string that {@link hasMinimumDataSource} expects.
 * The floor only distinguishes macOS-family (Full Disk Access → texts) from the
 * rest, so Windows is the only non-macOS branch we need to name precisely.
 */
function platformInfoToOnboardingPlatform(info: {
  isMacOS: boolean;
  isWindows: boolean;
}): Platform {
  if (info.isMacOS) return "macos";
  if (info.isWindows) return "windows";
  // Desktop-only app; the remaining desktop target reuses the macOS flow.
  return "linux";
}

/**
 * Whether a user SATISFIES the onboarding data-source floor (BACKLOG-1821) —
 * i.e. they have at least one source this app can audit (a mailbox, or a texts
 * capability).
 *
 * It deliberately reuses the floor's own {@link hasMinimumDataSource} predicate
 * so the definition of "complete enough" stays single-sourced with onboarding —
 * a texts-only user (macOS Full Disk Access, or an iPhone/Android selection)
 * has satisfied the floor and MUST NOT be treated as incomplete (no shaming of
 * texts-only completion).
 *
 * Two callers read it with OPPOSITE polarity, which is why it is extracted:
 *   - {@link selectSetupIncomplete} negates it to drive the "Resume setup"
 *     affordance (BACKLOG-1709 / BACKLOG-1711).
 *   - the onboarding routing gate calls it directly (BACKLOG-3277,
 *     `reducer.ts:167-172`) rather than re-deriving a stricter answer of its
 *     own, which is what held a declined-permission user in onboarding forever.
 *
 * Fail-open, exactly like the floor: because the `ready` state records
 * `needsDriverSetup: false` (so `driverSetupComplete` reads true) and any phone
 * selection satisfies the floor, an iPhone/Android user always satisfies this.
 * The only population it reports as unsatisfied is the true zero-source
 * dead-end — no email, not macOS-with-FDA, and no phone selected.
 *
 * @param userData - The user's persisted source and permission facts
 * @param platform - The desktop platform they are running on
 * @returns true when the floor IS satisfied
 */
export function hasMinimumDataSourceForUser(
  userData: Pick<UserData, "phoneType" | "hasEmailConnected" | "needsDriverSetup" | "fda">,
  platform: Pick<PlatformInfo, "isMacOS" | "isWindows">
): boolean {
  // Reconstruct the minimal OnboardingContext the floor reads. Fields the floor
  // ignores are given inert defaults; only platform/email/permissions/phone/
  // driver actually drive hasMinimumDataSource.
  const context: OnboardingContext = {
    platform: platformInfoToOnboardingPlatform(platform),
    phoneType: userData.phoneType,
    emailConnected: userData.hasEmailConnected,
    connectedEmail: null,
    emailSkipped: false,
    driverSkipped: false,
    // In `ready`, driver setup is resolved (needsDriverSetup === false),
    // so treat the driver capability as present for an iPhone user (fail-open).
    driverSetupComplete: userData.needsDriverSetup === false,
    permissionsGranted: isFdaGranted(userData.fda),
    termsAccepted: true,
    emailProvider: null,
    authProvider: "google",
    isNewUser: false,
    isDatabaseInitialized: true,
    userId: null,
    isUserVerifiedInLocalDb: true,
    isResumedFromFdaRelaunch: false,
  };

  return hasMinimumDataSource(context);
}

/**
 * Whether a user who has reached the main app (`ready`) is still genuinely
 * BELOW the onboarding data-source floor (BACKLOG-1821) — i.e. they have NO
 * connected data source at all (no mailbox AND no texts capability).
 *
 * This is the single signal behind the "Resume setup" affordance
 * (BACKLOG-1709 / BACKLOG-1711). It is the exact negation of
 * {@link hasMinimumDataSourceForUser} over the same projection, so the banner
 * and the onboarding routing gate cannot drift apart.
 *
 * Returns `false` for every non-`ready` state:
 *   - onboarding renders its own flow/floor UI,
 *   - loading/login/error/unauthenticated show no main-app chrome.
 *
 * Because the predicate fails open (see above), the banner appears ONLY for the
 * true zero-source dead-end: no email, not macOS-with-FDA, and no phone
 * selected.
 *
 * @param state - Current application state
 * @returns true only when in `ready` AND the data-source floor is unmet
 */
export function selectSetupIncomplete(state: AppState): boolean {
  if (state.status !== "ready") {
    return false;
  }
  const { userData, platform } = state;
  return !hasMinimumDataSourceForUser(userData, platform);
}
