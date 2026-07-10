/**
 * Updater Failure Store — a tiny in-memory holder for the most recent
 * auto-updater failure, used to link a filed support ticket to its Sentry event.
 * BACKLOG-1903 (SPRINT-167 Auto-Updater Resilience).
 *
 * Standalone (no Electron/Sentry/main.ts imports) so both the writer
 * (electron/main.ts `handleUpdaterError`) and the reader
 * (electron/services/supportTicketService.ts `collectDiagnostics`) can import it
 * WITHOUT creating a circular dependency on main.ts (which has heavy top-level
 * side effects: Sentry.init, app.whenReady, etc.).
 */

import type { UpdaterErrorType } from "./updateDiagnostics";

/**
 * Snapshot of the most recent updater failure. Populated by the autoUpdater
 * `error` handler; consumed by support-ticket diagnostics.
 */
export interface LastUpdaterFailure {
  /** Sentry event_id (null when Sentry is disabled, e.g. plain `npm run dev`). */
  sentryEventId: string | null;
  errorType: UpdaterErrorType;
  targetVersion?: string;
  at: number; // epoch ms
}

/** How long a failure remains "recent" for ticket linkage (10 minutes). */
export const UPDATER_FAILURE_LINK_WINDOW_MS = 10 * 60 * 1000;

let lastUpdaterFailure: LastUpdaterFailure | null = null;

/** Record the most recent updater failure (overwrites any previous). */
export function setLastUpdaterFailure(failure: LastUpdaterFailure): void {
  lastUpdaterFailure = failure;
}

/**
 * Returns the most recent updater failure if it happened within the linkage
 * window, else null. Used by support-ticket diagnostics to attach the Sentry
 * event_id so tickets arrive pre-diagnosed.
 */
export function getRecentUpdaterFailure(): LastUpdaterFailure | null {
  if (!lastUpdaterFailure) return null;
  if (Date.now() - lastUpdaterFailure.at > UPDATER_FAILURE_LINK_WINDOW_MS) {
    return null;
  }
  return lastUpdaterFailure;
}

/** Test/utility helper to clear stored state. */
export function __resetUpdaterFailureStore(): void {
  lastUpdaterFailure = null;
}
