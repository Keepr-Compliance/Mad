/**
 * BACKLOG-3784 — iPhone sync telemetry, main half.
 *
 * - `completion-shown`: the renderer's ack is measured against the sync start and the
 *   storage-complete send, even though `endSync` has already cleared the live state
 *   (syncHandlers calls `endSync("complete")` BEFORE it sends `sync:storage-complete`).
 * - `renderer-gap`: silent while the renderer ticks; one line when ticks resume after
 *   more than 3 s.
 * - `WindowResponsivenessTracker`: an unresponsive→responsive pair logs the duration;
 *   Sentry only above 5 s, at most once per 10 min, tags only.
 */

import { SyncTimeline } from "../syncTimeline";
import {
  WindowResponsivenessTracker,
  durationBucket,
  SENTRY_THROTTLE_MS,
} from "../windowResponsivenessTracker";

function makeTimeline() {
  let t = 0;
  const lines: string[] = [];
  const timeline = new SyncTimeline({
    now: () => t,
    sink: (l) => lines.push(l),
    reporter: () => {},
    runReporter: null,
  });
  return {
    timeline,
    lines,
    at: (ms: number) => {
      t = ms;
    },
  };
}

describe("BACKLOG-3784: completion-shown", () => {
  it("logs elapsed from sync start, lag from the storage-complete send, and the three legs", () => {
    const { timeline, lines, at } = makeTimeline();
    at(1_000);
    timeline.beginSync();
    timeline.enter("storing:messages");
    at(1_764_439);
    timeline.endSync("complete", { messages: 37 });
    at(1_764_500);
    timeline.markStorageCompleteSent();
    at(2_052_900);
    timeline.markCompletionShown({ receivedAt: 2_052_000, shownAt: 2_052_400 });

    const line = lines.filter((l) => l.includes("completion-shown"));
    expect(line).toEqual([
      "[SyncTimeline] completion-shown elapsedMs=2051900 lagMs=288400 receivedLagMs=287500 renderMs=400 ackLagMs=500 outcome=complete",
    ]);
    expect(timeline.lastRunSnapshot()?.completionShownAt).toBe(2_052_900);
  });

  it("records once per run and ignores an ack with no ended run", () => {
    const { timeline, lines, at } = makeTimeline();
    timeline.markCompletionShown({});
    expect(lines.filter((l) => l.includes("completion-shown"))).toHaveLength(0);

    at(10);
    timeline.beginSync();
    at(20);
    timeline.endSync("complete");
    timeline.markStorageCompleteSent();
    at(30);
    timeline.markCompletionShown({});
    timeline.markCompletionShown({});
    expect(lines.filter((l) => l.includes("completion-shown"))).toEqual([
      "[SyncTimeline] completion-shown elapsedMs=20 lagMs=10 outcome=complete",
    ]);

    // A new sync forgets the old run.
    timeline.beginSync();
    expect(timeline.lastRunSnapshot()).toBeNull();
  });
});

describe("BACKLOG-3784: renderer-gap", () => {
  it("is silent while ticks arrive within 3 s, logs one line on a longer gap", () => {
    const { timeline, lines, at } = makeTimeline();
    at(0);
    timeline.beginSync();
    timeline.enter("storing:attachments");
    timeline.noteRendererTick({ first: true });
    for (let s = 1; s <= 5; s++) {
      at(s * 1000);
      timeline.noteRendererTick({});
    }
    at(8_000); // exactly 3 s after the last tick: not a gap
    timeline.noteRendererTick({});
    expect(lines.filter((l) => l.includes("renderer-gap"))).toHaveLength(0);

    at(295_000);
    timeline.noteRendererTick({ hidden: false });
    expect(lines.filter((l) => l.includes("renderer-gap"))).toEqual([
      "[SyncTimeline] renderer-gap gapMs=287000 phase=storing:attachments hidden=false",
    ]);
  });

  it("does not report the idle time before a sync's first tick", () => {
    const { timeline, lines, at } = makeTimeline();
    at(0);
    timeline.noteRendererTick({});
    at(600_000);
    timeline.noteRendererTick({ first: true });
    expect(lines.filter((l) => l.includes("renderer-gap"))).toHaveLength(0);
  });

  it("names the post-sync window when the gap closes after the sync ended", () => {
    const { timeline, lines, at } = makeTimeline();
    at(0);
    timeline.beginSync();
    timeline.noteRendererTick({ first: true });
    at(500);
    timeline.endSync("complete");
    at(10_000);
    timeline.noteRendererTick({});
    expect(lines.filter((l) => l.includes("renderer-gap"))).toEqual([
      "[SyncTimeline] renderer-gap gapMs=10000 phase=post-sync hidden=false",
    ]);
  });
});

