/**
 * BACKLOG-3996: one way to stop an iPhone tool (idevice_id, ideviceinfo, idevicepair,
 * idevicebackup2), and a time limit on the short queries.
 *
 * Before this, none of the short queries had a time limit or a kill. A query that was
 * held and never answered stayed alive for good: the sync waited on it, Cancel walked
 * away from it without stopping it, and quit left it running.
 *
 * Main process only. Nothing here crosses into src/.
 *
 * ## Facts the design rests on (measured on macOS with node, 2026-10-18)
 *
 * - `ChildProcess.killed` means "a signal was SENT", not "the process died". A stopped
 *   child sent SIGTERM reads `killed === true` and stays alive. Whether a process is
 *   gone is read off `exitCode` / `signalCode` only, never `.killed`.
 * - SIGTERM does nothing to a stopped process; SIGKILL ends it.
 * - Node's `child.kill()` reaches the direct child only. A grandchild survives.
 *
 * Windows (NOT measurable from a Mac): `child.kill()` is TerminateProcess on one PID.
 * `taskkill /T /F` walks the tree by parent PID, so it must run while the parent is
 * still alive — it goes FIRST, and `child.kill()` is only the fallback.
 */
import { spawn, type ChildProcess } from "child_process";
import path from "path";
import log from "electron-log";
import * as Sentry from "@sentry/electron/main";

/**
 * The time limit on every short iPhone query (A-F in the BACKLOG-3996 plan).
 *
 * Measured, not chosen: a storage query that stalled for 60.0 s and then answered
 * (exit 0, empty) stays under the line, and a first-run security scan of about 60 s
 * is not cut off at the moment it lets the tool go. Nothing that ran past 90 s has
 * ever returned usable data. Its own constant on purpose — not shared with any other
 * 90 s budget in the app.
 *
 * idevicebackup2 is NOT covered by this: it runs for hours, and its 30-minute
 * no-progress watchdog (BackupService) already covers a held start.
 */
export const IPHONE_QUERY_TIMEOUT_MS = 90_000;

/** How long taskkill gets before `child.kill()` is used as well (taskkill can be held too). */
export const TASKKILL_FALLBACK_MS = 3_000;

/** After a kill: no 'exit' within this long is reported as a process that would not stop. */
export const KILL_EXIT_BACKSTOP_MS = 10_000;

/** The tools this module stops. Names only — never a path. */
export type IphoneToolName =
  | "idevice_id"
  | "ideviceinfo"
  | "idevicepair"
  | "idevicebackup2";

/**
 * True once the process has exited. Read off exitCode/signalCode only — `.killed`
 * is true as soon as a signal was sent, which says nothing about whether it worked.
 */
export function hasExited(proc: ChildProcess): boolean {
  return proc.exitCode !== null || proc.signalCode !== null;
}

/**
 * The absolute path of taskkill. A bare "taskkill" is resolved by libuv, which on
 * Windows looks in the current directory before PATH. `path.win32` so the result is
 * the same string whatever machine builds it.
 */
export function taskkillPath(): string {
  return path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
}

export interface KillOptions {
  tool: IphoneToolName;
  /** Why it is being stopped: "timeout", "cancel", "watchdog", "app-quit", ... */
  reason: string;
  /**
   * POSIX only. When set, send SIGTERM first and SIGKILL after this many ms if the
   * process has not exited (idevicebackup2: lets it close its session). When unset,
   * SIGKILL at once (the read-only queries). Ignored on Windows, where every kill is
   * forced.
   */
  graceMs?: number;
}

// ── Backstop reporting: once per tool per stretch ─────────────────────────────

/** Tools for which "did not exit after kill" was already sent in this stretch. */
const reportedStuck = new Set<IphoneToolName>();

/**
 * A stretch ends when a tool of that name exits on its own (it was not killed). Until
 * then a kill that keeps failing — a poll respawned every 90 s under a permanent hold —
 * sends one event, not one per kill.
 */
function noteExitedOnItsOwn(tool: IphoneToolName): void {
  reportedStuck.delete(tool);
}

function reportDidNotExit(proc: ChildProcess, opts: KillOptions, killedAt: number): void {
  const elapsedMs = Date.now() - killedAt;
  // The PID only. Never the command path (on Windows it is the install path, which can
  // hold the user name) and never the UDID.
  log.error(
    `[iPhoneTool] ${opts.tool} did not exit ${elapsedMs} ms after kill (reason=${opts.reason}, pid=${proc.pid ?? "none"})`,
  );
  if (reportedStuck.has(opts.tool)) return;
  reportedStuck.add(opts.tool);
  Sentry.captureMessage("iPhone tool did not exit after kill", {
    level: "error",
    tags: { component: "iphone_tool_process", platform: process.platform },
    extra: {
      tool: opts.tool,
      reason: opts.reason,
      elapsedMs,
      platform: process.platform,
      pid: proc.pid,
    },
  });
}

// ── The kill ──────────────────────────────────────────────────────────────────

/**
 * Stop an iPhone tool and everything it started. No-op once the process has exited.
 *
 * - Windows: taskkill /PID <pid> /T /F first (the tree walk needs the parent alive).
 *   When taskkill finishes, fails to start, or has not finished after
 *   TASKKILL_FALLBACK_MS, `proc.kill()` (TerminateProcess) if the process is still alive.
 *   taskkill exit 128 ("not found") means it was already gone.
 * - POSIX: SIGKILL, or SIGTERM then SIGKILL after `graceMs`.
 *
 * Then, KILL_EXIT_BACKSTOP_MS later, a process that still has not exited is logged and
 * reported (once per tool per stretch). Never throws.
 */
