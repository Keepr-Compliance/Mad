/**
 * State Machine Reducer
 *
 * Core reducer for the unified state machine. Handles all state transitions
 * in a pure, predictable manner. This replaces the fragmented hook-based
 * state coordination (BACKLOG-142).
 *
 * @module appCore/state/machine/reducer
 */

import { fdaBlocksOnboarding, unknownFdaFor, wasFdaAnswered } from "./fdaState";
import { hasMinimumDataSourceForUser } from "./selectors/userDataSelectors";
import type {
  AppState,
  AppAction,
  LoadingState,
  OnboardingState,
  ReadyState,
  OnboardingStep,
  PlatformInfo,
  User,
  UserData,
  LoginSuccessAction,
  AuthPreValidatedAction,
  InitStageReceivedAction,
} from "./types";
import { INITIAL_APP_STATE } from "./types";

// ============================================
// EXTENDED ACTION TYPES (for reducer context)
// ============================================

/**
 * Extended UserDataLoadedAction that includes context needed for transitions.
 * The orchestrator should provide user and platform when dispatching.
 */
interface UserDataLoadedWithContext {
  type: "USER_DATA_LOADED";
  data: UserData;
  /** User from previous AUTH_LOADED - required for state transition */
  user: User;
  /** Platform from previous AUTH_LOADED - required for state transition */
  platform: PlatformInfo;
}

/**
 * Union type for actions that the reducer can handle with full context.
 */
type AppActionWithContext = Exclude<AppAction, { type: "USER_DATA_LOADED" }> | UserDataLoadedWithContext | LoginSuccessAction | AuthPreValidatedAction;

// ============================================
// ONBOARDING STEP PROGRESSION
// ============================================

/**
 * Determines the next onboarding step based on completed steps,
 * platform info, and user data.
 *
 * Step order:
 * 1. phone-type - Always first (select iPhone/Android)
 * 2. secure-storage - macOS only (keychain explanation)
 * 3. email-connect - Email connection/onboarding
 * 4. permissions - macOS only (Full Disk Access)
 * 5. apple-driver - Windows + iPhone only (driver setup)
 *
 * @param completed - Array of already completed steps
 * @param platform - Platform information
 * @param userData - User preferences and completion state
 * @returns The next step to show, or null if all complete
 */
export function getNextOnboardingStep(
  completed: OnboardingStep[],
  platform: PlatformInfo,
  userData: UserData
): OnboardingStep | null {
  // Define step order with conditional inclusion
  const steps: OnboardingStep[] = [];

  // 1. Phone type selection is always first
  steps.push("phone-type");

  // 2. macOS secure storage explanation
  if (platform.isMacOS) {
    steps.push("secure-storage");
  }

  // 3. Email connection
  steps.push("email-connect");

  // 4. macOS permissions (if not already granted)
  // BACKLOG-3275: the `platform.isMacOS` guard is now carried by the union —
  // `fdaBlocksOnboarding("not-applicable")` is false, which is exactly what the
  // guard short-circuited to on Windows.
  if (fdaBlocksOnboarding(userData.fda)) {
    steps.push("permissions");
  }

  // 5. Windows + iPhone driver setup (if needed)
  // Use userData.phoneType instead of platform.hasIPhone to check user's actual selection
  // (fixes TASK-1180: platform.hasIPhone may not be updated yet when step completes)
  if (platform.isWindows && userData.phoneType === "iphone" && userData.needsDriverSetup) {
    steps.push("apple-driver");
  }

  // Find first uncompleted step
  for (const step of steps) {
    if (!completed.includes(step)) {
      return step;
    }
  }

  return null; // All steps complete
}

/**
 * Checks if onboarding is complete based on user data.
 * Onboarding is complete when the user has selected phone type and
 * platform-specific requirements are met.
 *
 * Email onboarding is optional for returning users - they can skip it
 * and connect email later from the dashboard.
 */
