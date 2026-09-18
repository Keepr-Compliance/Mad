/**
 * Session Security Service
 * Handles session validity checks including idle timeout and absolute timeout
 *
 * BACKLOG-3297 — what each timeout measures:
 *
 * - SESSION_TIMEOUT_MS (absolute): time since the session was created, read from
 *   `sessions.created_at`. This is what bounds a session across quit, relaunch,
 *   crash and sleep.
 * - IDLE_TIMEOUT_MS: time since the last activity recorded IN THIS PROCESS. It is
 *   not measured across a relaunch: time the app spends closed is not idle time.
 *   A fresh process starts idle tracking at its first check.
 *
 * `sessions.created_at` / `last_accessed_at` are written by SQLite's
 * `CURRENT_TIMESTAMP` ("YYYY-MM-DD HH:MM:SS", UTC, no zone marker), so they are
 * read with `parseDbTimestamp`, never `new Date(...)`, which would read them as
 * local time.
 *
 * Entry points (main process): `checkSessionValidity` is called from
 * `sessionHandlers.ts` `handleGetCurrentUser` (IPC `auth:get-current-user`) and
 * `handleValidateSession` (IPC `auth:validate-session`), registered by
 * `registerSessionHandlers` <- `authHandlers.ts:66` <- `main.ts:1711`.
 * Renderer callers of `auth:get-current-user`: `LoadingOrchestrator.tsx:509`,
 * `AuthContext.tsx:89` (via `authService.ts:221`), `SupportWidget.tsx:64`, `:99`,
 * `DeviceLimitScreen.tsx:24`, `:59`. `auth:validate-session` has no renderer
 * caller.
 */

import logService from "./logService";
import { parseDbTimestamp } from "../utils/dbTimestamp";

/**
 * Session validity check result
 */
export interface SessionValidityResult {
  valid: boolean;
  reason?: "expired" | "idle" | "invalid";
}

/**
 * Session data interface (minimal for validation)
 */
interface SessionData {
  created_at: string;
  /**
   * Still written by `validateSession` and passed by callers, but NOT used for
   * the idle check (BACKLOG-3297): it records the previous session lookup, and
   * reading it on a fresh process counted the time the app was closed as idle.
   */
  last_accessed_at?: string;
}

/**
 * Session Security Service Class
 * Manages session validity with idle and absolute timeout checks
 */
class SessionSecurityService {
  // Session timeout constants
  private readonly IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
  private readonly SESSION_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours

  // Track last activity time per session (in-memory)
  private lastActivityMap: Map<string, number> = new Map();

  /**
   * Record user activity for a session
   * @param sessionToken - The session token to track
   */
  recordActivity(sessionToken: string): void {
    this.lastActivityMap.set(sessionToken, Date.now());
  }

  /**
   * Get last activity time for a session
   * @param sessionToken - The session token to check
   * @returns Last activity timestamp or null if not tracked
   */
  getLastActivity(sessionToken: string): number | null {
    return this.lastActivityMap.get(sessionToken) || null;
  }

  /**
   * Check if a session is valid based on timeouts
   * @param session - Session data with created_at timestamp
   * @param sessionToken - The session token for activity tracking
   * @returns Session validity result
   */
  async checkSessionValidity(
    session: SessionData,
    sessionToken?: string,
  ): Promise<SessionValidityResult> {
    const now = Date.now();

    // Check absolute timeout (24 hours from creation)
    const createdAt = parseDbTimestamp(session.created_at);
    if (!createdAt) {
      // An unreadable creation time cannot be bounded, so the session is not
      // accepted (previously NaN compared false against both limits and passed).
      await logService.warn(
        "Session rejected: created_at is missing or unparseable",
        "SessionSecurityService",
      );
      if (sessionToken) {
        this.lastActivityMap.delete(sessionToken);
      }
      return { valid: false, reason: "invalid" };
    }
    const sessionAge = now - createdAt.getTime();

    if (sessionAge > this.SESSION_TIMEOUT_MS) {
      await logService.info(
        "Session expired due to age",
        "SessionSecurityService",
        {
          sessionAge: Math.round(sessionAge / 1000 / 60), // minutes
          maxAge: Math.round(this.SESSION_TIMEOUT_MS / 1000 / 60), // minutes
        },
      );

      // Clean up activity tracking
      if (sessionToken) {
        this.lastActivityMap.delete(sessionToken);
      }

      return { valid: false, reason: "expired" };
    }

    // Check idle timeout (30 minutes of inactivity)
    if (sessionToken) {
      const lastActivity = this.lastActivityMap.get(sessionToken);

      if (lastActivity) {
        const idleTime = now - lastActivity;

        if (idleTime > this.IDLE_TIMEOUT_MS) {
          await logService.info(
            "Session expired due to inactivity",
            "SessionSecurityService",
            {
              idleTime: Math.round(idleTime / 1000 / 60), // minutes
              maxIdleTime: Math.round(this.IDLE_TIMEOUT_MS / 1000 / 60), // minutes
            },
          );

          // Clean up activity tracking
          this.lastActivityMap.delete(sessionToken);

          return { valid: false, reason: "idle" };
        }
      } else {
        // No activity recorded in this process yet (fresh launch). Idle time is
        // measured only across activity in this process, so tracking starts now;
        // the time the app was closed is bounded by SESSION_TIMEOUT_MS above.
        await logService.info(
          "No in-process activity record for session; idle tracking starts now",
          "SessionSecurityService",
          {
            sessionAge: Math.round(sessionAge / 1000 / 60), // minutes
          },
        );
        this.lastActivityMap.set(sessionToken, now);
      }
    }

    return { valid: true };
  }

  /**
   * Clean up session from activity tracking
   * @param sessionToken - The session token to remove
   */
  cleanupSession(sessionToken: string): void {
    this.lastActivityMap.delete(sessionToken);
  }

  /**
   * Get remaining session time in seconds
   * @param session - Session data with created_at timestamp
   * @returns Remaining time in seconds, or 0 if expired
   */
  getRemainingSessionTime(session: SessionData): number {
    const createdAt = parseDbTimestamp(session.created_at);
    if (!createdAt) {
      return 0;
    }
    const expiresAt = createdAt.getTime() + this.SESSION_TIMEOUT_MS;
    const remaining = expiresAt - Date.now();
    return Math.max(0, Math.round(remaining / 1000));
  }

  /**
   * Get remaining idle time in seconds
   * @param sessionToken - The session token to check
   * @returns Remaining idle time in seconds, or 0 if expired
   */
  getRemainingIdleTime(sessionToken: string): number {
    const lastActivity = this.lastActivityMap.get(sessionToken);
    if (!lastActivity) {
      return Math.round(this.IDLE_TIMEOUT_MS / 1000); // Full idle time if not tracked
    }

    const expiresAt = lastActivity + this.IDLE_TIMEOUT_MS;
    const remaining = expiresAt - Date.now();
    return Math.max(0, Math.round(remaining / 1000));
  }

  /**
   * Get current configuration values
   */
  getConfig(): { idleTimeoutMs: number; sessionTimeoutMs: number } {
    return {
      idleTimeoutMs: this.IDLE_TIMEOUT_MS,
      sessionTimeoutMs: this.SESSION_TIMEOUT_MS,
    };
  }

  /**
   * Clear all activity tracking (for testing or shutdown)
   */
  clearAllActivity(): void {
    this.lastActivityMap.clear();
  }
}

// Export singleton instance
export const sessionSecurityService = new SessionSecurityService();
export default sessionSecurityService;
