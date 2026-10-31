/**
 * @jest-environment node
 *
 * BACKLOG-3965 PR-3 — the Dashboard's Todo read, on the real schema.sql and a
 * real SQLite engine (`openTestDb`: better-sqlite3 under Electron, node:sqlite
 * under plain node).
 *
 * Fixture shape transcribed from transactionOpenDbService-3965.test.ts and
 * checklistDealLock-3910d.test.ts. NULL `submission_status` and NULL
 * `detection_status` are set by an UPDATE after the insert: both columns have
 * a DEFAULT and no NOT NULL, so the schema admits NULL; no writer in the repo
 * is known to emit it (MECHANISM UNTRACED for NULL), and SR plan review change
 * 1 requires the read to keep such deals.
 *
 * Wrong builds each block catches:
 *   - the lock filter written as "not in the lock map's keys": every status is
 *     a key, so every deal drops -> "open deals of every open status" red.
 *   - a locked deal included -> "locked statuses" red.
 *   - a bare `NOT IN` on submission_status (drops NULL) -> NULL submission red.
 *   - `detection_status = 'confirmed'` or a bare `NOT IN` (drops NULL) -> NULL detection red.
 *   - optional or ticked items listed -> their own reds.
 *   - the deal's ring counted from one checklist -> "two checklists" red.
 *   - another user's deals -> "user scope" red.
 *   - the order broken anywhere -> "order" red.
 *   - the header count taken from the capped rows -> "total is not capped" red.
 *   - an empty answer that is not `{ totalCount: 0, items: [] }` -> "empty" red.
 */
import * as fs from "fs";
import * as nodePath from "path";

import { openTestDb, type TestDb } from "../../__tests__/helpers/syncSqliteDriver";

let db: TestDb;
jest.mock("../core/dbConnection", () => ({
  dbGet: (sql: string, params: unknown[] = []) => db.prepare(sql).get(...(params as never[])),
  dbAll: (sql: string, params: unknown[] = []) => db.prepare(sql).all(...(params as never[])),
  dbRun: (sql: string, params: unknown[] = []) => {
    const r = db.prepare(sql).run(...(params as never[]));
    return { lastInsertRowid: r.lastInsertRowid, changes: r.changes };
  },
  dbTransaction: <T,>(fn: () => T): T => db.transaction(fn)(),
  ensureDb: () => db,
}));

import {
  getChecklistsForTransaction,
  listOpenRequiredChecklistItems,
  OPEN_REQUIRED_ITEMS_MAX_LIMIT,
} from "../checklistDbService";
import { listOpenRequiredItemsSql } from "../checklistSql";
import { LOCKED_SUBMISSION_STATUSES } from "../../transactionEligibility";

const SCHEMA = nodePath.join(__dirname, "..", "..", "..", "database", "schema.sql");
const USER = "user-3965";
const OTHER_USER = "user-3965-other";

const run = (q: string, ...p: unknown[]) => db.prepare(q).run(...(p as never[]));

interface DealOpts {
  user?: string;
  address?: string;
  status?: string | null;
  detection?: string | null;
  submission?: string | null;
  closing?: string | null;
}

function seedDeal(id: string, opts: DealOpts = {}): void {
  run(
    `INSERT INTO transactions (id, user_id, property_address) VALUES (?, ?, ?)`,
    id,
    opts.user ?? USER,
    opts.address ?? `${id} Road`,
  );
  // Set after the insert so the column defaults cannot mask NULL.
  run(`UPDATE transactions SET status = ? WHERE id = ?`, "status" in opts ? opts.status : "active", id);
  if ("detection" in opts) run(`UPDATE transactions SET detection_status = ? WHERE id = ?`, opts.detection, id);
  if ("submission" in opts) run(`UPDATE transactions SET submission_status = ? WHERE id = ?`, opts.submission, id);
  if ("closing" in opts) run(`UPDATE transactions SET closing_deadline = ? WHERE id = ?`, opts.closing, id);
}

interface ItemOpts {
  id?: string;
  required?: boolean;
  checked?: boolean;
  sort?: number;
}

