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

type QueryType =
  | "external"
  | "imported"
  | "backfill"
  | "emailDerived"
  | "threadIdentity"
  | "threadIdentityTargeted"
  | "candidateMessageThreads"
  // BACKLOG-3837: the step-1 Continue scans (wizardMessageScansDb.ts).
  | "messageDerived"
  | "commDatesPlan"
  | "sourceCoverageFloors";

/**
 * Per-type payload carried alongside `{ id, type, userId }` (BACKLOG-1717).
 *
 * Passed as an OPTIONS OBJECT rather than a fourth positional argument so the
 * three existing callers are untouched, and so a second payload field later
 * does not reopen the same signature.
 */
export interface ContactQueryPayload {
  /** `emailDerived` only: which mailboxes this read covers. */
  providers?: readonly string[];
}

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

let workerPathOverride: string | null = null;

function getWorkerPath(): string {
  return workerPathOverride ?? path.join(__dirname, 'contactQueryWorker.js');
}

/** Test seam: a compiled worker script (the TS source has no .js beside it). */
export function setContactWorkerPathForTests(p: string | null): void {
  workerPathOverride = p;
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
  payload: ContactQueryPayload = {},
): Promise<unknown[]> {
  /**
   * THE DEDUP KEY MUST NAME THE PAYLOAD, NOT JUST THE TYPE (BACKLOG-1717).
   *
   * It was `${userId}:${type}`. With one query type that takes arguments, two
   * reads for the same user with DIFFERENT provider sets collide on that key
   * and the second caller is handed the first's in-flight promise — i.e. the
   * first call's answer, for the wrong set of mailboxes.
   *
   * Reachable without contrivance: the user flips the Gmail switch while a
   * picker read is in flight, or two surfaces load either side of a toggle
   * change. The sort makes the key order-independent, so ["outlook","gmail"]
   * and ["gmail","outlook"] still dedup against each other, which is correct —
   * they are the same read.
   *
   * Types that carry no payload keep exactly the key they had.
   */
  const providerKey = payload.providers ? `:${[...payload.providers].sort().join(",")}` : "";
  const dedupKey = `${userId}:${type}${providerKey}`;

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

    worker.postMessage({
      id,
      type,
      userId,
      ...(payload.providers ? { providers: [...payload.providers] } : {}),
    });
  });

  // Store for deduplication, clean up when resolved/rejected
  inflightQueries.set(dedupKey, promise);
  // The caller handles the rejection; the `.finally` copy must not become an unhandled
  // rejection of its own (BACKLOG-3816: it crashed a jest run on a failed query).
  promise
    .finally(() => {
      inflightQueries.delete(dedupKey);
    })
    .catch(() => undefined);

  return promise;
}

/**
 * Short-lived workers started by {@link queryOnDedicatedWorker}. Tracked so a database
 * restore (drain) and app quit stop them: each holds its own read-only connection.
 */
const dedicatedWorkers = new Set<Worker>();
/** Dedicated workers stopped on purpose by a database restore / close / app quit. */
const stoppedDedicatedWorkers = new WeakSet<Worker>();

/**
 * Why a dedicated query failed (BACKLOG-3816 fix round). The caller decides on this:
 * only `start_failed` (no worker ever ran the query) is safe to retry on the main thread.
 *  - unavailable: pool in a restore / shutting down / not initialised
 *  - start_failed: the worker could not be created, could not open the database, or died before it was ready
 *  - timeout: `timeoutMs` elapsed
 *  - stopped: stopped by a restore / close / quit while running
 *  - failed: the worker was up and the query or the thread failed
 */
export type DedicatedQueryFailure = "unavailable" | "start_failed" | "timeout" | "stopped" | "failed";

export class DedicatedWorkerError extends Error {
  constructor(
    message: string,
    readonly code: DedicatedQueryFailure,
  ) {
    super(message);
    this.name = "DedicatedWorkerError";
  }
}

/** Test-only: dedicated workers still alive (started and not yet exited). */
export function getDedicatedWorkerCountForTests(): number {
  return dedicatedWorkers.size;
}

/**
 * Run ONE query on a worker of its own, started for it and stopped after (BACKLOG-3816
 * PC final check, 2026-10-10). For long reads — the attached-thread identity index read
 * every text message of the user and took up to 44 s on the founder's PC — that must not
 * hold the shared worker: contact list reads queue behind it there and time out at 30 s.
 * Same compiled script and the same init message as the pool; needs the pool to have
 * been initialized (it supplies the database path and key). Rejects, never hangs:
 * `timeoutMs` bounds start-up plus the query.
 */
