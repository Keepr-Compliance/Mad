/**
 * AccountVerificationStep - User Verification Checkpoint
 *
 * This step runs AFTER secure-storage and BEFORE email-connect.
 * It verifies that the user exists in the local SQLite database,
 * creating them if necessary via the existing initializeSecureStorage handler.
 *
 * Features:
 * - Event-driven: waits for 'complete' init stage event before verifying (BACKLOG-1383)
 * - Shows stage-appropriate messages while waiting for init
 * - Exponential backoff retry on failure (1s, 2s, 4s + jitter, max 3 retries)
 * - Shows error with "Try Again" + "Contact Support" after max retries
 * - Auto-advances on success
 * - Sentry breadcrumbs for full verification lifecycle
 *
 * Platform: macOS, Windows, Linux (all platforms)
 *
 * @module onboarding/steps/AccountVerificationStep
 */

import React, { useState, useEffect, useRef } from "react";
import type {
  OnboardingStep,
  OnboardingStepMeta,
  OnboardingStepContentProps,
} from "../types";
import type { UserVerifiedInLocalDbAction } from "../types/actions";
import * as Sentry from '@sentry/electron/renderer';
import logger from '../../../utils/logger';
import {
  classifyFailureReason,
  reportOnboardingFailure,
} from '../sentryOnboarding';

// =============================================================================
// CONSTANTS
// =============================================================================

const MAX_RETRIES = 3;
/** Base delay for exponential backoff (ms) */
const BACKOFF_BASE_MS = 1000;
/** Backoff multiplier */
const BACKOFF_FACTOR = 2;
/** Maximum random jitter added to backoff (ms) */
const MAX_JITTER_MS = 500;
/** Minimum time to show "Setting up..." so user sees the step */
const MIN_DISPLAY_MS = 1200;

// =============================================================================
// STEP METADATA
// =============================================================================

/**
 * Step metadata for the account verification step.
 * Shows after secure-storage (DB init done), before email-connect.
 */
export const meta: OnboardingStepMeta = {
  id: "account-verification",
  progressLabel: "Account Setup",
  platforms: ["macos", "windows", "linux"],
  navigation: {
    showBack: false,
    hideContinue: true, // Auto-advances, no button needed
  },
  // This step cannot be skipped
  skip: undefined,
  // Show only if DB is initialized but user not yet verified in local DB
  shouldShow: (context) => {
    const shouldShow = context.isDatabaseInitialized && !context.isUserVerifiedInLocalDb;
    logger.debug(
      `%c[STEP] account-verification: ${shouldShow ? 'SHOW' : 'HIDE'}`,
      `background: ${shouldShow ? '#DAA520' : '#228B22'}; color: white; font-weight: bold; padding: 2px 8px;`,
      { isDatabaseInitialized: context.isDatabaseInitialized, isUserVerifiedInLocalDb: context.isUserVerifiedInLocalDb }
    );
    return shouldShow;
  },
  // Queue predicates
  // Always visible in progress bar. Only becomes active after secure-storage
  // completes (isDatabaseInitialized = true), because it follows secure-storage
  // in the flow and secure-storage's isComplete gates progression.
  isApplicable: () => true,
  isComplete: (context) => context.isUserVerifiedInLocalDb,
};

// =============================================================================
// ICONS
// =============================================================================

/**
 * Spinner icon for loading state
 */
function SpinnerIcon(): React.ReactElement {
  return (
    <svg
      className="w-7 h-7 text-white animate-spin"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  );
}

/**
 * Checkmark icon for success state
 */
function CheckmarkIcon(): React.ReactElement {
  return (
    <svg
      className="w-7 h-7 text-white"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M5 13l4 4L19 7"
      />
    </svg>
  );
}

/**
 * Error icon for failure state
 */
function ErrorIcon(): React.ReactElement {
  return (
    <svg
      className="w-7 h-7 text-white"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
      />
    </svg>
  );
}

// =============================================================================
// CONTENT COMPONENT
// =============================================================================

type VerificationStatus = 'waiting-for-init' | 'verifying' | 'success' | 'error';

