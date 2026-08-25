/**
 * BACKLOG-2866 — TRIPWIRE: the export include set must stay review-blind.
 *
 * The founder's first instinct on this item was filed as "filter the export".
 * He then ruled the other way, and the reason is the important part:
 *
 *   "we don't need to filter because the same mechanism that stops a user from
 *    completing a transaction is the same one that will block them from
 *    exporting. no reason to filter it."
 *
 * A filter would be the WORSE design, not merely a redundant one. It would
 * silently drop emails from an audit package and hand a broker an artifact that
 * is quietly missing things — the failure mode this whole item is about. The
 * gate refuses instead, and names the deal that needs attention.
 *
 * So `exportPlan.ts` must never learn about review state. This test is the
 * tripwire on the next person who "fixes" the count by filtering here, which is
 * a change that would pass every other test in the repo.
 *
 * Deliberately a SOURCE SCAN rather than a behavioural assertion: the property
 * being protected is the ABSENCE of a coupling, and absence is not observable
 * from behaviour once the gate upstream makes the blocked case unreachable.
 */
import { readFileSync } from "fs";
import { join } from "path";

const EXPORT_PLAN = join(__dirname, "..", "services", "exportPlan.ts");

describe("exportPlan.ts stays review-blind (BACKLOG-2866)", () => {
  const source = readFileSync(EXPORT_PLAN, "utf8");

  it("reads the file it thinks it reads", () => {
    // Guards the guard: a renamed or moved module would make every assertion
    // below pass against an empty string.
    expect(source.length).toBeGreaterThan(500);
    expect(source).toMatch(/resolveExportPlan/);
  });

  it.each([
    ["getReviewState", /getReviewState/],
    ["reviewStateService", /reviewStateService/],
    ["pending_review_communications", /pending_review_communications/],
    ["address_missing", /address_missing/],
  ])("contains no reference to %s", (_name, pattern) => {
    expect(source).not.toMatch(pattern);
  });

  it("does not filter on match_reason", () => {
    // `match_reason` may be SELECTED — the plan carries it as data. What must
    // never appear is a predicate on it, which is what a review filter looks
    // like: `WHERE ... match_reason != ...`, `.filter(c => c.match_reason ...)`.
    const filterShapes = [
      /match_reason\s*(!==|===|<>|=|!=)/,
      /WHERE[^;]*match_reason/i,
      /filter\([^)]*match_reason/,
    ];
    for (const shape of filterShapes) {
      expect(source).not.toMatch(shape);
    }
  });
});
