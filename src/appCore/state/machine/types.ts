/**
 * State Machine Types
 *
 * Comprehensive TypeScript types for the unified state machine that replaces
 * fragmented hook-based state coordination. These types form the foundation
 * for the state coordination layer (BACKLOG-142).
 *
 * @module appCore/state/machine/types
 */

// ============================================
// LOADING PHASES
// ============================================

/**
 * Loading phases in initialization sequence.
 * MUST execute in this order.
 */
export type LoadingPhase =
  | "checking-storage" // Check if encryption key store exists
  | "validating-auth" // TASK-2086: Pre-DB auth validation (SOC 2 CC6.1)
  | "awaiting-keychain" // macOS only: Wait for user to confirm keychain access
  | "initializing-db" // Initialize secure storage (may prompt on macOS)
  | "loading-auth" // Check authentication state
  | "loading-user-data"; // Load phone type, email status, etc.

// ============================================
// ONBOARDING STEPS
// ============================================

/**
 * Onboarding steps - MUST match existing OnboardingFlow registry.
 * See: src/components/onboarding/types/steps.ts
 * See: src/components/onboarding/steps/index.ts
 *
 * Note: 'terms' is handled as a modal in AppRouter, not as an onboarding step.
 */
export type OnboardingStep =
  | "phone-type" // Phone type selection screen
  | "secure-storage" // macOS keychain explanation (keychain-explanation route)
  | "account-verification" // Verify user exists in local DB
  | "contact-source" // Select contact sources
  | "email-connect" // Email onboarding screen
  | "data-sync" // Sync checkpoint before permissions
  | "permissions" // macOS permissions
  | "apple-driver" // Windows + iPhone driver setup
  | "android-coming-soon"; // Android placeholder

// ============================================
// PLATFORM INFO
// ============================================

/**
 * Platform-specific information used for conditional onboarding flows
 * and feature availability.
 */
export interface PlatformInfo {
  /** True if running on macOS */
  isMacOS: boolean;
  /** True if running on Windows */
  isWindows: boolean;
  /** True if user selected iPhone (affects driver setup on Windows) */
  hasIPhone: boolean;
}

// ============================================
// USER DATA
// ============================================

/**
 * Authenticated user information from Supabase.
 */
export interface User {
  /** Unique user identifier */
  id: string;
  /** User's email address */
  email: string;
  /** User's display name (optional) */
  displayName?: string;
  /** URL to user's avatar image (optional) */
  avatarUrl?: string;
}

/**
 * User preferences and onboarding completion state.
 * Persisted to database after initialization.
 */
export interface UserData {
  /** Selected phone type during onboarding */
  phoneType: "iphone" | "android" | null;
  /** True if user completed email onboarding (connected or skipped) */
  hasCompletedEmailOnboarding: boolean;
  /** True if user has connected an email account */
  hasEmailConnected: boolean;
  /** True if Windows + iPhone user needs Apple Mobile Device driver */
  needsDriverSetup: boolean;
  /** True if macOS user has granted Full Disk Access */
  hasPermissions: boolean;
}

// ============================================
// ERRORS
// ============================================

/**
 * Structured error information for error states.
 */
export interface AppError {
  /** Error code for programmatic handling */
  code: AppErrorCode;
  /** Human-readable error message */
  message: string;
  /** Additional error details (e.g., stack trace, context) */
  details?: unknown;
}

/**
 * Error codes for different failure scenarios.
 */
export type AppErrorCode =
  | "API_NOT_READY" // Preload bridge not available (race condition)
  | "STORAGE_CHECK_FAILED" // Failed to check secure storage
  | "DB_INIT_FAILED" // Failed to initialize database
  | "AUTH_FAILED" // Failed to authenticate user
  | "USER_DATA_FAILED" // Failed to load user data
  | "NETWORK_ERROR" // Network connectivity issue
  | "UNKNOWN_ERROR"; // Catch-all for unexpected errors

// ============================================
// APP STATES (Discriminated Union)
// ============================================

/**
 * All possible application states.
 * Uses discriminated union pattern with 'status' as discriminant.
 */
export type AppState =
  | LoadingState
  | UnauthenticatedState
  | OnboardingState
  | ReadyState
  | ErrorState;

/**
 * Application is loading and initializing.
 * Progresses through phases in order.
 */
export interface LoadingState {
  status: "loading";
  /** Current phase in the loading sequence */
  phase: LoadingPhase;
  /** Optional progress 0-100 for long phases */
  progress?: number;
  /**
   * User info from LOGIN_SUCCESS action.
   * Only present when entering loading-user-data from fresh login.
   */
  user?: User;
  /**
   * Platform info from LOGIN_SUCCESS action.
   * Only present when entering loading-user-data from fresh login.
   */
  platform?: PlatformInfo;
  /**
   * True when DB initialization is deferred for first-time macOS users.
   * DB will be initialized during onboarding secure-storage step instead.
   * This prevents the Keychain prompt from appearing before the login screen.
   */
  deferredDbInit?: boolean;

  // ---- Init stage metadata (BACKLOG-1379: event-driven init protocol) ----