export function queryOnDedicatedWorker(
  type: QueryType,
  userId: string,
  timeoutMs: number = 30_000,
  /** BACKLOG-3868: extra fields of the query message (e.g. `request` for threadIdentityTargeted). */
  extras?: Record<string, unknown>,
): Promise<unknown[]> {
  return new Promise<unknown[]>((resolve, reject) => {
    if (exclusiveHold || shuttingDown || !lastDbPath || !lastEncryptionKey) {
      reject(new DedicatedWorkerError("Dedicated contact worker unavailable", "unavailable"));
      return;
    }
    let w: Worker;
    try {
      w = new Worker(getWorkerPath());
    } catch (error) {
      reject(new DedicatedWorkerError(error instanceof Error ? error.message : String(error), "start_failed"));
      return;
    }
    dedicatedWorkers.add(w);
    const id = crypto.randomUUID();
    let settled = false;
    let started = false;
    const finish = (error: Error | null, data?: unknown[]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Graceful first (the worker closes its connection and exits), terminate as backstop.
      try {
        w.postMessage({ type: "shutdown" });
      } catch {
        // already gone
      }
      const kill = setTimeout(() => void w.terminate().catch(() => undefined), 2_000);
      kill.unref?.();
      w.once("exit", () => clearTimeout(kill));
      if (error) reject(error);
      else resolve(data ?? []);
    };
    const timer = setTimeout(
      () =>
        finish(new DedicatedWorkerError(`Dedicated contact query timed out after ${timeoutMs}ms (type: ${type})`, "timeout")),
      timeoutMs,
    );
    w.on("message", (msg: { type?: string; id?: string; success?: boolean; data?: unknown[]; error?: string }) => {
      if (msg.type === "ready") {
        started = true;
        w.postMessage({ ...extras, id, type, userId });
        return;
      }
      if (msg.type === "error") {
        finish(new DedicatedWorkerError(msg.error || "Dedicated contact worker could not open the database", started ? "failed" : "start_failed"));
        return;
      }
      if (msg.id !== id) return;
      if (msg.success && msg.data) finish(null, msg.data);
      else finish(new DedicatedWorkerError(msg.error || "Unknown worker error", "failed"));
    });
    w.on("error", (error) => finish(new DedicatedWorkerError(error.message, started ? "failed" : "start_failed")));
    w.on("exit", (code) => {
      dedicatedWorkers.delete(w);
      finish(
        new DedicatedWorkerError(
          `Dedicated contact worker exited with code ${code}`,
          stoppedDedicatedWorkers.has(w) ? "stopped" : started ? "failed" : "start_failed",
        ),
      );
    });
    w.postMessage({ type: "init", dbPath: lastDbPath, encryptionKey: lastEncryptionKey });
  });
}

/** Stop every dedicated worker; resolves when each has exited. Never throws. */
function stopDedicatedWorkers(): Promise<void> {
  return Promise.all(
    [...dedicatedWorkers].map(
      (w) =>
        new Promise<void>((resolve) => {
          stoppedDedicatedWorkers.add(w);
          w.once("exit", () => resolve());
          w.terminate().catch(() => resolve());
        }),
    ),
  ).then(() => undefined);
}

/**
 * Shutdown the worker pool. Called on app quit.
 *
 * Returns a promise that resolves once the pool worker AND every dedicated worker has
 * exited (each closes its database connection first on the graceful path). App quit
 * ignores it; anything that needs the database file released (a Windows file delete
 * or rename) must await it. The state reset below is synchronous either way.
 */
export function shutdownPool(): Promise<void> {
  shuttingDown = true;
  const dedicatedStopped = stopDedicatedWorkers();
  let poolStopped: Promise<void> = Promise.resolve();
  if (worker) {
    const w = worker;
    poolStopped = new Promise<void>((resolve) => {
      w.once("exit", () => resolve());
      try {
        w.postMessage({ type: "shutdown" });
      } catch {
        // Worker may already be terminated
        resolve();
      }
      // Give it a moment to clean up, then force terminate
      setTimeout(() => {
        if (worker === w) worker = null;
        w.terminate().then(() => resolve(), () => resolve());
      }, 500);
    });
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
  return Promise.all([dedicatedStopped, poolStopped]).then(() => undefined);
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
    // BACKLOG-3816: a dedicated worker holds its own connection to the file being replaced.
    await stopDedicatedWorkers();
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