function isOnboardingComplete(userData: UserData, platform: PlatformInfo, _isNewUser: boolean = false): boolean {
  // Must have phone type selected
  if (!userData.phoneType) {
    return false;
  }

  // Email onboarding is required for ALL users (new and returning)
  // This ensures the email-connect step is shown if not completed
  // BUG FIX: Previously only checked for new users, causing returning users
  // to skip the email step entirely
  if (!userData.hasCompletedEmailOnboarding) {
    return false;
  }

  // macOS must have permissions — OR have already declined them, with a data
  // source that does not depend on them.
  //
  // BACKLOG-3212: before this, `!hasPermissions` alone forced every macOS user
  // who declined Full Disk Access back into onboarding on EVERY launch. That
  // made BACKLOG-1842's "Skip for now" unrepeatable in practice: the skip lived
  // in a React useState Set and died with the process, and this check re-routed
  // the user regardless. A user who cannot grant FDA at all (managed Mac) was
  // onboarded forever.
  //
  // `fdaSkipped` is deliberately NOT folded into `hasPermissions`: skipping
  // does not grant access to the local Messages database, and anything gating
  // on that capability must keep reading `hasPermissions`.
  //
  // The `hasEmailConnected` conjunct is what keeps the BACKLOG-1821
  // data-source floor intact. `hasCompletedEmailOnboarding` is also true for a
  // user who SKIPPED email, so releasing on `fdaSkipped` alone would drop a
  // user who skipped both email and FDA onto the dashboard with zero data
  // sources — the floor would never fire again. A connected mailbox is
  // strictly narrower than the floor's own accepted sources
  // (dataSourceFloor.getSatisfyingSource: email, FDA, iPhone driver, Android),
  // so this can never release someone the floor would have held. Users whose
  // only source is Android or an iPhone driver still enter onboarding, but the
  // queue now seeds `permissions` as answered, the floor passes, and the queue
  // completes without re-asking.
  //
  // BACKLOG-3275: `fdaBlocksOnboarding` carries the platform check (it is false
  // for "not-applicable"). The `hasEmailConnected` conjunct deliberately stays
  // HERE rather than moving into that helper: it reads a second field, so it is
  // not a projection of the Full Disk Access union and cannot be exhaustively
  // checked on it.
  if (fdaBlocksOnboarding(userData.fda)) {
    const declinedWithAnotherSource =
      userData.fda === "declined" && hasMinimumDataSourceForUser(userData, platform);
    if (!declinedWithAnotherSource) {
      return false;
    }
  }

  // Windows + iPhone must not need driver setup
  // Use userData.phoneType instead of platform.hasIPhone to check user's actual selection
  if (platform.isWindows && userData.phoneType === "iphone" && userData.needsDriverSetup) {
    return false;
  }

  return true;
}

// ============================================
// REDUCER
// ============================================

/**
 * Core reducer for app state machine.
 * All state transitions are explicit and predictable.
 *
 * Key principles:
 * - Pure function: no side effects
 * - Invalid transitions return current state unchanged
 * - Error states track previousState for retry functionality
 *
 * @param state - Current application state
 * @param action - Action to process
 * @returns New application state
 */
