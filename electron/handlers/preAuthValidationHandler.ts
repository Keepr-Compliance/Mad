/**
 * Pre-Auth Validation Handler (TASK-2086)
 *
 * Validates the user's Supabase auth token BEFORE the encrypted database
 * is opened. This ensures SOC 2 CC6.1 compliance: data is only accessible
 * to currently authorized users.
 *
 * Key design decisions:
 * - Uses session.json (encrypted by safeStorage, NOT by the database)
 * - Supabase client initializes from env vars only (no DB dependency)
 * - Offline users within grace period are allowed through
 * - No session = new user -> proceed to DB init (will show login screen)
 *
 * @module handlers/preAuthValidationHandler
 */

import { ipcMain, net } from "electron";
import sessionService from "../services/sessionService";
import supabaseService from "../services/supabaseService";
import logService from "../services/logService";

/** Offline grace period: 24 hours (SOC 2 compliant revocation window) */
const OFFLINE_GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;

/**
 * Result of pre-DB auth validation.
 */
export interface PreAuthResult {
  /** True if auth validation passed (or no session exists) */
  valid: boolean;
  /** True if no session.json exists (new user / cleared session) */
  noSession?: boolean;
  /** Reason for auth failure (when valid is false) */
  reason?: string;
}

/**
 * Validates the user's session before database decryption.
 *
 * Flow:
 * 1. Read session.json (safeStorage decryption, no DB needed)
 * 2. If no session: return valid (new user path)
 * 3. Try server-side validation via Supabase auth.getUser()
 * 4. On success: update lastServerValidatedAt, return valid
 * 5. On auth failure: clear session, return invalid
 * 6. On network error: check offline grace period
 */
export async function handlePreAuthValidation(): Promise<PreAuthResult> {
  // console.log("[PRE-AUTH] === Starting pre-DB auth validation (SOC 2 CC6.1) ===");
  // console.log("[PRE-AUTH] Database has NOT been decrypted yet");

  // Step 1: Read session.json (safeStorage decryption, no DB needed)
  const session = await sessionService.loadSession();

  if (!session || !session.supabaseTokens) {
    // console.log("[PRE-AUTH] No session found — new user or cleared session. Proceeding to DB init.");
    await logService.info(
      "Pre-auth: No session found, proceeding to DB init",
      "PreAuthValidation"
    );
    return { valid: true, noSession: true };
  }

  // Step 2: Check network availability
  const isOnline = net.isOnline;

  if (!isOnline) {
    // console.log("[PRE-AUTH] Device is OFFLINE — checking grace period...");
    return handleOfflineGracePeriod(session.lastServerValidatedAt);
  }

  // Step 3: Try server-side validation
  // console.log("[PRE-AUTH] Session found. Validating with Supabase server...");
  try {
    // Initialize Supabase client (env vars only, no DB)
    const client = supabaseService.getClient();

    // Restore SDK session from stored tokens
    const { error: setSessionError } = await client.auth.setSession({
      access_token: session.supabaseTokens.access_token,
      refresh_token: session.supabaseTokens.refresh_token,
    });

    if (setSessionError) {
      // console.log("[PRE-AUTH] ❌ setSession FAILED — token invalid:", setSessionError.message);
      await logService.info(
        "Pre-auth: setSession failed, clearing session",
        "PreAuthValidation",
        { error: setSessionError.message }
      );
      return await rejectAfterClearingSession("token_invalid");
    }

    // Server-side validation
    const { data, error: getUserError } = await client.auth.getUser();

    if (getUserError || !data.user) {
      // console.log("[PRE-AUTH] ❌ Server REJECTED session — user revoked/deleted. DB will NOT be decrypted.");
      await logService.info(
        "Pre-auth: Server rejected session, clearing",
        "PreAuthValidation",
        { error: getUserError?.message }
      );
      return await rejectAfterClearingSession("session_revoked");
    }

    // Valid! Update lastServerValidatedAt
    // console.log("[PRE-AUTH] ✅ Session VALID — user confirmed by Supabase server. Proceeding to DB decrypt.");
    await sessionService.updateSession({
      lastServerValidatedAt: Date.now(),
    });

    await logService.info(
      "Pre-auth: Session validated server-side",
      "PreAuthValidation"
    );
    return { valid: true };

  } catch (error: unknown) {
    // Network error during validation -- check offline grace period
    const errorMessage = error instanceof Error ? error.message : String(error);
    await logService.warn(
      "Pre-auth: Network error during validation, checking grace period",
      "PreAuthValidation",
      { error: errorMessage }
    );
    return handleOfflineGracePeriod(session.lastServerValidatedAt);
  }
}

/**
 * BACKLOG-3410: clear the rejected session and report why. The renderer opens
 * the DB after "token_invalid" / "session_revoked" on the understanding that
 * session.json is gone, so if the delete did not succeed the result must carry
 * a reason the renderer does NOT route to DB init.
 *
 * Total: never rejects. A throw from the clear (or from the warning log) must
 * not escape as an IPC rejection, which the renderer would treat as valid.
 */
async function rejectAfterClearingSession(
  reason: "token_invalid" | "session_revoked"
): Promise<PreAuthResult> {
  let cleared: unknown = false;
  let clearError: string | undefined;
  try {
    cleared = await sessionService.clearSession();
  } catch (error: unknown) {
    clearError = error instanceof Error ? error.message : String(error);
  }

  if (cleared === true) {
    return { valid: false, reason };
  }

  try {
    await logService.warn(
      "Pre-auth: could not clear rejected session, keeping DB closed",
      "PreAuthValidation",
      { rejectedReason: reason, error: clearError }
    );
  } catch {
    // Logging must not change the outcome: the DB stays closed either way.
  }
  return { valid: false, reason: "session_clear_failed" };
}

/**
 * Check if the offline grace period allows proceeding without server validation.
 */
async function handleOfflineGracePeriod(
  lastServerValidatedAt: number | undefined
): Promise<PreAuthResult> {
  const lastValidated = lastServerValidatedAt || 0;
  const elapsed = Date.now() - lastValidated;

  if (lastValidated > 0 && elapsed < OFFLINE_GRACE_PERIOD_MS) {
    await logService.info(
      "Pre-auth: Offline but within grace period, proceeding",
      "PreAuthValidation",
      { elapsedMs: elapsed, graceMs: OFFLINE_GRACE_PERIOD_MS }
    );
    return { valid: true };
  }

  // Grace period expired or never validated
  await logService.warn(
    "Pre-auth: Offline and grace period expired, blocking",
    "PreAuthValidation",
    { elapsedMs: elapsed, graceMs: OFFLINE_GRACE_PERIOD_MS }
  );
  return { valid: false, reason: "offline_grace_expired" };
}

/**
 * Register the pre-auth validation IPC handler.
 * Called from main.ts during app initialization.
 */
export function registerPreAuthValidationHandler(): void {
  ipcMain.handle("pre-auth:validate-session", async () => {
    return handlePreAuthValidation();
  });
}
