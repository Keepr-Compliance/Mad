/**
 * License Context
 * Centralizes license state management for the application.
 * Provides license type, AI addon status, and computed permission flags.
 *
 * License Model (BACKLOG-426):
 *   license_type: 'individual' | 'team' | 'enterprise' (base license)
 *   ai_detection_enabled: boolean (add-on, works with ANY base license)
 *
 * SPRINT-062: Added license validation with trial tracking, transaction limits,
 * and device limits. LicenseProvider now accepts userId prop for validation.
 *
 * SPRINT-127 / TASK-2160: transactionLimit and hasAIAddon now read from
 * plan features via useFeatureGate (max_transaction_size, ai_detection).
 * Plan features are the sole source of truth; no license column fallback.
 *
 * Combined Examples:
 *   - Individual + No AI: Export, manual transactions only
 *   - Individual + AI: Export, manual transactions, AI detection features
 *   - Team + No AI: Submit for review, manual transactions only
 *   - Team + AI: Submit for review, manual transactions, AI detection features
 */

import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
} from "react";
import type { LicenseType } from "../../electron/types/models";
import type { LicenseValidationResult } from "@keepr/shared";
import { licenseService } from "../services";
import { useFeatureGate } from "../hooks/useFeatureGate";
import logger from '../utils/logger';

// License context value interface
interface LicenseContextValue {
  // Core license data
  licenseType: LicenseType;
  hasAIAddon: boolean;
  organizationId: string | null;

  // Computed convenience flags
  /** true for individual license - can export locally */
  canExport: boolean;
  /** true for team/enterprise license - can submit for broker review */
  canSubmit: boolean;
  /** true if AI detection add-on is enabled */
  canAutoDetect: boolean;

  // Loading state
  isLoading: boolean;
  /** True after first successful license load - used to prevent loading UI on refresh */
  hasInitialized: boolean;
  /**
   * BACKLOG-2885 — is the license CLASS actually known for the user who is
   * signed in right now?
   *
   * `isLoading` cannot answer that, and callers that used it as a proxy were
   * wrong. `electron/handlers/licenseHandlers.ts` answers `success: true,
   * license_type: "individual", organization_id: undefined` when NO SESSION has
   * loaded yet — a positive "you are an individual" that is indistinguishable,
   * from here, from a real one. This provider mounts above auth, so its first
   * fetch routinely gets that pre-session answer and records it with
   * `isLoading: false`. A brokerage user then reads as an individual, with no
   * loading flag raised, until something re-fetches.
   *
   * So this flag tracks WHO the last completed fetch answered for, not merely
   * that a fetch finished. A caller whose decision differs by license class
   * (`useCompleteTransaction` routes Complete to submit-vs-export) must treat
   * false as UNKNOWN and refuse to choose, rather than taking the default
   * branch.
   *
   * THREE CONDITIONS, each for a window that produced the bug:
   *   1. a fetch has completed for the CURRENT user (`answeredForUserId`) —
   *      the license used to be read once, at mount, above auth;
   *   2. that answer was session-backed (`answerIsUsable`) — the main process
   *      returns a positive "individual, no organization" when it has no
   *      session yet, and on the deferred-DB deep-link path `userId` is set
   *      before the session is written;
   *   3. `validateLicense` has also landed (`validatedForUserId`) — it is a
   *      second writer of `licenseType`, so until it speaks `canSubmit` is
   *      still moving.
   *
   * It always settles. Every fetch and validate path — success, no-license,
   * and throw — clears `isLoading` and stamps its user; a load that FAILS
   * resolves to the individual/export default; and the wait for a session is
   * bounded, after which the answer is accepted as-is. Nothing here can leave
   * a caller waiting on a state that will not arrive.
   */
  isLicenseResolved: boolean;

  // Actions
  refresh: () => Promise<void>;