export function appStateReducer(
  state: AppState,
  action: AppActionWithContext
): AppState {
  switch (action.type) {
    // ============================================
    // LOADING PHASE TRANSITIONS
    // ============================================

    case "STORAGE_CHECKED": {
      // Only valid from initial loading state
      if (state.status !== "loading" || state.phase !== "checking-storage") {
        return state; // Invalid transition
      }

      // BACKLOG-3253: first-run macOS used to branch off here and defer the
      // database open to onboarding's secure-storage step, to stay ahead of a
      // Keychain prompt. That prompt does not happen -- macOS prompts when an
      // app READS an item written under a different code signature, and a
      // first run is always a WRITE. Measured on two Macs, 2026-09-08.
      //
      // Every platform now takes the same route, first run and returning.
      //
      // TASK-2086: Proceed to pre-DB auth validation (SOC 2 CC6.1)
      // Auth must be validated BEFORE database decryption.
      return {
        status: "loading",
        phase: "validating-auth",
      };
    }

    // ============================================
    // TASK-2086: PRE-DB AUTH VALIDATION (SOC 2 CC6.1)
    // ============================================

    case "AUTH_PRE_VALIDATED": {
      // Only valid from validating-auth phase
      if (state.status !== "loading" || state.phase !== "validating-auth") {
        return state;
      }

      if (!action.valid) {
        // Auth failed pre-DB -- go to unauthenticated WITHOUT ever opening DB
        return {
          status: "unauthenticated",
          reason: action.reason || "session_revoked",
        } as import("./types").UnauthenticatedState;
      }

      // Auth passed or no session exists -- proceed to DB initialization
      return {
        status: "loading",
        phase: "initializing-db",
      };
    }

    case "DB_INIT_STARTED": {
      // Progress indicator - valid during initializing-db phase or onboarding with deferred init
      if (state.status === "loading" && state.phase === "initializing-db") {
        return { ...state, progress: 0 };
      }
      // Also allow during onboarding for first-time macOS users (deferred DB init)
      if (state.status === "onboarding" && state.deferredDbInit) {
        return state; // No visible change needed, but action is valid
      }
      return state;
    }

    case "DB_INIT_COMPLETE": {
      // Handle during normal loading flow
      if (state.status === "loading" && state.phase === "initializing-db") {
        if (!action.success) {
          // DB initialization failed - transition to error state
          return {
            status: "error",
            error: {
              code: "DB_INIT_FAILED",
              message: action.error || "Failed to initialize database",
            },
            recoverable: true,
            previousState: state,
          };
        }

        // Success - proceed to load auth
        return {
          status: "loading",
          phase: "loading-auth",
        };
      }

      // Handle during onboarding for first-time macOS users (deferred DB init)
      if (state.status === "onboarding" && state.deferredDbInit) {
        if (!action.success) {
          // DB initialization failed - transition to error state
          return {
            status: "error",
            error: {
              code: "DB_INIT_FAILED",
              message: action.error || "Failed to initialize database",
            },
            recoverable: true,
            previousState: state,
          };
        }

        // Success - clear deferred flag, DB is now initialized
        return {
          ...state,
          deferredDbInit: false,
        };
      }

      return state;
    }

    case "AUTH_LOADED": {
      if (state.status !== "loading" || state.phase !== "loading-auth") {
        return state;
      }

      // Preserve deferredDbInit flag from loading state
      const loadingState = state as LoadingState;
      const deferredDbInit = loadingState.deferredDbInit;

      if (!action.user) {
        // No authenticated user - preserve deferredDbInit for after login
        return {
          status: "unauthenticated",
          deferredDbInit,
        };
      }

      if (action.isNewUser) {
        // New user - start onboarding immediately
        // For new users, we don't need to load user data first
        const firstStep = getNextOnboardingStep([], action.platform, {
          phoneType: null,
          hasCompletedEmailOnboarding: false,
          hasEmailConnected: false,
          needsDriverSetup: true, // Assume needed until checked
          fda: unknownFdaFor(action.platform),
        });

        return {
          status: "onboarding",
          step: firstStep || "phone-type", // Default to phone-type if null
          user: action.user,
          platform: action.platform,
          completedSteps: [],
          deferredDbInit,
        };
      }

      // Returning user - need to load their data
      // Preserve deferredDbInit for returning users on fresh macOS installs
      return {
        status: "loading",
        phase: "loading-user-data",
        deferredDbInit,
      };
    }

    // ============================================
    // LOGIN_SUCCESS - Fresh login from unauthenticated state
    // ============================================

    case "LOGIN_SUCCESS": {
      // Only valid from unauthenticated state
      if (state.status !== "unauthenticated") {
        return state; // Invalid transition
      }

      // Preserve deferredDbInit flag from unauthenticated state
      const deferredDbInit = state.deferredDbInit;

      if (action.isNewUser) {
        // New user - start onboarding immediately
        const firstStep = getNextOnboardingStep([], action.platform, {
          phoneType: null,
          hasCompletedEmailOnboarding: false,
          hasEmailConnected: false,
          needsDriverSetup: true, // Assume needed until checked
          fda: unknownFdaFor(action.platform),
        });

        return {
          status: "onboarding",
          step: firstStep || "phone-type", // Default to phone-type if null
          user: action.user,
          platform: action.platform,
          completedSteps: [],
          deferredDbInit,
        };
      }

      // Returning user - need to load their data
      // Store user/platform in loading state for Phase 4 to use
      // Preserve deferredDbInit for returning users on fresh macOS installs
      return {
        status: "loading",
        phase: "loading-user-data",
        progress: 75, // Skip phases 1-3, go directly to user data loading
        user: action.user,
        platform: action.platform,
        deferredDbInit,
      };
    }

    case "USER_DATA_LOADED": {
      if (state.status !== "loading" || state.phase !== "loading-user-data") {
        return state;
      }

      // User and platform context can come from:
      // 1. Action (app restart flow via authDataRef in LoadingOrchestrator)
      // 2. State (fresh login flow via LOGIN_SUCCESS)
      const actionWithContext = action as UserDataLoadedWithContext;
      const loadingState = state as LoadingState;

      const user = actionWithContext.user || loadingState.user;
      const platform = actionWithContext.platform || loadingState.platform;
      const { data } = actionWithContext;

      // Check if user and platform are provided
      if (!user || !platform) {
        // Missing context - this is a programming error
        // Return to checking-storage to restart the flow
        return {
          status: "error",
          error: {
            code: "USER_DATA_FAILED",
            message: "Missing user or platform context in USER_DATA_LOADED action",
          },
          recoverable: true,
          previousState: state,
        };
      }

      // Determine if onboarding is complete
      // USER_DATA_LOADED is only called for returning users, so isNewUser = false
      // This allows returning users to skip email onboarding and go to dashboard
      if (isOnboardingComplete(data, platform, false)) {
        // All onboarding complete - go to ready state
        return {
          status: "ready",
          user,
          platform,
          userData: data,
        };
      }

      // Need to complete onboarding
      // Determine which steps are already complete based on userData
      const completedSteps: OnboardingStep[] = [];

      if (data.phoneType) {
        completedSteps.push("phone-type");
      }

      if (data.hasCompletedEmailOnboarding) {
        completedSteps.push("email-connect");
      }

      // BACKLOG-3212: an already-declined FDA prompt counts as answered here
      // exactly as a granted one does. The "implied complete" reasoning for
      // secure-storage is identical in both cases — secure-storage sits before
      // permissions in the macOS flow, so reaching permissions at all (to
      // grant OR to skip) means secure-storage already ran.
      //
      // BACKLOG-3275: `wasFdaAnswered` is the ONLY thing that decides whether
      // "permissions" belongs in completedSteps. The arrow now points one way —
      // completedSteps is derived from the union, never the reverse.
      //
      // The `platform.isMacOS` guard is KEPT rather than folded into the helper:
      // `wasFdaAnswered("not-applicable")` is true, and a Windows user must not
      // acquire completedSteps entries they do not have today. completedSteps is
      // read outside this reducer at derivation/stepDerivation.ts:189.
      if (platform.isMacOS && wasFdaAnswered(data.fda)) {
        completedSteps.push("permissions");
        completedSteps.push("secure-storage"); // Implied complete if they got past it
      }

      if (platform.isWindows && platform.hasIPhone && !data.needsDriverSetup) {
        completedSteps.push("apple-driver");
      }

      const nextStep = getNextOnboardingStep(completedSteps, platform, data);

      // Preserve deferredDbInit for returning users on fresh installs
      // This handles the case where a user exists in Supabase but the local
      // app data was deleted - DB still needs to be initialized
      const deferredDbInit = loadingState.deferredDbInit;

      return {
        status: "onboarding",
        step: nextStep || "phone-type", // Fallback shouldn't happen
        user,
        platform,
        completedSteps,
        // Preserve the Full Disk Access state from loaded data so selectors can
        // access it. Fixes the bug where users with FDA granted were stuck on
        // the permissions step.
        //
        // BACKLOG-3212: this also carries the persisted "Skip for now" choice.
        // A user can legitimately re-enter onboarding for another reason (no
        // mailbox yet); when they do, the queue reads `"declined"` here to seed
        // `permissions` as already answered instead of asking again.
        fda: data.fda,
        // Preserve hasEmailConnected so returning users with email already
        // connected don't get shown the email-connect step unnecessarily.
        // Without this, OnboardingState.hasEmailConnected defaults to undefined,
        // causing selectHasEmailConnectedNullable to return false.
        hasEmailConnected: data.hasEmailConnected,
        // BACKLOG-3276: carry the loaded phone type into onboarding state.
        // `completedSteps` above already says phone-type is answered, but the
        // queue reads the answer itself (OnboardingFlow -> selectPhoneType ->
        // PhoneTypeStep.isComplete), so without this a returning user is asked
        // "What phone do you use?" again. Record only what was loaded; `null`
        // stays unset and is never defaulted from the platform.
        selectedPhoneType: data.phoneType ?? undefined,
        // Preserve deferredDbInit for first-time macOS installs (even for returning users)
        deferredDbInit,
      };
    }

    // ============================================
    // ONBOARDING TRANSITIONS
    // ============================================

    case "ONBOARDING_STEP_COMPLETE": {
      if (state.status !== "onboarding") {
        return state;
      }

      // When completing a step, ensure all preceding steps are also marked complete
      // This handles the case where the UI navigates through steps without explicitly completing each one
      let completedSteps = state.completedSteps.includes(action.step)
        ? state.completedSteps
        : [...state.completedSteps, action.step];

      // Track phone type selection from the action (when completing phone-type step)
      // This is the user's actual selection, not inferred from platform detection
      const selectedPhoneType: "iphone" | "android" | undefined =
        action.step === "phone-type" && action.phoneType
          ? action.phoneType
          : state.selectedPhoneType;

      // If completing permissions on macOS, mark all preceding steps as complete
      // macOS flow order: phone-type → secure-storage → email-connect → permissions
      // So preceding steps are phone-type, secure-storage, and email-connect
      if (action.step === "permissions") {
        const precedingSteps: OnboardingStep[] = ["phone-type", "email-connect"];
        if (state.platform.isMacOS) {
          precedingSteps.push("secure-storage");
        }
        for (const step of precedingSteps) {
          if (!completedSteps.includes(step)) {
            completedSteps = [...completedSteps, step];
          }
        }
      }

      // Determine user data state based on completed steps
      //
      // BACKLOG-3276: only a recorded selection counts. This used to fall back
      // to `platform.hasIPhone ? "iphone" : "android"`, but every production
      // producer of PlatformInfo sets hasIPhone to false, so the fallback wrote
      // "android" for any user without a recorded selection, including iPhone
      // users. An unanswered phone type stays null.
      const phoneTypeForUserData: "iphone" | "android" | null = completedSteps.includes("phone-type")
        ? (selectedPhoneType ?? null)
        : null;

      const userData: UserData = {
        phoneType: phoneTypeForUserData,
        hasCompletedEmailOnboarding: completedSteps.includes("email-connect"),
        hasEmailConnected: state.hasEmailConnected ?? false,
        needsDriverSetup:
          state.platform.isWindows &&
          selectedPhoneType === "iphone" &&
          !completedSteps.includes("apple-driver"),
        // BACKLOG-3275: carried through, never derived from `completedSteps`.
        //
        // This line used to read `completedSteps.includes("permissions")`. A
        // user who DECLINED Full Disk Access has that entry — correctly, it
        // means "asked and answered" — so completing any other step reported
        // the capability as granted, and dropped the record of the decline in
        // the same transition.
        //
        // Navigation does not decide capability. Only the permission probe and
        // the user's own recorded answer do, and both reach this state before
        // the transition.
        fda: state.fda ?? unknownFdaFor(state.platform),
      };

      const nextStep = getNextOnboardingStep(
        completedSteps,
        state.platform,
        userData
      );

      if (!nextStep) {
        // All onboarding complete - transition to ready
        return {
          status: "ready",
          user: state.user,
          platform: state.platform,
          userData,
        };
      }

      // Continue to next step
      return {
        ...state,
        step: nextStep,
        completedSteps,
        selectedPhoneType,
      };
    }

    case "FDA_GRANTED": {
      // BACKLOG-3275: the only writer of `"granted"` outside the probe
      // derivation. Valid from onboarding (the grant happened during the
      // permissions step) and from ready (the BACKLOG-3208 Settings path).
      if (state.status === "onboarding") {
        return { ...state, fda: "granted" };
      }
      if (state.status === "ready") {
        return { ...state, userData: { ...state.userData, fda: "granted" } };
      }
      return state;
    }

    case "PHONE_TYPE_RESET": {
      if (state.status !== "onboarding") {
        return state;
      }

      return {
        ...state,
        selectedPhoneType: undefined,
        completedSteps: state.completedSteps.filter((s) => s !== "phone-type"),
      };
    }

    case "RESUME_MARKER_APPLIED": {
      if (state.status !== "onboarding") {
        return state;
      }

      // Seed selectedPhoneType from the marker so phone-type's context-driven
      // isComplete (phoneType !== null) is satisfied immediately — the queue
      // will not show phone-type as active. Also mark phone-type complete in
      // completedSteps for the legacy step/completedSteps bookkeeping this
      // state still carries alongside the queue.
      if (!action.phoneType) {
        return state;
      }

      return {
        ...state,
        selectedPhoneType: action.phoneType,
        completedSteps: state.completedSteps.includes("phone-type")
          ? state.completedSteps
          : [...state.completedSteps, "phone-type"],
      };
    }

    case "ONBOARDING_SKIP": {
      if (state.status !== "onboarding") {
        return state;
      }

      // Skipping is treated the same as completing for navigation
      // The actual skip behavior (what data gets stored) is handled by orchestrator
      return appStateReducer(state, {
        type: "ONBOARDING_STEP_COMPLETE",
        step: action.step,
      });
    }

    case "ONBOARDING_QUEUE_DONE": {
      // Queue-driven completion: the onboarding queue reports all steps are done.
      // Transition to ready state with userData derived from onboarding state.
      if (state.status !== "onboarding") {
        return state;
      }

      const phoneType: "iphone" | "android" | null =
        state.selectedPhoneType ?? null;

      const userData: UserData = {
        phoneType,
        hasCompletedEmailOnboarding: true,
        hasEmailConnected: state.hasEmailConnected ?? false,
        needsDriverSetup: false,
        fda: state.fda ?? unknownFdaFor(state.platform),
      };

      return {
        status: "ready",
        user: state.user,
        platform: state.platform,
        userData,
      };
    }

    case "EMAIL_CONNECTED": {
      if (state.status === "onboarding") {
        // Update onboarding state to track that email was connected
        const updatedState: OnboardingState = {
          ...state,
          hasEmailConnected: true,
        };
        // Recursively call reducer to complete the step and potentially transition to ready
        // This ensures the flow advances after email OAuth completes
        return appStateReducer(updatedState, {
          type: "ONBOARDING_STEP_COMPLETE",
          step: "email-connect",
        });
      }

      if (state.status === "ready") {
        // User connected email from Settings after onboarding complete
        // Update userData.hasEmailConnected so dashboard banner disappears
        return {
          ...state,
          userData: {
            ...state.userData,
            hasEmailConnected: true,
          },
        };
      }

      // Invalid state for email connection
      return state;
    }

    // TASK-1730: Handle email disconnection to update hasEmailConnected state
    case "EMAIL_DISCONNECTED": {
      if (state.status === "ready") {
        // User disconnected email from Settings
        // Update userData.hasEmailConnected so setup banner reappears
        return {
          ...state,
          userData: {
            ...state.userData,
            hasEmailConnected: false,
          },
        };
      }

      // In other states (onboarding, loading), disconnection is not expected
      // but if it happens, ignore it
      return state;
    }

    // ============================================
    // READY STATE TRANSITIONS
    // ============================================

    case "APP_READY": {
      // This is a no-op if already ready
      // It's used to explicitly signal readiness from other states
      if (state.status === "ready") {
        return state;
      }

      // APP_READY can only be dispatched when already in a terminal state
      // Other states should transition through proper actions
      return state;
    }

    case "START_EMAIL_SETUP": {
      // Only valid from ready state - allows user to connect email after initial onboarding
      //
      // BACKLOG-3276: the only dispatcher is useNavigationFlow.ts
      // (goToEmailOnboarding), called only from the Resume Setup banner
      // (useResumeSetup.ts). That banner shows only when selectSetupIncomplete
      // is true, which no ready user with a phone type satisfies. The phone-type
      // handling below guards this transition for any future entry point.
      if (state.status !== "ready") {
        return state;
      }

      // Transition back to onboarding with email-connect step
      // Preserve user data except mark email onboarding as incomplete
      return {
        status: "onboarding",
        step: "email-connect",
        user: state.user,
        platform: state.platform,
        // Mark the steps before email-connect as complete. BACKLOG-3276:
        // phone-type counts only when an answer is recorded, so a user who
        // never answered is routed back to it instead of being treated as
        // answered.
        completedSteps: [
          ...(state.userData.phoneType !== null ? ["phone-type" as const] : []),
          ...(state.platform.isMacOS ? ["secure-storage" as const] : []),
        ],
        // BACKLOG-3276: carry the recorded answer so the queue does not ask
        // "What phone do you use?" again. `null` stays unset.
        selectedPhoneType: state.userData.phoneType ?? undefined,
        // Preserve email connected state if they already have it (shouldn't happen, but be safe)
        hasEmailConnected: state.userData.hasEmailConnected,
        // BACKLOG-3212 / BACKLOG-3275: a ready user who opens email setup must
        // not be re-asked for Full Disk Access they already declined. One field
        // now carries both the capability and the recorded answer, so neither
        // can be dropped while the other survives.
        fda: state.userData.fda,
      };
    }

    // ============================================
    // LOGOUT
    // ============================================

    case "LOGOUT": {
      // Logout works from any state
      return { status: "unauthenticated" };
    }

    // ============================================
    // ERROR HANDLING
    // ============================================

    case "ERROR": {
      // Any state can transition to error
      return {
        status: "error",
        error: action.error,
        recoverable: action.recoverable ?? false,
        previousState: state,
      };
    }

    case "RETRY": {
      if (state.status !== "error") {
        return state;
      }

      if (!state.recoverable) {
        // Non-recoverable errors cannot be retried
        return state;
      }

      // Return to previous state, or initial if no previous state
      return state.previousState || INITIAL_APP_STATE;
    }

    // ============================================
    // INIT STAGE METADATA (BACKLOG-1379)
    // ============================================

    case "INIT_STAGE_RECEIVED": {
      // Only update metadata while in loading state — this is informational only
      // and does NOT drive state transitions.
      if (state.status !== "loading") {
        return state;
      }

      const { stage, progress, message } = (action as InitStageReceivedAction).payload;

      return {
        ...state,
        initStage: stage,
        migrationProgress: progress,
        initMessage: message,
      };
    }

    default: {
      // Unknown action - return current state
      // TypeScript should catch this at compile time
      return state;
    }
  }
}