let seq = 0;
function seedChecklist(
  dealId: string,
  checklistId: string,
  items: ItemOpts[],
  checklistSort = 0,
): string[] {
  run(
    `INSERT INTO transaction_checklists (id, transaction_id, template_id, template_name, sort_order)
     VALUES (?, ?, ?, 'Residential', ?)`,
    checklistId,
    dealId,
    `tpl-${checklistId}`,
    checklistSort,
  );
  return items.map((item) => {
    seq += 1;
    const id = item.id ?? `i-${seq}`;
    run(
      `INSERT INTO transaction_checklist_items (id, checklist_id, title, is_required, is_checked, checked_at, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      checklistId,
      `Item ${id}`,
      item.required === false ? 0 : 1,
      item.checked ? 1 : 0,
      item.checked ? "2026-10-01T00:00:00Z" : null,
      item.sort ?? 0,
    );
    return id;
  });
}

/** One required, unticked item on a fresh deal; returns the item id. */
function dealWithOneOpenItem(dealId: string, opts: DealOpts = {}): string {
  seedDeal(dealId, opts);
  return seedChecklist(dealId, `c-${dealId}`, [{}])[0];
}

const read = (userId = USER, limit = OPEN_REQUIRED_ITEMS_MAX_LIMIT) =>
  listOpenRequiredChecklistItems(userId, LOCKED_SUBMISSION_STATUSES, limit);
const dealIds = async (userId = USER) => (await read(userId)).items.map((r) => r.transactionId);

beforeEach(() => {
  db = openTestDb();
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(fs.readFileSync(SCHEMA, "utf8"));
  db.exec("PRAGMA foreign_keys = ON");
  run(`INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'a@example.test', 'google', 'oa-a')`, USER);
  run(`INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'b@example.test', 'google', 'oa-b')`, OTHER_USER);
});

afterEach(() => db.close());

describe("BACKLOG-3965 Todo read — which deals", () => {
  it("lists an open deal of EVERY open submission status, and a NULL one (the map-keys filter would list none)", async () => {
    dealWithOneOpenItem("d-not-submitted", { submission: "not_submitted" });
    dealWithOneOpenItem("d-needs-changes", { submission: "needs_changes" });
    dealWithOneOpenItem("d-rejected-sub", { submission: "rejected" });
    dealWithOneOpenItem("d-null-sub", { submission: null });
    expect((await dealIds()).sort()).toEqual(
      ["d-needs-changes", "d-not-submitted", "d-null-sub", "d-rejected-sub"].sort(),
    );
  });

  it("leaves out every locked submission status", async () => {
    for (const s of ["submitted", "under_review", "resubmitted", "approved"]) {
      dealWithOneOpenItem(`d-${s}`, { submission: s });
    }
    dealWithOneOpenItem("d-open");
    expect(await dealIds()).toEqual(["d-open"]);
  });

  it("keeps a deal whose detection_status is NULL, leaves out pending and rejected", async () => {
    dealWithOneOpenItem("d-null-detect", { detection: null });
    dealWithOneOpenItem("d-confirmed", { detection: "confirmed" });
    dealWithOneOpenItem("d-pending", { detection: "pending" });
    dealWithOneOpenItem("d-dismissed", { detection: "rejected" });
    expect((await dealIds()).sort()).toEqual(["d-confirmed", "d-null-detect"]);
  });

  it("only active deals: closed, rejected, pending and NULL status are left out", async () => {
    dealWithOneOpenItem("d-active");
    dealWithOneOpenItem("d-closed", { status: "closed" });
    dealWithOneOpenItem("d-status-rejected", { status: "rejected" });
    dealWithOneOpenItem("d-status-pending", { status: "pending" });
    dealWithOneOpenItem("d-status-null", { status: null });
    expect(await dealIds()).toEqual(["d-active"]);
  });

  it("user scope: another user's open deal is never listed", async () => {
    dealWithOneOpenItem("d-mine");
    dealWithOneOpenItem("d-theirs", { user: OTHER_USER });
    expect(await dealIds()).toEqual(["d-mine"]);
    expect(await dealIds(OTHER_USER)).toEqual(["d-theirs"]);
  });
});

describe("BACKLOG-3965 Todo read — which items", () => {
  it("required and unticked only: optional items and ticked items are left out", async () => {
    seedDeal("d1");
    seedChecklist("d1", "c1", [
      { id: "req-open", required: true, checked: false },
      { id: "req-done", required: true, checked: true },
      { id: "opt-open", required: false, checked: false },
      { id: "opt-done", required: false, checked: true },
    ]);
    const { items, totalCount } = await read();
    expect(items.map((i) => i.itemId)).toEqual(["req-open"]);
    expect(totalCount).toBe(1);
  });

  it("the deal's ring is summed across BOTH checklists and counts required items only", async () => {
    seedDeal("d1");
    seedChecklist("d1", "c1", [
      { id: "a1", required: true, checked: true },
      { id: "a2", required: true, checked: false },
      { id: "a3", required: false, checked: true },
    ], 0);
    seedChecklist("d1", "c2", [
      { id: "b1", required: true, checked: true },
      { id: "b2", required: true, checked: true },
      { id: "b3", required: true, checked: false },
      { id: "b4", required: false, checked: false },
    ], 1);
    const { items } = await read();
    const deal = await getChecklistsForTransaction("d1", "agent");
    expect(deal).toMatchObject({ requiredDone: 3, requiredTotal: 5 });
    expect(items.map((i) => i.itemId)).toEqual(["a2", "b3"]);
    for (const item of items) {
      expect([item.dealRequiredDone, item.dealRequiredTotal]).toEqual([
        deal.requiredDone,
        deal.requiredTotal,
      ]);
    }
  });

  it("each row carries the deal, the checklist, the title and the Closing Date", async () => {
    seedDeal("d1", { address: "1 Elm St", closing: "2026-11-20" });
    seedChecklist("d1", "c1", [{ id: "x1" }]);
    expect((await read()).items).toEqual([
      {
        itemId: "x1",
        checklistId: "c1",
        title: "Item x1",
        transactionId: "d1",
        propertyAddress: "1 Elm St",
        closingDeadline: "2026-11-20",
        dealRequiredDone: 0,
        dealRequiredTotal: 1,
      },
    ]);
  });
});

describe("BACKLOG-3965 Todo read — order, count and the empty answer", () => {
  it("Closing Date soonest first by calendar day (date and ISO forms mixed), no date last, then deal, checklist, item", async () => {
    // Same calendar day in both stored forms; the ISO one has the EARLIER address,
    // so a plain text compare of the column (date-only sorts first) reds.
    seedDeal("d-late", { address: "A Late", closing: "2026-12-01" });
    seedDeal("d-iso", { address: "A Same Day ISO", closing: "2026-11-10T00:00:00.000Z" });
    seedDeal("d-date", { address: "B Same Day Date", closing: "2026-11-10" });
    seedDeal("d-none", { address: "A No Date", closing: null });
    seedDeal("d-empty", { address: "B Empty Date", closing: "" });
    seedChecklist("d-late", "c-late", [{ id: "late-1" }]);
    seedChecklist("d-iso", "c-iso", [{ id: "iso-1" }]);
    // Two checklists on one deal: ids run AGAINST sort_order, and item ids run
    // against item sort_order, so dropping either sort key reds.
    seedChecklist("d-date", "c-date-a", [{ id: "date-a1", sort: 2 }, { id: "date-a2", sort: 1 }], 1);
    seedChecklist("d-date", "c-date-z", [{ id: "date-z1", sort: 5 }], 0);
    seedChecklist("d-none", "c-none", [{ id: "none-1" }]);
    seedChecklist("d-empty", "c-empty", [{ id: "empty-1" }]);
    const { items } = await read();
    expect(items.map((i) => i.itemId)).toEqual([
      "iso-1",
      "date-z1",
      "date-a2",
      "date-a1",
      "late-1",
      "none-1",
      "empty-1",
    ]);
    expect(items.find((i) => i.itemId === "empty-1")?.closingDeadline).toBeNull();
  });

  it("the total is not capped by the row limit", async () => {
    seedDeal("d1");
    seedChecklist("d1", "c1", Array.from({ length: 7 }, (_, n) => ({ id: `n${n}`, sort: n })));
    const { items, totalCount } = await read(USER, 3);
    expect(items.map((i) => i.itemId)).toEqual(["n0", "n1", "n2"]);
    expect(totalCount).toBe(7);
  });

  it("the limit is clamped to 1..50", async () => {
    seedDeal("d1");
    seedChecklist("d1", "c1", Array.from({ length: 55 }, (_, n) => ({ id: `n${n}`, sort: n })));
    expect((await read(USER, 500)).items).toHaveLength(OPEN_REQUIRED_ITEMS_MAX_LIMIT);
    expect((await read(USER, 0)).items).toHaveLength(1);
    expect((await read(USER, 500)).totalCount).toBe(55);
  });

  it("nothing left is an empty list and a zero count, not null", async () => {
    seedDeal("d1");
    seedChecklist("d1", "c1", [{ required: true, checked: true }]);
    expect(await read()).toEqual({ totalCount: 0, items: [] });
  });

  it("refuses to read with no locked status rather than treat every deal as open", () => {
    expect(() => listOpenRequiredChecklistItems(USER, [], 5)).toThrow(/no locked status/);
  });

  it("the plan reaches deals through the user and items through their checklist — no full scan of items or checklists", () => {
    const plan = (
      db
        .prepare(`EXPLAIN QUERY PLAN ${listOpenRequiredItemsSql(LOCKED_SUBMISSION_STATUSES.length)}`)
        .all(USER, ...LOCKED_SUBMISSION_STATUSES, 5) as Array<{ detail: string }>
    ).map((r) => r.detail);
    const text = plan.join("\n");
    // Measured (Electron's SQLite 3.53): SEARCH t by idx_transactions_user_id,
    // c by its (transaction_id, template_id) autoindex, i by
    // idx_checklist_items_checklist; the ring subqueries the same; one temp
    // B-tree for the ORDER BY over this user's open items only.
    expect(text).toMatch(/SEARCH t USING (COVERING )?INDEX idx_transactions_user_id/);
    expect(text).toMatch(/SEARCH c USING (COVERING )?INDEX sqlite_autoindex_transaction_checklists_2/);
    expect(text).toMatch(/SEARCH i USING (COVERING )?INDEX idx_checklist_items_checklist/);
    expect(text).not.toMatch(/\bSCAN\b/);
  });
});
