/**
 * Contact Worker Pool (TASK-1956)
 *
 * Singleton that creates ONE persistent Worker at DB init time and reuses it
 * for all contact queries. This eliminates the ~150-450ms main-thread blocking
 * from spawning a new Worker() on every page load.
 *
 * API:
 *   initializePool(dbPath, encryptionKey) — called once after DB init
 *   queryContacts(type, userId, timeout?)  — routes query to persistent worker
 *   shutdownPool()                         — called on app quit
 *   isPoolReady()                          — guard for fallback
 *
 * Deduplication: If same userId:type query is already in-flight, the same
 * Promise is returned to avoid duplicate queries from both handlers.
 */

import { Worker } from "worker_threads";
import path from "path";
import crypto from "crypto";
import logService from "../services/logService";

type QueryType = "external" | "imported" | "backfill";

interface PendingQuery {
  resolve: (data: unknown[]) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

let worker: Worker | null = null;
let ready = false;
let initPromise: Promise<void> | null = null;

// BACKLOG-1122: Auto-restart tracking
let restartAttempts = 0;
let lastDbPath: string | null = null;
let lastEncryptionKey: string | null = null;
const MAX_RESTART_ATTEMPTS = 3;
let shuttingDown = false;

/**
 * BACKLOG-2553 — held for the duration of a database restore.
 *
 * `shuttingDown` CANNOT serve this purpose: `initializePool` clears it
 * unconditionally at the top of every call (see below), so any caller wipes it.
 * This flag is checked in `initializePool` ABOVE the `initPromise` guard,
 * because the window it protects outlives `initPromise` — the worker's own
 * `exit` handler sets `initPromise = null`, so from worker-exit until the
 * restore finishes, `initPromise` is null and would let a second `Worker` be
 * constructed over the file being replaced.
 */
let exclusiveHold = false;

/** Rejection message from `initializePool` while a restore holds the pool. */
export const POOL_HELD_FOR_RESTORE =
  "Contact worker pool is held for a database restore";

/**
 * Outcome of `drainPoolForExclusiveAccess`.
 *
 * `via` records WHICH path released the handle. It is logged rather than merely
 * returned: only the graceful path runs the worker's own `db.close()`, so if a
 * Windows EBUSY on the restore copy is ever reported, the log says whether the
 * handle was closed or the thread was torn down under it — without that, the
 * distinction has to be re-derived from first principles.
 */
export interface DrainResult {
  drained: boolean;
  via?: "no-worker" | "graceful-exit" | "terminate";
  reason?: string;
}

/**
 * Resolves `true` if `p` settles first, `false` if `ms` elapses first.
 *
 * REJECTS if `p` rejects — `w.terminate()` can, and swallowing that would let
 * the drain report success for a handle it never released. Both handlers are
 * attached synchronously, so a rejection arriving after the timer already won
 * is consumed here and never surfaces as an unhandled rejection.
 */
function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const timer = setTimeout(() => resolve(false), ms);
    if (typeof timer.unref === "function") timer.unref();
    p.then(
      () => { clearTimeout(timer); resolve(true); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/** Drop the exclusive hold. Never throws; safe to call twice. */
function releaseExclusiveHold(): void {
  exclusiveHold = false;
  shuttingDown = false;
}

// Pending queries by request ID
const pendingQueries = new Map<string, PendingQuery>();

// Deduplication: in-flight queries by "userId:type" key
const inflightQueries = new Map<string, Promise<unknown[]>>();

function getWorkerPath(): string {
  return path.join(__dirname, 'contactQueryWorker.js');
}

function handleWorkerMessage(msg: { type?: string; id?: string; success?: boolean; data?: unknown[]; error?: string }): void {
  // Init response
  if (msg.type === "ready") {
    ready = true;
    logService.info("[ContactWorkerPool] Worker initialized and ready", "ContactWorkerPool");
    return;
  }

  if (msg.type === "error") {
    logService.error("[ContactWorkerPool] Worker init error: " + msg.error, "ContactWorkerPool");
    return;
  }

  // Query response
  if (msg.id) {
    const pending = pendingQueries.get(msg.id);
    if (!pending) return;

    clearTimeout(pending.timeout);
    pendingQueries.delete(msg.id);

    if (msg.success && msg.data) {
      pending.resolve(msg.data);
    } else {
      pending.reject(new Error(msg.error || "Unknown worker error"));
    }
  }
}

/**
 * Initialize the persistent worker pool.
 * Called once after database initialization succeeds.
 */
export function initializePool(dbPath: string, encryptionKey: string): Promise<void> {
  // BACKLOG-2553 — MUST stay above the `initPromise` guard. See `exclusiveHold`.
  // Rejecting rather than resolving is honest: all three call sites `.catch()`
  // (systemHandlers.ts:527, systemHandlers.ts:795, and the auto-restart below).
  if (exclusiveHold) {
    return Promise.reject(new Error(POOL_HELD_FOR_RESTORE));
  }

  if (initPromise) return initPromise;

  // BACKLOG-1122: Save credentials for auto-restart
  lastDbPath = dbPath;
  lastEncryptionKey = encryptionKey;
  shuttingDown = false;

  initPromise = new Promise<void>((resolve, reject) => {
    try {
      const workerPath = getWorkerPath();
      worker = new Worker(workerPath);

      worker.on("message", handleWorkerMessage);

      worker.on("error", (err) => {
        logService.error("[ContactWorkerPool] Worker error: " + err.message, "ContactWorkerPool");
        // Reject all pending queries
        for (const [id, pending] of pendingQueries) {
          clearTimeout(pending.timeout);
          pending.reject(err);
          pendingQueries.delete(id);
        }
        inflightQueries.clear();
        ready = false;
      });

      worker.on("exit", (code) => {
        if (code !== 0) {
          logService.warn(`[ContactWorkerPool] Worker exited with code ${code}`, "ContactWorkerPool");
        }
        worker = null;
        ready = false;
        initPromise = null;
        inflightQueries.clear();
        // Reject remaining pending queries
        for (const [, pending] of pendingQueries) {
          clearTimeout(pending.timeout);
          pending.reject(new Error(`Worker exited with code ${code}`));
        }
        pendingQueries.clear();

        // BACKLOG-1122: Auto-restart on unexpected exit (non-zero code)
        if (code !== 0 && !shuttingDown && lastDbPath && lastEncryptionKey) {
          restartAttempts++;
          if (restartAttempts <= MAX_RESTART_ATTEMPTS) {
            logService.warn(
              `[ContactWorkerPool] Auto-restarting worker (attempt ${restartAttempts}/${MAX_RESTART_ATTEMPTS})`,
              "ContactWorkerPool",
            );
            // Restart asynchronously to avoid recursion in the exit handler
            setTimeout(() => {
              initializePool(lastDbPath!, lastEncryptionKey!).catch((err) => {
                logService.error(
                  `[ContactWorkerPool] Auto-restart failed: ${err.message}`,
                  "ContactWorkerPool",
                );
              });
            }, 1000 * restartAttempts); // Increasing delay: 1s, 2s, 3s
          } else {
            logService.error(
              `[ContactWorkerPool] Worker crashed ${MAX_RESTART_ATTEMPTS} times — giving up`,
              "ContactWorkerPool",
            );
          }
        }
      });

      // Send init message with DB credentials
      worker.postMessage({
        type: "init",
        dbPath,
        encryptionKey,
      });

      // Wait for ready signal with timeout
      const initTimeout = setTimeout(() => {
        if (!ready) {
          reject(new Error("Worker pool init timed out after 10s"));
          worker?.terminate();
          worker = null;
          initPromise = null;
        }
      }, 10_000);

      // Poll for ready state (the message handler sets ready = true)
      const checkReady = setInterval(() => {
        if (ready) {
          clearInterval(checkReady);
          clearTimeout(initTimeout);
          // BACKLOG-1122: Reset restart counter on successful init
          restartAttempts = 0;
          resolve();
        }
      }, 10);
    } catch (error) {
      initPromise = null;
      reject(error);
    }
  });

  return initPromise;
}

/**
 * Query contacts via the persistent worker.
 * Returns the same Promise for duplicate in-flight queries (deduplication).
 */
export function queryContacts(
  type: QueryType,
  userId: string,
  timeoutMs: number = 30_000,
): Promise<unknown[]> {
  // Deduplication key
  const dedupKey = `${userId}:${type}`;

  // If same query is already in-flight, return the same promise
  const inflight = inflightQueries.get(dedupKey);
  if (inflight) {
    logService.debug(`[ContactWorkerPool] Dedup hit for ${dedupKey}`, "ContactWorkerPool");
    return inflight;
  }

  const promise = new Promise<unknown[]>((resolve, reject) => {
    if (!worker || !ready) {
      reject(new Error("Worker pool not initialized"));
      return;
    }

    const id = crypto.randomUUID();

    const timeout = setTimeout(() => {
      pendingQueries.delete(id);
      inflightQueries.delete(dedupKey);
      reject(new Error(`Contact query timed out after ${timeoutMs}ms (type: ${type})`));
    }, timeoutMs);

    pendingQueries.set(id, { resolve, reject, timeout });

    worker.postMessage({ id, type, userId });
  });

  // Store for deduplication, clean up when resolved/rejected
  inflightQueries.set(dedupKey, promise);
  promise.finally(() => {
    inflightQueries.delete(dedupKey);
  });

  return promise;
}

/**
 * Shutdown the worker pool. Called on app quit.
 */
export function shutdownPool(): void {
  shuttingDown = true;
  if (worker) {
    try {
      worker.postMessage({ type: "shutdown" });
    } catch {
      // Worker may already be terminated
    }
    // Give it a moment to clean up, then force terminate
    setTimeout(() => {
      if (worker) {
        worker.terminate();
        worker = null;
      }
    }, 500);
  }
  ready = false;
  initPromise = null;
  inflightQueries.clear();

  // Clean up pending queries
  for (const [id, pending] of pendingQueries) {
    clearTimeout(pending.timeout);
    pending.reject(new Error("Worker pool shutting down"));
    pendingQueries.delete(id);
  }
}

/**
 * BACKLOG-2553 — stop the contact worker and PROVE it is gone, so a restore can
 * replace the database file with no second thread holding it open.
 *
 * WHY `shutdownPool()` CANNOT BE USED FOR THIS: it posts the shutdown message
 * and then schedules `worker.terminate()` inside a 500 ms `setTimeout`, and
 * returns `void`. `await shutdownPool()` resolves on the next microtask with the
 * thread — and its SQLite handle — still alive. It is correct for app quit,
 * where nothing waits on it, and useless as a barrier before a file copy.
 *
 * WHAT IS ACTUALLY AT RISK (corrected threat model, BACKLOG-2536):
 * the worker's connection is `readonly: true` (`contactQueryWorker.ts:74`), so
 * it CANNOT write and no write can be lost. What a live worker costs is:
 *   - Windows: `fs.copyFileSync` over the database can fail EBUSY/EPERM because
 *     a second thread holds the file open, so the restore fails outright;
 *   - macOS: the copy succeeds and the worker keeps READING the old unlinked
 *     inode, so the user who just restored a backup still sees pre-restore
 *     contacts until the pool restarts.
 * Neither is corruption. Both are worth preventing, and the drain prevents both.
 * (That Windows locking is the EBUSY mechanism is INFERRED from the code and
 * platform semantics; it was not reproduced on a Windows machine.)
 *
 * Resolves on the worker's real `exit` event, at ANY exit code: a worker that
 * crashed while shutting down has still released its handle, and demanding
 * code 0 would refuse restores that are in fact safe.
 *
 * @param graceMs     how long to wait for the worker's own `db.close()` + exit
 * @param terminateMs how long to wait for the `terminate()` fallback
 */
export async function drainPoolForExclusiveAccess(
  graceMs = 2_000,
  terminateMs = 3_000,
): Promise<DrainResult> {
  if (exclusiveHold) {
    // A concurrent drain already owns the worker. Refuse rather than race it.
    return { drained: false, reason: "pool is already held by another restore" };
  }

  exclusiveHold = true;

  // EVERYTHING below runs inside this try. `postMessage` can throw — the quit
  // path wraps the identical call for that reason — and `terminate()` can
  // reject. If either escaped, `exclusiveHold` would stay set for the life of
  // the process, every later `initializePool` would reject, and the contact
  // pool would be dead until app quit with no route back.
  try {
    shuttingDown = true;
    ready = false;
    inflightQueries.clear();
    for (const [id, pending] of pendingQueries) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Worker pool draining for database restore"));
      pendingQueries.delete(id);
    }

    const w = worker;
    if (!w) {
      initPromise = null;
      logService.info(
        "[ContactWorkerPool] Drained: no worker was running",
        "ContactWorkerPool",
      );
      return { drained: true, via: "no-worker" };
    }

    // Registered BEFORE the shutdown message so a worker that exits instantly
    // cannot fire `exit` into a listener that does not exist yet.
    const exited = new Promise<void>((resolve) => {
      w.once("exit", () => resolve());
    });

    try {
      w.postMessage({ type: "shutdown" });
    } catch {
      // Worker may already be terminated. The exit race below still settles it.
    }

    if (await settlesWithin(exited, graceMs)) {
      logService.info(
        "[ContactWorkerPool] Drained: worker closed its connection and exited",
        "ContactWorkerPool",
      );
      return { drained: true, via: "graceful-exit" };
    }

    // FALLBACK, AND WHAT IT DOES NOT PROVE: only the graceful path above runs
    // the worker's `db.close()`. `terminate()` tears down the isolate and
    // relies on the native addon's finaliser to release the file. That cannot
    // be observed on macOS, which unlinks open files without complaint, so this
    // is stated as INFERRED. If the handle does survive, `copyFileSync` throws
    // EBUSY and the caller's existing safety-copy recovery runs — the
    // pre-existing failure mode, not a new one.
    if (await settlesWithin(w.terminate().then(() => exited), terminateMs)) {
      logService.warn(
        "[ContactWorkerPool] Drained via terminate() — the worker did not shut " +
          "down gracefully, so its connection was not explicitly closed",
        "ContactWorkerPool",
      );
      return { drained: true, via: "terminate" };
    }

    releaseExclusiveHold();
    return {
      drained: false,
      reason: `worker did not exit within ${graceMs + terminateMs}ms`,
    };
  } catch (error) {
    releaseExclusiveHold();
    return {
      drained: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * BACKLOG-2553 — release the hold taken by `drainPoolForExclusiveAccess` and,
 * when it is safe to, start a fresh worker.
 *
 * The hold is dropped as the FIRST statement inside the try, so it is released
 * on every path through this function including a thrown one. A restore that
 * succeeded must never be reported failed because the pool could not restart,
 * so nothing here throws: contact reads simply fall back to the main-thread
 * connection until the next launch.
 *
 * @param dbPath        pass `null` to use the path the pool was opened with
 * @param encryptionKey pass `null` to use the key the pool was opened with
 * @param spawn         whether the database is actually open. On the
 *   double-failure restore path (copy done, `initialize()` failed, safety-copy
 *   recovery also failed) the file is NOT open; a worker started against it
 *   never posts `ready`, and `initializePool` would sit on its 10-second timer
 *   with the user's error dialog waiting behind it.
 */
export async function restartPoolAfterExclusiveAccess(
  dbPath: string | null,
  encryptionKey: string | null,
  spawn: boolean,
): Promise<void> {
  try {
    // FIRST — before anything that could throw.
    releaseExclusiveHold();

    if (!spawn) {
      logService.warn(
        "[ContactWorkerPool] Hold released without restarting: database is not open",
        "ContactWorkerPool",
      );
      return;
    }

    // The pool restarts against the path it was OPENED with, not a second
    // independent derivation of the database location.
    const resolvedPath = dbPath ?? lastDbPath;
    const resolvedKey = encryptionKey ?? lastEncryptionKey;
    if (!resolvedPath || !resolvedKey) {
      logService.warn(
        "[ContactWorkerPool] Hold released without restarting: no stored credentials",
        "ContactWorkerPool",
      );
      return;
    }

    await initializePool(resolvedPath, resolvedKey);
    logService.info(
      "[ContactWorkerPool] Worker pool restarted after exclusive access",
      "ContactWorkerPool",
    );
  } catch (error) {
    logService.error(
      "[ContactWorkerPool] Failed to restart worker pool after exclusive access: " +
        (error instanceof Error ? error.message : String(error)),
      "ContactWorkerPool",
    );
  }
}

/**
 * Check if the worker pool is ready for queries.
 */
export function isPoolReady(): boolean {
  return ready && worker !== null;
}