/** Stage-appropriate messages shown while waiting for init to complete */
const INIT_STAGE_MESSAGES: Record<string, string> = {
  'db-opening': 'Opening secure database...',
  'migrating': 'Updating database...',
  'creating-user': 'Setting up your account...',
  'db-ready': 'Database ready...',
  'idle': 'Preparing...',
};

/**
 * Calculate exponential backoff delay with jitter.
 * Delay = base * factor^attempt + random(0, maxJitter)
 */
function getBackoffDelay(attempt: number): number {
  const delay = BACKOFF_BASE_MS * Math.pow(BACKOFF_FACTOR, attempt);
  const jitter = Math.random() * MAX_JITTER_MS;
  return delay + jitter;
}

/**
 * Content component for the account verification step.
 * Event-driven: waits for 'complete' init stage before verifying user in local DB.
 * Uses exponential backoff retry on verification failure.
 */
export function AccountVerificationContent({
  context,
  onAction,
}: OnboardingStepContentProps): React.ReactElement {
  const [status, setStatus] = useState<VerificationStatus>('waiting-for-init');
  const [retryCount, setRetryCount] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [initStageMessage, setInitStageMessage] = useState<string>('Preparing...');

  // Track when step first rendered so we can enforce MIN_DISPLAY_MS
  const startTimeRef = useRef(Date.now());
  // Guard to ensure Sentry event fires only once per error occurrence
  const hasSentryReportedRef = useRef(false);

  // verify is called from the effect with a `cancelled` closure variable.
  // Each effect invocation gets its own `cancelled`, making this StrictMode-safe.
  const verifyRef = useRef<((attempt: number, isCancelled: () => boolean) => Promise<void>) | undefined>(undefined);
  verifyRef.current = async (attempt: number, isCancelled: () => boolean) => {
    if (isCancelled()) return;

    setStatus('verifying');
    setErrorMessage(null);

    const totalMs = Date.now() - startTimeRef.current;

    // Sentry breadcrumb: verification attempt started
    Sentry.addBreadcrumb({
      category: 'onboarding.verification',
      message: `Verification attempt ${attempt + 1}/${MAX_RETRIES + 1}`,
      level: 'info',
      data: {
        attempt: attempt + 1,
        init_stage: 'complete',
        networkOnline: navigator.onLine,
      },
    });

    // Tag scope with onboarding phase during verification
    Sentry.setTag('onboarding_phase', 'verification');

    try {
      // Use dedicated handler that ensures user exists in local DB
      const result = await window.api.system.verifyUserInLocalDb();

      if (isCancelled()) return;

      if (result.success) {
        const successTotalMs = Date.now() - startTimeRef.current;

        // Sentry breadcrumb: verification succeeded
        Sentry.addBreadcrumb({
          category: 'onboarding.verification',
          message: `Verification succeeded on attempt ${attempt + 1}`,
          level: 'info',
          data: {
            attempt: attempt + 1,
            total_ms: successTotalMs,
          },
        });

        setStatus('success');

        // Ensure the step is visible for at least MIN_DISPLAY_MS
        const elapsed = Date.now() - startTimeRef.current;
        const remaining = Math.max(0, MIN_DISPLAY_MS - elapsed);
        setTimeout(() => {
          if (isCancelled()) return;
          // Dispatch action to update context
          const action: UserVerifiedInLocalDbAction = {
            type: 'USER_VERIFIED_IN_LOCAL_DB',
          };
          onAction(action);
        }, remaining);
      } else if (result.transient || result.retryable) {
        // BACKLOG-2149: The DB is still starting up (memory-pressured cold start).
        // This is NOT a terminal setup failure — the main-process handler already
        // waited for db-ready and told us to retry. Show a calm "starting up"
        // state and keep polling WITHOUT counting toward MAX_RETRIES, so a slow
        // init never surfaces the "Setup failed" screen. The handler's own
        // timeout is the ultimate backstop against hanging forever.
        Sentry.addBreadcrumb({
          category: 'onboarding.verification',
          message: 'Verification returned transient (DB starting up), retrying',
          level: 'info',
          data: { attempt: attempt + 1, error: result.error || 'starting up' },
        });
        setStatus('waiting-for-init');
        setInitStageMessage('Starting up your secure database...');
        const delay = getBackoffDelay(Math.min(attempt, MAX_RETRIES));
        // Do NOT increment the attempt counter — transient waits are not failures.
        setTimeout(() => verifyRef.current?.(attempt, isCancelled), delay);
      } else {
        const failureMsg = result.error || 'Unknown failure';
        // Auto-retry with exponential backoff if under limit
        if (attempt < MAX_RETRIES) {
          // Sentry breadcrumb: verification failed, will retry
          Sentry.addBreadcrumb({
            category: 'onboarding.verification',
            message: `Verification failed on attempt ${attempt + 1}, will retry`,
            level: 'warning',
            data: {
              attempt: attempt + 1,
              error: failureMsg,
              will_retry: true,
            },
          });

          setRetryCount(attempt + 1);
          const delay = getBackoffDelay(attempt);
          setTimeout(() => verifyRef.current?.(attempt + 1, isCancelled), delay);
        } else {
          // Max retries reached - show error
          setStatus('error');
          setErrorMessage('Unable to set up your account. Please contact support.');
          // Report final failure to Sentry
          if (!hasSentryReportedRef.current) {
            hasSentryReportedRef.current = true;

            Sentry.captureMessage('Account verification failed after max retries', {
              level: 'error',
              tags: {
                component: 'onboarding',
                step: 'account_verification',
                onboarding_phase: 'verification',
              },
              extra: {
                attempts: MAX_RETRIES + 1,
                total_ms: totalMs,
                error_message: failureMsg,
                network_online: navigator.onLine,
              },
            });

            const reason = classifyFailureReason({
              dbInitialized: true,
              networkOnline: navigator.onLine,
              error: new Error(failureMsg),
            });
            reportOnboardingFailure({
              step: 'account_verification',
              reason,
              dbInitialized: true,
              networkOnline: navigator.onLine,
              hasSession: true,
              errorMessage: failureMsg,
            });
          }
        }
      }
    } catch (error) {
      if (isCancelled()) return;

      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error('[AccountVerificationStep] Verification failed:', error);

      // Auto-retry on exception with exponential backoff
      if (attempt < MAX_RETRIES) {
        // Sentry breadcrumb: exception, will retry
        Sentry.addBreadcrumb({
          category: 'onboarding.verification',
          message: `Verification exception on attempt ${attempt + 1}, will retry`,
          level: 'warning',
          data: {
            attempt: attempt + 1,
            error: errorMsg,
            will_retry: true,
          },
        });

        setRetryCount(attempt + 1);
        const delay = getBackoffDelay(attempt);
        setTimeout(() => verifyRef.current?.(attempt + 1, isCancelled), delay);
      } else {
        setStatus('error');
        setErrorMessage(
          error instanceof Error
            ? `Setup failed: ${error.message}`
            : 'Unable to set up your account. Please contact support.'
        );
        // Report final failure to Sentry
        if (!hasSentryReportedRef.current) {
          hasSentryReportedRef.current = true;

          Sentry.captureMessage('Account verification failed after max retries (exception)', {
            level: 'error',
            tags: {
              component: 'onboarding',
              step: 'account_verification',
              onboarding_phase: 'verification',
            },
            extra: {
              attempts: MAX_RETRIES + 1,
              total_ms: totalMs,
              error_message: errorMsg,
              network_online: navigator.onLine,
            },
          });

          const reason = classifyFailureReason({
            dbInitialized: true,
            networkOnline: navigator.onLine,
            error,
          });
          reportOnboardingFailure({
            step: 'account_verification',
            reason,
            dbInitialized: true,
            networkOnline: navigator.onLine,
            hasSession: true,
            errorMessage: errorMsg,
          });
        }
      }
    }
  };

  // Event-driven initialization (BACKLOG-1383, BACKLOG-1455 take 2):
  // Uses `cancelled` local variable pattern (per LoadingOrchestrator) instead of
  // hasStartedRef/mountedRef. Each effect invocation gets its own `cancelled`
  // closure, making this StrictMode-safe: cleanup from run #1 sets cancelled=true,
  // run #2 creates a fresh cancelled=false.
  useEffect(() => {
    let cancelled = false;
    let verificationStarted = false;
    let subscriptionCleanup: (() => void) | null = null;

    const startVerification = () => {
      if (verificationStarted || cancelled) return;
      verificationStarted = true;
      setStatus('verifying');
      verifyRef.current?.(0, () => cancelled);
    };

    const checkAndSubscribe = async () => {
      // BACKLOG-1455: If queue context already says DB is initialized, skip the
      // init-stage broadcaster check entirely. The queue only activates this step
      // after secure-storage completes (isDatabaseInitialized = true), so the DB
      // is guaranteed ready. Relying solely on the broadcaster caused a hang when
      // the broadcaster stage was stale (e.g., 'idle' after a fast init path).
      if (context.isDatabaseInitialized) {
        console.log('[AccountVerification] DB already initialized per context, skipping init-stage check');
        Sentry.addBreadcrumb({
          category: 'onboarding.init',
          message: 'DB already initialized per queue context — skipping init-stage check',
          level: 'info',
          data: { isDatabaseInitialized: true, waited_ms: 0 },
        });
        startVerification();
        return;
      }

      // 1. Check current init stage (fallback for edge cases where context lags)
      try {
        const currentStage = await window.api?.system?.getInitStage?.();
        if (cancelled) return;

        if (currentStage && currentStage.stage === 'complete') {
          // Already complete - proceed immediately
          console.log('[AccountVerification] Init stage already complete via IPC');
          Sentry.addBreadcrumb({
            category: 'onboarding.init',
            message: 'Init already complete on mount',
            level: 'info',
            data: { stage: currentStage.stage, waited_ms: 0 },
          });
          startVerification();
          return;
        }
      } catch {
        // getInitStage may not be available — fall through to subscription or direct verification
      }

      if (cancelled) return;

      // 2. If not complete, subscribe to events
      if (!window.api?.system?.onInitStage) {
        // Fallback: if onInitStage is unavailable, proceed directly
        // (backward compatibility with older preload bridges)
        logger.warn('[AccountVerificationStep] onInitStage not available, proceeding directly');
        startVerification();
        return;
      }

      setStatus('waiting-for-init');
      setInitStageMessage('Preparing...');

      // BACKLOG-1455: Safety timeout — if init-stage events never arrive (e.g., broadcaster
      // stuck at 'idle'), force-start verification after 5 seconds. The verify() function
      // handles DB-not-ready errors via its own retry logic.
      const safetyTimeout = setTimeout(() => {
        if (cancelled || verificationStarted) return;
        console.warn('[AccountVerification] Safety timeout — forcing verification start after 5s');
        Sentry.addBreadcrumb({
          category: 'onboarding.init',
          message: 'Safety timeout reached — forcing verification',
          level: 'warning',
          data: { waited_ms: Date.now() - startTimeRef.current },
        });
        // Clean up subscription before starting verification
        if (subscriptionCleanup) {
          subscriptionCleanup();
          subscriptionCleanup = null;
        }
        startVerification();
      }, 5000);

      const unsubscribe = window.api.system.onInitStage((event) => {
        if (cancelled) return;

        const waitedMs = Date.now() - startTimeRef.current;

        // Sentry breadcrumb: init stage received while waiting
        Sentry.addBreadcrumb({
          category: 'onboarding.init',
          message: `Init stage received while waiting: ${event.stage}`,
          level: 'info',
          data: { stage: event.stage, waited_ms: waitedMs },
        });

        // Update stage-appropriate message
        const message = INIT_STAGE_MESSAGES[event.stage] || event.message || 'Preparing...';
        setInitStageMessage(message);

        if (event.stage === 'complete') {
          // Init complete - clean up subscription and start verification
          clearTimeout(safetyTimeout);
          unsubscribe();
          subscriptionCleanup = null;
          startVerification();
        }
      });

      subscriptionCleanup = () => {
        clearTimeout(safetyTimeout);
        unsubscribe();
      };
    };

    checkAndSubscribe();

    return () => {
      cancelled = true;
      if (subscriptionCleanup) {
        subscriptionCleanup();
        subscriptionCleanup = null;
      }
    };
  }, [context.isDatabaseInitialized, onAction]);

  // BACKLOG-1455 Fix 3: Safety retry — if status stays 'verifying' for 10 seconds,
  // something went wrong (e.g., verify() resolved into a cancelled closure).
  // Re-trigger verification to recover.
  useEffect(() => {
    if (status !== 'verifying') return;

    const safety = setTimeout(() => {
      console.warn('[AccountVerification] Safety: still verifying after 10s, retrying');
      Sentry.addBreadcrumb({
        category: 'onboarding.verification',
        message: 'Safety retry: still verifying after 10s',
        level: 'warning',
        data: { total_ms: Date.now() - startTimeRef.current },
      });
      // Reset and re-trigger verification
      setRetryCount(0);
      hasSentryReportedRef.current = false;
      verifyRef.current?.(0, () => false);
    }, 10000);

    return () => clearTimeout(safety);
  }, [status]);

  const handleRetry = () => {
    // Reset retry count and start fresh verification
    setRetryCount(0);
    // Reset Sentry guard so a new failure sequence can report again
    hasSentryReportedRef.current = false;
    // Manual retry: use a non-cancelled checker since user explicitly clicked
    verifyRef.current?.(0, () => false);
  };

  const handleContactSupport = () => {
    // TASK-2319: Open in-app support widget instead of mailto
    window.dispatchEvent(
      new CustomEvent('open-support-widget', {
        detail: { subject: 'Account Setup Issue' },
      })
    );
  };

  // Determine icon and colors based on status
  const getIconAndColors = () => {
    switch (status) {
      case 'success':
        return {
          icon: <CheckmarkIcon />,
          gradient: 'from-green-500 to-emerald-600',
        };
      case 'error':
        return {
          icon: <ErrorIcon />,
          gradient: 'from-red-500 to-rose-600',
        };
      case 'waiting-for-init':
      case 'verifying':
      default:
        return {
          icon: <SpinnerIcon />,
          gradient: 'from-blue-500 to-purple-600',
        };
    }
  };

  const { icon, gradient } = getIconAndColors();

  return (
    <div className="text-center">
      {/* Icon with gradient background */}
      <div className={`inline-flex items-center justify-center w-14 h-14 bg-gradient-to-br ${gradient} rounded-full mb-4 shadow-lg`}>
        {icon}
      </div>

      {/* Title */}
      <h2 className="text-xl font-bold text-gray-900 mb-2">
        {status === 'waiting-for-init' && 'Initializing...'}
        {status === 'verifying' && 'Setting up your account...'}
        {status === 'success' && 'Account ready!'}
        {status === 'error' && 'Setup failed'}
      </h2>

      {/* Status message */}
      <p className="text-gray-600 text-sm mb-5">
        {status === 'waiting-for-init' && initStageMessage}
        {status === 'verifying' && (
          retryCount > 0
            ? `Retrying... (attempt ${retryCount + 1} of ${MAX_RETRIES + 1})`
            : 'Preparing your local database'
        )}
        {status === 'success' && 'Continuing to email setup...'}
        {status === 'error' && errorMessage}
      </p>

      {/* Error actions */}
      {status === 'error' && (
        <div className="space-y-3">
          <button
            onClick={handleRetry}
            className="w-full px-4 py-2.5 bg-gradient-to-r from-blue-500 to-purple-600 text-white rounded-lg font-semibold hover:from-blue-600 hover:to-purple-700 transition-colors min-h-[44px]"
          >
            Try Again
          </button>
          <button
            onClick={handleContactSupport}
            className="w-full px-4 py-2.5 border border-gray-300 text-gray-700 rounded-lg font-semibold hover:bg-gray-50 transition-colors min-h-[44px]"
          >
            Contact Support
          </button>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// STEP DEFINITION & REGISTRATION
// =============================================================================

/**
 * Complete step definition for the account verification step.
 */
const AccountVerificationStep: OnboardingStep = {
  meta,
  Content: AccountVerificationContent,
};

export default AccountVerificationStep;
