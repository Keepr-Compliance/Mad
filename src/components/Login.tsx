/**
 * Login Component
 * Handles user authentication via Google or Microsoft OAuth
 * Two-step flow: Login first, connect mailboxes later
 *
 * When database is not initialized (no keychain access yet), the login handlers
 * will emit a "pending" event instead of "complete". This allows the parent
 * to show the keychain explanation screen before completing the login.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import type { User, Subscription } from "../../electron/types/models";
import logger from '../utils/logger';
import { AppMark } from "./common/AppMark";

// TASK-2044: Login retry configuration
const LOGIN_RETRY_CONFIG = {
  maxRetries: 0,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
  /** Timeout for waiting for deep link callback (ms) */
  callbackTimeoutMs: 60000,
  /** Error codes from deep link that should NOT trigger retry */
  nonRetryableCodes: ["MISSING_TOKENS", "INVALID_TOKENS", "INVALID_URL"],
} as const;

// Type for pending OAuth data
export interface PendingOAuthData {
  provider: "google" | "microsoft";
  userInfo: { id: string; email: string; name?: string; picture?: string };
  tokens: {
    access_token: string;
    refresh_token: string | null;
    expires_at: string;
    scopes: string[];
  };
  cloudUser: {
    id: string;
    subscription_tier?: string;
    trial_ends_at?: string;
    email?: string;
    terms_accepted_at?: string;
    privacy_policy_accepted_at?: string;
  };
  subscription?: { tier?: string; status?: string; trial_ends_at?: string };
}

// TASK-1507: Deep link auth callback data types
export interface DeepLinkAuthData {
  accessToken: string;
  refreshToken: string;
  userId?: string;
  user?: {
    id: string;
    email?: string;
    name?: string;
  };
  provider?: string; // "google" | "azure" | etc from Supabase app_metadata
  licenseStatus?: {
    isValid: boolean;
    licenseType: "trial" | "individual" | "team";
    trialDaysRemaining?: number;
    transactionCount: number;
    transactionLimit: number;
    canCreateTransaction: boolean;
    deviceCount: number;
    deviceLimit: number;
    aiEnabled: boolean;
    blockReason?: string;
  };
  isNewUser?: boolean; // BACKLOG-546: Based on terms acceptance, not transaction count
}

interface LoginProps {
  onLoginSuccess: (
    user: User,
    sessionToken: string,
    provider: string,
    subscription: Subscription,
    isNewUser: boolean,
  ) => void;
  onLoginPending?: (oauthData: PendingOAuthData) => void;
  /** TASK-1507: Called when deep link auth succeeds with license/device validation */
  onDeepLinkAuthSuccess?: (data: DeepLinkAuthData) => void;
  /** TASK-1507: Called when license is blocked (expired/suspended) */
  onLicenseBlocked?: (data: { userId: string; blockReason: string }) => void;
  /** TASK-1507: Called when device limit is reached */
  onDeviceLimitReached?: (data: { userId: string; deviceCount: number; deviceLimit: number }) => void;
}