  /** Current initialization stage from main process broadcaster */
  initStage?: string;
  /** Migration progress 0-100 from main process (when stage is 'migrating') */
  migrationProgress?: number;
  /** Human-readable init status message from main process */
  initMessage?: string;
}

/**
 * User is not authenticated.
 * Show login screen.
 */
export interface UnauthenticatedState {
  status: "unauthenticated";
  /**
   * True when DB initialization is deferred for first-time macOS users.
   * Preserved from loading state to be passed to onboarding after login.
   */
  deferredDbInit?: boolean;
}

/**
 * User is authenticated but needs to complete onboarding.
 * Progress through onboarding steps.
 */
export interface OnboardingState {
  status: "onboarding";
  /** Current onboarding step (legacy - queue now determines active step) */
  step: OnboardingStep;
  /** Authenticated user */
  user: User;
  /** Platform information */
  platform: PlatformInfo;
  /** Track which steps are complete */
  completedSteps: OnboardingStep[];
  /** True if email was connected during this onboarding session */
  hasEmailConnected?: boolean;
  /** True if macOS Full Disk Access is granted (checked during loading) */
  hasPermissions?: boolean;
  /** Phone type selected during onboarding (iphone or android) */
  selectedPhoneType?: "iphone" | "android";
  /**
   * True when DB initialization is deferred for first-time macOS users.
   * DB will be initialized during the secure-storage onboarding step.
   */
  deferredDbInit?: boolean;
}

/**
 * Application is fully initialized and ready to use.
 * User has completed authentication and onboarding.
 */
export interface ReadyState {
  status: "ready";
  /** Authenticated user */
  user: User;
  /** Platform information */
  platform: PlatformInfo;
  /** User preferences and completion state */
  userData: UserData;
}

/**
 * Application encountered an error.
 * May be recoverable or require restart.
 */
export interface ErrorState {
  status: "error";
  /** Error details */
  error: AppError;
  /** If true, user can retry/recover */
  recoverable: boolean;
  /** Previous state to return to on retry */
  previousState?: AppState;
}

// ============================================
// ACTIONS (Discriminated Union)
// ============================================

/**
 * All possible actions that can be dispatched to the state machine.
 * Uses discriminated union pattern with 'type' as discriminant.
 */
export type AppAction =
  | StorageCheckedAction
  | AuthPreValidatedAction
  | KeychainConfirmedAction
  | DbInitStartedAction
  | DbInitCompleteAction
  | AuthLoadedAction
  | LoginSuccessAction
  | UserDataLoadedAction
  | OnboardingStepCompleteAction
  | OnboardingSkipAction
  | OnboardingQueueDoneAction
  | PhoneTypeResetAction
  | ResumeMarkerAppliedAction
  | EmailConnectedAction
  | EmailDisconnectedAction
  | StartEmailSetupAction
  | AppReadyAction
  | LogoutAction
  | ErrorAction
  | RetryAction
  | InitStageReceivedAction;

/**
 * Storage check completed - determined if key store exists.
 */
export interface StorageCheckedAction {
  type: "STORAGE_CHECKED";
  /** True if encryption key store exists */
  hasKeyStore: boolean;
  /** True if running on macOS (needed to determine if keychain confirmation is needed) */
  isMacOS?: boolean;
}

/**
 * TASK-2086: Pre-DB auth validation completed (SOC 2 CC6.1).
 * Dispatched after server-side auth validation BEFORE database decryption.
 * Ensures data is only accessible to currently authorized users.
 */
export interface AuthPreValidatedAction {
  type: "AUTH_PRE_VALIDATED";
  /** True if auth validation passed (or no session exists) */
  valid: boolean;
  /** True if no session.json exists (new user / cleared session) */
  noSession?: boolean;
  /** Reason for auth failure (when valid is false) */
  reason?: string;
}

/**
 * User confirmed keychain access on macOS.
 * Dispatched when user clicks "Continue" on the KeychainExplanation screen.
 */
export interface KeychainConfirmedAction {
  type: "KEYCHAIN_CONFIRMED";
}

/**
 * Database initialization has started.
 * May trigger OS prompt on macOS for keychain access.
 */
export interface DbInitStartedAction {
  type: "DB_INIT_STARTED";
}

/**
 * Database initialization completed.
 */
export interface DbInitCompleteAction {
  type: "DB_INIT_COMPLETE";
  /** True if initialization succeeded */
  success: boolean;
  /** Error message if initialization failed */
  error?: string;
}

/**
 * Authentication state loaded.
 */
export interface AuthLoadedAction {
  type: "AUTH_LOADED";
  /** Authenticated user or null if not authenticated */
  user: User | null;
  /** True if this is a new user (needs full onboarding) */
  isNewUser: boolean;
  /** Platform information */
  platform: PlatformInfo;
}

/**
 * Fresh login completed successfully.
 * Dispatched when a user logs in (not during app restart).
 * Transitions state machine from unauthenticated to loading-user-data.
 */
export interface LoginSuccessAction {
  type: "LOGIN_SUCCESS";
  /** Authenticated user */
  user: User;
  /** Platform information */
  platform: PlatformInfo;
  /** True if this is a new user (needs full onboarding) */
  isNewUser: boolean;
}

