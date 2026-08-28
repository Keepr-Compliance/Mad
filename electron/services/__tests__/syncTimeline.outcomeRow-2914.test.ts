/**
 * BACKLOG-2914 (built as FIX 4 of BACKLOG-2911) — THE DURATION AXIS: one row per sync,
 * success included, with the dimensions that make a duration comparable.
 *
 * ## Why the success row is the point
 *
 * Grepping the founder's complete 2026-08-28 session for "Sync completed" / "Backup
 * Successful" / a total returns NOTHING. The phases end and the run stops. A count of
 * failures without a count of successes is not a rate — it is a count — and all three
 * consumers of this data need the denominator first:
 *
 *   2914  a release that made syncs slower, visible without user reports
 *   2894  telling a user how long their sync will take
 *   2952  a failure uptick per SOURCE per release
 *
 * 2952 is what constrains the shape: it EXTENDS this row rather than defining a second
 * one, so `source` is a field from the first commit even though there is one source.
 *
 * ## Scope, deliberately
 *
 * THE DURATION AXIS ONLY. No `reason_code`, no failure taxonomy. BACKLOG-2909 (a
 * successful sync reporting "Sync Failed" on disconnect) and BACKLOG-2903 (normal
 * chatter logged as an error pattern) are both open, and a failure rate computed over
 * them would be confidently wrong. Neither touches durations.
 *
 * ## The measurement this is built from
 *
 * The founder's first complete end-to-end run, 2026-08-28, transcribed from SyncTimeline:
 *
 *   phase=backup            elapsedMs=3131816  bytes=61217118530  incremental=true
 *   phase=parsing-contacts  elapsedMs=24       contacts=1176
 *   phase=parsing-messages  elapsedMs=20427    messages=663722
 *   phase=resolving         elapsedMs=113
 *   phase=cleanup           elapsedMs=246270
 *
 * Two of those numbers are wrong and this file pins both fixes:
 *   - `incremental=true` on a 61.2 GB / 52-minute run whose Status.plist said
 *     `IsFullBackup: 1`. See `deviceReportedBackupMode`.
 *   - `cleanup` at 4 min 6 s for closing two SQLite parsers — it stayed OPEN across the
 *     IPC handoff and absorbed the start of the 663,722-row message write.
 */

import { SyncTimeline } from "../syncTimeline";

function outcomeRows(lines: string[]): string[] {
  return lines.filter((l) => l.includes("sync-outcome"));
}

function theOutcomeRow(lines: string[]): string {
  const rows = outcomeRows(lines);
  if (rows.length !== 1) throw new Error(`expected exactly one outcome row, got ${rows.length}`);
  return rows[0];
}

function makeTimeline(): { timeline: SyncTimeline; lines: string[]; tick: (ms: number) => void } {
  const lines: string[] = [];
  let clock = 0;
  const timeline = new SyncTimeline({ now: () => clock, sink: (l) => lines.push(l) });
  return { timeline, lines, tick: (ms: number) => { clock += ms; } };
}

// ---------------------------------------------------------------------------
// CONTROL (a) — the denominator
// ---------------------------------------------------------------------------