describe("BACKLOG-3784: WindowResponsivenessTracker", () => {
  function makeTracker(phase: string | null = "post-sync") {
    let t = 0;
    const logs: string[] = [];
    const captures: Array<{ message: string; context: unknown }> = [];
    const tracker = new WindowResponsivenessTracker({
      now: () => t,
      log: (l) => logs.push(l),
      capture: (message, context) => captures.push({ message, context }),
      getPhase: () => phase,
    });
    return { tracker, logs, captures, at: (ms: number) => (t = ms) };
  }

  it("logs the duration when the window answers again", () => {
    const { tracker, logs, at } = makeTracker();
    at(1_000);
    tracker.onUnresponsive();
    at(4_000);
    expect(tracker.onResponsive()).toBe(3_000);
    expect(logs).toEqual(["[Main] Window responsive again durationMs=3000 phase=post-sync"]);
  });

  it("dates the freeze from the first unresponsive event", () => {
    const { tracker, logs, at } = makeTracker(null);
    at(1_000);
    tracker.onUnresponsive();
    at(2_000);
    tracker.onUnresponsive();
    at(9_000);
    tracker.onResponsive();
    expect(logs).toEqual(["[Main] Window responsive again durationMs=8000 phase=none"]);
  });

  it("ignores responsive with no prior freeze", () => {
    const { tracker, logs, captures } = makeTracker();
    expect(tracker.onResponsive()).toBeNull();
    expect(logs).toEqual([]);
    expect(captures).toEqual([]);
  });

  it("sends Sentry only above 5 s, with tags only", () => {
    const { tracker, captures, at } = makeTracker("storing:messages");
    at(0);
    tracker.onUnresponsive();
    at(5_000); // exactly 5 s: not above the threshold
    tracker.onResponsive();
    expect(captures).toHaveLength(0);

    at(10_000);
    tracker.onUnresponsive();
    at(15_001);
    tracker.onResponsive();
    expect(captures).toEqual([
      {
        message: "Window unresponsive (duration)",
        context: {
          level: "warning",
          tags: {
            kind: "window_unresponsive",
            duration_bucket: "5s_15s",
            sync_phase: "storing:messages",
          },
        },
      },
    ]);
  });

  it("sends at most one Sentry event per 10 minutes", () => {
    const { tracker, captures, logs, at } = makeTracker();
    const freeze = (start: number, ms: number) => {
      at(start);
      tracker.onUnresponsive();
      at(start + ms);
      tracker.onResponsive();
    };
    freeze(0, 60_000); // ends at 60_000 -> sent
    freeze(120_000, 60_000); // ends at 180_000, inside the window -> not sent
    freeze(60_000 + SENTRY_THROTTLE_MS - 10_001, 10_000); // ends 1 ms before the window closes
    expect(captures).toHaveLength(1);
    freeze(60_000 + SENTRY_THROTTLE_MS - 10_000, 10_000); // ends exactly as it closes -> sent
    expect(captures).toHaveLength(2);
    expect(logs).toHaveLength(4);
  });

  it("buckets durations coarsely", () => {
    expect(durationBucket(4_999)).toBe("lt_5s");
    expect(durationBucket(5_000)).toBe("5s_15s");
    expect(durationBucket(14_999)).toBe("5s_15s");
    expect(durationBucket(15_000)).toBe("15s_60s");
    expect(durationBucket(59_999)).toBe("15s_60s");
    expect(durationBucket(60_000)).toBe("1m_5m");
    expect(durationBucket(299_999)).toBe("1m_5m");
    expect(durationBucket(300_000)).toBe("gte_5m");
  });
});