const Login = ({
  onLoginSuccess,
  onLoginPending,
  onDeepLinkAuthSuccess,
  onLicenseBlocked,
  onDeviceLimitReached,
}: LoginProps) => {
  const [loading, setLoading] = useState(false);
  const [provider, setProvider] = useState<"google" | "microsoft" | "browser" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // TASK-1507: Track when browser auth is in progress
  const [browserAuthInProgress, setBrowserAuthInProgress] = useState(false);

  // TASK-2044: Retry state for browser auth
  const [retryAttempt, setRetryAttempt] = useState(0);
  const [isRetrying, setIsRetrying] = useState(false);
  const [retriesExhausted, setRetriesExhausted] = useState(false);
  const callbackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ==========================================
  // TASK-2044: Retry timer cleanup
  // ==========================================

  /**
   * Clear all retry-related timers to prevent duplicate sessions
   */
  const clearRetryTimers = useCallback(() => {
    if (callbackTimeoutRef.current) {
      clearTimeout(callbackTimeoutRef.current);
      callbackTimeoutRef.current = null;
    }
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
  }, []);

  /**
   * Reset all retry state back to initial values
   */
  const resetRetryState = useCallback(() => {
    clearRetryTimers();
    setRetryAttempt(0);
    setIsRetrying(false);
    setRetriesExhausted(false);
  }, [clearRetryTimers]);

  // Clean up timers on unmount
  useEffect(() => {
    return () => {
      clearRetryTimers();
    };
  }, [clearRetryTimers]);

  // ==========================================
  // TASK-1507: Deep Link Event Handlers
  // ==========================================

  /**
   * Handle successful deep link auth callback
   * Called when browser OAuth completes and returns via keepr://callback
   */
  const handleDeepLinkSuccess = useCallback((data: DeepLinkAuthData) => {
    logger.debug("[Login] Deep link auth success:", data.userId);
    clearRetryTimers();
    setBrowserAuthInProgress(false);
    setLoading(false);
    setProvider(null);
    resetRetryState();

    if (onDeepLinkAuthSuccess) {
      onDeepLinkAuthSuccess(data);
    }
  }, [onDeepLinkAuthSuccess, clearRetryTimers, resetRetryState]);

  /**
   * Handle deep link auth error
   * TASK-2044: Enhanced with auto-retry for retryable errors
   * Called when browser OAuth fails or returns invalid tokens
   */
  const handleDeepLinkError = useCallback((data: { error: string; code: string }) => {
    logger.error(`[Login] Deep link auth error (attempt ${retryAttempt + 1}):`, data);
    clearRetryTimers();

    // Check if this is a non-retryable error
    const isNonRetryable = LOGIN_RETRY_CONFIG.nonRetryableCodes.includes(
      data.code as typeof LOGIN_RETRY_CONFIG.nonRetryableCodes[number]
    );

    if (isNonRetryable || retryAttempt >= LOGIN_RETRY_CONFIG.maxRetries) {
      // Non-retryable error or max retries reached: show error + "Try again" button
      logger.warn(
        `[Login] ${isNonRetryable ? "Non-retryable error" : "Max retries reached"} -- stopping auto-retry`
      );
      setBrowserAuthInProgress(false);
      setLoading(false);
      setIsRetrying(false);
      if (!isNonRetryable) {
        setRetriesExhausted(true);
      }
      // BACKLOG-2173b: with maxRetries: 0, retryAttempt is always 0 here, so
      // exactly one attempt was made -- "after multiple attempts" was
      // misleading (there was only ever one). Word it honestly based on
      // whether any retries actually ran.
      const hadRetries = retryAttempt > 0;
      setError(
        isNonRetryable
          ? data.error || "Browser authentication failed"
          : hadRetries
            ? "Login failed after multiple attempts. Please check your connection and try again."
            : "Sign-in is taking longer than expected. Please check your connection and try again."
      );
      return;
    }

    // Retryable error: auto-retry with exponential backoff
    const nextAttempt = retryAttempt + 1;
    const delay = Math.min(
      LOGIN_RETRY_CONFIG.baseDelayMs * Math.pow(2, retryAttempt),
      LOGIN_RETRY_CONFIG.maxDelayMs
    );

    logger.info(
      `[Login] Retrying browser auth (attempt ${nextAttempt + 1}/${LOGIN_RETRY_CONFIG.maxRetries + 1}) in ${delay}ms`
    );

    setRetryAttempt(nextAttempt);
    setIsRetrying(true);
    setError(null);

    // Schedule retry after backoff delay
    retryTimeoutRef.current = setTimeout(async () => {
      try {
        const result = await window.api.auth.openAuthInBrowser();
        if (!result.success) {
          // If opening browser itself fails, treat as exhausted
          setIsRetrying(false);
          setBrowserAuthInProgress(false);
          setLoading(false);
          setRetriesExhausted(true);
          setError(result.error || "Failed to open browser for authentication");
        } else {
          // Browser opened, start callback timeout for this retry attempt
          setIsRetrying(false);
          callbackTimeoutRef.current = setTimeout(() => {
            logger.warn(`[Login] Deep link callback timeout on retry attempt ${nextAttempt + 1}`);
            // Trigger the error handler again (which may retry or give up)
            handleDeepLinkError({ error: "Authentication timed out", code: "UNKNOWN_ERROR" });
          }, LOGIN_RETRY_CONFIG.callbackTimeoutMs);
        }
      } catch (err) {
        logger.error("[Login] Retry browser open failed:", err);
        setIsRetrying(false);
        setBrowserAuthInProgress(false);
        setLoading(false);
        setRetriesExhausted(true);
        setError("Failed to retry authentication");
      }
    }, delay);
  }, [retryAttempt, clearRetryTimers]);

  /**
   * Handle license blocked event
   * Called when user authenticates but license is expired/suspended
   */
  const handleLicenseBlocked = useCallback((data: {
    userId: string;
    blockReason: string;
    licenseStatus: unknown;
  }) => {
    logger.warn("[Login] License blocked:", data.blockReason);
    clearRetryTimers();
    resetRetryState();
    setBrowserAuthInProgress(false);
    setLoading(false);
    setProvider(null);

    if (onLicenseBlocked) {
      onLicenseBlocked({ userId: data.userId, blockReason: data.blockReason });
    } else {
      // Default handling if no callback provided
      setError(`Your license is ${data.blockReason}. Please contact support.`);
    }
  }, [onLicenseBlocked, clearRetryTimers, resetRetryState]);

  /**
   * Handle device limit reached event
   * Called when user authenticates but device registration fails
   */
  const handleDeviceLimit = useCallback((data: {
    userId: string;
    licenseStatus: {
      deviceCount: number;
      deviceLimit: number;
    };
  }) => {
    logger.warn("[Login] Device limit reached");
    clearRetryTimers();
    resetRetryState();
    setBrowserAuthInProgress(false);
    setLoading(false);
    setProvider(null);

    if (onDeviceLimitReached) {
      onDeviceLimitReached({
        userId: data.userId,
        deviceCount: data.licenseStatus.deviceCount,
        deviceLimit: data.licenseStatus.deviceLimit,
      });
    } else {
      // Default handling if no callback provided
      setError(`Device limit reached (${data.licenseStatus.deviceCount}/${data.licenseStatus.deviceLimit}). Please deactivate a device first.`);
    }
  }, [onDeviceLimitReached, clearRetryTimers, resetRetryState]);

  /**
   * Set up deep link event listeners
   * Per SR Engineer review: Add listeners directly to Login.tsx, not a separate hook
   */
  useEffect(() => {
    // Set up listeners for deep link events
    const cleanups: (() => void)[] = [];

    if (window.api.onDeepLinkAuthCallback) {
      cleanups.push(window.api.onDeepLinkAuthCallback(handleDeepLinkSuccess));
    }

    if (window.api.onDeepLinkAuthError) {
      cleanups.push(window.api.onDeepLinkAuthError(handleDeepLinkError));
    }

    if (window.api.onDeepLinkLicenseBlocked) {
      cleanups.push(window.api.onDeepLinkLicenseBlocked(handleLicenseBlocked));
    }

    if (window.api.onDeepLinkDeviceLimit) {
      cleanups.push(window.api.onDeepLinkDeviceLimit(handleDeviceLimit));
    }

    // Cleanup on unmount
    return () => {
      cleanups.forEach((cleanup) => cleanup());
    };
  }, [handleDeepLinkSuccess, handleDeepLinkError, handleLicenseBlocked, handleDeviceLimit]);

  /**
   * Handle Browser Sign In (Deep Link Flow)
   * TASK-1507: Opens Supabase auth in default browser, returns via deep link
   */
  const handleBrowserLogin = async () => {
    // TASK-2044: Clear any previous retry timers before starting fresh
    clearRetryTimers();

    setLoading(true);
    setError(null);
    setProvider("browser");
    setBrowserAuthInProgress(true);
    setRetriesExhausted(false);

    try {
      const result = await window.api.auth.openAuthInBrowser();

      if (!result.success) {
        setError(result.error || "Failed to open browser for authentication");
        setLoading(false);
        setProvider(null);
        setBrowserAuthInProgress(false);
      } else {
        // TASK-2044: Start callback timeout -- if deep link never fires, trigger retry
        callbackTimeoutRef.current = setTimeout(() => {
          logger.warn("[Login] Deep link callback timeout -- triggering retry logic");
          handleDeepLinkError({ error: "Authentication timed out", code: "UNKNOWN_ERROR" });
        }, LOGIN_RETRY_CONFIG.callbackTimeoutMs);
      }
    } catch (err) {
      logger.error("Browser login error:", err);
      const errorMessage =
        err instanceof Error ? err.message : "Failed to start browser login";
      setError(errorMessage);
      setLoading(false);
      setProvider(null);
      setBrowserAuthInProgress(false);
    }
  };

  /**
   * TASK-2044: Fresh retry -- resets all retry state and starts a brand new login attempt
   * This is called by the "Try again" button after all retries are exhausted.
   */
  const handleTryAgain = () => {
    clearRetryTimers();
    resetRetryState();
    setError(null);
    // Start a completely fresh login flow
    handleBrowserLogin();
  };

  /**
   * Cancel login flow
   * TASK-2044: Also clears retry state and timers
   */
  const handleCancel = () => {
    clearRetryTimers();
    resetRetryState();
    setLoading(false);
    setProvider(null);
    setError(null);
    setBrowserAuthInProgress(false);
  };

  return (
    <div
      className="min-h-screen flex items-center justify-center p-4"
      style={{
        background:
          'radial-gradient(120% 80% at 50% -10%, rgba(79,70,229,0.10), transparent 60%), #F1F2F8',
      }}
    >
      <div
        className="bg-white rounded-[20px] max-w-[400px] w-full px-9 pt-10 pb-8"
        style={{
          border: '1px solid #E7E8F0',
          boxShadow:
            '0 12px 34px -12px rgba(20,22,43,0.16), 0 1px 2px rgba(20,22,43,0.04)',
        }}
      >
        {/* Brand header (Option A: mark carries the brand; heading is a plain
            instruction — mark is decorative so the heading is the sole "Keepr"). */}
        <div className="flex flex-col items-center text-center mb-8">
          <AppMark
            size={60}
            className="drop-shadow-[0_8px_18px_rgba(79,70,229,0.30)]"
          />
          <h1
            className="mt-4 text-[21px] font-extrabold tracking-[-0.02em]"
            style={{ color: '#14162B' }}
          >
            Sign in to Keepr
          </h1>
          <p
            className="mt-2.5 text-[11px] font-bold uppercase tracking-[0.13em]"
            style={{ color: '#9297A6' }}
          >
            Desktop
          </p>
        </div>

        {/* Error Message -- TASK-2044: includes "Try again" button when retries exhausted */}
        {error && (
          <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg">
            <p className="text-sm text-red-800">{error}</p>
            {retriesExhausted && (
              <button
                onClick={handleTryAgain}
                className="mt-3 w-full px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
              >
                Try Again
              </button>
            )}
          </div>
        )}

        {/* Browser Authentication in Progress (TASK-1507, enhanced TASK-2044) */}
        {provider === "browser" && browserAuthInProgress && (
          <div className="mb-6">
            <div className="p-6 bg-gradient-to-br from-green-50 to-teal-50 border-2 border-green-200 rounded-lg text-center">
              <div className="flex flex-col items-center">
                <div className="w-12 h-12 border-4 border-green-600 border-t-transparent rounded-full animate-spin mb-4"></div>
                <p className="text-sm text-green-900 font-semibold mb-2">
                  {isRetrying
                    ? `Retrying (attempt ${retryAttempt + 1}/${LOGIN_RETRY_CONFIG.maxRetries + 1})...`
                    : retryAttempt > 0
                      ? `Authenticating in Browser (attempt ${retryAttempt + 1}/${LOGIN_RETRY_CONFIG.maxRetries + 1})...`
                      : "Authenticating in Browser..."}
                </p>
                <p className="text-xs text-green-700 mb-4">
                  {isRetrying
                    ? "Reconnecting... Please wait."
                    : "Complete sign-in in your default browser. The app will update automatically when finished."}
                </p>
                <button
                  onClick={handleCancel}
                  className="px-4 py-2 border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Initial Login Buttons */}
        {!((provider === "microsoft" || provider === "google" || provider === "browser") && loading) && (
            <div>
              {/* SPRINT-062: Browser Sign In (Deep Link Flow) - Primary login method */}
              <button
                onClick={handleBrowserLogin}
                disabled={loading}
                className="w-full flex items-center justify-center gap-3 bg-gradient-to-r from-green-500 to-teal-500 text-white py-3 px-4 rounded-lg hover:from-green-600 hover:to-teal-600 disabled:from-gray-300 disabled:to-gray-300 disabled:cursor-not-allowed transition-colors"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9"
                  />
                </svg>
                <span className="font-medium">Sign in with Browser</span>
              </button>
            </div>
          )}

        {/* Legal footer (BACKLOG-2126) — external links open in the default browser */}
        <p
          className="mt-6 text-center text-xs leading-relaxed"
          style={{ color: '#9297A6' }}
        >
          By continuing you agree to Keepr&apos;s{' '}
          <button
            type="button"
            onClick={() => window.api?.shell?.openExternal?.('https://keeprcompliance.com/terms')}
            className="border-b text-[#6C7180] hover:text-[#14162B]"
            style={{ borderColor: '#E7E8F0' }}
          >
            Terms
          </button>{' '}
          and{' '}
          <button
            type="button"
            onClick={() => window.api?.shell?.openExternal?.('https://keeprcompliance.com/privacy')}
            className="border-b text-[#6C7180] hover:text-[#14162B]"
            style={{ borderColor: '#E7E8F0' }}
          >
            Privacy Policy
          </button>
          .
        </p>
      </div>
    </div>
  );
};

export default Login;
