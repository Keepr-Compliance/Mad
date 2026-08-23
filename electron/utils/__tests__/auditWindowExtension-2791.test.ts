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
 * date reported "extended" on every single save — including saves that changed
 * nothing. Both windows are now computed against ONE clock. The regression test
 * for it is "a save that changes nothing is not an extension, even with no
 * close date", which fails without the seam.
 *
 * CONTROLS RUN (mutation applied, suite re-run, MEASURED result):
 *  1. `>=`/`<=` relaxed to `>`/`<` on the containment half (i.e. accept a mixed
 *     edit)                                             -> RED, 2 of 12 tests.
 *  2. Drop the strict-widening half, keeping containment (so an identical save
 *     counts as an extension)                           -> RED, 4 of 12 tests.
 *  3. Remove the shared `now`, letting each window take its own clock
 *                                                       -> RED, 1 of 12 tests
 *     (the no-close-date test — the only one that can see it).
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
    // The `now` seam. Both windows end at "today" here, so without ONE shared
    // clock the second call lands a millisecond later and every save on an open
    // deal reports an extension.
    const open = win(START_SAME, null);
    expect(isAuditWindowExtended(open, { ...open }, NOW)).toBe(false);
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
