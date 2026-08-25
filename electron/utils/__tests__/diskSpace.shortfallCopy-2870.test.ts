/**
 * @jest-environment node
 *
 * BACKLOG-2870 — the words the user reads, and the error string that reaches
 * them untranslated.
 *
 * The founder ran a force re-import; it died partway with SQLite's raw
 * `database or disk is full`; his reaction was "but my disk isn't full", and
 * Finder agreed with him — it was showing ~176 GB against a true 17 GB.
 *
 * Two defects hide in that sentence, and this suite pins both:
 *
 *   1. The raw driver error was never translated. `deviceSyncOrchestrator`
 *      already has a disk-full matcher and it does NOT match this string —
 *      pinned below, because "the regex looks like it covers it" is exactly the
 *      reading that let it through.
 *   2. A message quoting the TRUE free figure reads as a lie to anyone looking
 *      at Finder. The copy has to name the reason, and it has to do it WITHOUT
 *      inventing the one number macOS will not tell it (see
 *      `utils/localSnapshots.ts` for the enumeration of every interface that
 *      does not report snapshot-held bytes).
 */

import {
  describeDiskShortfall,
  isDiskFullError,
  formatSpace,
} from "../diskSpace";

jest.mock("../../services/logService", () => {
  const noop = jest.fn();
  return { __esModule: true, default: { info: noop, warn: noop, error: noop, debug: noop } };
});

const GB = 1024 * 1024 * 1024;

/** The threshold the import pre-flight enforces, in bytes. */
const REQUIRED = 3 * GB;

/**
 * Every number-with-a-unit in a string, e.g. "3 GB", "512 MB".
 *
 * Used to prove the snapshot clause carries NO byte figure. Asserting on the
 * absence of one specific invented number ("159 GB") would pass the moment a
 * future edit invented a DIFFERENT one, so the assertion is over the shape.
 */
function sizeFigures(text: string): string[] {
  return text.match(/\d[\d,.]*\s*[GMK]B/g) ?? [];
}

/** Just the sentence about snapshots, or "" when the clause was omitted. */
function snapshotClause(text: string): string {
  const sentence = text
    .split(/(?<=\.)\s+/)
    .find((s) => /snapshot/i.test(s));
  return sentence ?? "";
}

describe("BACKLOG-2870 — isDiskFullError", () => {
  /**
   * THE FOUNDER'S EXACT STRING. Transcribed from the failure, not paraphrased.
   * If this ever stops matching, the bug is back in the exact shape it shipped.
   */
  it("matches SQLite's `database or disk is full` — the string that actually reached him", () => {
    expect(isDiskFullError(new Error("database or disk is full"))).toBe(true);
  });

  /**
   * THE TRAP, PINNED AS A FACT RATHER THAN A COMMENT.
   *
   * `deviceSyncOrchestrator.ts` tests `/disk space|no space|ENOSPC|not enough
   * space/i` and looks for all the world like a disk-full matcher. Not one of
   * its four alternatives occurs in SQLite's sentence. This test exists so that
   * anyone who later thinks "we already have a matcher for this, let's reuse it"
   * is told, in a failing assertion, that they do not.
   */
  it("documents WHY a new matcher was needed: the existing orchestrator regex misses it", () => {
    const orchestratorPattern = /disk space|no space|ENOSPC|not enough space/i;
    expect(orchestratorPattern.test("database or disk is full")).toBe(false);
    expect(isDiskFullError(new Error("database or disk is full"))).toBe(true);
  });

  it("matches on the driver's result CODE even when the message is reworded", () => {
    // A driver upgrade can reword the sentence; it will not rename SQLITE_FULL.
    const err = Object.assign(new Error("some future wording"), {
      code: "SQLITE_FULL",
    });
    expect(isDiskFullError(err)).toBe(true);
  });

  it("matches the fs/ENOSPC spelling too — the attachment-copy half", () => {
    expect(
      isDiskFullError(new Error("ENOSPC: no space left on device, write"))
    ).toBe(true);
    expect(
      isDiskFullError(Object.assign(new Error("write failed"), { code: "ENOSPC" }))
    ).toBe(true);
  });

  it("does NOT claim unrelated failures are disk-full", () => {
    expect(isDiskFullError(new Error("SQLITE_BUSY: database is locked"))).toBe(false);
    expect(isDiskFullError(new Error("no such table: messages"))).toBe(false);
    expect(isDiskFullError(new Error("Full Disk Access permission required"))).toBe(false);
    expect(isDiskFullError(null)).toBe(false);
    expect(isDiskFullError(undefined)).toBe(false);
  });
});

