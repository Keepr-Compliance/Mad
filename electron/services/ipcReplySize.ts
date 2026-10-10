/**
 * BACKLOG-3785: LOG LARGE IPC REPLIES DURING A SYNC.
 *
 * The renderer froze for ~5 minutes right after an iPhone sync while main was
 * idle. One candidate is a renderer `invoke` whose reply scales with the number
 * of stored messages: the renderer deserialises and processes it on its main
 * thread. This names the channel without a profile: while a sync is running (or
 * just finished — `syncTimeline.currentPhase()` is non-null), every
 * `ipcMain.handle` reply of roughly 1 MB or more logs ONE line:
 *
 *   [IpcReplySize] channel=<name> approxBytes=<n> durationMs=<ms> phase=<phase>
 *
 * Channel names are static strings in this codebase; no payload content is
 * logged. Outside a sync nothing is measured. Measuring walks the reply once
 * (cheaper than serialising it) and stops counting at 512 MB (`approxBytes`
 * then ends in "+").
 *
 * Installed by electron/bootstrap/installIpcReplySizeLog.ts, which patches
 * `ipcMain.handle` BEFORE any handler registers (import position in main.ts), so
 * every handler is covered without editing ~370 call sites. The wrapper
 * returns the handler's own result/rejection unchanged and can never throw on
 * its own account.
 */

export const LARGE_REPLY_BYTES = 1024 * 1024;
/**
 * BACKLOG-3884: a handler that takes this long logs one line at ANY time, sync
 * or not, so a main-side stall on a user action names its channel:
 *
 *   [IpcSlowHandler] channel=<name> durationMs=<ms> approxBytes=<n>
 *
 * Duration is wall time from invoke to reply, so it includes awaited work as
 * well as synchronous work.
 */
export const SLOW_HANDLER_MS = 1_000;
export const REPLY_SIZE_CAP_BYTES = 512 * 1024 * 1024;

type PhaseSource = () => string | null;
let phaseSource: PhaseSource = () => null;

/** Measuring runs only while this returns a phase (registered by the sync handlers). */
export function setIpcReplySizePhaseSource(source: PhaseSource): void {
  phaseSource = source;
}

/**
 * Approximate structured-clone size of `value` in bytes. Strings count one byte
 * per code unit, numbers 8, typed arrays/buffers their byteLength. Counting stops
 * once `cap` is passed. Shared/cyclic objects are counted once.
 */
export function approxSerializedBytes(value: unknown, cap = REPLY_SIZE_CAP_BYTES): number {
  let bytes = 0;
  const seen = new Set<object>();
  const stack: unknown[] = [value];
  while (stack.length > 0 && bytes <= cap) {
    const v = stack.pop();
    if (v === null || v === undefined) {
      bytes += 1;
      continue;
    }
    switch (typeof v) {
      case "string":
        bytes += v.length;
        continue;
      case "number":
      case "bigint":
        bytes += 8;
        continue;
      case "boolean":
        bytes += 1;
        continue;
      case "object":
        break;
      default:
        continue;
    }
    const obj = v as object;
    if (seen.has(obj)) continue;
    seen.add(obj);
    if (ArrayBuffer.isView(obj)) {
      bytes += obj.byteLength;
    } else if (obj instanceof ArrayBuffer) {
      bytes += obj.byteLength;
    } else if (obj instanceof Date) {
      bytes += 8;
    } else if (Array.isArray(obj)) {
      bytes += 1;
      for (const item of obj) stack.push(item);
    } else if (obj instanceof Map) {
      for (const [k, item] of obj) stack.push(k, item);
    } else if (obj instanceof Set) {
      for (const item of obj) stack.push(item);
    } else {
      for (const key of Object.keys(obj)) {
        bytes += key.length;
        stack.push((obj as Record<string, unknown>)[key]);
      }
    }
  }
  return bytes;
}

export interface HandleTarget {
  handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => void;
}

export interface ReplySizeDeps {
  phase: () => string | null;
  now: () => number;
  log: (line: string) => void;
}

const WRAPPED = Symbol.for("keepr.ipcReplySizeWrapped");