/**
 * User data loaded from database.
 */
export interface UserDataLoadedAction {
  type: "USER_DATA_LOADED";
  /** User preferences and completion state */
  data: UserData;
}

/**
 * User completed an onboarding step.
 */
export interface OnboardingStepCompleteAction {
  type: "ONBOARDING_STEP_COMPLETE";
  /** The step that was completed */
  step: OnboardingStep;
  /** Phone type selected during phone-type step (required when step is "phone-type") */
  phoneType?: "iphone" | "android";
}

/**
 * Queue-driven onboarding completion.
 * Dispatched when the onboarding queue reports all steps are complete.
 */
export interface OnboardingQueueDoneAction {
  type: "ONBOARDING_QUEUE_DONE";
}

/**
 * Reset phone type selection during onboarding.
 * Dispatched when user navigates back from the android pairing step
 * to re-select their phone type. Clears selectedPhoneType and removes
 * "phone-type" from completedSteps so the queue shows phone-type as active.
 */
export interface PhoneTypeResetAction {
  type: "PHONE_TYPE_RESET";
}

/**
 * BACKLOG-1842 (resume-at-step fix round): applied once, early in onboarding,
 * when a single-use resume marker was consumed on this launch (i.e. this
 * process just came up from the FDA-grant relaunch). Seeds `selectedPhoneType`
 * from the marker so phone-type's context-driven `isComplete` predicate
 * (`phoneType !== null`) is satisfied immediately and the queue does not
 * replay the phone-type step. Steps whose completion isn't reducer-tracked
 * (contact-source, account-verification's isUserVerifiedInLocalDb) are seeded
 * separately by OnboardingFlow's local state from the same marker.
 */
export interface ResumeMarkerAppliedAction {
  type: "RESUME_MARKER_APPLIED";
  phoneType: "iphone" | "android" | null;
}

/**
 * User skipped an onboarding step.
 */
export interface OnboardingSkipAction {
  type: "ONBOARDING_SKIP";
  /** The step that was skipped */
  step: OnboardingStep;
}

/**
 * Email connection completed during onboarding.
 * Updates the onboarding state to track that email was connected.
 */
export interface EmailConnectedAction {
  type: "EMAIL_CONNECTED";
  /** The email address that was connected */
  email: string;
  /** The email provider (google or microsoft) */
  provider: "google" | "microsoft";
}

/**
 * User disconnected their email account from Settings.
 * Updates hasEmailConnected to false so the setup banner reappears.
 * TASK-1730: Added to support email disconnection state propagation.
 */
export interface EmailDisconnectedAction {
  type: "EMAIL_DISCONNECTED";
  /** The email provider that was disconnected */
  provider: "google" | "microsoft";
}

/**
 * User wants to start email setup from the dashboard.
 * Transitions from ready state back to onboarding with email-connect step.
 * Used when user clicks "Continue Setup" on the dashboard.
 */
export interface StartEmailSetupAction {
  type: "START_EMAIL_SETUP";
}

/**
 * Application is ready - all initialization and onboarding complete.
 */
export interface AppReadyAction {
  type: "APP_READY";
}

/**
 * User logged out.
 */
export interface LogoutAction {
  type: "LOGOUT";
}

/**
 * An error occurred.
 */
export interface ErrorAction {
  type: "ERROR";
  /** Error details */
  error: AppError;
  /** True if error is recoverable (default: false) */
  recoverable?: boolean;
}

/**
 * User is retrying after an error.
 */
export interface RetryAction {
  type: "RETRY";
}

/**
 * Received an initialization stage event from the main process.
 * Updates metadata on LoadingState without changing state transitions.
 * Part of the event-driven initialization protocol (BACKLOG-1379).
 */
export interface InitStageReceivedAction {
  type: "INIT_STAGE_RECEIVED";
  payload: {
    stage: string;
    progress?: number;
    message?: string;
    error?: { message: string; retryable: boolean };
  };
}

// ============================================
// CONTEXT VALUE
// ============================================

/**
 * Context value provided by AppStateProvider.
 * Includes state, dispatch, and derived selectors for convenience.
 */
export interface AppStateContextValue {
  /** Current state */
  state: AppState;
  /** Dispatch action to update state */
  dispatch: React.Dispatch<AppAction>;

  // ============================================
  // DERIVED SELECTORS (for convenience)
  // ============================================

  /** True when status is 'loading' */
  isLoading: boolean;
  /** True when status is 'ready' */
  isReady: boolean;
  /** Current user or null */
  currentUser: User | null;
  /** Platform info or null (only available after auth loaded) */
  platform: PlatformInfo | null;
  /** Current loading phase or null */
  loadingPhase: LoadingPhase | null;
  /** Current onboarding step or null */
  onboardingStep: OnboardingStep | null;
  /** Current error or null */
  error: AppError | null;
}

// ============================================
// INITIAL STATE
// ============================================

/**
 * Initial state for the application.
 * Starts in loading state, checking storage.
 */
export const INITIAL_APP_STATE: LoadingState = {
  status: "loading",
  phase: "checking-storage",
};
