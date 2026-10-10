/**
 * BACKLOG-3884 follow-up: MAIN-PROCESS EVENT-LOOP LAG LOG.
 *
 * `[IpcSlowHandler]` times one handler at a time. It cannot see main blocked by
 * work that is not a single slow handler: timers, background sync, `ipcMain.on`
 * listeners, or many sub-second handlers back to back. This monitor can: a
 * timer that should fire every `intervalMs` and logs when it fires late.
 *
 *   [MainLag] durationMs=<n> sinceLastIpc=<channel|none> lastIpcAgoMs=<n|none>
 *             inFlight=<channels|none> syncPhase=<phase|none> [suppressed=<n>]
 *
 * `durationMs` is the lateness (gap minus interval). A drift timer under-reads a
 * block by up to one interval, so with the default 100 ms interval a block of
 * 1100 ms or more is always logged and one of 1000-1100 ms only sometimes.
 * `sinceLastIpc` is the last channel whose handler started (handle only, see
 * ipcReplySize.ts), `lastIpcAgoMs` how long before the late tick it started, and
 * `inFlight` the handlers still running then. Channel and phase names, counts
 * and ms only.
 *
 * Cost: one timer callback per 100 ms (unref'd, so it never keeps the app
 * alive). Rate limit: one line per `minLogGapMs`; lines skipped in between are
 * counted on the next line as `suppressed=<n>`. Never throws.
 */

export const MAIN_LAG_THRESHOLD_MS = 1_000;
export const MAIN_LAG_INTERVAL_MS = 100;
export const MAIN_LAG_MIN_LOG_GAP_MS = 5_000;
export const MAIN_LAG_AUTO_RESUME_TICKS = 50;

export interface MainLagContext {
  lastChannel: string | null;
  lastStartedAt: number;
  inFlight: string[];
  syncPhase: string | null;
}

export interface MainLagDeps {
  now: () => number;
  log: (line: string) => void;
  context: () => MainLagContext;
  intervalMs?: number;
  thresholdMs?: number;
  minLogGapMs?: number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export interface MainLagMonitor {
  start: () => void;
  stop: () => void;
  /** Run one check now (what the timer runs). Exposed for tests. */
  tick: () => void;
  /** Forget the last tick. */
  resetBaseline: () => void;
  /** Machine is going to sleep: ticks do nothing until `resume()`. */
  suspend: () => void;
  /** Machine woke: the next tick only sets a new baseline, it never reports a lag. */
  resume: () => void;
}

export function createMainLagMonitor(deps: MainLagDeps): MainLagMonitor {
  const intervalMs = deps.intervalMs ?? MAIN_LAG_INTERVAL_MS;
  const thresholdMs = deps.thresholdMs ?? MAIN_LAG_THRESHOLD_MS;
  const minLogGapMs = deps.minLogGapMs ?? MAIN_LAG_MIN_LOG_GAP_MS;
  const setIntervalFn = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const clearIntervalFn =
    deps.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));

  let last: number | null = null;
  let lastLoggedAt = -Infinity;
  let suppressed = 0;
  let handle: unknown = null;
  let suspended = false;
  // While suspended: ticks that arrive on schedule mean the machine is awake,
  // so a suspend that never got its resume event clears itself.
  let suspTickAt: number | null = null;
  let onScheduleTicks = 0;

  const tick = (): void => {
    try {
      if (suspended) {
        const t = deps.now();
        const onSchedule = suspTickAt === null || t - suspTickAt <= intervalMs * 1.5;
        suspTickAt = t;
        onScheduleTicks = onSchedule ? onScheduleTicks + 1 : 1;
        last = null;
        if (onScheduleTicks < MAIN_LAG_AUTO_RESUME_TICKS) return;
        suspended = false;
        last = t;
        deps.log("[MainLag] resumed without a resume event");
        return;
      }
      const now = deps.now();
      const prev = last;
      last = now;
      if (prev === null) return;
      const lag = now - prev - intervalMs;
      if (lag < thresholdMs) return;
      if (now - lastLoggedAt < minLogGapMs) {
        suppressed += 1;
        return;
      }
      const ctx = deps.context();
      const ago = ctx.lastChannel ? `${Math.max(0, Math.round(now - ctx.lastStartedAt))}` : "none";
      let line =
        `[MainLag] durationMs=${Math.round(lag)}` +
        ` sinceLastIpc=${ctx.lastChannel ?? "none"}` +
        ` lastIpcAgoMs=${ago}` +
        ` inFlight=${ctx.inFlight.length > 0 ? ctx.inFlight.join(",") : "none"}` +
        ` syncPhase=${ctx.syncPhase ?? "none"}`;
      if (suppressed > 0) line += ` suppressed=${suppressed}`;
      suppressed = 0;
      lastLoggedAt = now;
      deps.log(line);
    } catch {
      // Telemetry only.
    }
  };

  return {
    start() {
      if (handle !== null) return;
      last = deps.now();
      handle = setIntervalFn(tick, intervalMs);
      const h = handle as { unref?: () => void };
      if (typeof h?.unref === "function") h.unref();
    },
    stop() {
      if (handle === null) return;
      clearIntervalFn(handle);
      handle = null;
      last = null;
    },
    tick,
    resetBaseline() {
      last = null;
    },
    suspend() {
      suspended = true;
      suspTickAt = null;
      onScheduleTicks = 0;
      last = null;
    },
    resume() {
      suspended = false;
      last = null;
    },
  };
}
