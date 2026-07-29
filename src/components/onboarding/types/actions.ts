/**
 * Onboarding Step Action Type Definitions
 *
 * Action types for step state changes and navigation.
 *
 * @module onboarding/types/actions
 */

import type { PhoneType } from "../../../appCore/state/types";

// =============================================================================
// STEP ACTIONS
// =============================================================================

/**
 * Base interface for all step actions.
 * All actions must have a type discriminator.
 */
interface BaseStepAction {
  type: string;
}

/**
 * Action dispatched when user selects their phone type.
 */
export interface SelectPhoneAction extends BaseStepAction {
  type: "SELECT_PHONE";
  payload: {
    phoneType: NonNullable<PhoneType>;
  };
}

/**
 * Action dispatched when user initiates email connection.
 * The orchestrator handles the actual OAuth flow.
 */
export interface ConnectEmailStartAction extends BaseStepAction {
  type: "CONNECT_EMAIL_START";
  payload: {
    provider: "google" | "microsoft";
  };
}

/**
 * Action dispatched when email connection is completed.
 */
export interface EmailConnectedAction extends BaseStepAction {
  type: "EMAIL_CONNECTED";
  payload: {
    email: string;
    provider: "google" | "microsoft";
  };
}

/**
 * Action dispatched when email connection is skipped.
 */
export interface EmailSkippedAction extends BaseStepAction {
  type: "EMAIL_SKIPPED";
}

/**
 * Action dispatched when required permissions are granted.
 */
export interface PermissionGrantedAction extends BaseStepAction {
  type: "PERMISSION_GRANTED";
}

/**
 * Action dispatched when driver setup is completed.
 */
export interface DriverSetupCompleteAction extends BaseStepAction {
  type: "DRIVER_SETUP_COMPLETE";
}

/**
 * Action dispatched when driver setup is skipped.
 */
export interface DriverSkippedAction extends BaseStepAction {
  type: "DRIVER_SKIPPED";
}

/**
 * Action dispatched when terms are accepted.
 */
export interface TermsAcceptedAction extends BaseStepAction {
  type: "TERMS_ACCEPTED";
}

/**
 * Action dispatched when terms are declined.
 */
export interface TermsDeclinedAction extends BaseStepAction {
  type: "TERMS_DECLINED";
}

/**
 * Action dispatched when secure storage setup is confirmed.
 */
export interface SecureStorageSetupAction extends BaseStepAction {
  type: "SECURE_STORAGE_SETUP";
}

/**
 * Action dispatched to navigate to the next step.
 */
export interface NavigateNextAction extends BaseStepAction {
  type: "NAVIGATE_NEXT";
}

/**
 * Action dispatched to navigate to the previous step.
 */
export interface NavigateBackAction extends BaseStepAction {
  type: "NAVIGATE_BACK";
}

/**
 * Action dispatched when onboarding is fully completed.
 */
export interface OnboardingCompleteAction extends BaseStepAction {
  type: "ONBOARDING_COMPLETE";
}

/**
 * Action dispatched from Android Coming Soon screen to go back and select iPhone.
 */
export interface GoBackSelectIphoneAction extends BaseStepAction {
  type: "GO_BACK_SELECT_IPHONE";
}

/**
 * Action dispatched from Android Coming Soon screen to continue with email only.
 */
export interface ContinueEmailOnlyAction extends BaseStepAction {
  type: "CONTINUE_EMAIL_ONLY";
}

/**
 * Action dispatched from the Android pairing step's post-pair success state to
 * finish/close the Settings Android Sync wizard (BACKLOG-2327).
 *
 * SCOPE: consumed ONLY by the Settings Android Sync wizard
 * (`settings/android/AndroidSyncSetup`), which maps it to the wizard's
 * completion path (`onComplete` → close the modal, falling back to the terminal
 * "done" cursor). The first-run onboarding orchestrator does NOT wire any
 * navigation to this action — the pairing step is Settings-wizard-only after
 * BACKLOG-2288 removed it from both onboarding flows. Do NOT drive onboarding
 * navigation from this action.
 */
export interface AndroidSyncDoneAction extends BaseStepAction {
  type: "ANDROID_SYNC_DONE";
}

/**
 * Action dispatched when the user has been verified to exist in the local database.
 * This is triggered by the account-verification step after successfully
 * confirming/creating the user in SQLite.
 */
export interface UserVerifiedInLocalDbAction extends BaseStepAction {
  type: "USER_VERIFIED_IN_LOCAL_DB";
}

/**
 * Union type of all possible step actions.
 * Used for type-safe action handling in step components.
 */
export type StepAction =
  | SelectPhoneAction
  | ConnectEmailStartAction
  | EmailConnectedAction
  | EmailSkippedAction
  | PermissionGrantedAction
  | DriverSetupCompleteAction
  | DriverSkippedAction
  | TermsAcceptedAction
  | TermsDeclinedAction
  | SecureStorageSetupAction
  | NavigateNextAction
  | NavigateBackAction
  | OnboardingCompleteAction
  | GoBackSelectIphoneAction
  | ContinueEmailOnlyAction
  | AndroidSyncDoneAction
  | UserVerifiedInLocalDbAction;

/**
 * Type guard to extract the action type string literal.
 */
export type StepActionType = StepAction["type"];