describe("BACKLOG-2914: every sync produces exactly one outcome row", () => {
  it("THE CONTROL — a SUCCESSFUL sync emits one", () => {
    // Delete the emit in `endSync` and this is the case that reds. Without it there is
    // no denominator and every rate built on this data is a count wearing a percent sign.
    const { timeline, lines } = makeTimeline();

    timeline.beginSync();
    timeline.enter("backup");
    timeline.endSync("complete", { messages: 663722 });

    expect(theOutcomeRow(lines)).toContain("outcome=complete");
    expect(theOutcomeRow(lines)).toContain("messages=663722");
  });

  it("a FAILED sync emits one too, with the same shape", () => {
    const { timeline, lines } = makeTimeline();

    timeline.beginSync();
    timeline.enter("backup");
    timeline.endSync("error");

    expect(theOutcomeRow(lines)).toContain("outcome=error");
  });

  it("a CANCELLED sync emits one", () => {
    const { timeline, lines } = makeTimeline();

    timeline.beginSync();
    timeline.enter("backup");
    timeline.endSync("cancelled");

    expect(theOutcomeRow(lines)).toContain("outcome=cancelled");
  });

  it("`source` is a first-class field from day one — BACKLOG-2952 extends this row", () => {
    const { timeline, lines } = makeTimeline();

    timeline.beginSync();
    timeline.endSync("complete");

    // Not "the iPhone event, generalised later". macOS Messages, address books,
    // Outlook, Gmail, Google Contacts, the Android companion and email attachments all
    // have to fit this row, and adding the dimension afterwards means re-keying
    // whatever has already been collected.
    expect(theOutcomeRow(lines)).toContain("source=iphone-backup");
  });

  it("carries every phase's duration, so a regression lands on a phase", () => {
    const { timeline, lines, tick } = makeTimeline();

    timeline.beginSync();
    timeline.enter("backup");
    tick(3_131_816);
    timeline.enter("parsing-messages");
    tick(20_427);
    timeline.endSync("complete");

    const row = theOutcomeRow(lines);
    expect(row).toContain("phases=backup:3131816,parsing-messages:20427");
    expect(row).toContain("elapsedMs=3152243");
  });
});

// ---------------------------------------------------------------------------
// CONTROL (b) — context must not leak between runs
// ---------------------------------------------------------------------------

describe("BACKLOG-2914: one run's environment never appears in the next run's row", () => {
  it("THE CONTROL — `beginSync` clears the context", () => {
    // A leaked dimension is worse than a missing one: a missing field reads as
    // "not established", while run N's device model on run N+1's row reads as data.
    const { timeline, lines } = makeTimeline();

    timeline.beginSync();
    timeline.setContext({ deviceModel: "iPhone14,2", priorBackup: "exists" });
    timeline.endSync("complete");

    timeline.beginSync();
    timeline.endSync("complete");

    const rows = outcomeRows(lines);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("deviceModel=iPhone14,2");
    expect(rows[1]).not.toContain("iPhone14,2");
    expect(rows[1]).not.toContain("priorBackup=");
  });

  it("`endSync` clears it too, so a run that never calls beginSync cannot inherit", () => {
    const { timeline, lines } = makeTimeline();

    timeline.beginSync();
    timeline.setContext({ deviceModel: "iPhone14,2" });
    timeline.endSync("complete");

    // `enter()` auto-opens a sync when none is running — the one path that reaches
    // `endSync` without an explicit `beginSync`.
    timeline.enter("backup");
    timeline.endSync("error");

    expect(outcomeRows(lines)[1]).not.toContain("iPhone14,2");
  });

  it("context merges across call sites, because the facts arrive at different times", () => {
    // The device is known at pre-flight, the prior-backup verdict after the status
    // check, the backup mode only once idevicebackup2 prints it. One setter, many
    // callers, one row.
    const { timeline, lines } = makeTimeline();

    timeline.beginSync();
    timeline.setContext({ deviceModel: "iPhone14,2" });
    timeline.setContext({ priorBackup: "none" });
    timeline.setContext({ incremental: false, backupModeSource: "device-reported" });
    timeline.endSync("complete");

    const row = theOutcomeRow(lines);
    expect(row).toContain("deviceModel=iPhone14,2");
    expect(row).toContain("priorBackup=none");
    expect(row).toContain("incremental=false");
    expect(row).toContain("backupModeSource=device-reported");
  });
});

// ---------------------------------------------------------------------------
// CONTROL (c) — a phase that ends is closed where it ends
// ---------------------------------------------------------------------------

