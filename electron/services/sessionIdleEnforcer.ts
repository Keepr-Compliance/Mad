/**
 * BACKLOG-3833 — enforce the session idle timeout while the app stays open.
 *
 * Two callers:
 * - IPC `session:user-activity` (renderer input heartbeat, at most once a
 *   minute, no arguments): `enforceSessionIdle({ recordActivity: true })`.
 * - A main-side interval (every minute): `enforceSessionIdle({ recordActivity: false })`.
 *
 * Validity is checked BEFORE activity is recorded, so input from a user who
 * returns after the idle limit cannot revive an already idle session: it takes
 * the same sign-out path. On sign-out the renderer is told through
 * `session:idle-expired` and runs its normal logout flow.
 *
 * An error never signs anyone out; only an explicit invalid result does.
 */
import databaseService from "./databaseService";
import sessionService from "./sessionService";
import sessionSecurityService from "./sessionSecurityService";
import logService from "./logService";
import { sendToMainWindow } from "../windowRegistry";

export const SESSION_IDLE_EXPIRED_CHANNEL = "session:idle-expired";
export const SESSION_IDLE_CHECK_INTERVAL_MS = 60 * 1000;

export type IdleEnforceResult = "signed-out" | "no-session" | "active" | "expired" | "error";

export async function enforceSessionIdle(opts: {
  recordActivity: boolean;
}): Promise<IdleEnforceResult> {
  try {
    if (!databaseService.isInitialized()) return "no-session";
    const session = await sessionService.loadSession();
    if (!session?.sessionToken) return "signed-out";
    const token = session.sessionToken;

    const dbSession = await databaseService.validateSession(token);
    if (!dbSession) return "no-session";

    const check = await sessionSecurityService.checkSessionValidity(
      { created_at: dbSession.created_at, last_accessed_at: dbSession.last_accessed_at },
      token,
    );

    if (!check.valid) {
      await databaseService.deleteSession(token);
      await sessionService.clearSession();
      sessionSecurityService.cleanupSession(token);
      await logService.info("Session signed out by idle enforcement", "SessionIdleEnforcer", {
        reason: check.reason,
      });
      sendToMainWindow(SESSION_IDLE_EXPIRED_CHANNEL);
      return "expired";
    }

    if (opts.recordActivity) {
      sessionSecurityService.recordActivity(token);
    }
    return "active";
  } catch (error) {
    await logService.warn("Session idle enforcement check failed", "SessionIdleEnforcer", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return "error";
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Start the once-a-minute idle check. Safe to call twice. */
export function startSessionIdleEnforcement(): void {
  if (timer) return;
  timer = setInterval(() => {
    void enforceSessionIdle({ recordActivity: false });
  }, SESSION_IDLE_CHECK_INTERVAL_MS);
  if (typeof timer === "object" && timer && "unref" in timer) {
    timer.unref();
  }
}

export function stopSessionIdleEnforcement(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
