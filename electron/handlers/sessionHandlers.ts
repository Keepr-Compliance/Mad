/**
 * Session Handlers
 * Handles session management, validation, logout, terms acceptance, and email onboarding
 */

import { ipcMain, IpcMainInvokeEvent, shell } from "electron";
import * as Sentry from "@sentry/electron/main";
import type { User } from "../types/models";

// Import services
import databaseService from "../services/databaseService";
import supabaseService from "../services/supabaseService";
import sessionService from "../services/sessionService";
import sessionSecurityService from "../services/sessionSecurityService";
import auditService from "../services/auditService";
import logService from "../services/logService";
import { setSyncUserId } from "./syncHandlers";
import failureLogService from "../services/failureLogService";
import { getDeviceId, registerDevice } from "../services/deviceService";

// Import validation utilities
import {
  ValidationError,
  validateUserId,
  validateSessionToken,
  isSessionTokenCorruptionError,
  SESSION_TOKEN_MIN_LENGTH,
  SESSION_TOKEN_MAX_LENGTH,
} from "../utils/validation";
import { wrapHandler } from "../utils/wrapHandler";
import { redactEmail } from "../utils/redactSensitive";

// Import constants
import {
  CURRENT_TERMS_VERSION,
  CURRENT_PRIVACY_POLICY_VERSION,
} from "../constants/legalVersions";

/**
 * BACKLOG-1840: stop the additive-only shadow delta poller on every logout path so
 * it can't keep ticking (and polling with the now-stale user id) after sign-out.
 * The poller is only ever started while signed in (see maybeStartShadowDeltaSync);
 * stop() is a no-op when it was never started. Fire-and-forget + fail-closed via
 * dynamic import (mirrors the start wiring) — must NEVER throw into a logout path.
 */
export function stopShadowDeltaSyncOnLogout(): void {
  void import("../services/shadowDeltaSyncService")
    .then((m) => m.default.stop())
    .catch((err) => {
      logService.warn(
        "[SessionHandlers] Shadow delta sync stop failed (non-fatal)",
        "SessionHandlers",
        { error: err instanceof Error ? err.message : "Unknown" },
      );
    });
}

// Type definitions
interface AuthResponse {
  success: boolean;
  error?: string;
}

interface TermsAcceptanceResponse extends AuthResponse {
  user?: User;
}

interface SessionValidationResponse extends AuthResponse {
  valid: boolean;
  user?: User;
}

interface CurrentUserResponse extends AuthResponse {
  user?: User;
  sessionToken?: string;
  subscription?: import("../types/models").Subscription;
  provider?: string;
  isNewUser?: boolean;
}

/**
 * TASK-1809: Fetch cloud user with retry logic and exponential backoff
 * Used to reliably get terms data from Supabase
 * @param userId - Supabase user ID
 * @param maxRetries - Maximum number of retry attempts (default: 3)
 * @returns Cloud user data or null if all retries fail
 */
