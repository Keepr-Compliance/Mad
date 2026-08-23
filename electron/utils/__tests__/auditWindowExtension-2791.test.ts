/**
 * @jest-environment node
 *
 * BACKLOG-2791 — WHEN DOES A DATE EDIT COUNT AS AN EXTENSION?
 *
 * Founder, 2026-08-23: "the review sync (and its popup) must ALSO run when the
 * user changes the audit dates in a way that EXTENDS the transaction's audit
 * range — extending the window brings new communications into scope; today
 * nothing happens until the next open."
 *
 * The Communication Lifecycle Contract states the trigger as "dates edited so
 * the window covers more", and parks narrowing: "narrowing is NOT a trigger —
 * its semantics are an open founder decision".
 *
 * SO THE PREDICATE IS A TRUE SUPERSET TEST, NOT "moved outward at either end".
 * The distinction only shows up in the MIXED cases (one end gains, the other
 * loses), and it is deliberate: a mixed edit contains a narrowing, and running
 * discovery over the half that grew while the half that shrank is governed by
 * undecided semantics would ship a decision the founder explicitly deferred.
 * Recorded here rather than buried, because it is a judgement call and the
 * founder may want the other one.
 *
 * BOUNDARIES ARE SWEPT, NOT SAMPLED: all nine combinations of (start earlier /
 * same / later) x (end earlier / same / later) are asserted, because one input
 * per branch cannot catch an off-by-one and the two ends are independent.
 *
 * THE `now` SEAM. `computeTransactionDateRange` falls back to `new Date()` when
 * `closed_at` is absent. Computing the two windows back-to-back therefore gave
 * the SECOND one a later end by a millisecond or two, and a deal with no close
 * date could report "extended" on a save that changed nothing. Both windows are
 * now computed against ONE clock.
 *
 * The first regression test written for that seam DID NOT WORK, and the failure
 * is instructive enough to keep: asserting it against the real clock left the
 * suite fully GREEN when the seam was removed (measured, 12 of 12 passed),
 * because two `new Date()` calls almost always land in the same millisecond. A
 * race asserted with the real clock is a coin flip, not a control. The test that
 * replaced it drives a monotonic clock so the drift is certain.
 *
 * CONTROLS RUN (mutation applied, suite re-run, MEASURED result — all against
 * the current 14 tests):
 *  1. `contains` forced true, i.e. accept a mixed edit    -> RED, 2 of 14 tests
 *     (exactly the two mixed rows of the sweep).
 *  2. `strictlyWider` forced true, i.e. an identical save counts as an extension
 *                                                         -> RED, 3 of 14 tests.
 *  3. Remove the shared `now` from `isAuditWindowExtended` -> RED, 1 of 14 tests
 *     (the monotonic-clock test — the only one that can see it).
 *  4. Ignore the `now` parameter inside `computeTransactionDateRange`
 *                                                         -> RED, 2 of 14 tests.
 */

import {
  computeTransactionDateRange,
  isAuditWindowExtended,
} from "../emailDateRange";

const NOW = new Date("2026-08-23T12:00:00.000Z");

/** A transaction's stored audit dates. */
const win = (started: string | null, closed: string | null) => ({
  started_at: started,
  created_at: "2026-01-01T00:00:00.000Z",
  closed_at: closed,
});

const START_EARLIER = "2026-02-01T00:00:00.000Z";
const START_SAME = "2026-03-01T00:00:00.000Z";
const START_LATER = "2026-04-01T00:00:00.000Z";

const END_EARLIER = "2026-09-01T00:00:00.000Z";
const END_SAME = "2026-10-01T00:00:00.000Z";
const END_LATER = "2026-11-01T00:00:00.000Z";

const BEFORE = win(START_SAME, END_SAME);

describe("BACKLOG-2791 — isAuditWindowExtended sweeps both ends", () => {
  describe("the 3x3 boundary sweep — every combination of both ends", () => {
    const cases: Array<[string, string, string, boolean]> = [
      // start,        end,          label,                                  extended?
      [START_EARLIER, END_LATER, "both ends move outward", true],
      [START_EARLIER, END_SAME, "start reaches back, end unchanged", true],
      [START_SAME, END_LATER, "end reaches forward, start unchanged", true],

      [START_SAME, END_SAME, "nothing changed", false],
      [START_LATER, END_SAME, "start moves in — a narrowing", false],
      [START_SAME, END_EARLIER, "end moves in — a narrowing", false],
      [START_LATER, END_EARLIER, "both ends move in — a narrowing", false],

      // The two mixed cases: one end gains, the other loses. NOT supersets.
      [START_EARLIER, END_EARLIER, "start gains, end loses — mixed", false],
      [START_LATER, END_LATER, "start loses, end gains — mixed", false],
    ];

    it.each(cases)(
      "start=%s end=%s (%s) -> extended=%s",
      (started, closed, _label, expected) => {
        expect(isAuditWindowExtended(BEFORE, win(started, closed), NOW)).toBe(expected);
      },
    );
  });

  it("a one-day extension at the end counts — the boundary is strict, not fuzzy", () => {
    const after = win(START_SAME, "2026-10-02T00:00:00.000Z");
    expect(isAuditWindowExtended(BEFORE, after, NOW)).toBe(true);
  });

  it("a save that changes nothing is not an extension, even with NO close date", () => {
    const open = win(START_SAME, null);
    expect(isAuditWindowExtended(open, { ...open }, NOW)).toBe(false);
  });

  it("the `now` argument is honoured — an open-ended window ends at the clock it is given", () => {
    expect(computeTransactionDateRange(win(START_SAME, null), NOW).end.getTime()).toBe(
      NOW.getTime(),
    );
  });

  it("both windows are measured against ONE clock — an open deal does not drift between them", () => {
    // THE REGRESSION THIS PINS, and why the obvious version of it does not.
    //
    // With no close date both ends default to "today", so the two windows were
    // computed by two separate `new Date()` calls and the second could land a
    // millisecond later — reporting an extension on a save that changed nothing.
    //
    // Asserting that with the real clock is not a test, it is a coin flip: the
    // two calls usually fall inside the same millisecond, so removing the shared
    // clock left the suite GREEN (measured: 12 of 12 passed). A monotonic clock
    // makes the race certain instead of likely, which is the only way this
    // control can go red on purpose.
    const base = new Date("2026-08-23T12:00:00.000Z").getTime();
    const RealDate = Date;
    let tick = 0;
    const spy = jest
      .spyOn(global, "Date")
      .mockImplementation(((...args: unknown[]) =>
        args.length === 0
          ? new RealDate(base + tick++)
          : new RealDate(...(args as [string]))) as unknown as () => Date);

    try {
      const open = win(START_SAME, null);
      // No explicit clock — the production call shape.
      expect(isAuditWindowExtended(open, { ...open })).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("clearing the close date IS an extension — the window now runs to today", () => {
    // A deal closed in the past, reopened: end goes from closed_at+30d to now.
    const closedInPast = win(START_SAME, "2026-05-01T00:00:00.000Z");
    const reopened = win(START_SAME, null);
    // Stated as the reason, not just the verdict.
    expect(computeTransactionDateRange(reopened, NOW).end.getTime()).toBeGreaterThan(
      computeTransactionDateRange(closedInPast, NOW).end.getTime(),
    );
    expect(isAuditWindowExtended(closedInPast, reopened, NOW)).toBe(true);
  });
});
