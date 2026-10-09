/**
 * BACKLOG-3785: AUTOMATIC RENDERER CPU PROFILE ON FREEZE.
 *
 * During an iPhone sync the renderer ticks main once a second (BACKLOG-3784
 * heartbeat, `sync:renderer-tick`). Twice in the field the renderer then went
 * silent for ~5 minutes while main stayed live, and nothing in the logs names
 * what the renderer was running.
 *
 * WHY THE PROFILER IS STARTED BEFORE THE FREEZE. CDP `Profiler.*` commands are
 * dispatched on the renderer's main thread: measured on this repo's Electron, a
 * `Profiler.enable` sent to a renderer stuck in a 15 s loop resolved only after
 * the loop ended. Attaching once the silence is noticed would profile the idle
 * AFTER the freeze. So while the heartbeat runs, the profiler runs (5 ms
 * sampling, restarted every 60 s so a profile holds at most ~60 s before a
 * freeze plus the freeze), and V8's sampler — its own thread — records the
 * block. When ticks resume after a long gap, main stops the profiler, logs a
 * summary and writes the profile.
 *
 * A capture needs ALL of:
 *   - a gap > 10 s between two heartbeat ticks (the later may be the `stopped`
 *     tick the renderer sends when the sync leaves "syncing");
 *   - neither tick reported a hidden window (a hidden window's timers are
 *     throttled — a gap there is not a hang);
 *   - main was responsive for the whole gap (a 1 s watchdog that only runs
 *     while armed saw no late run, and has run within the last 2 s) — otherwise
 *     the gap is main's own block delaying the ticks;
 *   - at least 10 minutes since the previous capture.
 *
 * Never with DevTools open or another debugger attached; detaches when DevTools
 * opens, when the sync stops, and on any failure. Every failure is logged and
 * swallowed: this is telemetry and must never crash or block anything.
 *
 * The profile is written ENCRYPTED with the at-rest file key (a profile can
 * contain strings) under userData/diagnostics/, newest 3 kept, at most 20 MB.
 * If it cannot be encrypted it is not written. The log line carries function
 * names and file basenames:line only — no URLs, paths or argument values.
 */

import * as fs from "fs";
import * as path from "path";
import { Readable } from "stream";
import { app } from "electron";
import log from "electron-log";
import { hostAppPaths } from "../capabilities/appPathsProvider";
import { hostErrorReporter } from "../capabilities/errorReporterProvider";
import type { CaptureMessageOptions } from "../capabilities/errorReporter";
import { getAtRestFiles } from "./atRest/dataKeyService";
import { isCrashReportingEnabled } from "./crashReportingPreference";
import { syncTimeline } from "./syncTimeline";

export const FREEZE_SILENCE_MS = 10_000;
export const FREEZE_CAPTURE_MIN_INTERVAL_MS = 10 * 60_000;
export const WATCHDOG_INTERVAL_MS = 1_000;
/** A watchdog run this much later than scheduled counts as a main-thread stall. */
export const MAIN_STALL_MS = 1_000;
export const PROFILE_ROLL_MS = 60_000;
export const PROFILE_SAMPLING_INTERVAL_US = 20_000;
/** The profiler keeps running this long after the sync ends (the field freezes began right after it). */
export const POST_SYNC_PROFILE_MS = 3 * 60_000;
/** A window `unresponsive` -> `responsive` freeze at least this long is reported. */
export const WINDOW_FREEZE_REPORT_MS = 10_000;
/** Wait this long before reporting a window freeze, so a profiled capture of the same freeze wins. */
export const WINDOW_FREEZE_REPORT_DELAY_MS = 2_000;

/**
 * Sync phases in which the renderer is profiled: everything AFTER the device
 * backup (idevicebackup2) has finished — decrypting, parsing, resolving, cleanup,
 * storing:* — plus "running" (the hand-off between a closed phase and the next,
 * which is exactly where the field freezes began) and "post-sync" (the first
 * POST_SYNC_PROFILE_MS after the sync ends). Never during "backup*".
 */
