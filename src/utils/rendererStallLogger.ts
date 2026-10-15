/**
 * BACKLOG-3884: name every renderer stall of >= 1 s in main.log.
 *
 * Electron's `unresponsive` event fires only after its hang timeout (several
 * seconds), and the window-freeze report acts at >= 10 s, so a 1-8 s freeze of
 * the renderer's main thread left no line at all. This watches the renderer
 * itself:
 *
 *   - PerformanceObserver "longtask": Chromium reports every task over 50 ms
 *     with its duration. A task of >= STALL_LOG_MS logs one line.
 *   - Fallback when "longtask" is not supported: a requestAnimationFrame gap of
 *     >= STALL_LOG_MS while the document stayed visible (rAF pauses for hidden
 *     windows, which is not a stall).
 *
 * The line goes through the renderer logger, which relays it to main.log as
 * `[Renderer] ...`:
 *
 *   [RendererStall] durationMs=<n> screen=<screen name> phase=<phase> source=<longtask|raf>
 *
 * Names and numbers only: the screen NAME (getCurrentScreenName) and a phase
 * NAME set by the code that knows what it is doing (setRendererStallPhase).
 * At most one line per STALL_LOG_MIN_INTERVAL_MS; stalls inside the interval
 * are counted and reported as `suppressed=<n>` on the next line.
 */
import logger from "./logger";
import { getCurrentScreenName } from "./currentScreenName";

export const STALL_LOG_MS = 1_000;
export const STALL_LOG_MIN_INTERVAL_MS = 5_000;

let phase: string | null = null;

/** The phase a stall should be attributed to, or null to clear. Names only. */
export function setRendererStallPhase(next: string | null): void {
  phase = next;
}

export function getRendererStallPhase(): string | null {
  return phase;
}

export interface StallReporterDeps {
  now: () => number;
  log: (line: string) => void;
  screen: () => string;
  phase: () => string | null;
}

/** The rate-limited formatter, separated from the browser observers for tests. */
export function createStallReporter(deps: StallReporterDeps): (durationMs: number, source: "longtask" | "raf") => boolean {
  let lastAt: number | null = null;
  let suppressed = 0;
  return (durationMs, source) => {
    try {
      if (!(durationMs >= STALL_LOG_MS)) return false;
      const at = deps.now();
      if (lastAt !== null && at - lastAt < STALL_LOG_MIN_INTERVAL_MS) {
        suppressed += 1;
        return false;
      }
      lastAt = at;
      const extra = suppressed > 0 ? ` suppressed=${suppressed}` : "";
      suppressed = 0;
      deps.log(
        `[RendererStall] durationMs=${Math.round(durationMs)} screen=${deps.screen()}` +
          ` phase=${deps.phase() ?? "none"} source=${source}${extra}`,
      );
      return true;
    } catch {
      return false; // Telemetry only.
    }
  };
}

let installed = false;

/** Install once at renderer start. Never throws. Returns how stalls are observed. */
export function installRendererStallLogger(
  env: {
    PerformanceObserver?: typeof PerformanceObserver;
    requestAnimationFrame?: (cb: FrameRequestCallback) => number;
    document?: Document;
    now?: () => number;
    log?: (line: string) => void;
  } = {},
): "longtask" | "raf" | "none" {
  if (installed) return "none";
  try {
    const now = env.now ?? (() => performance.now());
    const report = createStallReporter({
      now,
      log: env.log ?? ((line) => logger.warn(line)),
      screen: () => getCurrentScreenName(),
      phase: () => phase,
    });
    const PO = env.PerformanceObserver ?? (typeof PerformanceObserver !== "undefined" ? PerformanceObserver : undefined);
    const supported = PO?.supportedEntryTypes ?? [];
    if (PO && supported.includes("longtask")) {
      const observer = new PO((list) => {
        for (const entry of list.getEntries()) report(entry.duration, "longtask");
      });
      observer.observe({ type: "longtask", buffered: false });
      installed = true;
      return "longtask";
    }
    const raf = env.requestAnimationFrame ?? (typeof requestAnimationFrame !== "undefined" ? requestAnimationFrame : undefined);
    const doc = env.document ?? (typeof document !== "undefined" ? document : undefined);
    if (!raf || !doc) return "none";
    let last: number | null = null;
    const tick = () => {
      const t = now();
      if (doc.visibilityState !== "visible") {
        last = null;
      } else {
        if (last !== null) report(t - last, "raf");
        last = t;
      }
      raf(tick);
    };
    doc.addEventListener?.("visibilitychange", () => {
      last = null;
    });
    raf(tick);
    installed = true;
    return "raf";
  } catch {
    return "none";
  }
}

/** Test seam. */
export function __resetRendererStallLoggerForTests(): void {
  installed = false;
  phase = null;
}
