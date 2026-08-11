/**
 * @jest-environment node
 */

/**
 * BACKLOG-2632 — the "Removed" date on a dismissed email must not CHANGE on refetch.
 *
 * ===========================================================================
 * THE DEFECT THIS SUITE PINS
 * ===========================================================================
 * `addIgnoredCommunication` omitted `ignored_at` from its INSERT column list, so
 * SQLite applied `DEFAULT CURRENT_TIMESTAMP` and stored a NAIVE UTC string
 * ("2026-08-10 01:00:00"). The object it handed back to the caller carried
 * `new Date().toISOString()` instead — a DIFFERENT string for the same instant.
 *
 * Two different strings for one row means the section rendered one day from the
 * in-memory object and, after the first refetch, a different day from the
 * database. A date that changes by itself reads as data corruption, which is a
 * strictly worse failure than a date that is merely six hours out.
 *
 * The assertion is BYTE identity between what went into the INSERT and what came
 * back out of the function — not "both parse to the same day", which would still
 * pass with the two formats present.
 *
 * ===========================================================================
 * WHY THE FORMAT STAYS NAIVE
 * ===========================================================================
 * `ignored_at` is sorted as a STRING by four queries
 * (`communicationDbService` getIgnoredCommunicationsBy{Transaction,User}, and
 * `emailLinkingHandlers.ts:634/693`). A space (0x20) sorts before a `T` (0x54),
 * so writing ISO into a column that already holds naive rows would silently
 * reorder same-day rows, and backfilling the old rows is not safe. The renderers
 * were taught to read the naive shape instead (`parseDbTimestamp`); this write
 * site only had to stop disagreeing with itself.
 *
 * `dbRun` is mocked, so this suite never loads the native sqlite binary and runs
 * clean under `npx jest`.
 */

const mockDbGet = jest.fn();
const mockDbRun = jest.fn();
const mockDbAll = jest.fn();

jest.mock("../core/dbConnection", () => ({
  dbGet: (...args: unknown[]) => mockDbGet(...args),
  dbRun: (...args: unknown[]) => mockDbRun(...args),
  dbAll: (...args: unknown[]) => mockDbAll(...args),
}));

import { addIgnoredCommunication } from "../communicationDbService";
import { dbTimestampNow } from "../../../utils/dbTimestamp";

/** The INSERT's SQL text and bound params from the single dbRun call. */
function capturedInsert(): { sql: string; params: unknown[] } {
  expect(mockDbRun).toHaveBeenCalledTimes(1);
  const [sql, params] = mockDbRun.mock.calls[0] as [string, unknown[]];
  return { sql, params };
}

/** Position of a column in the INSERT's column list, so we bind-check the right slot. */
function columnIndex(sql: string, column: string): number {
  const columnList = sql.slice(sql.indexOf("(") + 1, sql.indexOf(")"));
  const columns = columnList.split(",").map((c) => c.trim());
  const index = columns.indexOf(column);
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}

const NEW_IGNORED = {
  user_id: "user-2632",
  transaction_id: "txn-2632",
  email_subject: "Closing disclosure",
  email_sender: "escrow@example.com",
  email_sent_at: "2026-08-10T00:30:00.000Z",
  thread_id: "thread-2632",
  email_id: "email-2632",
  original_communication_id: null,
  reason: null,
  match_reason: null,
};

describe("dbTimestampNow", () => {
  it("produces SQLite's CURRENT_TIMESTAMP shape exactly", () => {
    // Naive UTC: space separator, seconds precision, no fraction, no zone marker.
    expect(dbTimestampNow(new Date("2026-08-10T22:09:57.989Z"))).toBe("2026-08-10 22:09:57");
    expect(dbTimestampNow(new Date("2026-08-10T01:00:00.000Z"))).toBe("2026-08-10 01:00:00");
    expect(dbTimestampNow()).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("is UTC, not local — the value must not carry the machine's offset", () => {
    const instant = new Date("2026-08-10T01:00:00.000Z");
    // 01:00 UTC. If this ever emitted local time it would read 19:00 at UTC-6.
    expect(dbTimestampNow(instant).slice(11, 13)).toBe("01");
  });
});

describe("Control 3 — addIgnoredCommunication persists what it returns", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("binds ignored_at explicitly rather than leaning on the column default", async () => {
    await addIgnoredCommunication(NEW_IGNORED);

    const { sql } = capturedInsert();
    expect(sql).toContain("INSERT INTO ignored_communications");
    // Before the fix the column was absent and DEFAULT CURRENT_TIMESTAMP applied.
    expect(columnIndex(sql, "ignored_at")).toBeGreaterThanOrEqual(0);
  });

  it("returns the BYTE-IDENTICAL string it just wrote", async () => {
    const returned = await addIgnoredCommunication(NEW_IGNORED);

    const { sql, params } = capturedInsert();
    const persisted = params[columnIndex(sql, "ignored_at")];

    // The whole defect in one assertion: these used to be two different strings
    // ("2026-08-10 01:00:00" persisted vs "2026-08-10T01:00:00.000Z" returned).
    expect(persisted).toBe(returned.ignored_at);
    expect(typeof persisted).toBe("string");
  });

  it("writes the naive-UTC shape, so it sorts with the rows already in the column", async () => {
    const returned = await addIgnoredCommunication(NEW_IGNORED);

    // `ORDER BY ignored_at DESC` is a string sort. An ISO value here would sort
    // above every same-day naive row regardless of its actual time.
    expect(returned.ignored_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(returned.ignored_at).not.toContain("T");
    expect(returned.ignored_at).not.toContain("Z");
  });

  it("has exactly one bound param per column in the INSERT", async () => {
    await addIgnoredCommunication(NEW_IGNORED);

    const { sql, params } = capturedInsert();
    const columnCount = sql
      .slice(sql.indexOf("(") + 1, sql.indexOf(")"))
      .split(",").length;
    const placeholderCount = (sql.match(/\?/g) ?? []).length;

    expect(placeholderCount).toBe(columnCount);
    expect(params).toHaveLength(columnCount);
  });

  it("still carries the other fields through unchanged", async () => {
    const returned = await addIgnoredCommunication(NEW_IGNORED);

    expect(returned.user_id).toBe("user-2632");
    expect(returned.transaction_id).toBe("txn-2632");
    expect(returned.email_id).toBe("email-2632");
    expect(returned.thread_id).toBe("thread-2632");
    expect(returned.email_sent_at).toBe("2026-08-10T00:30:00.000Z");
    expect(returned.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