export function isProfilingPhase(phase: string | null): boolean {
  if (phase === null) return false;
  if (phase.startsWith("backup")) return false;
  return (
    phase === "running" ||
    phase === "post-sync" ||
    phase === "decrypting" ||
    phase === "resolving" ||
    phase === "cleanup" ||
    phase.startsWith("parsing") ||
    phase.startsWith("storing")
  );
}

/**
 * ONE limit for every freeze report — a profiled capture or a window freeze —
 * at most one per FREEZE_CAPTURE_MIN_INTERVAL_MS.
 */
export class FreezeReportGate {
  private lastAt: number | null = null;
  /** Takes the slot when it is free. */
  tryAcquire(now: number): boolean {
    if (this.lastAt !== null && now - this.lastAt < FREEZE_CAPTURE_MIN_INTERVAL_MS) return false;
    this.lastAt = now;
    return true;
  }
}

export const freezeReportGate = new FreezeReportGate();

let lastScreenName = "unknown";
/** The renderer reports its screen NAME on change (and with each sync tick). */
export function noteScreenName(screen: unknown): void {
  lastScreenName = sanitizeScreenName(screen);
}
export function currentScreenName(): string {
  return lastScreenName;
}
export const CDP_COMMAND_TIMEOUT_MS = 15_000;
/**
 * The capture's Profiler.stop may wait behind a renderer that re-blocked right
 * after the tick that ended the gap. Main is idle meanwhile, so wait longer
 * rather than lose the profile.
 */
export const CAPTURE_STOP_TIMEOUT_MS = 120_000;
export const MAX_PROFILE_BYTES = 20 * 1024 * 1024;
export const MAX_PROFILES_KEPT = 3;
export const PROFILE_DIR_NAME = "diagnostics";
export const PROFILE_FILE_PREFIX = "renderer-freeze-";
export const PROFILE_FILE_SUFFIX = ".cpuprofile.kenc";

/** The slice of Electron's WebContents this module uses (injectable for tests). */
export interface ProfiledContents {
  isDestroyed(): boolean;
  isDevToolsOpened(): boolean;
  on(event: "devtools-opened" | "destroyed", listener: () => void): unknown;
  removeListener(event: "devtools-opened" | "destroyed", listener: () => void): unknown;
  debugger: {
    isAttached(): boolean;
    attach(protocolVersion?: string): void;
    detach(): void;
    sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>;
  };
}

export interface RendererTickInfo {
  first?: boolean;
  hidden?: boolean;
  /** The renderer's heartbeat stopped on purpose (sync left "syncing"). */
  stopped?: boolean;
  /** Screen NAME the renderer is showing (step + open modal names). Never ids. */
  screen?: string;
}

/** Screen names are app step/modal names; anything else is reported as "unknown". */
export function sanitizeScreenName(screen: unknown): string {
  return typeof screen === "string" && /^[A-Za-z0-9_+-]{1,80}$/.test(screen) ? screen : "unknown";
}

export interface FreezeProfilerDeps {
  now: () => number;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  log: { info: (msg: string) => void; warn: (msg: string) => void };
  /** Directory profiles are written to. */
  profileDir: () => string;
  /** Encrypt `data` to `destPath`. Must never write plaintext; throws when it cannot encrypt. */
  writeEncrypted: (destPath: string, data: Buffer) => Promise<void>;
  /** Send one Sentry event. Default honours the user's "Send crash reports" choice. */
  report: (message: string, options: CaptureMessageOptions) => void;
  /** The sync phase right now (syncTimeline), or null. */
  phase: () => string | null;
  appVersion: () => string;
  platform: () => string;
  /** Whether the renderer may be profiled right now (the post-backup window). */
  profilingAllowed: () => boolean;
  /** The shared freeze-report limit. */
  gate: FreezeReportGate;
}

