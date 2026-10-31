/**
 * @jest-environment node
 *
 * BACKLOG-3965 PR-2 — "last opened", on the real driver and the real schema.sql.
 *
 * Fixture shape transcribed from checklistSchemaConstraints-3475.test.ts.
 *
 * Wrong builds each block catches:
 *   - the open written as a column on transactions (or any write to that row):
 *     updated_at moves through update_transactions_timestamp -> "updated_at unchanged" red.
 *   - a second row per deal instead of an upsert -> "one row per deal" red.
 *   - the FK without ON DELETE CASCADE: deleting a deal throws -> "deal delete" red.
 *   - the count taken from the first checklist only -> "two checklists" red.
 *   - the NULL-unsafe filter (`detection_status <> 'pending'` drops NULL) -> "NULL" red.
 *   - another user's deals in the read -> "user scope" red.
 *   - a full scan instead of the opened_at index -> EXPLAIN red.
 */
import * as nodePath from "path";
import * as fs from "fs";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  nodePath.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

let db: DatabaseType;
jest.mock("../core/dbConnection", () => ({
  dbGet: (sql: string, params: unknown[] = []) => db.prepare(sql).get(...(params as never[])),
  dbAll: (sql: string, params: unknown[] = []) => db.prepare(sql).all(...(params as never[])),
  dbRun: (sql: string, params: unknown[] = []) => db.prepare(sql).run(...(params as never[])),
  dbTransaction: (fn: () => unknown) => db.transaction(fn)(),
  ensureDb: () => db,
  getRawDatabase: () => db,
}));

import { getRecentlyOpenedTransactions, recordTransactionOpen } from "../transactionOpenDbService";
import { GET_RECENTLY_OPENED_TRANSACTIONS_SQL } from "../transactionOpenSql";
import { getChecklistsForTransaction } from "../checklistDbService";
import { deleteTransaction } from "../transactionDbService";

const SCHEMA = nodePath.join(__dirname, "..", "..", "..", "database", "schema.sql");
const USER = "user-3965";
const OTHER_USER = "user-3965-other";

const run = (q: string, ...p: unknown[]) => db.prepare(q).run(...(p as never[]));
const get = (q: string, ...p: unknown[]) => db.prepare(q).get(...(p as never[])) as Record<string, unknown> | undefined;
const all = (q: string, ...p: unknown[]) => db.prepare(q).all(...(p as never[])) as Array<Record<string, unknown>>;

function seedDeal(
  id: string,
  opts: { user?: string; status?: string | null; detection?: string | null } = {},
): void {
  run(
    `INSERT INTO transactions (id, user_id, property_address) VALUES (?, ?, ?)`,
    id,
    opts.user ?? USER,
    `${id} Road`,
  );
  // NULL / explicit values are set after the insert so the column defaults do not mask them.
  if ("status" in opts) run(`UPDATE transactions SET status = ? WHERE id = ?`, opts.status, id);
  if ("detection" in opts) run(`UPDATE transactions SET detection_status = ? WHERE id = ?`, opts.detection, id);
}

let itemSeq = 0;
function seedChecklist(dealId: string, checklistId: string, templateId: string, items: Array<{ required: boolean; checked: boolean }>): void {
  run(
    `INSERT INTO transaction_checklists (id, transaction_id, template_id, template_name) VALUES (?, ?, ?, 'Residential')`,
    checklistId,
    dealId,
    templateId,
  );
  for (const item of items) {
    itemSeq += 1;
    run(
      `INSERT INTO transaction_checklist_items (id, checklist_id, title, is_required, is_checked, checked_at)
       VALUES (?, ?, 'Item', ?, ?, ?)`,
      `i-${itemSeq}`,
      checklistId,
      item.required ? 1 : 0,
      item.checked ? 1 : 0,
      item.checked ? "2026-10-01T00:00:00Z" : null,
    );
  }
}

const ids = (rows: Array<{ transactionId: string }>) => rows.map((r) => r.transactionId);

beforeEach(() => {
  db = new Database(":memory:") as unknown as DatabaseType;
  db.pragma("foreign_keys = OFF");
  db.exec(fs.readFileSync(SCHEMA, "utf8"));
  db.pragma("foreign_keys = ON");
  run(`INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'a@example.test', 'google', 'oa-a')`, USER);
  run(`INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'b@example.test', 'google', 'oa-b')`, OTHER_USER);
});

afterEach(() => db.close());

