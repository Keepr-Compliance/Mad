/**
 * @jest-environment node
 *
 * BACKLOG-2960 — the re-cache timing line's SHAPE.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SHAPE IS WORTH A TEST OF ITS OWN
 * ---------------------------------------------------------------------------
 * This instrument exists to produce two numbers that can be subtracted: one from
 * develop as it stands, one from develop after BACKLOG-2960's async conversion.
 * The subtraction is only valid if BOTH runs printed the same fields under the
 * same keys — a field renamed, dropped or silently zeroed between the two
 * measurements does not produce a wrong comparison, it produces one that cannot
 * be made at all, and the failure is invisible until someone tries.
 *
 * So the controls here pin the exact rendered string rather than asserting that
 * "it contains the elapsed time". `toContain("elapsedMs")` would stay green
 * through a line that dropped `mode`, and mode is what separates the founder's
 * 33,637-email force run from the two-second incremental run that follows it.
 *
 * ---------------------------------------------------------------------------
 * FIXTURE PROVENANCE
 * ---------------------------------------------------------------------------
 * `FORCE_RUN` below is the shape `precacheEmails` assembles in its `finally`,
 * with counts standing in for the founder's mailbox as stated on the item
 * (33,637 emails). The field NAMES and the omit-vs-zero behaviour are the parts
 * under test; the digits are arbitrary and say so.
 *
 * ---------------------------------------------------------------------------
 * CONTROLS, AND THE MUTATION THAT MAKES EACH RED
 * ---------------------------------------------------------------------------
 *   1. full force line      -> delete the `elapsedMs` part from the formatter:
 *                              red (this is the pre-registered mutation)
 *   2. ordinary run omits
 *      `inserted`           -> change the omit to `inserted=${x ?? 0}`: red
 *   3. force run carries it -> drop the spread: red
 *   4. no providers         -> return "" instead of "none": red
 *   5. key set + order      -> reorder or rename any key: red
 */

import {
  EMAIL_PRECACHE_TIMING_TAG,
  formatEmailPrecacheTimingLine,
  type EmailPrecacheTimingRecord,
} from "../emailPrecacheTiming";

/** A completed force re-cache — the run the 3% bound is stated against. */
const FORCE_RUN: EmailPrecacheTimingRecord = {
  mode: "force",
  outcome: "success",
  providers: ["outlook", "gmail"],
  checked: 33637,
  written: 33637,
  inserted: 33637,
  elapsedMs: 812345,
  build: "1.4.2",
  dbMs: 91204,
};

/** An ordinary incremental run over a mailbox that already held mail. */
const INCREMENTAL_RUN: EmailPrecacheTimingRecord = {
  mode: "re-cache",
  outcome: "success",
  providers: ["outlook"],
  checked: 12,
  written: 3,
  elapsedMs: 2104,
  build: "1.4.2",
  dbMs: 418,
};

