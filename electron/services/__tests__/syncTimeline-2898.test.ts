/**
 * BACKLOG-2898 — back-end step boundaries carry duration and counts.
 *
 * Foundation for BACKLOG-2894 (per-step duration/size telemetry): these
 * controls pin the FIELDS 2894 will read, so a later refactor cannot quietly
 * drop the duration or the counts and still look green.
 */

import { SyncTimeline, formatPhaseEnd } from "../syncTimeline";

/** Deterministic clock so elapsed values are exact, not approximate. */
function fixedClock(steps: number[]): () => number {
  let i = 0;
  return () => steps[Math.min(i++, steps.length - 1)];
}

describe("BACKLOG-2898: SyncTimeline phase boundaries", () => {
  it("records elapsedMs and the counts a phase produced, by exact field", () => {
    const lines: string[] = [];
    const timeline = new SyncTimeline({
      now: fixedClock([1000, 1000, 200000, 200000, 260000, 260000]),
      sink: (l) => lines.push(l),
    });

    timeline.beginSync({ platform: "win32", encrypted: true });
    timeline.enter("backup");
    timeline.annotate("backup", { files: 64213, bytes: 5798205440 });
    timeline.enter("parsing-messages");
    timeline.annotate("parsing-messages", { messages: 663000, conversations: 2337 });
    timeline.endSync("complete");

    const [backup, parsing] = timeline.records();

    expect(backup.phase).toBe("backup");
    expect(backup.elapsedMs).toBe(199000);
    expect(backup.endedAt).toBe(200000);
    expect(backup.counts.files).toBe(64213);
    expect(backup.counts.bytes).toBe(5798205440);

    expect(parsing.elapsedMs).toBe(60000);
    expect(parsing.counts.messages).toBe(663000);
    expect(parsing.counts.conversations).toBe(2337);
  });

  it("emits a phase-end line carrying elapsedMs and the counts", () => {
    const lines: string[] = [];
    const timeline = new SyncTimeline({
      now: fixedClock([0, 0, 5000, 5000]),
      sink: (l) => lines.push(l),
    });

    timeline.beginSync();
    timeline.enter("storing:attachments");
    timeline.annotate("storing:attachments", { attachments: 64000 });
    timeline.endSync("complete");

    const endLine = lines.find((l) => l.includes("phase-end"));
    expect(endLine).toContain("phase=storing:attachments");
    expect(endLine).toContain("elapsedMs=5000");
    expect(endLine).toContain("attachments=64000");
  });

  it("gives a re-entered phase its own record — never one doubled duration", () => {
    const timeline = new SyncTimeline({
      now: fixedClock([0, 0, 100, 300, 700, 700]),
      sink: () => {},
    });

    timeline.beginSync();
    timeline.enter("backup");
    timeline.enter("backup");
    timeline.endSync("complete");

    const records = timeline.records();
    expect(records).toHaveLength(2);
    expect(records[0].elapsedMs).toBe(100);
    expect(records[1].elapsedMs).toBe(400);
  });

  it("keeps the phases a CANCELLED sync completed", () => {
    const timeline = new SyncTimeline({
      now: fixedClock([0, 0, 1000, 1000, 2500, 2500]),
      sink: () => {},
    });

    timeline.beginSync();
    timeline.enter("backup");
    timeline.annotate("backup", { files: 12 });
    timeline.enter("storing:messages");
    timeline.endSync("cancelled");

    const records = timeline.records();
    expect(records.map((r) => r.phase)).toEqual(["backup", "storing:messages"]);
    expect(records[0].counts.files).toBe(12);
    expect(records.every((r) => r.elapsedMs !== null)).toBe(true);
  });

  it("logs NO per-item events — a 64,000-file phase is two lines", () => {
    const lines: string[] = [];
    const timeline = new SyncTimeline({ now: () => 0, sink: (l) => lines.push(l) });

    timeline.beginSync();
    timeline.enter("backup");
    // The real workload: 64,000 files transferred inside one phase.
    for (let i = 0; i < 64000; i++) {
      timeline.annotate("backup", { files: i + 1 });
    }
    timeline.endSync("complete");

    // sync-start, phase-start, phase-end, sync-end. Nothing per file.
    expect(lines).toHaveLength(4);
  });

  it("formats a record with the fields BACKLOG-2894 will read", () => {
    const line = formatPhaseEnd({
      phase: "decrypting",
      startedAt: 0,
      endedAt: 42,
      elapsedMs: 42,
      counts: { bytes: 100 },
    });
    expect(line).toBe("[SyncTimeline] phase-end phase=decrypting elapsedMs=42 bytes=100");
  });
});