  // SPRINT-062: License validation status
  /** Full validation result from license service */
  validationStatus: LicenseValidationResult | null;
  /** Whether the license is valid (not blocked) */
  isValid: boolean;
  /** Reason for block if license is invalid */
  blockReason: LicenseValidationResult["blockReason"] | null;
  /** Days remaining in trial (null if not on trial) */
  trialDaysRemaining: number | null;
  /** Current transaction count */
  transactionCount: number;
  /** Maximum transactions allowed */
  transactionLimit: number;
  /** Whether user can create a new transaction */
  canCreateTransaction: boolean;
}

// License state interface (internal)
interface LicenseState {
  licenseType: LicenseType;
  hasAIAddon: boolean;
  organizationId: string | null;
  isLoading: boolean;
  /** True after first successful load - prevents loading screen on refresh */
  hasInitialized: boolean;
  /**
   * BACKLOG-2885 — the userId the last COMPLETED fetchLicense answered for.
   * `undefined` means no answer has ever landed. Compared against the live
   * userId to derive `isLicenseResolved`; `undefined !== null` is what keeps
   * "never answered" distinct from "answered for the signed-out state".
   */
  answeredForUserId: string | null | undefined;
  /**
   * BACKLOG-2885 — is the last completed answer one we may act on?
   *
   * False for exactly one case: a signed-in user whose answer came back
   * `sessionBacked: false`, meaning the main process had no session yet and
   * returned its "individual, no organization" default. Stamping that as this
   * user's license is what left a brokerage user reading as an individual.
   *
   * A FAILED load sets this true — "could not read" resolves to the
   * individual/export default rather than waiting forever.
   */
  answerIsUsable: boolean;
  /**
   * BACKLOG-2885 — how many times we have re-asked while the main process
   * reported no session.
   *
   * This is STATE and not a ref on purpose. The retry is an effect, and an
   * effect only re-runs when its dependencies change; a ref counter leaves them
   * identical between attempts, so exactly ONE retry ever fires and
   * `answerIsUsable` never reaches the give-up branch — leaving Complete
   * disabled forever, which is worse than the defect being fixed. Caught by the
   * bounded-wait control.
   */
  sessionWaitAttempt: number;
  /**
   * BACKLOG-2885 — the userId `validateLicense` last completed for.
   *
   * `validateLicense` overwrites `licenseType`, which drives `canSubmit`, and it
   * runs on a different network call from `fetchLicense`. Until BOTH have landed
   * the pair (licenseType, organizationId) is still moving, so declaring the
   * license "known" after only one of them lets a user act on a value that is
   * about to change — the same defect this item exists to remove.
   */
  validatedForUserId: string | null | undefined;
  // SPRINT-062: Validation status
  validationStatus: LicenseValidationResult | null;
}

// Default license state (individual with no AI)
const defaultLicenseState: LicenseState = {
  licenseType: "individual",
  hasAIAddon: false,
  organizationId: null,
  isLoading: true,
  hasInitialized: false,
  answeredForUserId: undefined,
  answerIsUsable: false,
  sessionWaitAttempt: 0,
  validatedForUserId: undefined,
  validationStatus: null,
};

// Create context with undefined default to ensure provider is used
const LicenseContext = createContext<LicenseContextValue | undefined>(
  undefined
);

// Provider props - SPRINT-062: Added userId prop for validation
interface LicenseProviderProps {
  children: React.ReactNode;
  /** User ID for license validation (null if not authenticated) */
  userId?: string | null;
}

/**
 * LicenseProvider component
 * Wraps the application and provides license state and computed permissions
 *
 * SPRINT-062: Now accepts userId prop for license validation. When userId is
 * provided, validates license and tracks trial status, transaction limits, etc.
 */