describe("BACKLOG-3965 recordTransactionOpen", () => {
  it("writes one row per deal; a second open moves opened_at, it does not add a row", () => {
    seedDeal("d1");
    expect(recordTransactionOpen("d1", "2026-10-31T10:00:00.000Z")).toBe(true);
    expect(recordTransactionOpen("d1", "2026-10-31T11:00:00.000Z")).toBe(true);
    expect(all(`SELECT transaction_id, opened_at FROM transaction_opens`)).toEqual([
      { transaction_id: "d1", opened_at: "2026-10-31T11:00:00.000Z" },
    ]);
  });

  it("an unknown deal id writes nothing and does not throw", () => {
    expect(recordTransactionOpen("no-such-deal", "2026-10-31T10:00:00.000Z")).toBe(false);
    expect(all(`SELECT * FROM transaction_opens`)).toEqual([]);
  });

  it("never touches the transactions row: updated_at is unchanged by an open (C10)", () => {
    // Set at INSERT, not by an UPDATE: update_transactions_timestamp fires on any
    // UPDATE and would move the value to "now" first, and an open in the same
    // second would then compare equal and hide the bump (measured: it did).
    run(
      `INSERT INTO transactions (id, user_id, property_address, updated_at) VALUES ('d1', ?, 'd1 Road', '2020-01-01 00:00:00')`,
      USER,
    );
    recordTransactionOpen("d1", "2026-10-31T10:00:00.000Z");
    recordTransactionOpen("d1", "2026-10-31T11:00:00.000Z");
    expect(get(`SELECT updated_at FROM transactions WHERE id = 'd1'`)?.updated_at).toBe("2020-01-01 00:00:00");
  });

  it("deleting a deal deletes its row and leaves the other deal's row (cascade)", async () => {
    seedDeal("d1");
    seedDeal("d2");
    recordTransactionOpen("d1", "2026-10-31T10:00:00.000Z");
    recordTransactionOpen("d2", "2026-10-31T10:00:00.000Z");
    await deleteTransaction("d1");
    expect(all(`SELECT transaction_id FROM transaction_opens`)).toEqual([{ transaction_id: "d2" }]);
  });
});

describe("BACKLOG-3965 getRecentlyOpenedTransactions", () => {
  it("newest first, cut at the limit, never-opened deals absent", () => {
    for (const id of ["a", "b", "c", "never"]) seedDeal(id);
    recordTransactionOpen("a", "2026-10-31T09:00:00.000Z");
    recordTransactionOpen("b", "2026-10-31T11:00:00.000Z");
    recordTransactionOpen("c", "2026-10-31T10:00:00.000Z");
    expect(ids(getRecentlyOpenedTransactions(USER, 5))).toEqual(["b", "c", "a"]);
    expect(ids(getRecentlyOpenedTransactions(USER, 2))).toEqual(["b", "c"]);
  });

  it("only this user's deals", () => {
    seedDeal("mine");
    seedDeal("theirs", { user: OTHER_USER });
    recordTransactionOpen("mine", "2026-10-31T09:00:00.000Z");
    recordTransactionOpen("theirs", "2026-10-31T10:00:00.000Z");
    expect(ids(getRecentlyOpenedTransactions(USER, 5))).toEqual(["mine"]);
  });

  it("leaves out rejected deals and deals pending or rejected in detection; keeps NULL status and NULL detection (SR change 1)", () => {
    const cases: Array<[string, { status?: string | null; detection?: string | null }, boolean]> = [
      ["active-confirmed", { status: "active", detection: "confirmed" }, true],
      ["closed", { status: "closed", detection: "confirmed" }, true],
      ["status-null", { status: null, detection: "confirmed" }, true],
      ["detection-null", { status: "active", detection: null }, true],
      ["status-rejected", { status: "rejected", detection: "confirmed" }, false],
      ["detection-pending", { status: "active", detection: "pending" }, false],
      ["detection-rejected", { status: "active", detection: "rejected" }, false],
    ];
    cases.forEach(([id, opts], n) => {
      seedDeal(id, opts);
      recordTransactionOpen(id, `2026-10-31T10:00:0${n}.000Z`);
    });
    const expected = cases.filter(([, , shown]) => shown).map(([id]) => id).reverse();
    expect(ids(getRecentlyOpenedTransactions(USER, 50))).toEqual(expected);
  });

  it("required counts are summed across every checklist on the deal and equal getChecklistsForTransaction (C10)", async () => {
    seedDeal("two");
    seedChecklist("two", "c1", "tpl-1", [
      { required: true, checked: true },
      { required: true, checked: false },
      { required: false, checked: true },
    ]);
    seedChecklist("two", "c2", "tpl-2", [
      { required: true, checked: true },
      { required: true, checked: true },
      { required: false, checked: false },
    ]);
    seedDeal("none");
    recordTransactionOpen("two", "2026-10-31T10:00:00.000Z");
    recordTransactionOpen("none", "2026-10-31T09:00:00.000Z");

    const rows = getRecentlyOpenedTransactions(USER, 5);
    const truth = await getChecklistsForTransaction("two", "agent");
    expect(truth.requiredDone).toBe(3);
    expect(truth.requiredTotal).toBe(4);
    expect(rows[0]).toEqual({
      transactionId: "two",
      propertyAddress: "two Road",
      status: "active",
      openedAt: "2026-10-31T10:00:00.000Z",
      requiredDone: truth.requiredDone,
      requiredTotal: truth.requiredTotal,
    });
    expect(rows[1]).toMatchObject({ transactionId: "none", requiredDone: 0, requiredTotal: 0 });
  });

  it("the read uses the opened_at index and searches, never scans, the checklist tables (SR §11)", () => {
    const plan = all(`EXPLAIN QUERY PLAN ${GET_RECENTLY_OPENED_TRANSACTIONS_SQL}`, USER, 5).map((r) => String(r.detail));
    expect(plan.some((d) => d.includes("idx_transaction_opens_opened_at"))).toBe(true);
    expect(plan.some((d) => /^SCAN (t|transactions)\b/.test(d))).toBe(false);
    expect(plan.some((d) => /^SCAN (c|i)\b/.test(d))).toBe(false);
    expect(plan.some((d) => /USE TEMP B-TREE FOR ORDER BY/.test(d))).toBe(false);
  });
});