describe("BACKLOG-2870 — describeDiskShortfall", () => {
  it("states what is needed and what is REALLY available, up front", () => {
    const text = describeDiskShortfall({
      requiredBytes: REQUIRED,
      availableBytes: 1.2 * GB,
      snapshotCount: 23,
      phase: "before",
    });

    expect(text).toContain("3 GB");
    expect(text).toContain("1.2 GB");
    // The word that separates this from Finder's number, and the reason the
    // founder should believe it.
    expect(text).toContain("actually available");
  });

  /**
   * The clause that stops a correct number reading as a bug.
   *
   * Measured on his Mac 2026-08-25: df 17 GB avail, Finder ~176 GB, 23 local
   * snapshots. Without this sentence the refusal is indistinguishable from the
   * app being broken.
   */
  it("names the snapshot reason when the count is readable", () => {
    const text = describeDiskShortfall({
      requiredBytes: REQUIRED,
      availableBytes: 17 * GB,
      snapshotCount: 23,
      phase: "before",
    });

    expect(text).toMatch(/may show more free space/i);
    expect(text).toContain("23 local Time Machine snapshots");
    expect(text).toMatch(/cannot use until it reclaims them/i);
  });

  /**
   * CONTROL — NO FABRICATED NUMBER, IN ANY VARIANT.
   *
   * The item's own draft copy said "about 159 GB is held by Time Machine local
   * snapshots". 159 is 176 minus 17: a subtraction of two figures, one of which
   * this process cannot even read, presented to the user as a measurement. It
   * would also silently fold in caches and trash, which are not snapshots.
   *
   * macOS reports snapshot COUNT and never snapshot BYTES (every interface
   * enumerated in `utils/localSnapshots.ts`), so the clause must carry no size
   * at all. Asserted over the SHAPE — any digits-plus-unit — so that inventing a
   * different number later does not sail through.
   */
  it("puts NO byte figure in the snapshot clause, in any variant", () => {
    for (const phase of ["before", "during"] as const) {
      for (const snapshotCount of [1, 23, 500]) {
        for (const availableBytes of [17 * GB, 900 * 1024 * 1024, null]) {
          const text = describeDiskShortfall({
            requiredBytes: REQUIRED,
            availableBytes,
            snapshotCount,
            phase,
          });
          expect(snapshotClause(text)).toMatch(/snapshot/i);
          expect(sizeFigures(snapshotClause(text))).toEqual([]);
        }
      }
    }
  });

  /**
   * The other half of the same control: unreadable count => the clause is DROPPED,
   * not filled with a guess or a placeholder.
   */
  it("drops the snapshot clause entirely when the count cannot be read", () => {
    const text = describeDiskShortfall({
      requiredBytes: REQUIRED,
      availableBytes: 1.2 * GB,
      snapshotCount: null,
      phase: "before",
    });

    expect(text).not.toMatch(/snapshot/i);
    expect(text).not.toMatch(/may show more free space/i);
    // ...and it still says the thing the user needs.
    expect(text).toContain("3 GB");
    expect(text).toContain("1.2 GB");
  });

  it("drops the clause on a Mac that genuinely holds no snapshots", () => {
    const text = describeDiskShortfall({
      requiredBytes: REQUIRED,
      availableBytes: 1.2 * GB,
      snapshotCount: 0,
      phase: "before",
    });
    expect(text).not.toMatch(/snapshot/i);
  });

  it("uses the singular for exactly one snapshot", () => {
    const text = describeDiskShortfall({
      requiredBytes: REQUIRED,
      availableBytes: 1.2 * GB,
      snapshotCount: 1,
      phase: "before",
    });
    expect(text).toContain("1 local Time Machine snapshot is");
  });

  /**
   * A refusal and a mid-run stop are different events and must not read the same.
   * The mid-run one has to say the store is intact — that is the fact
   * stage-and-swap buys and the founder's "partial import" fear needs answered.
   */
  it("distinguishes the up-front refusal from the mid-run stop", () => {
    const before = describeDiskShortfall({
      requiredBytes: REQUIRED,
      availableBytes: 1.2 * GB,
      snapshotCount: null,
      phase: "before",
    });
    const during = describeDiskShortfall({
      requiredBytes: REQUIRED,
      availableBytes: 1.2 * GB,
      snapshotCount: null,
      phase: "during",
    });

    expect(before).toMatch(/needs about/i);
    expect(before).not.toMatch(/ran out of disk space/i);

    expect(during).toMatch(/ran out of disk space/i);
    expect(during).toMatch(/Nothing was changed/i);
  });

  /**
   * NOT ADVICE. The item is explicit: state the fact, let him decide. Telling a
   * user to delete their Time Machine restore points to make room for an import
   * is the same trade macOS makes silently, and it is the trade BACKLOG-2743
   * exists to prevent.
   */
  it("never tells the user to delete their snapshots", () => {
    const text = describeDiskShortfall({
      requiredBytes: REQUIRED,
      availableBytes: 17 * GB,
      snapshotCount: 23,
      phase: "before",
    });
    expect(text).not.toMatch(/delete|remove|free up|thin|purge/i);
  });

  it("omits the comparison rather than printing a placeholder when free space is unknown", () => {
    const text = describeDiskShortfall({
      requiredBytes: REQUIRED,
      availableBytes: null,
      snapshotCount: null,
      phase: "before",
    });
    expect(text).toContain("3 GB");
    expect(text).not.toMatch(/null|undefined|NaN|-1/);
    expect(sizeFigures(text)).toEqual(["3 GB"]);
  });
});

describe("BACKLOG-2870 — formatSpace", () => {
  it("keeps a tenth of a GB near the boundary and drops it once past ten", () => {
    expect(formatSpace(1.2 * GB)).toBe("1.2 GB");
    expect(formatSpace(3 * GB)).toBe("3 GB");
    expect(formatSpace(17 * GB)).toBe("17 GB");
  });

  it("falls back to MB rather than printing 0.1 GB", () => {
    expect(formatSpace(512 * 1024 * 1024)).toBe("512 MB");
    // Never "0 MB" — a user told they have zero when they have some reads as broken.
    expect(formatSpace(1024)).toBe("1 MB");
  });
});
