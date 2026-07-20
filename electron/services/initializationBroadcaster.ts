/**
 * InitializationBroadcaster
 *
 * Singleton service that tracks initialization stages and broadcasts
 * stage transitions to renderer processes via IPC events.
 *
 * Part of the event-driven initialization protocol (BACKLOG-1379).
 * Replaces polling-based readiness detection with push-based approach.
 */

import { BrowserWindow } from "electron";
import log from "electron-log";

// ============================================
// TYPE DEFINITIONS
// ============================================

export type InitStage =
  | "idle"
  | "db-opening"
  | "migrating"
  | "db-ready"
  | "creating-user"
  | "complete"
  | "error";

export interface InitStageEvent {
  stage: InitStage;
  progress?: number; // 0-100 for migration progress
  message?: string; // Human-readable status
  error?: { message: string; retryable: boolean }; // Only when stage=error
}

interface StageHistoryEntry {
  stage: InitStage;
  timestamp: string;
  detail?: string;
}

// ============================================
// IPC CHANNEL CONSTANT
// ============================================

export const INIT_STAGE_CHANNEL = "system:init-stage";

// ============================================
// DB-READY GATE CONSTANTS (BACKLOG-2149)
// ============================================

/**
 * Default bound for {@link InitializationBroadcaster.whenDbReady}. If the DB has
 * not reported `db-ready`/`complete` within this window, callers get a
 * `{ ready: false, timedOut: true }` result instead of hanging forever. Slow
 * (memory-pressured) inits should still finish well under this; the bound only
 * exists so a stuck init surfaces a real outcome rather than a hang.
 */
export const DEFAULT_DB_READY_TIMEOUT_MS = 30_000;

/** Result of awaiting the DB-ready signal. */
export interface DbReadyResult {
  /** True once the DB is queryable (stage `db-ready` or `complete`). */
  ready: boolean;
  /** True when the wait exceeded the timeout bound without becoming ready. */
  timedOut: boolean;
  /** Present when the init sequence reached the `error` stage while waiting. */
  error?: { message: string; retryable: boolean };
}

/** Stages at which the local database is open and queryable. */
const DB_QUERYABLE_STAGES: ReadonlySet<InitStage> = new Set<InitStage>([
  "db-ready",
  "complete",
]);

// ============================================
// INITIALIZATION BROADCASTER
// ============================================

class InitializationBroadcaster {
  private currentEvent: InitStageEvent = { stage: "idle" };
  private history: StageHistoryEntry[] = [];
  private window: BrowserWindow | null = null;
  /** Pending {@link whenDbReady} waiters, resolved from {@link broadcast}. */
  private dbReadyWaiters: Set<(result: DbReadyResult) => void> = new Set();

  /**
   * Set the BrowserWindow reference for broadcasting.
   * Must be called after the main window is created.
   * Safe to call with null (clears the window reference).
   */
  setWindow(win: BrowserWindow | null): void {
    this.window = win;
  }

  /**
   * Get the current initialization stage event.
   * Used by late-joining renderers to catch up on current state.
   */
  getCurrentStage(): InitStageEvent {
    return { ...this.currentEvent };
  }

  /**
   * Get the full stage transition history for diagnostics.
   * Returns a copy to prevent external mutation.
   */
  getHistory(): StageHistoryEntry[] {
    return [...this.history];
  }