export function LicenseProvider({
  children,
  userId,
}: LicenseProviderProps): React.ReactElement {
  const [state, setState] = useState<LicenseState>(defaultLicenseState);

  // Track last license check to throttle focus refresh (60 second minimum between checks)
  const lastCheckRef = useRef<number>(0);
  const FOCUS_THROTTLE_MS = 60000; // 60 seconds

  // BACKLOG-2885: the prop is optional; normalise so "signed out" is one value.
  const currentUserId = userId ?? null;

  /**
   * BACKLOG-2885 — the user a fetch must still be relevant to when it lands.
   * Set synchronously by the effect that triggers each fetch, so a response for
   * a previous user cannot overwrite a newer user's license (or stamp the wrong
   * owner and strand `isLicenseResolved` at false).
   */
  const latestUserIdRef = useRef<string | null>(currentUserId);

  /**
   * BACKLOG-2885 — how long to keep asking while the main process reports it has
   * no session yet.
   *
   * Needed because NOTHING announces the persist. On the deferred-DB deep-link
   * path (`electron/handlers/systemHandlers.ts:596-608`, BACKLOG-2173b) the
   * renderer is told about the login by the deep-link callback, while the
   * session is saved later by `persistSessionForUser` — which logs and emits no
   * renderer event. Until one exists, the only honest option is to re-ask.
   *
   * Asking is cheap in precisely the state that triggers it: with no session
   * `getLicenseData` returns before any network call.
   *
   * The cap is what keeps Complete from being dead forever if the session never
   * arrives: on exhaustion the answer is accepted as-is, which is the behaviour
   * before this fix, but bounded and deterministic.
   */
  const SESSION_WAIT_RETRY_MS = 300;
  const SESSION_WAIT_MAX_RETRIES = 20;

  /**
   * Fetch license from main process (original method for backward compatibility)
   * Note: This is a silent fetch that doesn't set isLoading to true,
   * so it won't trigger the loading screen on background refreshes.
   */
  const fetchLicense = useCallback(async () => {
    // BACKLOG-2885: the license this call is answering FOR. Captured before the
    // await so the answer can be attributed, and discarded if the user changed
    // underneath it.
    const answeringFor = currentUserId;
    const isStale = () => latestUserIdRef.current !== answeringFor;

    try {
      const result = await licenseService.get();
      if (isStale()) return;
      if (result.success && result.data) {
        const license = result.data;
        // BACKLOG-2885: signed out, the no-session default IS the right answer.
        // Signed in, it is a placeholder and must not be recorded as this
        // user's license class.
        const usable = answeringFor === null || license.sessionBacked;
        setState((prev) => ({
          ...prev,
          licenseType: license.license_type || "individual",
          hasAIAddon: license.ai_detection_enabled || false,
          organizationId: license.organization_id || null,
          isLoading: false,
          hasInitialized: true,
          answeredForUserId: answeringFor,
          answerIsUsable: usable,
        }));
      } else {
        // No license found - use defaults
        setState((prev) => ({
          ...prev,
          isLoading: false,
          hasInitialized: true,
          answeredForUserId: answeringFor,
          answerIsUsable: true,
        }));
      }
    } catch {
      // License fetch failed silently - use defaults.
      // BACKLOG-2885: a FAILED load still counts as answered. "Could not load"
      // must resolve to the individual/export default, never leave the caller
      // waiting on a state that will not arrive.
      if (isStale()) return;
      setState((prev) => ({
        ...prev,
        isLoading: false,
        hasInitialized: true,
        answeredForUserId: answeringFor,
        answerIsUsable: true,
      }));
    }
  }, [currentUserId]);

  /**
   * SPRINT-062: Validate license for a specific user
   * Handles trial status, transaction limits, and auto-creates license if needed
   *
   * SPRINT-066: Added hasInitialized tracking to prevent showing "Checking license..."
   * screen on background refreshes. Only shows loading UI before first successful load.
   */
  const validateLicense = useCallback(async () => {
    // BACKLOG-2885: the user this run answers for, and the guard that drops it
    // if a newer user arrives mid-flight — same contract as fetchLicense.
    const validatingFor = currentUserId;
    const isStale = () => latestUserIdRef.current !== validatingFor;

    if (!userId) {
      setState((prev) => ({
        ...prev,
        validationStatus: null,
        isLoading: false,
        validatedForUserId: validatingFor,
      }));
      return;
    }

    try {
      // Only set isLoading: true if we haven't initialized yet
      // This prevents showing "Checking license..." on background refreshes
      setState((prev) => ({
        ...prev,
        isLoading: prev.hasInitialized ? prev.isLoading : true,
      }));

      // Validate license through service (returns ApiResult<LicenseValidationResult>)
      const validationResponse = await licenseService.validate(userId);
      let validationResult = validationResponse.success ? validationResponse.data : null;

      // If no license exists, create a trial license
      if (!validationResult || validationResult.blockReason === "no_license") {
        const createResponse = await licenseService.create(userId);
        if (createResponse.success && createResponse.data) {
          validationResult = createResponse.data;
        }
      }

      // Update state with validation result
      if (isStale()) return;
      if (validationResult) {
        setState((prev) => ({
          ...prev,
          validationStatus: validationResult,
          // Map validation result to existing fields for backward compatibility
          licenseType: validationResult.licenseType as LicenseType,
          hasAIAddon: validationResult.aiEnabled,
          isLoading: false,
          hasInitialized: true, // Mark as initialized after first successful load
          validatedForUserId: validatingFor,
        }));
      } else {
        // Fallback if both validate and create failed
        setState((prev) => ({
          ...prev,
          isLoading: false,
          hasInitialized: true,
          validatedForUserId: validatingFor,
        }));
      }
    } catch (error) {
      logger.error("Failed to validate license:", error);
      // BACKLOG-2148: A thrown error here is a TRANSIENT load failure (IPC / network /
      // DB-init race), NOT evidence the account is invalid. The previous fallback set
      // isValid:false + blockReason:'no_license'/'trial', which LicenseGate rendered as
      // the false "Trial Expired / Upgrade" screen for valid authenticated users
      // (ELECTRON-1Z). Fail OPEN instead: allow access with a soft, non-blocking
      // 'load_error' reason and let the app retry validation online.
      //
      // 'load_error' must NOT be 'no_license' — the retry/validate path above keys
      // trial-license creation on blockReason === 'no_license', and we do NOT want a
      // transient error to force a trial row for a user who may already be a paid
      // individual. Terminal states (suspended/expired) are never produced here; they
      // come from the main-process success path (calculateLicenseStatus).
      const fallbackStatus: LicenseValidationResult = {
        isValid: true,
        licenseType: "individual",
        transactionCount: 0,
        transactionLimit: 0,
        canCreateTransaction: true,
        deviceCount: 0,
        deviceLimit: 1,
        aiEnabled: false,
        blockReason: "load_error",
      };
      if (isStale()) return;
      setState((prev) => ({
        ...prev,
        validationStatus: fallbackStatus,
        isLoading: false,
        hasInitialized: true, // Mark as initialized even on error to prevent loading loop
        // BACKLOG-2885: a validation that FAILED still counts as landed, for the
        // same reason a failed fetch does — it must not hold the UI unresolved.
        validatedForUserId: validatingFor,
      }));
    }
  }, [userId, currentUserId]);

  /**
   * Fetch the license on mount AND whenever the signed-in user changes.
   *
   * BACKLOG-2885 — this used to be mount-only (`fetchLicense` had `[]` deps),
   * which is how a brokerage user ended up reading as an individual for minutes
   * at a time. This provider mounts above `AuthProvider`'s session check, so the
   * mount fetch runs with no session and gets the "individual, no organization"
   * default; `validateLicense` then runs on login but sets only `licenseType`,
   * never `organizationId`. Nothing re-read the license after login, so the
   * organization arrived only when a window `focus` happened to fire the silent
   * background fetch — which is exactly what made the Export button appear
   * mid-click for the founder.
   *
   * The ref is assigned here, synchronously, before the fetch is dispatched, so
   * an in-flight answer for the previous user is discarded rather than
   * clobbering this one.
   */
  useEffect(() => {
    latestUserIdRef.current = currentUserId;
    // A new user gets a fresh wait budget.
    setState((prev) =>
      prev.sessionWaitAttempt === 0 ? prev : { ...prev, sessionWaitAttempt: 0 },
    );
    void fetchLicense();
  }, [fetchLicense, currentUserId]);

  /**
   * BACKLOG-2885 — keep asking while the answer is a no-session placeholder.
   *
   * THE PATH THIS EXISTS FOR: a cold launch driven by a `keepr://` deep link
   * with the database still down. `electron/main.ts` skips its session-save
   * block and only stores a pending user, then tells the renderer the login
   * succeeded. `AuthContext` sets `userId`, our fetch fires, and the main
   * process still has no session — so it answers "individual, no organization".
   * The session is written later, by `persistSessionForUser` after DB init,
   * which logs and sends nothing.
   *
   * A push event from that function would let this go away; until one exists,
   * re-asking is the only mechanism, and `sessionBacked` is what makes the
   * re-ask conditional on the real fact rather than on a timer.
   */
  useEffect(() => {
    if (currentUserId === null) return;
    // No answer for this user yet — the fetch is still in flight, not stalled.
    if (state.answeredForUserId !== currentUserId) return;
    if (state.answerIsUsable) return;

    if (state.sessionWaitAttempt >= SESSION_WAIT_MAX_RETRIES) {
      // Give up and accept the answer. This is the pre-fix behaviour, but
      // bounded and deterministic: Complete becomes usable rather than staying
      // disabled on a session that is never going to arrive.
      setState((prev) =>
        prev.answerIsUsable ? prev : { ...prev, answerIsUsable: true },
      );
      return;
    }

    const timer = setTimeout(() => {
      // Bumping the attempt count is what re-arms this effect for the NEXT
      // attempt; see the field's comment.
      setState((prev) => ({
        ...prev,
        sessionWaitAttempt: prev.sessionWaitAttempt + 1,
      }));
      void fetchLicense();
    }, SESSION_WAIT_RETRY_MS);
    return () => clearTimeout(timer);
  }, [
    currentUserId,
    state.answeredForUserId,
    state.answerIsUsable,
    state.sessionWaitAttempt,
    fetchLicense,
    SESSION_WAIT_MAX_RETRIES,
    SESSION_WAIT_RETRY_MS,
  ]);

  // SPRINT-062: Validate license when userId changes
  useEffect(() => {
    if (userId) {
      validateLicense();
    } else {
      // Clear validation status when user logs out.
      // BACKLOG-2885: stamp the signed-out state as validated too. Validation is
      // vacuously complete with no user, and leaving the stamp unset would hold
      // `isLicenseResolved` false forever for a signed-out session — a state no
      // consumer could ever leave.
      setState((prev) => ({
        ...prev,
        validationStatus: null,
        validatedForUserId: null,
      }));
    }
  }, [userId, validateLicense]);

  // Refresh on app focus (to catch license changes from other sources)
  // Throttled to prevent constant "checking license" on every focus
  useEffect(() => {
    const handleFocus = () => {
      const now = Date.now();
      // Skip if checked recently (within 60 seconds)
      if (now - lastCheckRef.current < FOCUS_THROTTLE_MS) {
        return;
      }
      lastCheckRef.current = now;

      // Do a silent background check - don't set isLoading to avoid UI disruption
      fetchLicense();
      // Skip validateLicense on focus - it sets isLoading which closes modals
      // License validation happens on mount and userId change anyway
    };

    window.addEventListener("focus", handleFocus);
    return () => {
      window.removeEventListener("focus", handleFocus);
    };
  }, [fetchLicense]);

  /**
   * Refresh license data
   */
  const refresh = useCallback(async () => {
    setState((prev) => ({ ...prev, isLoading: true }));
    await fetchLicense();
    if (userId) {
      await validateLicense();
    }
  }, [fetchLicense, validateLicense, userId]);

  // SPRINT-127 / TASK-2160: Read plan-level features (sole source of truth)
  const {
    isAllowed: featureIsAllowed,
    features: planFeatures,
  } = useFeatureGate();

  /**
   * BACKLOG-2885 — the license class is known only when a fetch has completed
   * FOR THIS USER and no newer fetch is in flight.
   *
   * `answeredForUserId` starts `undefined`, which never equals `currentUserId`
   * (`null` included), so the very first render is correctly unknown. Including
   * `!isLoading` folds in the `refresh()` window: while an explicit refresh is
   * running the answer may still change, and a caller that must not guess
   * should not act on the previous one.
   */
  const isLicenseResolved =
    !state.isLoading &&
    state.answeredForUserId === currentUserId &&
    state.answerIsUsable &&
    state.validatedForUserId === currentUserId;

  // Compute convenience flags
  const canExport = state.licenseType === "individual";
  const canSubmit =
    state.licenseType === "team" || state.licenseType === "enterprise";

  // SPRINT-127: hasAIAddon from plan feature. Plan features are sole source of truth.
  // featureIsAllowed returns true (fail-open) when the feature gate hasn't loaded yet.
  const hasAIAddon = featureIsAllowed("ai_detection");
  const canAutoDetect = hasAIAddon;

  // SPRINT-062: Extract validation status fields
  const validationStatus = state.validationStatus;
  const isValid = validationStatus?.isValid ?? true; // Default to true if no validation
  const blockReason = validationStatus?.blockReason ?? null;
  const trialDaysRemaining = validationStatus?.trialDaysRemaining ?? null;
  const transactionCount = validationStatus?.transactionCount ?? 0;

  // SPRINT-127: transactionLimit from plan feature. Plan features are sole source of truth.
  // Parse max_transaction_size feature value (string) as integer.
  // Defaults to Infinity (fail-open) when the feature is missing or not yet loaded.
  const planMaxTxn = planFeatures["max_transaction_size"]?.value;
  const parsedPlanLimit = planMaxTxn ? parseInt(planMaxTxn, 10) : NaN;
  const transactionLimit = !isNaN(parsedPlanLimit) ? parsedPlanLimit : Infinity;

  // SPRINT-127: canCreateTransaction uses plan-feature-derived limit
  const canCreateTransaction = transactionCount < transactionLimit;

  // Memoize context value to prevent unnecessary re-renders
  const contextValue = useMemo<LicenseContextValue>(
    () => ({
      licenseType: state.licenseType,
      hasAIAddon,
      organizationId: state.organizationId,
      canExport,
      canSubmit,
      canAutoDetect,
      isLoading: state.isLoading,
      hasInitialized: state.hasInitialized,
      isLicenseResolved,
      refresh,
      // SPRINT-062: Validation status fields
      validationStatus,
      isValid,
      blockReason,
      trialDaysRemaining,
      transactionCount,
      transactionLimit,
      canCreateTransaction,
    }),
    [
      state,
      isLicenseResolved,
      hasAIAddon,
      canExport,
      canSubmit,
      canAutoDetect,
      refresh,
      validationStatus,
      isValid,
      blockReason,
      trialDaysRemaining,
      transactionCount,
      transactionLimit,
      canCreateTransaction,
    ]
  );

  return (
    <LicenseContext.Provider value={contextValue}>
      {children}
    </LicenseContext.Provider>
  );
}

/**
 * Custom hook to use license context
 * Throws if used outside of LicenseProvider
 */
export function useLicense(): LicenseContextValue {
  const context = useContext(LicenseContext);
  if (context === undefined) {
    throw new Error("useLicense must be used within a LicenseProvider");
  }
  return context;
}

/**
 * Custom hook to check if user can export (individual license)
 * Returns a simpler interface for components that only need export permission
 */
export function useCanExport(): { canExport: boolean; isLoading: boolean } {
  const { canExport, isLoading } = useLicense();
  return { canExport, isLoading };
}

/**
 * Custom hook to check if user can submit (team/enterprise license)
 * Returns a simpler interface for components that only need submit permission
 */
export function useCanSubmit(): { canSubmit: boolean; isLoading: boolean } {
  const { canSubmit, isLoading } = useLicense();
  return { canSubmit, isLoading };
}

/**
 * Custom hook to check if AI detection is available
 * Returns a simpler interface for components that only need AI feature status
 */
export function useCanAutoDetect(): {
  canAutoDetect: boolean;
  isLoading: boolean;
} {
  const { canAutoDetect, isLoading } = useLicense();
  return { canAutoDetect, isLoading };
}

export default LicenseContext;