// ---------------------------------------------------------------------------
// Sentry events (pure builders — the key sets are a privacy contract, tested exactly)
// ---------------------------------------------------------------------------

export const FREEZE_EVENT_MESSAGE = "renderer_freeze";

export interface FreezeEventFrame {
  functionName: string;
  file: string;
  line: number;
  selfMs: number;
}

/**
 * A captured freeze. Tags: app version, platform, sync phase, screen NAME.
 * Extra: the freeze length and the top self-time frames from Keepr's own bundle
 * — function name, file basename, line, ms. Nothing else from the profile.
 */
export function buildFreezeEvent(input: {
  gapMs: number;
  /** Absent when there is no profile (a window freeze): the event then has no frames key. */
  bundleSelf?: ProfileEntry[];
  phase: string | null;
  screen: string;
  appVersion: string;
  platform: string;
}): CaptureMessageOptions {
  const frames: FreezeEventFrame[] | undefined = input.bundleSelf
    ?.filter((e) => e.bundle)
    .slice(0, 10)
    .map((e) => ({ functionName: e.functionName, file: e.file, line: e.line, selfMs: e.ms }));
  return {
    level: "warning",
    tags: {
      app_version: input.appVersion,
      platform: input.platform,
      sync_phase: input.phase ?? "none",
      screen: sanitizeScreenName(input.screen),
    },
    extra: frames ? { freeze_ms: input.gapMs, top_self_frames: frames } : { freeze_ms: input.gapMs },
  };
}

/** A freeze whose profile could not be captured: duration and phase only. */
export function buildCaptureFailedEvent(input: { gapMs: number; phase: string | null }): CaptureMessageOptions {
  return {
    level: "warning",
    tags: { sync_phase: input.phase ?? "none", capture: "failed" },
    extra: { freeze_ms: input.gapMs },
  };
}

// ---------------------------------------------------------------------------
// Profile summary (pure)
// ---------------------------------------------------------------------------

interface CpuProfileNode {
  id: number;
  callFrame: { functionName?: string; url?: string; lineNumber?: number };
  children?: number[];
}

export interface CpuProfile {
  nodes: CpuProfileNode[];
  startTime: number;
  endTime: number;
  samples?: number[];
  timeDeltas?: number[];
}

export interface ProfileEntry {
  /** Log form: "name file:line" (or the bare name for a runtime/native frame). */
  label: string;
  functionName: string;
  /** URL BASENAME only ("" for a frame with no script). */
  file: string;
  /** 1-based; 0 when unknown. */
  line: number;
  /** The frame is Keepr's own renderer bundle (app:// in a packaged build, the dev server in dev). */
  bundle: boolean;
  ms: number;
}

export interface ProfileSummary {
  samples: number;
  sampledMs: number;
  self: ProfileEntry[];
  total: ProfileEntry[];
  /** Top self-time frames from Keepr's bundle only (for Sentry). */
  bundleSelf: ProfileEntry[];
}

/**
 * Keepr's own renderer code: `app://` (packaged) or the local dev server, and not
 * a dependency pre-bundle under /node_modules/. Electron internals (node:electron/…),
 * extensions and native/runtime frames ("(program)", "(garbage collector)") are not.
 */
export function isBundleUrl(url: string | undefined): boolean {
  if (!url) return false;
  if (url.includes("/node_modules/")) return false;
  return url.startsWith("app://") || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(url);
}

interface FrameKey {
  label: string;
  functionName: string;
  file: string;
  line: number;
  bundle: boolean;
}

