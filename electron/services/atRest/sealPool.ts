/**
 * Runs one seal or classify pass over a list of files (BACKLOG-3816, seal throughput).
 *
 * `workers > 0`: that many worker threads (sealWorker.js), each doing sync I/O on its
 * own thread; the main thread only hands out batches and counts results. `workers = 0`:
 * the same engine in-process, one small batch per event-loop turn (tests, and the
 * fallback when a worker cannot be started — slower and it blocks the main thread for
 * one file at a time, but it seals exactly the same way).
 *
 * A worker that dies mid-batch has its batch re-run (in another worker or in-process).
 * That is safe: every file operation is temp → fsync → rename, and a file already
 * sealed is classified `sealed` and left alone.
 *
 * Pausing: the caller sets `stop[0] = 1`. Each worker stops before its next file, and no
 * new batch is handed out. The pass resolves with `stopped: true` and `outcomes[i]`
 * undefined for every file it did not reach.
 */
import os from "os";
import path from "path";
import { Worker } from "worker_threads";

import {
  createSealEngine,
  type EngineKey,
  type FileOutcome,
  type SealEngineOptions,
  type SealMode,
} from "./sealEngine";

export interface PassFile {
  path: string;
  size: number;
}

export interface PassOptions {
  files: readonly PassFile[];
  mode: SealMode;
  key: EngineKey;
  chunkSize?: number;
  /** 0 = in-process. */
  workers: number;
  /** Compiled worker script; defaults to sealWorker.js beside this file. */
  workerScript?: string;
  /** Shared pause flag: set [0] = 1 to stop at the next file boundary. */
  stop: Int32Array;
  /** In-process engine options (test seams). Ignored by workers. */
  engineOptions?: SealEngineOptions;
  /** Called after every batch with the indexes it covered (in `files`) and their outcomes. */
  onBatch?: (indexes: readonly number[], outcomes: readonly FileOutcome[]) => void;
  log?: (level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>) => void;
}

export interface PassResult {
  outcomes: Array<FileOutcome | undefined>;
  touchedDirs: Set<string>;
  stopped: boolean;
  /** Workers that actually ran (0 = everything ran in-process). */
  workersUsed: number;
}

/** Default worker count: I/O-bound work, so a few more than the spare cores, capped. */
export function defaultSealWorkers(): number {
  const cpus = Math.max(1, os.cpus()?.length ?? 1);
  return Math.max(2, Math.min(8, cpus - 1));
}

const MAX_BATCH_FILES = 64;
const MAX_BATCH_BYTES = 32 * 1024 * 1024;

function makeBatches(files: readonly PassFile[]): number[][] {
  const batches: number[][] = [];
  let current: number[] = [];
  let bytes = 0;
  files.forEach((f, i) => {
    if (current.length > 0 && (current.length >= MAX_BATCH_FILES || bytes + f.size > MAX_BATCH_BYTES)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(i);
    bytes += f.size;
  });
  if (current.length > 0) batches.push(current);
  return batches;
}

const yieldTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

export async function runPass(opts: PassOptions): Promise<PassResult> {
  const outcomes: Array<FileOutcome | undefined> = new Array(opts.files.length);
  const touchedDirs = new Set<string>();
  const queue = makeBatches(opts.files);
  const stopped = () => Atomics.load(opts.stop, 0) === 1;
  let anyStopped = false;

  const record = (indexes: readonly number[], result: { outcomes: FileOutcome[]; touchedDirs: string[]; stopped: boolean }) => {
    result.outcomes.forEach((o, k) => {
      outcomes[indexes[k]] = o;
    });
    for (const d of result.touchedDirs) touchedDirs.add(d);
    if (result.stopped) anyStopped = true;
    opts.onBatch?.(indexes.slice(0, result.outcomes.length), result.outcomes);
  };

  const held: { engine: ReturnType<typeof createSealEngine> | null } = { engine: null };
  const runInProcess = async () => {
    const inProcess = (held.engine ??= createSealEngine(opts.key, { chunkSize: opts.chunkSize, ...opts.engineOptions }));
    while (queue.length > 0) {
      if (stopped()) {
        anyStopped = true;
        return;
      }
      const indexes = queue.shift() as number[];
      // A few files per turn so timers and IPC still run between them.
      for (let k = 0; k < indexes.length; k += 4) {
        const part = indexes.slice(k, k + 4);
        const result = inProcess.runBatch(
          part.map((i) => opts.files[i].path),
          opts.mode,
          stopped,
        );
        record(part, result);
        if (result.stopped) {
          anyStopped = true;
          return;
        }
        await yieldTurn();
      }
    }
  };

  let workersUsed = 0;
  try {
    const wanted = Math.min(opts.workers, queue.length);
    if (wanted > 0) {
      const script = opts.workerScript ?? path.join(__dirname, "sealWorker.js");
      const live: Promise<void>[] = [];
      for (let w = 0; w < wanted; w++) {
        let worker: Worker;
        try {
          worker = new Worker(script, {
            workerData: {
              key: new Uint8Array(opts.key.key),
              keyId: opts.key.keyId,
              chunkSize: opts.chunkSize,
              stop: opts.stop.buffer,
              skipDataFsyncForMeasurement: opts.engineOptions?.skipDataFsyncForMeasurement === true,
            },
          });
        } catch (error) {
          opts.log?.("warn", "[BackupAtRest] a seal worker could not start; sealing in-process", {
            code: (error as NodeJS.ErrnoException)?.code ?? (error as Error)?.name,
          });
          break;
        }
        workersUsed++;
        live.push(driveWorker(worker));
      }
      await Promise.all(live);
    }
    // No worker started, or some died: whatever is left runs here.
    if (queue.length > 0 && !stopped()) await runInProcess();
    if (queue.length > 0 && stopped()) anyStopped = true;
  } finally {
    held.engine?.dispose();
  }
  return { outcomes, touchedDirs, stopped: anyStopped, workersUsed };

  function driveWorker(worker: Worker): Promise<void> {
    return new Promise<void>((resolve) => {
      let current: number[] | null = null;
      let nextId = 0;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        worker.removeAllListeners();
        worker.on("error", () => undefined);
        try {
          worker.postMessage({ type: "close" });
        } catch {
          // already gone
        }
        void worker.terminate().catch(() => undefined);
        resolve();
      };
      const sendNext = () => {
        if (stopped() || queue.length === 0) {
          if (stopped() && queue.length > 0) anyStopped = true;
          finish();
          return;
        }
        current = queue.shift() as number[];
        worker.postMessage({ type: "batch", id: nextId++, mode: opts.mode, files: current.map((i) => opts.files[i].path) });
      };
      const fail = (error: unknown) => {
        if (current) queue.unshift(current); // re-run: idempotent per file
        current = null;
        opts.log?.("warn", "[BackupAtRest] a seal worker stopped; its batch is re-run", {
          code: (error as NodeJS.ErrnoException)?.code ?? (error as Error)?.name ?? String(error),
        });
        finish();
      };
      worker.on("message", (msg: { type: string; outcomes: FileOutcome[]; touchedDirs: string[]; stopped: boolean }) => {
        if (msg.type !== "result" || !current) return;
        const indexes = current;
        current = null;
        // A stopped batch hands back the files it did not reach.
        if (msg.stopped && msg.outcomes.length < indexes.length) queue.unshift(indexes.slice(msg.outcomes.length));
        record(indexes, msg);
        sendNext();
      });
      worker.on("error", fail);
      worker.on("exit", (code) => {
        if (!finished) fail(new Error(`seal worker exited (${code})`));
      });
      worker.once("online", sendNext);
    });
  }
}