async function fetchCloudUserWithRetry(
  userId: string,
  maxRetries: number = 3
): Promise<User | null> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await logService.debug(
        `[TermsSync] Fetching cloud user (attempt ${attempt}/${maxRetries})`,
        "SessionHandlers",
        { userId: userId.substring(0, 8) + "..." }
      );

      const user = await supabaseService.getUserById(userId);
      return user;
    } catch (error) {
      lastError = error as Error;
      await logService.warn(
        `[TermsSync] Supabase fetch attempt ${attempt}/${maxRetries} failed`,
        "SessionHandlers",
        { error: lastError.message }
      );

      if (attempt < maxRetries) {
        // Exponential backoff: 500ms, 1000ms, 2000ms
        const delay = 500 * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  await logService.error(
    "[TermsSync] All Supabase fetch retries failed",
    "SessionHandlers",
    { error: lastError?.message || "Unknown error" }
  );
  return null; // Fall back to local data
}

/**
 * TASK-1809: Sync terms from cloud to local user if needed
 * This ensures users who accepted terms on cloud (before local DB init) get synced
 * @param localUser - The local user to potentially update
 * @param cloudUser - The cloud user with potential terms data
 * @returns Updated local user if sync was performed, original user otherwise
 */
async function syncTermsFromCloudToLocal(
  localUser: User,
  cloudUser: User | null
): Promise<User> {
  // Nothing to sync if no cloud user or cloud has no terms
  if (!cloudUser?.terms_accepted_at) {
    await logService.debug(
      "[TermsSync] No cloud terms to sync",
      "SessionHandlers",
      { cloudTerms: !!cloudUser?.terms_accepted_at }
    );
    return localUser;
  }

  // Already synced if local has terms
  if (localUser.terms_accepted_at) {
    await logService.debug(
      "[TermsSync] Local already has terms, no sync needed",
      "SessionHandlers"
    );
    return localUser;
  }

  // Sync terms from cloud to local
  await logService.info(
    "[TermsSync] Syncing terms from Supabase to local",
    "SessionHandlers",
    {
      userId: localUser.id.substring(0, 8) + "...",
      cloudTermsAt: cloudUser.terms_accepted_at,
    }
  );

  try {
    await databaseService.updateUser(localUser.id, {
      terms_accepted_at: cloudUser.terms_accepted_at,
      terms_version_accepted: cloudUser.terms_version_accepted,
      privacy_policy_accepted_at: cloudUser.privacy_policy_accepted_at,
      privacy_policy_version_accepted: cloudUser.privacy_policy_version_accepted,
    });

    // Re-fetch to get updated user
    const updatedUser = await databaseService.getUserById(localUser.id);
    if (updatedUser) {
      await logService.info(
        "[TermsSync] Successfully synced terms from cloud",
        "SessionHandlers",
        { userId: localUser.id.substring(0, 8) + "..." }
      );
      return updatedUser;
    }
  } catch (syncError) {
    await logService.error(
      "[TermsSync] Failed to sync terms to local",
      "SessionHandlers",
      { error: syncError instanceof Error ? syncError.message : "Unknown error" }
    );
    Sentry.captureException(syncError, {
      tags: { service: "session-handlers", operation: "syncTermsFromCloudToLocal" },
    });
  }

  return localUser;
}

/**
 * Check if user needs to accept or re-accept terms
 * TASK-1809: Now accepts optional cloud user to check cloud terms as fallback
 */
function needsToAcceptTerms(user: User, cloudUser?: User | null): boolean {
  // Check local user first
  const localTermsAccepted = user.terms_accepted_at;
  // Fall back to cloud terms if local is missing
  const termsAcceptedAt = localTermsAccepted || cloudUser?.terms_accepted_at;

  if (!termsAcceptedAt) {
    return true;
  }

  // Use local versions if available, otherwise check cloud
  const termsVersion = user.terms_version_accepted || cloudUser?.terms_version_accepted;
  const privacyVersion = user.privacy_policy_version_accepted || cloudUser?.privacy_policy_version_accepted;

  if (!termsVersion && !privacyVersion) {
    return false;
  }

  if (termsVersion && termsVersion !== CURRENT_TERMS_VERSION) {
    return true;
  }

  if (privacyVersion && privacyVersion !== CURRENT_PRIVACY_POLICY_VERSION) {
    return true;
  }

  return false;
}

/**
 * Handle logout
 */
async function handleLogout(
  _event: IpcMainInvokeEvent,
  sessionToken: string
): Promise<AuthResponse> {
  try {
    const validatedSessionToken = validateSessionToken(sessionToken);

    const session = await databaseService.validateSession(validatedSessionToken);
    // BACKLOG-2132: use user_id (the users_local FK), not id. After the JOIN
    // de-collision, session.id is the session UUID; the logout audit entry must
    // record the ACCOUNT id.
    const userId = session?.user_id || "unknown";

    await databaseService.deleteSession(validatedSessionToken);
    await sessionService.clearSession();
    sessionSecurityService.cleanupSession(validatedSessionToken);

    setSyncUserId(null);
    Sentry.setUser(null);
    stopShadowDeltaSyncOnLogout();

    await auditService.log({
      userId,
      sessionId: validatedSessionToken,
      action: "LOGOUT",
      resourceType: "SESSION",
      resourceId: validatedSessionToken,
      success: true,
    });

    await logService.info("User logged out successfully", "AuthHandlers", {
      userId,
    });

    return { success: true };
  } catch (error) {
    // TASK-2280: Recover from corrupted session tokens instead of showing error
    if (isSessionTokenCorruptionError(error)) {
      await logService.warn(
        "[Session] Corrupted session token detected during logout, clearing session",
        "SessionHandlers",
        { tokenLength: typeof sessionToken === "string" ? sessionToken.trim().length : 0 },
      );
      Sentry.captureMessage("Session token corruption detected", {
        level: "warning",
        tags: { component: "session", recovery: "auto_clear", operation: "handleLogout" },
        extra: {
          tokenLength: typeof sessionToken === "string" ? sessionToken.trim().length : 0,
          expectedMinLength: SESSION_TOKEN_MIN_LENGTH,
          expectedMaxLength: SESSION_TOKEN_MAX_LENGTH,
          platform: process.platform,
        },
      });
      await sessionService.clearSession();
      // Return success so the renderer redirects to login (session is now cleared)
      return { success: true };
    }

    await logService.error("Logout failed", "AuthHandlers", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
    Sentry.captureException(error, {
      tags: { service: "session-handlers", operation: "handleLogout" },
    });
    if (error instanceof ValidationError) {
      return {
        success: false,
        error: `Validation error: ${error.message}`,
      };
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Accept terms and privacy policy
 */
async function handleAcceptTerms(
  _event: IpcMainInvokeEvent,
  userId: string
): Promise<TermsAcceptanceResponse> {
  try {
    const validatedUserId = validateUserId(userId)!;

    const updatedUser = await databaseService.acceptTerms(
      validatedUserId,
      CURRENT_TERMS_VERSION,
      CURRENT_PRIVACY_POLICY_VERSION
    );

    await logService.info("Terms accepted", "AuthHandlers", {
      version: CURRENT_TERMS_VERSION,
    });

    try {
      await supabaseService.syncTermsAcceptance(
        userId,
        CURRENT_TERMS_VERSION,
        CURRENT_PRIVACY_POLICY_VERSION
      );
    } catch (syncError) {
      await logService.warn(
        "Failed to sync terms to Supabase",
        "AuthHandlers",
        {
          error:
            syncError instanceof Error ? syncError.message : "Unknown error",
        }
      );
      Sentry.captureException(syncError, {
        tags: { service: "session-handlers", operation: "handleAcceptTerms.syncToSupabase" },
      });
    }

    return { success: true, user: updatedUser };
  } catch (error) {
    await logService.error("Accept terms failed", "AuthHandlers", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
    Sentry.captureException(error, {
      tags: { service: "session-handlers", operation: "handleAcceptTerms" },
    });
    if (error instanceof ValidationError) {
      return {
        success: false,
        error: `Validation error: ${error.message}`,
      };
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Accept terms directly to Supabase (pre-DB onboarding flow)
 */
async function handleAcceptTermsToSupabase(
  _event: IpcMainInvokeEvent,
  userId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const validatedUserId = validateUserId(userId)!;

    await supabaseService.syncTermsAcceptance(
      validatedUserId,
      CURRENT_TERMS_VERSION,
      CURRENT_PRIVACY_POLICY_VERSION
    );

    await logService.info(
      "Terms accepted to Supabase (pre-DB flow)",
      "AuthHandlers",
      { version: CURRENT_TERMS_VERSION, userId: validatedUserId }
    );

    return { success: true };
  } catch (error: unknown) {
    // Handle both standard Error and PostgrestError from Supabase
    const errorObj = error as Record<string, unknown> | null;
    const errorMessage =
      (error instanceof Error ? error.message : undefined) ||
      (errorObj?.error_description as string) ||
      String(error) ||
      "Unknown error";
    const errorCode = (errorObj?.code as string) || (errorObj?.status as string) || "UNKNOWN";

    await logService.error(
      "Accept terms to Supabase failed",
      "AuthHandlers",
      {
        error: errorMessage,
        code: errorCode,
        details: errorObj?.details,
        hint: errorObj?.hint,
      }
    );
    Sentry.captureException(error, {
      tags: { service: "session-handlers", operation: "handleAcceptTermsToSupabase" },
    });
    if (error instanceof ValidationError) {
      return {
        success: false,
        error: `Validation error: ${error.message}`,
      };
    }
    return {
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Complete email onboarding
 */
async function handleCompleteEmailOnboarding(
  _event: IpcMainInvokeEvent,
  userId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const validatedUserId = validateUserId(userId)!;

    await databaseService.completeEmailOnboarding(validatedUserId);

    await logService.info("Email onboarding completed", "AuthHandlers", {
      userId: validatedUserId,
    });

    try {
      await supabaseService.completeEmailOnboarding(userId);
    } catch (syncError) {
      await logService.warn(
        "Failed to sync email onboarding to Supabase",
        "AuthHandlers",
        {
          error:
            syncError instanceof Error ? syncError.message : "Unknown error",
        }
      );
      Sentry.captureException(syncError, {
        tags: { service: "session-handlers", operation: "handleCompleteEmailOnboarding.syncToSupabase" },
      });
    }

    return { success: true };
  } catch (error) {
    await logService.error(
      "Complete email onboarding failed",
      "AuthHandlers",
      { error: error instanceof Error ? error.message : "Unknown error" }
    );
    Sentry.captureException(error, {
      tags: { service: "session-handlers", operation: "handleCompleteEmailOnboarding" },
    });
    if (error instanceof ValidationError) {
      return {
        success: false,
        error: `Validation error: ${error.message}`,
      };
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Check email onboarding status
 *
 * IMPORTANT: This checks for a valid mailbox token FIRST, regardless of the
 * email_onboarding_completed flag. This fixes a state mismatch bug (TASK-1039)
 * where users could have a valid token but the flag not set (race condition,
 * error, or interrupted flow), causing confusing UI states.
 *
 * If a token exists but the flag is false, we auto-correct the flag.
 */
async function handleCheckEmailOnboarding(
  _event: IpcMainInvokeEvent,
  userId: string
): Promise<{ success: boolean; completed: boolean; error?: string }> {
  try {
    const validatedUserId = validateUserId(userId)!;

    // Check for valid mailbox token FIRST, regardless of flag
    // This is the source of truth for whether email is actually connected
    const googleToken = await databaseService.getOAuthToken(
      validatedUserId,
      "google",
      "mailbox"
    );
    const microsoftToken = await databaseService.getOAuthToken(
      validatedUserId,
      "microsoft",
      "mailbox"
    );
    const hasValidMailboxToken = !!(googleToken || microsoftToken);

    // Check the flag for comparison/logging
    const onboardingCompleted =
      await databaseService.hasCompletedEmailOnboarding(validatedUserId);

    // Auto-correct inconsistent state: token exists but flag is false
    if (hasValidMailboxToken && !onboardingCompleted) {
      await logService.info(
        "Auto-correcting inconsistent email onboarding state: token exists but flag was false",
        "AuthHandlers",
        { userId: validatedUserId.substring(0, 8) + "..." }
      );
      await databaseService.completeEmailOnboarding(validatedUserId);
    }

    // Also handle the reverse: flag is true but no token
    if (onboardingCompleted && !hasValidMailboxToken) {
      await logService.info(
        "Email onboarding flag is true but no valid mailbox token found",
        "AuthHandlers",
        { userId: validatedUserId.substring(0, 8) + "..." }
      );
    }

    // The completed status is based on having a valid token
    // (token is the source of truth, not the flag)
    const completed = hasValidMailboxToken;

    await logService.info("Email onboarding check", "AuthHandlers", {
      userId: validatedUserId.substring(0, 8) + "...",
      completed,
      onboardingCompleted,
      hasValidMailboxToken,
    });

    return { success: true, completed };
  } catch (error) {
    await logService.error(
      "Check email onboarding status failed",
      "AuthHandlers",
      { error: error instanceof Error ? error.message : "Unknown error" }
    );
    Sentry.captureException(error, {
      tags: { service: "session-handlers", operation: "handleCheckEmailOnboarding" },
    });
    if (error instanceof ValidationError) {
      return {
        success: false,
        completed: false,
        error: `Validation error: ${error.message}`,
      };
    }
    return {
      success: false,
      completed: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Validate session
 */
async function handleValidateSession(
  _event: IpcMainInvokeEvent,
  sessionToken: string
): Promise<SessionValidationResponse> {
  try {
    const validatedSessionToken = validateSessionToken(sessionToken);

    const session = await databaseService.validateSession(validatedSessionToken);

    if (!session) {
      return { success: false, valid: false };
    }

    const securityCheck = await sessionSecurityService.checkSessionValidity(
      { created_at: session.created_at, last_accessed_at: session.last_accessed_at },
      validatedSessionToken
    );

    if (!securityCheck.valid) {
      await databaseService.deleteSession(validatedSessionToken);
      sessionSecurityService.cleanupSession(validatedSessionToken);
      return {
        success: false,
        valid: false,
        error: `Session ${securityCheck.reason}`,
      };
    }

    sessionSecurityService.recordActivity(validatedSessionToken);

    return { success: true, valid: true, user: session };
  } catch (error) {
    // TASK-2280: Recover from corrupted session tokens instead of showing error
    if (isSessionTokenCorruptionError(error)) {
      await logService.warn(
        "[Session] Corrupted session token detected during validation, clearing session",
        "SessionHandlers",
        { tokenLength: typeof sessionToken === "string" ? sessionToken.trim().length : 0 },
      );
      Sentry.captureMessage("Session token corruption detected", {
        level: "warning",
        tags: { component: "session", recovery: "auto_clear", operation: "handleValidateSession" },
        extra: {
          tokenLength: typeof sessionToken === "string" ? sessionToken.trim().length : 0,
          expectedMinLength: SESSION_TOKEN_MIN_LENGTH,
          expectedMaxLength: SESSION_TOKEN_MAX_LENGTH,
          platform: process.platform,
        },
      });
      await sessionService.clearSession();
      // Return valid=false without an error message so the renderer
      // treats this as "no session" and redirects to login
      return { success: false, valid: false };
    }

    await logService.error("Session validation failed", "AuthHandlers", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
    Sentry.captureException(error, {
      tags: { service: "session-handlers", operation: "handleValidateSession" },
    });
    if (error instanceof ValidationError) {
      return {
        success: false,
        valid: false,
        error: `Validation error: ${error.message}`,
      };
    }
    return {
      success: false,
      valid: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * TASK-1507G: Migrate user from old random ID to Supabase Auth ID
 * Updates all FK references in child tables
 * @param oldUser - The user with the incorrect local ID
 * @param newSupabaseId - The correct Supabase Auth UUID
 * @returns The migrated user with the new ID
 */
async function migrateUserToSupabaseId(
  oldUser: User,
  newSupabaseId: string
): Promise<User> {
  // Check if user with Supabase ID already exists (edge case: concurrent migration)
  const existingUser = await databaseService.getUserById(newSupabaseId);
  if (existingUser) {
    // User already migrated or created correctly - just return existing
    await logService.info(
      "TASK-1507G: User with Supabase ID already exists, skipping migration",
      "SessionHandlers",
      { supabaseId: newSupabaseId.substring(0, 8) + "..." }
    );
    return existingUser;
  }

  const db = databaseService.getRawDatabase();

  // Transaction to ensure atomicity
  const migrate = db.transaction(() => {
    // 1. Create new user with Supabase ID (copy all data)
    db.prepare(`
      INSERT INTO users_local (
        id, email, first_name, last_name, display_name, avatar_url,
        oauth_provider, oauth_id, subscription_tier, subscription_status,
        trial_ends_at, terms_accepted_at, terms_version_accepted,
        privacy_policy_accepted_at, privacy_policy_version_accepted,
        email_onboarding_completed_at, mobile_phone_type, timezone, theme,
        license_type, ai_detection_enabled, organization_id,
        created_at, updated_at
      )
      SELECT
        ?, email, first_name, last_name, display_name, avatar_url,
        oauth_provider, oauth_id, subscription_tier, subscription_status,
        trial_ends_at, terms_accepted_at, terms_version_accepted,
        privacy_policy_accepted_at, privacy_policy_version_accepted,
        email_onboarding_completed_at, mobile_phone_type, timezone, theme,
        license_type, ai_detection_enabled, organization_id,
        created_at, CURRENT_TIMESTAMP
      FROM users_local WHERE id = ?
    `).run(newSupabaseId, oldUser.id);

    // 2. Update FK references in all child tables (SR Engineer verified complete list)
    const tables = [
      'sessions',
      'oauth_tokens',
      'contacts',
      'transactions',
      'communications',
      'emails',
      'messages',
      'llm_settings',
      'audit_logs',
      'classification_feedback',
      'audit_packages',
      'ignored_communications',
    ];

    for (const table of tables) {
      try {
        db.prepare(`UPDATE ${table} SET user_id = ? WHERE user_id = ?`)
          .run(newSupabaseId, oldUser.id);
      } catch {
        // Table may not exist or have user_id column - ignore
      }
    }

    // 3. Delete old user record
    db.prepare('DELETE FROM users_local WHERE id = ?').run(oldUser.id);
  });

  migrate();

  // Return the migrated user
  const migratedUser = await databaseService.getUserById(newSupabaseId);
  if (!migratedUser) {
    throw new Error('User migration failed - could not find migrated user');
  }

  await logService.info(
    "TASK-1507G: User migration complete",
    "SessionHandlers",
    { newId: newSupabaseId.substring(0, 8) + "..." }
  );

  return migratedUser;
}

/**
 * Get current user from saved session
 */
async function handleGetCurrentUser(): Promise<CurrentUserResponse> {
  try {
    // Check if database is initialized first
    // If not, fall back to Supabase session for basic user info
    if (!databaseService.isInitialized()) {
      const client = supabaseService.getClient();
      const { data: { session: supaSession } } = await client.auth.getSession();
      if (supaSession?.user) {
        const meta = supaSession.user.user_metadata || {};
        return {
          success: true,
          user: {
            id: supaSession.user.id,
            email: supaSession.user.email || meta.email || "",
            display_name: meta.full_name || meta.name || supaSession.user.email || "",
          } as never,
        };
      }
      return { success: false, error: "Database not initialized" };
    }

    const session = await sessionService.loadSession();

    if (!session) {
      return { success: false, error: "No active session" };
    }

    const dbSession = await databaseService.validateSession(session.sessionToken);

    if (!dbSession) {
      await sessionService.clearSession();
      sessionSecurityService.cleanupSession(session.sessionToken);
      return { success: false, error: "Session expired or invalid" };
    }

    const securityCheck = await sessionSecurityService.checkSessionValidity(
      { created_at: dbSession.created_at, last_accessed_at: dbSession.last_accessed_at },
      session.sessionToken
    );

    if (!securityCheck.valid) {
      await databaseService.deleteSession(session.sessionToken);
      await sessionService.clearSession();
      sessionSecurityService.cleanupSession(session.sessionToken);
      return { success: false, error: `Session ${securityCheck.reason}` };
    }

    sessionSecurityService.recordActivity(session.sessionToken);

    // DORIAN'S T&C FIX: Restore Supabase SDK session for returning users
    // The Supabase SDK uses persistSession: false, so on app restart the SDK has no session.
    // This causes RLS policy failures (auth.uid() = null) when accepting T&C.
    // We manually restore the session from stored tokens.
    if (session.supabaseTokens) {
      try {
        const { error: setSessionError } = await supabaseService.getClient().auth.setSession({
          access_token: session.supabaseTokens.access_token,
          refresh_token: session.supabaseTokens.refresh_token,
        });

        if (setSessionError) {
          await logService.warn(
            "Supabase session restoration failed",
            "SessionHandlers",
            { error: setSessionError.message }
          );

          // Clear stale tokens from session file
          await sessionService.updateSession({ supabaseTokens: undefined });

          // If tokens are expired/invalid, force re-authentication
          // Otherwise user proceeds with broken Supabase session → T&C fails
          if (
            setSessionError.message.includes("expired") ||
            setSessionError.message.includes("invalid") ||
            setSessionError.message.includes("refresh")
          ) {
            await databaseService.deleteSession(session.sessionToken);
            await sessionService.clearSession();
            sessionSecurityService.cleanupSession(session.sessionToken);
            return { success: false, error: "Session expired, please sign in again" };
          }
        } else {
          await logService.info(
            "Supabase session restored for returning user",
            "SessionHandlers"
          );
        }
      } catch (restoreError) {
        await logService.warn(
          "Supabase session restoration error",
          "SessionHandlers",
          { error: restoreError instanceof Error ? restoreError.message : "Unknown" }
        );
        Sentry.captureException(restoreError, {
          tags: { service: "session-handlers", operation: "handleGetCurrentUser.restoreSupabaseSession" },
        });
      }
    }

    // TASK-2085: Server-side token validation for returning users
    // Prevents showing authenticated UI when session was revoked remotely
    // This closes the gap where setSession() succeeds (tokens parse OK)
    // but the server has actually revoked the user/token
    if (session.supabaseTokens) {
      try {
        const { data: userData, error: getUserError } = await supabaseService
          .getClient()
          .auth.getUser();

        if (getUserError || !userData.user) {
          // Session is invalid on the server (user deleted, token revoked)
          await logService.info(
            "Supabase session invalid on server, forcing re-login",
            "SessionHandlers",
            { error: getUserError?.message }
          );

          // Clean up the invalid session
          await databaseService.deleteSession(session.sessionToken);
          await sessionService.clearSession();
          sessionSecurityService.cleanupSession(session.sessionToken);

          return { success: false, error: "Session no longer valid" };
        }

        await logService.info(
          "Supabase session validated server-side",
          "SessionHandlers"
        );
      } catch (validationError) {
        // Network error during validation -- proceed optimistically
        // The user may be offline, and we don't want to block them
        await logService.warn(
          "Server-side session validation failed (network?), proceeding optimistically",
          "SessionHandlers",
          { error: validationError instanceof Error ? validationError.message : "Unknown" }
        );
      }
    }

    // TASK-1507E: Ensure local SQLite user exists for existing sessions
    // Users who authenticated before TASK-1507D have valid sessions but no local user,
    // which causes FK constraint failures on mailbox connection, messages import, etc.
    let freshUser = await databaseService.getUserById(session.user.id);

    if (!freshUser && session.user.email) {
      // Try to find user by email (handles case where session.user.id is Supabase UUID)
      freshUser = await databaseService.getUserByEmail(session.user.email);
    }

    if (!freshUser && session.user.oauth_id && session.provider) {
      // Try to find user by OAuth ID
      freshUser = await databaseService.getUserByOAuthId(
        session.provider,
        session.user.oauth_id
      );
    }

    // TASK-1507G: Check for ID mismatch - user exists but with wrong ID
    // Get the authoritative Supabase UUID (session.user.id should be it, but verify via auth service)
    const supabaseUserId = supabaseService.getAuthUserId() || session.user.id;

    if (freshUser && freshUser.id !== supabaseUserId) {
      await logService.info(
        "TASK-1507G: ID mismatch detected, migrating user",
        "SessionHandlers",
        {
          localId: freshUser.id.substring(0, 8) + "...",
          supabaseId: supabaseUserId.substring(0, 8) + "...",
        }
      );

      // Migrate user to Supabase ID
      freshUser = await migrateUserToSupabaseId(freshUser, supabaseUserId);
    }

    // TASK-1809: Always fetch cloud user with retry to reliably check terms state
    // This is critical for users who accepted terms before local DB was initialized
    await logService.debug(
      "[TermsSync] Fetching cloud user for terms check",
      "SessionHandlers",
      { userId: supabaseUserId.substring(0, 8) + "..." }
    );
    const cloudUser = await fetchCloudUserWithRetry(supabaseUserId);

    await logService.debug(
      "[TermsSync] Cloud user fetch result",
      "SessionHandlers",
      {
        cloudUserFound: !!cloudUser,
        cloudTermsAt: cloudUser?.terms_accepted_at || null,
      }
    );

    if (!freshUser && session.user.email) {
      // No local user exists - create one from session data
      // This syncs existing Supabase users to local SQLite (retroactive TASK-1507D fix)
      await logService.info(
        "Creating local user from existing session (TASK-1507E)",
        "SessionHandlers",
        { email: session.user.email }
      );

      try {
        // TASK-1507G: Pass Supabase Auth UUID as the user ID
        // This ensures local SQLite user ID matches Supabase for FK integrity
        freshUser = await databaseService.createUser({
          id: supabaseUserId,  // Use Supabase's authoritative UUID
          email: session.user.email,
          first_name: session.user.first_name,
          last_name: session.user.last_name,
          display_name:
            session.user.display_name ||
            session.user.email.split("@")[0],
          avatar_url: session.user.avatar_url,
          oauth_provider: session.provider || "google",
          oauth_id: session.user.oauth_id || session.user.id,
          subscription_tier: session.user.subscription_tier || "free",
          subscription_status: session.user.subscription_status || "trial",
          trial_ends_at: session.user.trial_ends_at,
          is_active: true,
        });

        await logService.info(
          "Local user created successfully from existing session",
          "SessionHandlers",
          { userId: freshUser.id }
        );

        // TASK-1809: Sync terms from cloud user (already fetched with retry)
        freshUser = await syncTermsFromCloudToLocal(freshUser, cloudUser);
      } catch (createError) {
        // Log but don't fail - auth should succeed even if local user creation fails
        await logService.error(
          "Failed to create local user from session",
          "SessionHandlers",
          {
            error: createError instanceof Error ? createError.message : "Unknown error",
          }
        );
        Sentry.captureException(createError, {
          tags: { service: "session-handlers", operation: "handleGetCurrentUser.createLocalUser" },
        });
      }
    } else if (freshUser && !freshUser.terms_accepted_at && cloudUser?.terms_accepted_at) {
      // TASK-1809: Existing local user missing terms, but cloud has them
      // This happens when user accepted terms to Supabase before local DB was initialized
      await logService.info(
        "[TermsSync] Existing user missing local terms, syncing from cloud",
        "SessionHandlers",
        {
          userId: freshUser.id.substring(0, 8) + "...",
          localTerms: !!freshUser.terms_accepted_at,
          cloudTerms: !!cloudUser.terms_accepted_at,
        }
      );
      freshUser = await syncTermsFromCloudToLocal(freshUser, cloudUser);
    }

    const user = freshUser || session.user;

    setSyncUserId(user.id);
    Sentry.setUser({ id: user.id, email: session.user.email ? redactEmail(session.user.email) : undefined });

    // BACKLOG-1831: start the additive-only SHADOW-mode delta poller on a
    // RESTORED-session boot too (returning user — the deep-link OAuth callback in
    // main.ts never runs on this path). This is the earliest reliable point that
    // holds the LOCAL user id on a session restore (same id used for sync
    // persistence just above). Fire-and-forget + fail-closed; the helper itself
    // gates on the flag + a Microsoft mailbox and start() is idempotent, so this
    // co-existing with the OAuth-callback call is harmless.
    void import("../services/shadowDeltaSyncService")
      .then(({ maybeStartShadowDeltaSync }) => maybeStartShadowDeltaSync(user.id))
      .catch((err) => {
        logService.warn(
          "[SessionHandlers] Shadow delta sync start failed (non-fatal)",
          "SessionHandlers",
          { error: err instanceof Error ? err.message : "Unknown" },
        );
      });

    // TASK-1809: Pass cloud user to needsToAcceptTerms for fallback check
    // Even if local sync failed, we can still check cloud terms state
    const requiresTerms = needsToAcceptTerms(user, cloudUser);

    await logService.debug(
      "[TermsSync] Final terms check result",
      "SessionHandlers",
      {
        localTermsAt: user.terms_accepted_at || null,
        cloudTermsAt: cloudUser?.terms_accepted_at || null,
        requiresTerms,
      }
    );

    // Update device record (app_version, last_seen_at) on every session restore
    // Fire-and-forget so it doesn't block app startup
    registerDevice(user.id).catch((err) => {
      logService.warn("Device registration on session restore failed", "SessionHandlers", {
        error: err instanceof Error ? err.message : "Unknown",
      });
    });

    return {
      success: true,
      user,
      sessionToken: session.sessionToken,
      subscription: session.subscription,
      provider: session.provider,
      isNewUser: requiresTerms,
    };
  } catch (error) {
    await logService.error("Get current user failed, trying Supabase session fallback", "AuthHandlers", {
      error: error instanceof Error ? error.message : "Unknown error",
    });

    // Fallback: try to get basic user info from Supabase auth session
    // This works even when the local DB isn't initialized (e.g., during onboarding)
    try {
      const client = supabaseService.getClient();
      const { data: { session: supaSession } } = await client.auth.getSession();
      if (supaSession?.user) {
        const meta = supaSession.user.user_metadata || {};
        return {
          success: true,
          user: {
            id: supaSession.user.id,
            email: supaSession.user.email || meta.email || "",
            display_name: meta.full_name || meta.name || supaSession.user.email || "",
          } as never, // Partial user — only id/email/display_name available before DB init
        };
      }
    } catch {
      // Supabase session also unavailable
    }

    Sentry.captureException(error, {
      tags: { service: "session-handlers", operation: "handleGetCurrentUser" },
    });
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Force logout - clears all sessions without requiring a session token
 * Used when the user is stuck (e.g., license blocked during login, can't switch accounts)
 *
 * Security note: This only clears LOCAL sessions on this device.
 * It cannot be used to log out other users or affect other devices.
 */
async function handleForceLogout(): Promise<AuthResponse> {
  try {
    await logService.info("Force logout initiated", "AuthHandlers");

    // 1. Clear Supabase session
    try {
      await supabaseService.signOut();
    } catch (supabaseError) {
      await logService.warn("Supabase signOut failed during force logout", "AuthHandlers", {
        error: supabaseError instanceof Error ? supabaseError.message : "Unknown error",
      });
      Sentry.captureException(supabaseError, {
        tags: { service: "session-handlers", operation: "handleForceLogout.supabaseSignOut" },
      });
      // Continue - local cleanup is still important
    }

    // 2. Clear local session file
    try {
      await sessionService.clearSession();
    } catch (sessionError) {
      await logService.warn("Session file clear failed during force logout", "AuthHandlers", {
        error: sessionError instanceof Error ? sessionError.message : "Unknown error",
      });
      Sentry.captureException(sessionError, {
        tags: { service: "session-handlers", operation: "handleForceLogout.clearSessionFile" },
      });
    }

    // 3. Clear database sessions (if database is initialized)
    try {
      if (databaseService.isInitialized()) {
        await databaseService.clearAllSessions();
      }
    } catch (dbError) {
      await logService.warn("Database session clear failed during force logout", "AuthHandlers", {
        error: dbError instanceof Error ? dbError.message : "Unknown error",
      });
      Sentry.captureException(dbError, {
        tags: { service: "session-handlers", operation: "handleForceLogout.clearDbSessions" },
      });
    }

    // 4. Clear sync user ID
    setSyncUserId(null);
    Sentry.setUser(null);
    stopShadowDeltaSyncOnLogout();

    await logService.info("Force logout completed successfully", "AuthHandlers");
    return { success: true };
  } catch (error) {
    await logService.error("Force logout failed", "AuthHandlers", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
    Sentry.captureException(error, {
      tags: { service: "session-handlers", operation: "handleForceLogout" },
    });
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * TASK-2045: Sign out of all devices (global session invalidation)
 * Calls Supabase global sign-out, logs audit entry, then cleans up local session.
 * Global sign-out is called BEFORE local cleanup because it needs the active token.
 */
async function handleSignOutAllDevices(): Promise<AuthResponse> {
  try {
    // 1. Call global sign-out while we still have an active token
    const result = await supabaseService.signOutGlobal();

    if (!result.success) {
      await logService.error(
        "Global sign-out failed",
        "SessionHandlers",
        { error: result.error }
      );
      return { success: false, error: result.error || "Failed to sign out of all devices" };
    }

    // 2. Log audit entry for global sign-out
    const userId = supabaseService.getAuthUserId() || "unknown";
    try {
      await auditService.log({
        userId,
        action: "LOGOUT",
        resourceType: "SESSION",
        success: true,
        metadata: { scope: "global", reason: "user_requested" },
      });
    } catch (auditError) {
      // Non-blocking: don't fail the sign-out if audit logging fails
      await logService.warn(
        "Audit log failed during global sign-out",
        "SessionHandlers",
        { error: auditError instanceof Error ? auditError.message : "Unknown error" }
      );
    }

    // 3. Clean up local session (same as force logout flow)
    try {
      await sessionService.clearSession();
    } catch (sessionError) {
      await logService.warn(
        "Session file clear failed during global sign-out",
        "SessionHandlers",
        { error: sessionError instanceof Error ? sessionError.message : "Unknown error" }
      );
    }

    try {
      if (databaseService.isInitialized()) {
        await databaseService.clearAllSessions();
      }
    } catch (dbError) {
      await logService.warn(
        "Database session clear failed during global sign-out",
        "SessionHandlers",
        { error: dbError instanceof Error ? dbError.message : "Unknown error" }
      );
    }

    setSyncUserId(null);
    stopShadowDeltaSyncOnLogout();

    await logService.info("Global sign-out completed successfully", "SessionHandlers");
    return { success: true };
  } catch (error) {
    await logService.error("Global sign-out failed", "SessionHandlers", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
    Sentry.captureException(error, {
      tags: { service: "session-handlers", operation: "handleSignOutAllDevices" },
    });
    // TASK-2058: Log failure for offline diagnostics
    failureLogService.logFailure(
      "sign_out_all_devices",
      error instanceof Error ? error.message : "Failed to sign out of all devices"
    );
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to sign out of all devices",
    };
  }
}

/**
 * Open broker portal auth page in the default browser
 * TASK-1507: Used for deep-link authentication flow
 * TASK-1510: Redirects to broker portal for provider selection (Google/Microsoft)
 */
async function handleOpenAuthInBrowser(): Promise<{ success: boolean; error?: string }> {
  try {
    // Use broker portal for provider selection page
    // Production: app.keeprcompliance.com, Dev: localhost:3001 (via .env.development)
    const brokerPortalUrl = process.env.BROKER_PORTAL_URL || 'https://app.keeprcompliance.com';
    const authUrl = `${brokerPortalUrl}/auth/desktop`;

    await logService.info("Opening auth URL in browser", "AuthHandlers", {
      url: authUrl,
    });

    await shell.openExternal(authUrl);
    return { success: true };
  } catch (error) {
    await logService.error("Failed to open auth in browser", "AuthHandlers", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
    Sentry.captureException(error, {
      tags: { service: "session-handlers", operation: "handleOpenAuthInBrowser" },
    });
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * TASK-2062: Validate remote session by checking Supabase auth.
 * Used by the renderer to poll whether the session is still valid
 * (detects remote invalidation from "Sign Out All Devices").
 * Returns { valid: true } on network errors to avoid false logouts.
 */
async function handleValidateRemoteSession(): Promise<{ valid: boolean }> {
  try {
    const client = supabaseService.getClient();
    const { data, error } = await client.auth.getUser();
    if (error || !data.user) {
      // Server-side errors (5xx) are not auth failures — assume valid
      // This prevents logout when Supabase has transient issues (e.g., "site url is improperly formatted")
      const statusCode = (error as unknown as { status?: number })?.status;
      const errorMsg = error?.message || "";
      if (statusCode && statusCode >= 500) {
        await logService.warn(
          "[SessionValidator] Supabase server error during validation, assuming valid",
          "SessionHandlers",
          { error: errorMsg, status: statusCode }
        );
        Sentry.captureMessage("Session validation: Supabase server error (assumed valid)", {
          level: "warning",
          tags: { service: "session-validator", supabase_status: String(statusCode) },
          extra: { error: errorMsg, status: statusCode },
        });
        return { valid: true };
      }
      if (errorMsg.includes("unexpected_failure") || errorMsg.includes("site url")) {
        await logService.warn(
          "[SessionValidator] Supabase config error during validation, assuming valid",
          "SessionHandlers",
          { error: errorMsg }
        );
        Sentry.captureMessage("Session validation: Supabase config error (assumed valid)", {
          level: "warning",
          tags: { service: "session-validator", error_type: "config" },
          extra: { error: errorMsg },
        });
        return { valid: true };
      }
      await logService.info(
        "[SessionValidator] Remote session invalid",
        "SessionHandlers",
        { error: errorMsg }
      );
      return { valid: false };
    }
    return { valid: true };
  } catch (error) {
    // Network error -- assume valid (don't logout on network issues)
    await logService.debug(
      "[SessionValidator] Network error during remote validation, assuming valid",
      "SessionHandlers",
      { error: error instanceof Error ? error.message : "Unknown error" }
    );
    return { valid: true };
  }
}

/**
 * TASK-2062: Get active devices for the current user.
 * Returns list of devices with isCurrentDevice flag.
 */
async function handleGetActiveDevices(
  _event: IpcMainInvokeEvent,
  userId: string
): Promise<{
  success: boolean;
  devices?: Array<{
    device_id: string;
    device_name: string;
    os: string;
    platform: string;
    last_seen_at: string;
    isCurrentDevice: boolean;
  }>;
  error?: string;
}> {
  try {
    const validatedUserId = validateUserId(userId)!;
    const client = supabaseService.getClient();

    const { data, error } = await client
      .from("devices")
      .select("device_id, device_name, os, platform, last_seen_at")
      .eq("user_id", validatedUserId)
      .eq("is_active", true)
      .order("last_seen_at", { ascending: false });

    if (error) {
      await logService.error(
        "[SessionValidator] Failed to get active devices",
        "SessionHandlers",
        { error: error.message }
      );
      return { success: false, error: error.message };
    }

    const currentDeviceId = getDeviceId();
    const devices = (data || []).map(
      (d: {
        device_id: string;
        device_name: string;
        os: string;
        platform: string;
        last_seen_at: string;
      }) => ({
        ...d,
        isCurrentDevice: d.device_id === currentDeviceId,
      })
    );

    return { success: true, devices };
  } catch (error) {
    await logService.error(
      "[SessionValidator] Error getting active devices",
      "SessionHandlers",
      { error: error instanceof Error ? error.message : "Unknown error" }
    );
    Sentry.captureException(error, {
      tags: { service: "session-handlers", operation: "handleGetActiveDevices" },
    });
    if (error instanceof ValidationError) {
      return { success: false, error: `Validation error: ${error.message}` };
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Register all session handlers
 */
export function registerSessionHandlers(): void {
  ipcMain.handle("auth:logout", wrapHandler(handleLogout, { module: "SessionHandlers" }));
  ipcMain.handle("auth:force-logout", wrapHandler(handleForceLogout, { module: "SessionHandlers" }));
  // TASK-2045: Global sign-out (all devices)
  ipcMain.handle("session:sign-out-all-devices", wrapHandler(handleSignOutAllDevices, { module: "SessionHandlers" }));
  ipcMain.handle("auth:accept-terms", wrapHandler(handleAcceptTerms, { module: "SessionHandlers" }));
  ipcMain.handle("auth:accept-terms-to-supabase", wrapHandler(handleAcceptTermsToSupabase, { module: "SessionHandlers" }));
  ipcMain.handle("auth:complete-email-onboarding", wrapHandler(handleCompleteEmailOnboarding, { module: "SessionHandlers" }));
  ipcMain.handle("auth:check-email-onboarding", wrapHandler(handleCheckEmailOnboarding, { module: "SessionHandlers" }));
  ipcMain.handle("auth:validate-session", wrapHandler(handleValidateSession, { module: "SessionHandlers" }));
  ipcMain.handle("auth:get-current-user", wrapHandler(handleGetCurrentUser, { module: "SessionHandlers" }));
  // TASK-1507: Open browser for Supabase OAuth with deep-link callback
  ipcMain.handle("auth:open-in-browser", wrapHandler(handleOpenAuthInBrowser, { module: "SessionHandlers" }));
  // TASK-2062: Remote session validation (polls Supabase auth.getUser)
  ipcMain.handle("session:validate-remote", wrapHandler(handleValidateRemoteSession, { module: "SessionHandlers" }));
  // TASK-2062: Active devices list for session management UI
  ipcMain.handle("session:get-active-devices", wrapHandler(handleGetActiveDevices, { module: "SessionHandlers" }));
}