export function killIphoneToolTree(proc: ChildProcess, opts: KillOptions): void {
  if (hasExited(proc)) return;
  const killedAt = Date.now();

  if (process.platform === "win32") {
    killWindowsTree(proc, opts);
  } else if (opts.graceMs !== undefined) {
    sendSignal(proc, "SIGTERM", opts);
    const escalate = setTimeout(() => {
      if (!hasExited(proc)) sendSignal(proc, "SIGKILL", opts);
    }, opts.graceMs);
    escalate.unref?.();
  } else {
    sendSignal(proc, "SIGKILL", opts);
  }

  const backstop = setTimeout(() => {
    if (!hasExited(proc)) reportDidNotExit(proc, opts, killedAt);
  }, KILL_EXIT_BACKSTOP_MS);
  backstop.unref?.();
}

function sendSignal(proc: ChildProcess, signal: NodeJS.Signals, opts: KillOptions): void {
  try {
    proc.kill(signal);
  } catch (err) {
    log.warn(`[iPhoneTool] ${opts.tool}: ${signal} failed (reason=${opts.reason})`, err);
  }
}

function killWindowsTree(proc: ChildProcess, opts: KillOptions): void {
  let fallbackDone = false;
  const fallback = () => {
    if (fallbackDone) return;
    fallbackDone = true;
    clearTimeout(fallbackTimer);
    if (!hasExited(proc)) {
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
    }
  };
  const fallbackTimer = setTimeout(fallback, TASKKILL_FALLBACK_MS);
  fallbackTimer.unref?.();

  // A spawn that failed has no pid; "/PID undefined" is never sent.
  if (proc.pid === undefined) {
    fallback();
    return;
  }
  try {
    const tk = spawn(taskkillPath(), ["/PID", String(proc.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    tk.on("error", (err) => {
      log.warn(`[iPhoneTool] taskkill could not start for ${opts.tool} (reason=${opts.reason})`, err);
      fallback();
    });
    tk.on("exit", (code) => {
      // 128: no such process — it had already exited. Not an error.
      if (code !== 0 && code !== 128) {
        log.warn(`[iPhoneTool] taskkill exited ${code} for ${opts.tool} (reason=${opts.reason})`);
      }
      fallback();
    });
  } catch (err) {
    log.warn(`[iPhoneTool] taskkill threw for ${opts.tool} (reason=${opts.reason})`, err);
    fallback();
  }
}

// ── Supervising a short query ─────────────────────────────────────────────────

/** Every supervised query still alive. Quit stops them all. */
const live = new Map<ChildProcess, IphoneToolName>();

export interface SuperviseOptions {
  tool: IphoneToolName;
  /** Defaults to IPHONE_QUERY_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Abort stops the tool at once (Cancel). */
  signal?: AbortSignal;
  /** Called once when the time limit ran out, just BEFORE the kill is issued. */
  onTimeout: () => void;
  /** Called once when `signal` aborted, just BEFORE the kill is issued. */
  onAbort?: () => void;
}

export interface Supervision {
  /** The call site settled on its own: stop the timer and the abort listener. */
  done(): void;
}

/**
 * Put a just-spawned short query under a time limit, Cancel, and quit. Call right
 * after `spawn()`. The call site keeps its own handlers and must ignore anything that
 * arrives after it settled — including the 'close' of the killed process.
 */
export function superviseIphoneTool(proc: ChildProcess, opts: SuperviseOptions): Supervision {
  let finished = false;
  let killedByUs = false;
  live.set(proc, opts.tool);

  const cleanup = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  };

  const onGone = () => {
    live.delete(proc);
    if (!killedByUs) noteExitedOnItsOwn(opts.tool);
    cleanup();
  };
  // 'close' too: some exits are only seen as 'close'.
  proc.once("exit", onGone);
  proc.once("close", onGone);

  const stop = (reason: string, then: (() => void) | undefined) => {
    if (finished) return;
    cleanup();
    killedByUs = true;
    // The call site settles FIRST, then the kill goes out. The kill can make the
    // process emit 'close' at once (and does, in jest fakes); the site must already
    // count as settled so that close is ignored, not read as a failed run.
    try {
      then?.();
    } finally {
      killIphoneToolTree(proc, { tool: opts.tool, reason });
    }
  };

  const onAbort = () => stop("cancel", opts.onAbort);
  const timer = setTimeout(() => stop("timeout", opts.onTimeout), opts.timeoutMs ?? IPHONE_QUERY_TIMEOUT_MS);
  timer.unref?.();

  if (opts.signal) {
    if (opts.signal.aborted) {
      // Defer so the caller has its handlers attached before onAbort runs.
      void Promise.resolve().then(onAbort);
    } else {
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  return { done: cleanup };
}

/**
 * Stop every supervised query still alive. Used on app quit: an undetached child is
 * not killed when the parent exits, so an abandoned query would outlive the app.
 * Returns how many were stopped.
 */
export function killAllIphoneTools(reason: string): number {
  const procs = [...live.entries()];
  for (const [proc, tool] of procs) {
    killIphoneToolTree(proc, { tool, reason });
  }
  return procs.length;
}

/** Test seam: the number of supervised queries still alive. */
export function __liveIphoneToolCountForTests(): number {
  return live.size;
}

/** Test seam: forget every supervised query and every backstop report. */
export function __resetIphoneToolProcessForTests(): void {
  live.clear();
  reportedStuck.clear();
}