/**
 * BACKLOG-3884 follow-up: what main was last asked to do over IPC. Written at
 * the START of every wrapped `ipcMain.handle` call, so a main-thread block that
 * begins inside a handler is attributed to the channel that was running. Read
 * by the main event-loop lag monitor and by the "Session loaded" line.
 * `ipcMain.on` listeners are not tracked (handle only). Channel names only.
 */
let lastIpcChannel: string | null = null;
let lastIpcStartedAt = 0;
const inFlight = new Map<string, number>();

export interface IpcActivitySnapshot {
  lastChannel: string | null;
  lastStartedAt: number;
  /** Channels with a handler still running, at most `max`, most-recent-first order not guaranteed. */
  inFlight: string[];
}

export function ipcActivitySnapshot(max = 5): IpcActivitySnapshot {
  const names: string[] = [];
  for (const [channel, count] of inFlight) {
    if (count <= 0) continue;
    names.push(count > 1 ? `${channel}x${count}` : channel);
    if (names.length >= max) break;
  }
  return { lastChannel: lastIpcChannel, lastStartedAt: lastIpcStartedAt, inFlight: names };
}

/** The last IPC channel a handler started for, or null. */
export function lastIpcChannelStarted(): string | null {
  return lastIpcChannel;
}

function noteIpcStart(channel: string, at: number): void {
  lastIpcChannel = channel;
  lastIpcStartedAt = at;
  inFlight.set(channel, (inFlight.get(channel) ?? 0) + 1);
}

function noteIpcEnd(channel: string): void {
  const n = (inFlight.get(channel) ?? 1) - 1;
  if (n <= 0) inFlight.delete(channel);
  else inFlight.set(channel, n);
}

/** Test seam: forget recorded IPC activity. */
export function resetIpcActivityForTests(): void {
  lastIpcChannel = null;
  lastIpcStartedAt = 0;
  inFlight.clear();
}

function formatBytes(bytes: number): string {
  return bytes > REPLY_SIZE_CAP_BYTES ? `${REPLY_SIZE_CAP_BYTES}+` : String(bytes);
}

/** Patch `target.handle` so every registered handler's reply is measured during a sync. Idempotent. */
export function wrapHandleForReplySize(target: HandleTarget, deps: ReplySizeDeps): void {
  const marked = target as HandleTarget & { [WRAPPED]?: true };
  if (marked[WRAPPED]) return;
  const original = target.handle.bind(target);
  target.handle = (channel, listener) =>
    original(channel, async (event: unknown, ...args: unknown[]) => {
      const started = deps.now();
      try {
        noteIpcStart(channel, started);
      } catch {
        // Telemetry only.
      }
      let result: unknown;
      let threw = false;
      try {
        result = await listener(event, ...args);
        return result;
      } catch (error) {
        threw = true;
        throw error;
      } finally {
        try {
          noteIpcEnd(channel);
        } catch {
          // Telemetry only.
        }
        // Measured at most once per reply, shared by both lines below.
        let bytes: number | null = null;
        const measure = (): number => {
          if (bytes === null) bytes = approxSerializedBytes(result);
          return bytes;
        };
        const durationMs = Math.round(deps.now() - started);
        try {
          if (durationMs >= SLOW_HANDLER_MS) {
            deps.log(
              threw
                ? `[IpcSlowHandler] channel=${channel} durationMs=${durationMs} threw=1`
                : `[IpcSlowHandler] channel=${channel} durationMs=${durationMs} approxBytes=${formatBytes(measure())}`,
            );
          }
        } catch {
          // Telemetry only: never affects the reply.
        }
        try {
          const phase = threw ? null : deps.phase();
          if (phase !== null) {
            const size = measure();
            if (size >= LARGE_REPLY_BYTES) {
              deps.log(
                `[IpcReplySize] channel=${channel} approxBytes=${formatBytes(size)}` +
                  ` durationMs=${durationMs} phase=${phase}`,
              );
            }
          }
        } catch {
          // Telemetry only: never affects the reply.
        }
      }
    });
  marked[WRAPPED] = true;
}

/** The current phase source (read at reply time). */
export function currentIpcReplySizePhase(): string | null {
  return phaseSource();
}