/** Function name + file BASENAME:line. Never the URL or path (it can hold a home directory). */
export function frameKey(frame: CpuProfileNode["callFrame"]): FrameKey {
  const functionName = frame.functionName && frame.functionName.length > 0 ? frame.functionName : "(anonymous)";
  const url = frame.url ?? "";
  if (url.length === 0) return { label: functionName, functionName, file: "", line: 0, bundle: false };
  const file = url.split(/[?#]/)[0].split(/[\\/]/).pop() || "?";
  const line = typeof frame.lineNumber === "number" && frame.lineNumber >= 0 ? frame.lineNumber + 1 : 0;
  return { label: `${functionName} ${file}:${line}`, functionName, file, line, bundle: isBundleUrl(url) };
}

export function frameLabel(frame: CpuProfileNode["callFrame"]): string {
  return frameKey(frame).label;
}

/**
 * Top-N self and inclusive time per function over the LAST `windowMs` of the
 * profile (the freeze), or the whole profile when `windowMs` is omitted.
 */
export function summarizeProfile(profile: CpuProfile, windowMs?: number, topN = 10): ProfileSummary {
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  const byId = new Map<number, CpuProfileNode>();
  const parent = new Map<number, number>();
  for (const node of profile.nodes) {
    byId.set(node.id, node);
    for (const child of node.children ?? []) parent.set(child, node.id);
  }

  // Sample timestamps (µs, profile clock).
  const stamps: number[] = new Array(samples.length);
  let t = profile.startTime;
  for (let i = 0; i < samples.length; i++) {
    t += deltas[i] ?? 0;
    stamps[i] = t;
  }
  const windowStart = windowMs === undefined ? -Infinity : profile.endTime - windowMs * 1000;

  const keys = new Map<string, FrameKey>();
  const keyOf = (node: CpuProfileNode): FrameKey => {
    const key = frameKey(node.callFrame);
    if (!keys.has(key.label)) keys.set(key.label, key);
    return key;
  };
  const self = new Map<string, number>();
  const total = new Map<string, number>();
  let counted = 0;
  let countedUs = 0;
  for (let i = 0; i < samples.length; i++) {
    if (stamps[i] < windowStart) continue;
    const next = i + 1 < samples.length ? stamps[i + 1] : profile.endTime;
    const us = Math.max(0, next - stamps[i]);
    counted++;
    countedUs += us;
    const leaf = byId.get(samples[i]);
    if (!leaf) continue;
    const leafLabel = keyOf(leaf).label;
    self.set(leafLabel, (self.get(leafLabel) ?? 0) + us);
    const seen = new Set<string>();
    let id: number | undefined = leaf.id;
    while (id !== undefined) {
      const node = byId.get(id);
      if (!node) break;
      if (node.callFrame.functionName !== "(root)") {
        const label = keyOf(node).label;
        if (!seen.has(label)) {
          seen.add(label);
          total.set(label, (total.get(label) ?? 0) + us);
        }
      }
      id = parent.get(id);
    }
  }

  const top = (m: Map<string, number>, onlyBundle = false): ProfileEntry[] =>
    [...m.entries()]
      .filter(([label]) => !onlyBundle || keys.get(label)!.bundle)
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([label, us]) => ({ ...keys.get(label)!, ms: Math.round(us / 1000) }));

  return {
    samples: counted,
    sampledMs: Math.round(countedUs / 1000),
    self: top(self),
    total: top(total),
    bundleSelf: top(self, true),
  };
}

function formatEntries(entries: ProfileEntry[]): string {
  return entries.map((e) => `${e.label} ${e.ms}ms`).join("; ");
}

// ---------------------------------------------------------------------------
// The profiler
// ---------------------------------------------------------------------------

type ArmState = "off" | "blocked" | "on";

export class RendererFreezeProfiler {
  private readonly deps: FreezeProfilerDeps;
  private contents: ProfiledContents | null = null;
  private state: ArmState = "off";
  private profilingSince: number | null = null;
  private lastTickAt: number | null = null;
  private lastTickHidden = false;
  private lastScreen = "unknown";
  private watchdog: unknown = null;
  private lastWatchdogAt: number | null = null;
  private lastStallAt: number | null = null;
  private capturing = false;
  /** Every CDP operation runs through this chain, one at a time. */
  private queue: Promise<void> = Promise.resolve();
  private readonly onDevToolsOpened = (): void => {
    this.deps.log.info("[FreezeProfiler] DevTools opened; profiler detached");
    this.enqueue(() => this.disarm());
  };
  private readonly onDestroyed = (): void => {
    this.forget();
  };

  constructor(deps: Partial<FreezeProfilerDeps> = {}) {
    this.deps = {
      now: deps.now ?? (() => Date.now()),
      setInterval:
        deps.setInterval ??
        ((fn, ms) => {
          const h = setInterval(fn, ms);
          if (typeof h === "object" && h && "unref" in h) (h as NodeJS.Timeout).unref();
          return h;
        }),
      clearInterval: deps.clearInterval ?? ((h) => clearInterval(h as NodeJS.Timeout)),
      log: deps.log ?? { info: (m) => log.info(m), warn: (m) => log.warn(m) },
      profileDir: deps.profileDir ?? (() => path.join(hostAppPaths.userData(), PROFILE_DIR_NAME)),
      profilingAllowed:
        deps.profilingAllowed ?? (() => isProfilingPhase(syncTimeline.currentPhase(POST_SYNC_PROFILE_MS))),
      gate: deps.gate ?? freezeReportGate,
      writeEncrypted:
        deps.writeEncrypted ??
        (async (destPath, data) => {
          await getAtRestFiles().encryptStreamToFile(Readable.from([data]), destPath);
        }),
      report:
        deps.report ??
        ((message, options) => {
          if (!isCrashReportingEnabled()) return;
          hostErrorReporter.captureMessage(message, options);
        }),
      phase: deps.phase ?? (() => syncTimeline.currentPhase()),
      appVersion: deps.appVersion ?? (() => app.getVersion()),
      platform: deps.platform ?? (() => process.platform),
    };
  }

  /** A heartbeat tick arrived from `contents`. Never throws. */
  noteTick(contents: ProfiledContents, tick: RendererTickInfo = {}): void {
    try {
      this.handleTick(contents, tick);
    } catch (error) {
      this.deps.log.warn(`[FreezeProfiler] tick handling failed; ignored: ${describe(error)}`);
    }
  }

  /** Settles once every queued CDP operation has finished (tests, shutdown). */
  idle(): Promise<void> {
    return this.queue;
  }

  private handleTick(contents: ProfiledContents, tick: RendererTickInfo): void {
    const now = this.deps.now();

    let contentsChanged = false;
    if (this.contents !== contents) {
      contentsChanged = true;
      if (this.contents) {
        // A different renderer: let go of the old one first (queued, so it runs
        // against the old contents before anything is armed on the new one).
        const previousContents = this.contents;
        this.enqueue(async () => {
          this.contents = previousContents;
          try {
            await this.disarm();
          } finally {
            this.contents = contents;
            // A refusal (DevTools) belonged to the old renderer.
            if (this.state === "blocked") this.state = "off";
          }
        });
      }
      this.contents = contents;
      this.lastTickAt = null;
    }

    if (tick.first) {
      // A new sync's first tick: never a gap. A previous refusal (DevTools) is re-checked.
      this.lastTickAt = null;
      if (this.state === "blocked") this.state = "off";
    }

    const previous = this.lastTickAt;
    const previousHidden = this.lastTickHidden;
    // The screen at the START of a gap is the one the freeze happened on.
    const previousScreen = this.lastScreen;
    this.lastTickAt = now;
    this.lastTickHidden = tick.hidden === true;
    this.lastScreen = sanitizeScreenName(tick.screen);
    if (tick.screen !== undefined) noteScreenName(tick.screen);

    if (previous !== null && this.state === "on" && !this.capturing) {
      const gapMs = now - previous;
      if (gapMs > FREEZE_SILENCE_MS) {
        const reason = this.captureRefusal(previous, now, previousHidden || tick.hidden === true);
        if (reason === null) {
          this.capturing = true;
          this.enqueue(() => this.capture(gapMs, previousScreen));
        } else {
          this.deps.log.info(`[FreezeProfiler] renderer gap ${gapMs}ms not captured: ${reason}`);
        }
      }
    }

    if (tick.stopped) {
      this.enqueue(() => this.disarm());
      return;
    }

    // BACKLOG-3785: profile only in the post-backup window (never during the backup).
    const allowed = this.safe(() => this.deps.profilingAllowed(), false);
    if (!allowed) {
      if (this.state === "on" && !this.capturing) this.enqueue(() => this.disarm());
      return;
    }

    if (this.state === "off" || contentsChanged) {
      // After a renderer change the old one's disarm is queued ahead of this.
      this.enqueue(() => this.arm());
    } else if (
      this.state === "on" &&
      !this.capturing &&
      this.profilingSince !== null &&
      now - this.profilingSince >= PROFILE_ROLL_MS
    ) {
      this.profilingSince = now; // claim the roll so later ticks do not queue another
      this.enqueue(() => this.roll());
    }
  }

  /** null when a capture may run; otherwise why not. */
  private captureRefusal(gapStart: number, now: number, hidden: boolean): string | null {
    if (hidden) return "window hidden (timer throttling)";
    if (!this.mainWasResponsive(gapStart, now)) return "main was not responsive during the gap";
    // Last, because it takes the shared slot when it is free.
    if (!this.deps.gate.tryAcquire(now)) return "rate limited";
    return null;
  }

  private mainWasResponsive(gapStart: number, now: number): boolean {
    if (this.lastWatchdogAt === null || now - this.lastWatchdogAt > 2 * WATCHDOG_INTERVAL_MS) return false;
    if (this.lastStallAt !== null && this.lastStallAt > gapStart) return false;
    return true;
  }

  private startWatchdog(): void {
    if (this.watchdog !== null) return;
    this.lastWatchdogAt = this.deps.now();
    this.lastStallAt = null;
    this.watchdog = this.deps.setInterval(() => {
      const at = this.deps.now();
      if (this.lastWatchdogAt !== null && at - this.lastWatchdogAt - WATCHDOG_INTERVAL_MS > MAIN_STALL_MS) {
        this.lastStallAt = at;
      }
      this.lastWatchdogAt = at;
    }, WATCHDOG_INTERVAL_MS);
  }

  private stopWatchdog(): void {
    if (this.watchdog === null) return;
    this.deps.clearInterval(this.watchdog);
    this.watchdog = null;
    this.lastWatchdogAt = null;
    this.lastStallAt = null;
  }

  private enqueue(op: () => Promise<void>): void {
    this.queue = this.queue.then(op).catch((error) => {
      this.deps.log.warn(`[FreezeProfiler] operation failed; profiler detached: ${describe(error)}`);
      this.detachQuietly();
    });
  }

  private async command(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = CDP_COMMAND_TIMEOUT_MS,
  ): Promise<unknown> {
    const contents = this.contents;
    if (!contents || contents.isDestroyed()) throw new Error("renderer gone");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs);
    });
    try {
      return await Promise.race([contents.debugger.sendCommand(method, params), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async arm(): Promise<void> {
    if (this.state !== "off") return;
    const contents = this.contents;
    if (!contents || contents.isDestroyed()) return;
    if (contents.isDevToolsOpened() || contents.debugger.isAttached()) {
      this.state = "blocked";
      this.deps.log.info("[FreezeProfiler] not armed: DevTools or another debugger is attached");
      return;
    }
    contents.debugger.attach("1.3");
    this.state = "on";
    contents.on("devtools-opened", this.onDevToolsOpened);
    contents.on("destroyed", this.onDestroyed);
    this.startWatchdog();
    await this.command("Profiler.enable");
    await this.command("Profiler.setSamplingInterval", { interval: PROFILE_SAMPLING_INTERVAL_US });
    await this.startProfiling();
  }

  private async startProfiling(): Promise<void> {
    await this.command("Profiler.start");
    this.profilingSince = this.deps.now();
  }

  /** Discard the running profile and start a fresh one (bounds a profile to ~60 s before a freeze). */
  private async roll(): Promise<void> {
    if (this.state !== "on" || this.capturing) return;
    await this.command("Profiler.stop");
    await this.startProfiling();
  }

  private async capture(gapMs: number, screen: string): Promise<void> {
    const phase = this.safePhase();
    try {
      if (this.state !== "on") throw new Error("profiler not running");
      const result = (await this.command("Profiler.stop", undefined, CAPTURE_STOP_TIMEOUT_MS)) as
        | { profile?: CpuProfile }
        | undefined;
      this.profilingSince = null;
      const profile = result?.profile;
      if (!profile || !Array.isArray(profile.nodes)) throw new Error("Profiler.stop returned no profile");
      const summary = summarizeProfile(profile, gapMs + 1000);
      this.deps.log.info(
        `[FreezeProfiler] renderer-freeze gapMs=${gapMs} phase=${phase ?? "none"} screen=${screen}` +
          ` samples=${summary.samples} sampledMs=${summary.sampledMs}` +
          ` self=[${formatEntries(summary.self)}] total=[${formatEntries(summary.total)}]`,
      );
      this.sendEvent(
        buildFreezeEvent({
          gapMs,
          bundleSelf: summary.bundleSelf,
          phase,
          screen,
          appVersion: this.safe(() => this.deps.appVersion(), "unknown"),
          platform: this.safe(() => this.deps.platform(), "unknown"),
        }),
      );
      await this.writeProfile(profile);
      if (this.state === "on") {
        // Keep profiling only while the window is still open.
        if (this.safe(() => this.deps.profilingAllowed(), false)) await this.startProfiling();
        else this.detachQuietly();
      }
    } catch (error) {
      this.sendEvent(buildCaptureFailedEvent({ gapMs, phase }));
      throw error;
    } finally {
      this.capturing = false;
    }
  }

  private sendEvent(options: CaptureMessageOptions): void {
    try {
      this.deps.report(FREEZE_EVENT_MESSAGE, options);
    } catch (error) {
      this.deps.log.warn(`[FreezeProfiler] Sentry report failed; ignored: ${describe(error)}`);
    }
  }

  private safePhase(): string | null {
    return this.safe(() => this.deps.phase(), null);
  }

  private safe<T>(fn: () => T, fallback: T): T {
    try {
      return fn();
    } catch {
      return fallback;
    }
  }

  private async writeProfile(profile: CpuProfile): Promise<void> {
    try {
      const data = Buffer.from(JSON.stringify(profile), "utf8");
      if (data.length > MAX_PROFILE_BYTES) {
        this.deps.log.warn(`[FreezeProfiler] profile not written: ${data.length} bytes exceeds ${MAX_PROFILE_BYTES}`);
        return;
      }
      const dir = this.deps.profileDir();
      await fs.promises.mkdir(dir, { recursive: true });
      const stamp = new Date(this.deps.now()).toISOString().replace(/[:.]/g, "-");
      const name = `${PROFILE_FILE_PREFIX}${stamp}${PROFILE_FILE_SUFFIX}`;
      await this.deps.writeEncrypted(path.join(dir, name), data);
      this.deps.log.info(`[FreezeProfiler] profile written (encrypted): ${PROFILE_DIR_NAME}/${name} ${data.length} bytes`);
      await this.prune(dir);
    } catch (error) {
      this.deps.log.warn(`[FreezeProfiler] profile not written: ${describe(error)}`);
    }
  }

  private async prune(dir: string): Promise<void> {
    const names = (await fs.promises.readdir(dir))
      .filter((n) => n.startsWith(PROFILE_FILE_PREFIX) && n.endsWith(PROFILE_FILE_SUFFIX))
      .sort()
      .reverse();
    for (const stale of names.slice(MAX_PROFILES_KEPT)) {
      await fs.promises.unlink(path.join(dir, stale)).catch(() => undefined);
    }
  }

  private async disarm(): Promise<void> {
    try {
      if (this.state === "on" && this.profilingSince !== null) {
        await this.command("Profiler.stop").catch(() => undefined);
      }
    } finally {
      this.detachQuietly();
    }
  }

  /** Detach and reset. Safe to call in any state. */
  private detachQuietly(): void {
    const contents = this.contents;
    const wasOn = this.state === "on";
    this.state = this.state === "blocked" ? "blocked" : "off";
    this.profilingSince = null;
    this.stopWatchdog();
    if (!contents) return;
    try {
      contents.removeListener("devtools-opened", this.onDevToolsOpened);
      contents.removeListener("destroyed", this.onDestroyed);
    } catch {
      // ignore
    }
    if (wasOn) {
      try {
        if (!contents.isDestroyed() && contents.debugger.isAttached()) contents.debugger.detach();
      } catch (error) {
        this.deps.log.warn(`[FreezeProfiler] detach failed; ignored: ${describe(error)}`);
      }
    }
  }

  /** The renderer is gone: drop all state without talking to it. */
  private forget(): void {
    this.stopWatchdog();
    this.state = "off";
    this.profilingSince = null;
    this.contents = null;
    this.lastTickAt = null;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * BACKLOG-3785: a window freeze (Electron `unresponsive` -> `responsive`) of at
 * least WINDOW_FREEZE_REPORT_MS, at any time — not only during a sync. Sends the
 * same `renderer_freeze` event with NO frames (there is no profile), after a short
 * delay so a profiled capture of the same freeze takes the shared slot first.
 * Never throws.
 */
export function createWindowFreezeReporter(
  deps: {
    now?: () => number;
    setTimeout?: (fn: () => void, ms: number) => unknown;
    gate?: FreezeReportGate;
    report?: (message: string, options: CaptureMessageOptions) => void;
    screen?: () => string;
    appVersion?: () => string;
    platform?: () => string;
    log?: (line: string) => void;
  } = {},
): (durationMs: number, phase: string | null) => void {
  const now = deps.now ?? (() => Date.now());
  const later = deps.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const gate = deps.gate ?? freezeReportGate;
  const report =
    deps.report ??
    ((message: string, options: CaptureMessageOptions) => {
      if (!isCrashReportingEnabled()) return;
      hostErrorReporter.captureMessage(message, options);
    });
  const log = deps.log ?? ((line: string) => logInfo(line));
  return (durationMs, phase) => {
    try {
      if (!(durationMs >= WINDOW_FREEZE_REPORT_MS)) return;
      // The screen the freeze happened on: read now, before the user navigates away.
      const screen = (deps.screen ?? currentScreenName)();
      later(() => {
        try {
          if (!gate.tryAcquire(now())) {
            log(`[FreezeProfiler] window freeze ${durationMs}ms not reported: rate limited`);
            return;
          }
          report(
            FREEZE_EVENT_MESSAGE,
            buildFreezeEvent({
              gapMs: durationMs,
              phase,
              screen,
              appVersion: (deps.appVersion ?? (() => app.getVersion()))(),
              platform: (deps.platform ?? (() => process.platform))(),
            }),
          );
        } catch (error) {
          log(`[FreezeProfiler] window freeze report failed; ignored: ${describe(error)}`);
        }
      }, WINDOW_FREEZE_REPORT_DELAY_MS);
    } catch {
      // Telemetry only.
    }
  };
}

function logInfo(line: string): void {
  log.info(line);
}

/** Process singleton, fed by the `sync:renderer-tick` handler. */
export const rendererFreezeProfiler = new RendererFreezeProfiler();