  /**
   * Broadcast a stage transition to all renderer windows.
   * Updates internal state and sends IPC event.
   *
   * Safe to call before window is set — the event is recorded
   * in history and getCurrentStage() is updated, but no IPC
   * message is sent.
   */
  broadcast(event: InitStageEvent): void {
    this.currentEvent = { ...event };

    const historyEntry: StageHistoryEntry = {
      stage: event.stage,
      timestamp: new Date().toISOString(),
      detail: event.message,
    };
    this.history.push(historyEntry);

    log.debug(
      `[InitBroadcaster] Stage: ${event.stage}${event.message ? ` — ${event.message}` : ""}`,
    );

    // BACKLOG-2149: Resolve any pending whenDbReady() waiters once the DB is
    // queryable, or once init fails. This is the awaitable half of the otherwise
    // push-only broadcaster — post-auth consumers (email precache, shadow delta
    // sync, audit writes, verify/get-current-user handlers) gate on it instead
    // of racing DatabaseService.initialize().
    if (DB_QUERYABLE_STAGES.has(event.stage)) {
      this.resolveDbReadyWaiters({ ready: true, timedOut: false });
    } else if (event.stage === "error") {
      this.resolveDbReadyWaiters({
        ready: false,
        timedOut: false,
        error: event.error ?? { message: "Initialization failed", retryable: true },
      });
    }

    // Broadcast to all windows (supports multi-window scenarios)
    try {
      const windows = BrowserWindow.getAllWindows();
      for (const win of windows) {
        if (!win.isDestroyed() && win.webContents) {
          win.webContents.send(INIT_STAGE_CHANNEL, event);
        }
      }
    } catch (err) {
      // Window may not be ready during early initialization — this is expected
      log.debug(
        `[InitBroadcaster] Could not broadcast to windows: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * BACKLOG-2149: Await the database becoming queryable.
   *
   * Resolves immediately with `{ ready: true }` if the current stage is already
   * `db-ready` or `complete`. Otherwise it waits for the next such broadcast, or
   * resolves with `{ ready: false, error }` if the init sequence reaches the
   * `error` stage, or `{ ready: false, timedOut: true }` after `timeoutMs`.
   *
   * This never rejects — callers get a discriminated result and decide what to
   * do (proceed, skip a best-effort task, or return a transient "starting up"
   * state to the renderer). The timeout guarantees no caller hangs forever if a
   * db-ready broadcast never arrives.
   *
   * @param timeoutMs Upper bound on the wait (default {@link DEFAULT_DB_READY_TIMEOUT_MS}).
   */
  whenDbReady(timeoutMs: number = DEFAULT_DB_READY_TIMEOUT_MS): Promise<DbReadyResult> {
    // Fast path: already queryable.
    if (DB_QUERYABLE_STAGES.has(this.currentEvent.stage)) {
      return Promise.resolve({ ready: true, timedOut: false });
    }

    return new Promise<DbReadyResult>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const waiter = (result: DbReadyResult): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.dbReadyWaiters.delete(waiter);
        resolve(result);
      };

      this.dbReadyWaiters.add(waiter);

      // A non-positive timeout means "no timeout" — wait indefinitely for a
      // broadcast. Otherwise arm the backstop.
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          waiter({ ready: false, timedOut: true });
        }, timeoutMs);
        // Don't keep the event loop alive solely for this timer.
        if (typeof timer === "object" && timer && "unref" in timer) {
          (timer as { unref: () => void }).unref();
        }
      }
    });
  }

  /**
   * Resolve and clear all pending whenDbReady() waiters with the given result.
   */
  private resolveDbReadyWaiters(result: DbReadyResult): void {
    if (this.dbReadyWaiters.size === 0) return;
    // Copy first: each waiter mutates the set (deletes itself) as it resolves.
    const waiters = [...this.dbReadyWaiters];
    for (const waiter of waiters) {
      waiter(result);
    }
  }

  /**
   * Reset the broadcaster to idle state.
   * Used for testing and re-initialization scenarios.
   */
  reset(): void {
    this.currentEvent = { stage: "idle" };
    this.history = [];
    this.window = null;
    // BACKLOG-2149: release any outstanding waiters so they don't leak.
    this.resolveDbReadyWaiters({ ready: false, timedOut: true });
    this.dbReadyWaiters.clear();
  }
}

// Export singleton instance
export const initializationBroadcaster = new InitializationBroadcaster();

// Also export the class for testing
export { InitializationBroadcaster };
