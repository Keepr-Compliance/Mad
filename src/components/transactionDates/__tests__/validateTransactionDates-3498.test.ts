/**
 * BACKLOG-3498 — the date rule shared by Export Step 1 and the Submit date step,
 * swept at its boundaries rather than sampled.
 *
 * The rule compares YYYY-MM-DD strings (moved verbatim from ExportModal's
 * `datesAreValid`): Start and End are required, and End may EQUAL Start — only
 * an End before Start is refused. The message says "after"; it is kept as it
 * was, and pinned here so a reword is a visible change.
 */
import {
  initialTransactionDates,
  validateTransactionDates,
} from "../useTransactionDatesForm";

const MISSING = "Please provide Start Date and End Date to continue";
const INVERTED = "End Date must be after Start Date";

describe("BACKLOG-3498 validateTransactionDates", () => {
  test.each([
    // [label, start, end, expected]
    ["equal dates", "2026-03-10", "2026-03-10", null],
    ["end one day after start", "2026-03-10", "2026-03-11", null],
    ["end one day before start", "2026-03-10", "2026-03-09", INVERTED],
    ["month boundary, forward", "2026-01-31", "2026-02-01", null],
    ["month boundary, backward", "2026-02-01", "2026-01-31", INVERTED],
    ["year boundary, forward", "2025-12-31", "2026-01-01", null],
    ["year boundary, backward", "2026-01-01", "2025-12-31", INVERTED],
    ["missing start", "", "2026-03-10", MISSING],
    ["missing end", "2026-03-10", "", MISSING],
    ["missing both", "", "", MISSING],
  ])("%s → %p", (_label, startDate, endDate, expected) => {
    expect(validateTransactionDates({ startDate, endDate })).toBe(expected);
  });
});

describe("BACKLOG-3498 initialTransactionDates — the row as input values", () => {
  it("keeps the date part of a detection-path ISO timestamp and a date-only wizard value", () => {
    // started_at: date-only (useAuditSubmission.ts:140-142).
    // closed_at: ISO timestamp (electron transactionService.ts:958).
    expect(
      initialTransactionDates({
        started_at: "2026-01-05",
        closing_deadline: undefined,
        closed_at: "2026-03-14T18:22:05.000Z",
      }),
    ).toEqual({ startDate: "2026-01-05", closingDate: "", endDate: "2026-03-14" });
  });

  it("reads a null column as empty", () => {
    expect(
      initialTransactionDates({
        started_at: null,
        closing_deadline: null,
        closed_at: null,
      } as unknown as Parameters<typeof initialTransactionDates>[0]),
    ).toEqual({ startDate: "", closingDate: "", endDate: "" });
  });
});
