import { inspect } from "util";
import type { Hook, LogMessage } from "electron-log";
import { redactLogText } from "../utils/redactSensitive";

/**
 * BACKLOG-2898 — explicit capacity for the support log.
 *
 * Before this, `electron/main.ts` set only `log.transports.file.level` and
 * inherited electron-log's DEFAULT `maxSize` of 1 MB
 * (node_modules/electron-log/src/node/transports/file/index.js:39).
 *
 * WHAT THAT COST, measured across the founder's COMPLETE retained history of
 * one 24-minute backup on his PC (2026-08-26):
 *
 *   main.log       703,761 B   4,023 lines   21 minutes      ~2.2 lines/sec
 *   main.old.log 1,048,385 B   5,294 lines   42 SECONDS      ~121 lines/sec
 *
 *   96% of the archive and 80.7% of the current file were the renderer
 *   announcing that it had repainted. Between the two files, ~22 minutes of a
 *   24-minute backup survive — and the two lines that decide whether
 *   incremental backup ran ("Using existing backup size for estimate" /
 *   "Estimated backup size from storage") appear ZERO times in either.
 *   BACKLOG-2896 is permanently unanswerable for that incident.
 *
 * WHY CAPACITY ALONE COULD NEVER HAVE FIXED IT: the storm ran at 24.4 KB/sec
 * sustained. At that rate even 8 MB holds five and a half minutes. No practical
 * cap survives an unthrottled per-frame log — which is why the primary fix is
 * the LEVEL change (renderer re-render notices are `debug` and never reach this
 * transport) and the per-line stderr classification, not this number.
 *
 * SIZING — against the steady state, which is what this number actually buys:
 *
 *   Ordinary app logging, measured outside the storm: 11,966 B over 21 min =
 *   570 B/min. A post-fix sync of that same workload adds ~4 KB of step and
 *   phase-boundary lines (measured: 10 renderer step lines, 20 timeline lines).
 *
 *     1 MB  ~= 30 hours of app use   -> a Monday sync is gone by Wednesday
 *     8 MB  ~= 10 days of app use    -> a Monday sync is still there on Friday
 *              ~= 300 complete syncs
 *
 *   That is the property worth having: a user who syncs, hits a problem days
 *   later, and sends in a log still has the sync in it.
 *
 * ARCHIVE DEPTH: electron-log keeps exactly ONE archive — `archiveLogFn` (same
 * file, :45) renames `main.log` to `main.old.log`, overwriting any previous
 * archive. Worst-case disk cost is therefore 2 x maxSize = 16 MB. Depth 1 is
 * kept deliberately: post-fix a whole sync is ~27 KB, so a sync cannot fill one
 * file let alone two, and the founder's 42-second archive was a symptom of the
 * flood, not of the depth. Raising depth would have bought him seconds.
 */

/** 8 MB — see the derivation above. */
export const LOG_FILE_MAX_SIZE_BYTES = 8 * 1024 * 1024;

/**
 * Production file level. Renderer re-render notices are emitted at `debug`
 * (src/components/iphone/IPhoneSyncFlow.tsx) and are dropped here — that is
 * the mechanism, so do not raise this to `debug` without re-reading 2898.
 */
export const LOG_FILE_LEVEL = "info" as const;

/** Number of archived log files electron-log retains after a rotation. */
export const LOG_FILE_ARCHIVE_DEPTH = 1;

/** Minimal shape of the electron-log file transport this module configures. */
export interface ConfigurableFileTransport {
  level: unknown;
  maxSize: number;
}

/** Apply the capacity policy to electron-log's file transport. */
export function applyLogFileConfig(transport: ConfigurableFileTransport): void {
  transport.level = LOG_FILE_LEVEL;
  transport.maxSize = LOG_FILE_MAX_SIZE_BYTES;
}

// ---------------------------------------------------------------------------
// BACKLOG-3819 — redact customer emails and phone numbers at the log sink.
//
// electron-log runs every hook in `logger.hooks` on each message, once per
// transport, BEFORE the transport formats it
// (node_modules/electron-log/src/core/Logger.js:177). One hook therefore covers
// the file AND console transports, every module that imports `electron-log`,
// `logService` (backed by electron-log via capabilities/electron/electronLogger),
// and renderer lines relayed through `log:renderer` (handlers/systemHandlers.ts),
// which arrive as a plain `log.info("[Renderer] ...")`.
//
// It is installed by bootstrap/installAppDataPaths.ts, the first import in
// main.ts, because several modules log during import — long before main.ts
// reaches `applyLogFileConfig`.
// ---------------------------------------------------------------------------


/** Minimal shape of a logger this module can attach the hook to. */
export interface HookableLogger {
  hooks: Hook[];
}

const MAX_DEPTH = 8;

/**
 * Return a redacted COPY of one log argument. Strings are redacted; arrays,
 * plain objects and Errors are copied with their strings redacted. The caller's
 * objects are never mutated. Cycles and very deep values are cut off rather
 * than walked forever.
 */
export function redactLogValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactLogText(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  if (depth >= MAX_DEPTH) return "[Truncated]";
  seen.add(value);
  try {
    if (value instanceof Error) {
      const copy = new Error(redactLogText(value.message));
      copy.name = value.name;
      copy.stack = value.stack ? redactLogText(value.stack) : copy.stack;
      for (const key of Object.keys(value)) {
        (copy as unknown as Record<string, unknown>)[key] = redactLogValue(
          (value as unknown as Record<string, unknown>)[key],
          depth + 1,
          seen,
        );
      }
      return copy;
    }
    if (Array.isArray(value)) {
      return value.map((item) => redactLogValue(item, depth + 1, seen));
    }
    if (value instanceof Date || Buffer.isBuffer(value) || ArrayBuffer.isView(value)) {
      return value;
    }
    if (value instanceof Map || value instanceof Set) {
      // Entries are not own enumerable properties; redact the printed form.
      return redactLogText(inspect(value, { depth: 4 }));
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactLogValue(item, depth + 1, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

/** The hook itself: redact every argument of a message. */
export const redactLogHook: Hook = (message: LogMessage) => {
  if (!message || !Array.isArray(message.data)) return message;
  return { ...message, data: message.data.map((item) => redactLogValue(item)) };
};

/**
 * Attach {@link redactLogHook} to a logger, once. Safe to call repeatedly.
 * It is placed LAST so it sees the output of any hook added before it.
 */
export function installLogRedactionHook(logger: HookableLogger): void {
  if (!logger.hooks.includes(redactLogHook)) {
    logger.hooks.push(redactLogHook);
  }
}