describe("BACKLOG-2960 — email pre-cache timing line", () => {
  /**
   * Control 1. The whole string, character for character.
   *
   * Pinned in full rather than field by field because the reason this file
   * exists is that a partially-correct line is worthless: the founder greps one
   * tag and reads what comes back, and every consumer of the before/after
   * comparison assumes both sides rendered identically.
   */
  it("renders every field of a completed force re-cache", () => {
    expect(formatEmailPrecacheTimingLine(FORCE_RUN)).toBe(
      "[PRECACHE-TIMING] mode=force outcome=success providers=outlook+gmail " +
        "checked=33637 written=33637 inserted=33637 elapsedMs=812345 build=1.4.2 " +
        "dbMs=91204",
    );
  });

  /**
   * Control 1 (mutation target, stated explicitly).
   *
   * `elapsedMs` is the only field the instrument was built for. Asserted as its
   * own claim so that removing it from the formatter fails a test whose NAME
   * says what was lost, rather than only failing a long string comparison.
   */
  it("carries the elapsed wall-clock, which is the whole point of the line", () => {
    expect(formatEmailPrecacheTimingLine(FORCE_RUN)).toContain("elapsedMs=812345");
  });

  /**
   * Control 2. `inserted` is OMITTED, not zeroed, on a run with no swap.
   *
   * `inserted=0` would read as "the swap ran and inserted nothing" — which is a
   * real and different outcome (BACKLOG-2856's no-provider-rebuilt path) — where
   * the truth is that no swap happened at all. Absence is the honest encoding.
   */
  it("omits `inserted` entirely on a run that never swapped", () => {
    const line = formatEmailPrecacheTimingLine(INCREMENTAL_RUN);
    expect(line).toBe(
      "[PRECACHE-TIMING] mode=re-cache outcome=success providers=outlook " +
        "checked=12 written=3 elapsedMs=2104 build=1.4.2 dbMs=418",
    );
    expect(line).not.toContain("inserted");
  });

  /**
   * Control 4 (BACKLOG-2960, database time). THE PREFIX IS FROZEN.
   *
   * `dbMs` was ADDED to this line, not folded into it. The founder and the PM
   * both read `[PRECACHE-TIMING]` by grepping the tag and cutting fields by
   * position, and runs measured before this change are still the comparison
   * baseline — so every field that existed must keep its text AND its position.
   * These two strings are the pre-change lines, transcribed from this file's own
   * assertions at commit `5b5a3a18b` (PR #2519), and the claim is that the new
   * line still starts with them exactly.
   *
   * Inserting `dbMs` anywhere but the end fails this and passes the whole-string
   * controls above, which is precisely the mistake worth catching.
   */
  it("leaves every pre-existing field byte-identical, in its original position", () => {
    const PRE_CHANGE_FORCE =
      "[PRECACHE-TIMING] mode=force outcome=success providers=outlook+gmail " +
      "checked=33637 written=33637 inserted=33637 elapsedMs=812345 build=1.4.2";
    const PRE_CHANGE_INCREMENTAL =
      "[PRECACHE-TIMING] mode=re-cache outcome=success providers=outlook " +
      "checked=12 written=3 elapsedMs=2104 build=1.4.2";

    expect(formatEmailPrecacheTimingLine(FORCE_RUN).startsWith(PRE_CHANGE_FORCE)).toBe(true);
    expect(
      formatEmailPrecacheTimingLine(INCREMENTAL_RUN).startsWith(PRE_CHANGE_INCREMENTAL),
    ).toBe(true);
  });

  /**
   * Control 5. `dbMs` is the field the acceptance bound moves to.
   *
   * Named as its own claim for the same reason `elapsedMs` is: `elapsedMs` on
   * this run is dominated by network fetch, which varied 40% across four
   * identical force re-caches (pm_comments `ac7a6f40`). Dropping `dbMs` from the
   * formatter should fail a test whose name says what the line stopped
   * reporting, not only a long string comparison.
   */
  it("carries the database time separately from the total elapsed", () => {
    const line = formatEmailPrecacheTimingLine(FORCE_RUN);
    expect(line).toContain("dbMs=91204");
    expect(line).toContain("elapsedMs=812345");
    // Two distinct figures, not one relabelled.
    expect(line).not.toContain("dbMs=812345");
  });

  /** Control 6. Database time is the LAST field, so no existing cut position moves. */
  it("appends database time at the end of the line", () => {
    expect(formatEmailPrecacheTimingLine(FORCE_RUN).split(" ").pop()).toBe("dbMs=91204");
    expect(formatEmailPrecacheTimingLine(INCREMENTAL_RUN).split(" ").pop()).toBe("dbMs=418");
  });

  /** Control 3. The mirror: a run that DID swap carries it. */
  it("carries `inserted` when the swap ran", () => {
    expect(formatEmailPrecacheTimingLine({ ...INCREMENTAL_RUN, inserted: 0 })).toContain(
      "inserted=0",
    );
  });

  /**
   * Control 4. No connected mailbox is a real exit path (`precacheEmails`
   * returns early when neither token exists) and it must still render a line a
   * reader can interpret, not an empty `providers=`.
   */
  it("renders `providers=none` when no mailbox was connected", () => {
    expect(
      formatEmailPrecacheTimingLine({ ...INCREMENTAL_RUN, providers: [] }),
    ).toContain("providers=none");
  });

  /**
   * Control 5. The key SET and its ORDER, derived from the rendered line rather
   * than restated by hand.
   *
   * A parser written against these lines breaks on a rename; a spreadsheet built
   * by splitting on spaces breaks on a reorder. Both are silent at the point of
   * the change and loud six weeks later, mid-comparison.
   */
  it("pins the key set and order for both run shapes", () => {
    const keys = (record: EmailPrecacheTimingRecord): string[] =>
      formatEmailPrecacheTimingLine(record)
        .split(" ")
        .slice(1) // drop the tag
        .map((part) => part.split("=")[0]);

    expect(keys(FORCE_RUN)).toEqual([
      "mode",
      "outcome",
      "providers",
      "checked",
      "written",
      "inserted",
      "elapsedMs",
      "build",
      "dbMs",
    ]);
    expect(keys(INCREMENTAL_RUN)).toEqual([
      "mode",
      "outcome",
      "providers",
      "checked",
      "written",
      "elapsedMs",
      "build",
      "dbMs",
    ]);
  });

  /**
   * The tag is the grep target documented in the PR body and in the item. It is
   * asserted as a literal here so that changing the constant — which would
   * silently invalidate every instruction telling a human what to grep for —
   * cannot pass.
   */
  it("uses the documented grep tag", () => {
    expect(EMAIL_PRECACHE_TIMING_TAG).toBe("[PRECACHE-TIMING]");
    expect(formatEmailPrecacheTimingLine(FORCE_RUN).startsWith(EMAIL_PRECACHE_TIMING_TAG)).toBe(
      true,
    );
  });

  /**
   * A line with a space inside a value cannot be read by `awk -F' '`, which is
   * how these get compared. No field is free text today; this holds that.
   */
  it("emits no value containing a space", () => {
    for (const part of formatEmailPrecacheTimingLine(FORCE_RUN).split(" ").slice(1)) {
      expect(part).toMatch(/^[a-zA-Z]+=[^\s]+$/);
    }
  });
});
