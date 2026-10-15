/**
 * @jest-environment node
 *
 * BACKLOG-3892 S5 (B7) — the backfill's ceiling `untilMs` on `selectChatMessages`.
 *
 * A floored sync read [C, ∞) with `sinceMs = C` (undated rows kept). The backfill reads
 * [F, C) with `untilMs = C`. At the same instant the two must split the DATED rows
 * exactly (none read twice, none missed) in both Apple date eras, and the backfill must
 * never read an undated row (the sync already did). Boundaries are swept at ±1 ms and
 * ±1 ns / ±1 s, not sampled.
 *
 * Fixture: the columns the parser reads (as in appleSmsDbSql.test.ts); real driver.
 */
import path from "path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

import { APPLE_EPOCH_MS, APPLE_SECONDS_DATE_MAX, selectChatMessages } from "../appleSmsDbSql";

function loadable(): boolean {
  try {
    new RealDatabase(":memory:").close();
    return true;
  } catch {
    return false;
  }
}
const maybe = loadable() ? describe : describe.skip;

/** C = 2026-01-15T10:20:30.500Z, in both eras. */
const C = Date.UTC(2026, 0, 15, 10, 20, 30, 500);
const C_NS = BigInt(C - APPLE_EPOCH_MS) * 1_000_000n;
const C_SEC = Math.floor((C - APPLE_EPOCH_MS) / 1000);

type Row = { ROWID: number };

maybe("BACKLOG-3892 S5: selectChatMessages untilMs", () => {
  let db: import("better-sqlite3").Database;
  const dates: Array<[number, bigint | number | null]> = [
    // nanosecond era around C
    [1, C_NS - 1_000_000n], // C - 1 ms
    [2, C_NS - 1n], // C - 1 ns
    [3, C_NS], // exactly C
    [4, C_NS + 1n],
    [5, C_NS + 1_000_000n],
    // seconds era around C's second
    [6, C_SEC - 1],
    [7, C_SEC],
    [8, C_SEC + 1],
    // undated
    [9, null],
    [10, 0],
    // far below and far above
    [11, 1_000],
    [12, C_NS * 2n],
  ];

  beforeAll(() => {
    db = new RealDatabase(":memory:") as unknown as import("better-sqlite3").Database;
    db.exec(`
      CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB, handle_id INTEGER,
        is_from_me INTEGER, date INTEGER, date_read INTEGER, date_delivered INTEGER, service TEXT);
      CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    `);
    const ins = db.prepare("INSERT INTO message (ROWID, guid, text, date) VALUES (?, ?, 't', ?)");
    const join = db.prepare("INSERT INTO chat_message_join VALUES (1, ?)");
    for (const [id, d] of dates) {
      ins.run(id, `g${id}`, d);
      join.run(id);
    }
    expect(C_SEC).toBeLessThan(APPLE_SECONDS_DATE_MAX);
  });
  afterAll(() => db.close());

  const ids = async (page: Parameters<typeof selectChatMessages>[3]): Promise<number[]> =>
    (await selectChatMessages<Row>(db, false, 1, page)).map((r) => r.ROWID).sort((a, b) => a - b);

  it("until C keeps every dated row below C in both eras, and no undated row", async () => {
    expect(await ids({ untilMs: C })).toEqual([1, 2, 6, 11]);
  });

  it("floor C and ceiling C split the rows exactly: dated rows once each, undated only in the floor read", async () => {
    const below = await ids({ untilMs: C });
    const above = await ids({ sinceMs: C });
    expect(below.filter((id) => above.includes(id))).toEqual([]);
    expect([...below, ...above].sort((a, b) => a - b)).toEqual(dates.map(([id]) => id));
    expect(above).toEqual(expect.arrayContaining([9, 10]));
  });

  it("±1 ms sweep: moving the ceiling by 1 ms moves exactly the rows at that boundary", async () => {
    expect(await ids({ untilMs: C - 1 })).toEqual([6, 11]); // C - 1 ms itself is not below C - 1 ms
    expect(await ids({ untilMs: C + 1 })).toEqual([1, 2, 3, 4, 6, 11]);
    // The seconds row in C's own second stays with the floor read until the ceiling reaches the next second.
    expect(await ids({ untilMs: C + 499 })).not.toContain(7);
    expect(await ids({ untilMs: C + 500 })).toContain(7);
  });

  it("a range [F, C) applies both bounds and still never reads an undated row", async () => {
    expect(await ids({ sinceMs: C - 1, untilMs: C + 1 })).toEqual([1, 2, 3, 4]);
  });
});
