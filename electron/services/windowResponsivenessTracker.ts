/**
 * BACKLOG-3784 — how long the window was unresponsive.
 *
 * Electron fires `unresponsive` when the renderer stops answering and `responsive`
 * when it answers again. Until now only the start was logged, so a freeze had no
 * length. This pairs the two: one `Window responsive again durationMs=<n>` line, and
 * for freezes longer than `SENTRY_THRESHOLD_MS` one Sentry message — throttled to
 * one per `SENTRY_THROTTLE_MS` so a flapping window cannot flood it.
 *
 * PRIVACY: the Sentry event carries tags only — a fixed kind, a duration bucket and
 * a sync phase NAME. No paths, no message content, no identifiers.
 */

export const SENTRY_THRESHOLD_MS = 5_000;
export const SENTRY_THROTTLE_MS = 10 * 60_000;

export type ResponsivenessCapture = (
  message: string,
  context: { level: "warning"; tags: Record<string, string> },
) => void;

export interface ResponsivenessTrackerDeps {
  now?: () => number;
  log: (line: string) => void;
  capture: ResponsivenessCapture;
  /** The sync phase right now, or null when no sync is involved. */
  getPhase?: () => string | null;
}

/** Coarse buckets so the tag has few values and no exact durations. */
export function durationBucket(ms: number): string {
  if (ms < 5_000) return "lt_5s";
  if (ms < 15_000) return "5s_15s";
  if (ms < 60_000) return "15s_60s";
  if (ms < 300_000) return "1m_5m";
  return "gte_5m";
}

export class WindowResponsivenessTracker {
  private unresponsiveSince: number | null = null;
  private phaseAtStart: string | null = null;
  private lastSentAt: number | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: ResponsivenessTrackerDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  onUnresponsive(): void {
    // Electron can repeat `unresponsive` during one freeze; the first one dates it.
    if (this.unresponsiveSince !== null) return;
    this.unresponsiveSince = this.now();
    this.phaseAtStart = this.readPhase();
  }

  /** Returns the freeze duration in ms, or null when there was no freeze to close. */
  onResponsive(): number | null {
    if (this.unresponsiveSince === null) return null;
    const at = this.now();
    const durationMs = at - this.unresponsiveSince;
    const phase = this.phaseAtStart ?? "none";
    this.unresponsiveSince = null;
    this.phaseAtStart = null;

    this.deps.log(`[Main] Window responsive again durationMs=${durationMs} phase=${phase}`);

    if (
      durationMs > SENTRY_THRESHOLD_MS &&
      (this.lastSentAt === null || at - this.lastSentAt >= SENTRY_THROTTLE_MS)
    ) {
      this.lastSentAt = at;
      try {
        this.deps.capture("Window unresponsive (duration)", {
          level: "warning",
          tags: {
            kind: "window_unresponsive",
            duration_bucket: durationBucket(durationMs),
            sync_phase: phase,
          },
        });
      } catch {
        // Telemetry must never break the window's event handling.
      }
    }
    return durationMs;
  }

  private readPhase(): string | null {
    try {
      return this.deps.getPhase ? this.deps.getPhase() : null;
    } catch {
      return null;
    }
  }
}