describe("BACKLOG-2914: `closePhase` stops a finished phase absorbing the next gap", () => {
  it("THE CONTROL — cleanup measures cleanup, not the handoff that follows it", () => {
    // THE MEASURED DEFECT. `setPhase("complete")` opened nothing, so `cleanup` stayed
    // open until `syncHandlers` entered `storing:messages` — after the IPC round trip
    // and after `persistSyncResult` reached its first progress callback. The founder's
    // run recorded `phase=cleanup elapsedMs=246270`: four minutes charged to closing
    // two SQLite parsers.
    const { timeline, lines, tick } = makeTimeline();

    timeline.beginSync();
    timeline.enter("cleanup");
    tick(400); // closing two parsers
    timeline.closePhase(); // <- what setPhase("complete") now does
    tick(245_870); // the IPC handoff and the start of the message write
    timeline.enter("storing:messages");
    tick(60_000);
    timeline.endSync("complete");

    const cleanup = timeline.records().find((r) => r.phase === "cleanup");
    expect(cleanup?.elapsedMs).toBe(400);

    // And the 245.8 s is attributed to NOTHING rather than to cleanup. A gap is a
    // question; a wrong attribution is an answer.
    const total = timeline
      .records()
      .reduce((sum, r) => sum + (r.elapsedMs ?? 0), 0);
    expect(total).toBeLessThan(246_270);
  });

  it("without the close, the phase swallows the gap — the pre-fix behaviour", () => {
    // The same script with `closePhase()` omitted, so the defect is on record next to
    // its fix rather than described in a comment.
    const { timeline, tick } = makeTimeline();

    timeline.beginSync();
    timeline.enter("cleanup");
    tick(400);
    tick(245_870);
    timeline.enter("storing:messages");
    timeline.endSync("complete");

    expect(timeline.records().find((r) => r.phase === "cleanup")?.elapsedMs).toBe(246_270);
  });
});

// ---------------------------------------------------------------------------
// CONTROL (c2) — the wait is not machine time
// ---------------------------------------------------------------------------

describe("BACKLOG-2914: waiting on the device is its own phase", () => {
  it("THE CONTROL — a 903.9 s pre-transfer wait is not charged to the transfer", () => {
    // Measured: 507 s, 684.6 s and 903.9 s before the first byte on three runs, all
    // inside the `backup` figure. The 52-minute backup on the complete run was ~16%
    // waiting. Fold that in and the model learns syncs are 8-15 minutes slower than
    // they are.
    const { timeline, lines, tick } = makeTimeline();

    timeline.beginSync();
    timeline.enter("backup");
    tick(2_000); // spawn, handshake
    timeline.enter("backup:waiting-for-device");
    tick(903_900); // the founder's worst measured wait
    timeline.enter("backup:transferring");
    tick(2_227_916);
    timeline.endSync("complete");

    const byPhase = new Map(timeline.records().map((r) => [r.phase, r.elapsedMs]));
    expect(byPhase.get("backup:waiting-for-device")).toBe(903_900);
    expect(byPhase.get("backup:transferring")).toBe(2_227_916);

    // The transferring phase must not contain the wait — this is the assertion that
    // reds if the split is removed and `backup` becomes one bucket again.
    expect(byPhase.get("backup:transferring")).toBeLessThan(903_900 + 2_227_916);

    // Both are on the outcome row, so a consumer can subtract one from the other
    // without re-deriving anything.
    const row = theOutcomeRow(lines);
    expect(row).toContain("backup:waiting-for-device:903900");
    expect(row).toContain("backup:transferring:2227916");
  });

  it("a run that never waited has no wait phase at all", () => {
    // The backup service gates both events on `hasEmittedPasscodeWaiting`, so a
    // transfer that starts within five seconds produces one `backup` phase. Recording a
    // zero-length wait would be inventing an event.
    const { timeline, tick } = makeTimeline();

    timeline.beginSync();
    timeline.enter("backup");
    tick(1_000_000);
    timeline.endSync("complete");

    expect(timeline.records().map((r) => r.phase)).toEqual(["backup"]);
  });
});
