/**
 * @jest-environment node
 */

/**
 * Unit tests for the first-transaction selector (BACKLOG-2006a).
 * The free sample reveals content on exactly ONE deterministic deal — the
 * in-app reveal and the sample-export gate MUST agree on the SAME id, so these
 * assert the EXACT selected id (never a count).
 */

import {
  selectFirstTransactionId,
  isFirstTransaction,
  compareForFirst,
} from "../firstTransactionSelector";

describe("firstTransactionSelector — deterministic 'first' = most recent", () => {
  it("empty list ⇒ null", () => {
    expect(selectFirstTransactionId([])).toBeNull();
  });

  it("picks the most recent by closed_at when present", () => {
    const list = [
      { id: "a", closed_at: "2026-05-01T00:00:00Z", created_at: "2026-01-01T00:00:00Z" },
      { id: "b", closed_at: "2026-07-01T00:00:00Z", created_at: "2026-02-01T00:00:00Z" }, // newest close
      { id: "c", closed_at: "2026-03-01T00:00:00Z", created_at: "2026-06-01T00:00:00Z" },
    ];
    expect(selectFirstTransactionId(list)).toBe("b");
  });

  it("falls back to created_at when closed_at is null/empty (COALESCE)", () => {
    const list = [
      { id: "a", closed_at: null, created_at: "2026-02-01T00:00:00Z" },
      { id: "b", closed_at: "", created_at: "2026-09-01T00:00:00Z" }, // newest via created_at
      { id: "c", closed_at: null, created_at: "2026-05-01T00:00:00Z" },
    ];
    expect(selectFirstTransactionId(list)).toBe("b");
  });

  it("tie on primary time ⇒ breaks by created_at DESC then id ASC (deterministic)", () => {
    // Same closed_at; b and c share created_at too ⇒ final tie-break = smallest id.
    const list = [
      { id: "z", closed_at: "2026-07-01T00:00:00Z", created_at: "2026-06-01T00:00:00Z" },
      { id: "m", closed_at: "2026-07-01T00:00:00Z", created_at: "2026-06-05T00:00:00Z" }, // newer created_at
      { id: "a", closed_at: "2026-07-01T00:00:00Z", created_at: "2026-06-05T00:00:00Z" }, // same created_at, smaller id
    ];
    // m and a tie on created_at; smaller id "a" wins the final tie-break.
    expect(selectFirstTransactionId(list)).toBe("a");
  });

  it("isFirstTransaction returns true ONLY for the selected id", () => {
    const list = [
      { id: "new", closed_at: null, created_at: "2026-07-01T00:00:00Z" },
      { id: "old", closed_at: null, created_at: "2026-01-01T00:00:00Z" },
    ];
    expect(isFirstTransaction("new", list)).toBe(true);
    expect(isFirstTransaction("old", list)).toBe(false);
  });

  it("compareForFirst is a total order (negative ⇒ a is more first)", () => {
    const newer = { id: "n", closed_at: null, created_at: "2026-07-01T00:00:00Z" };
    const older = { id: "o", closed_at: null, created_at: "2026-01-01T00:00:00Z" };
    expect(compareForFirst(newer, older)).toBeLessThan(0);
    expect(compareForFirst(older, newer)).toBeGreaterThan(0);
    expect(compareForFirst(newer, newer)).toBe(0);
  });
});
