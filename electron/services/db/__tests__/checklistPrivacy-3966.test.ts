/**
 * @jest-environment node
 *
 * BACKLOG-3966 PR-1 — THE PRIVATE CHECKLIST IS LEFT OUT OF EVERY BROKER-FACING
 * READ, AND ONLY THERE.
 *
 * Real driver (required by absolute path, so jest.config's moduleNameMapper
 * mock cannot stand in — it does not enforce UNIQUE; SR R9) over the real
 * schema.sql. Nothing writes the private row yet, so the fixture INSERTs it
 * with the columns of the schema.sql DDL for `transaction_checklists`.
 *
 * Wrong implementations this suite exists to catch:
 *   - a prefix match (`keepr:` anything is private) — hides a real template;
 *   - the broker read still returning the private row;
 *   - the agent read leaving it out (agent numbers must count My items);
 *   - the audience argument made optional or given a default;
 *   - the SQL literal drifting from the constant.
 *
 * RUNNER (real sqlite -> Electron ABI):
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js \
 *     --bail=0 electron/services/db/__tests__/checklistPrivacy-3966.test.ts
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

import { getChecklistsForTransaction } from "../checklistDbService";
import {
  MY_ITEMS_TEMPLATE_ID,
  NOT_PRIVATE_CHECKLIST_SQL,
  isPrivateChecklist,
} from "../checklistPrivacy";

const SCHEMA = nodePath.join(__dirname, "..", "..", "..", "database", "schema.sql");
const USER = "user-3966";
const TX = "txn-3966";

const run = (q: string, ...p: unknown[]) => db.prepare(q).run(...(p as never[]));

/** A checklist row with the schema.sql columns, and its items. */
function seedChecklist(
  id: string,
  templateId: string,
  templateName: string,
  sortOrder: number,
  items: Array<{ id: string; required: boolean; checked: boolean }>,
): void {
  run(
    `INSERT INTO transaction_checklists (id, transaction_id, template_id, template_name, sort_order)
     VALUES (?, ?, ?, ?, ?)`,
    id, TX, templateId, templateName, sortOrder,
  );
  items.forEach((item, n) =>
    run(
      `INSERT INTO transaction_checklist_items (id, checklist_id, title, is_required, is_checked, checked_at, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      item.id, id, `Item ${item.id}`, item.required ? 1 : 0, item.checked ? 1 : 0,
      item.checked ? "2026-10-31T09:00:00Z" : null, n,
    ),
  );
}

beforeEach(() => {
  db = new Database(":memory:") as unknown as DatabaseType;
  db.pragma("foreign_keys = OFF");
  db.exec(fs.readFileSync(SCHEMA, "utf8"));
  db.pragma("foreign_keys = ON");
  run(`INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'a@example.test', 'google', 'oa-a')`, USER);
  run(`INSERT INTO transactions (id, user_id, property_address) VALUES (?, ?, '1 Fixture Way')`, TX, USER);
  // The mock's numbers: template 7/12 required + My items 1/2 = 8/14.
  seedChecklist("cl-tpl", "tpl-purchase", "Residential Purchase", 0,
    Array.from({ length: 12 }, (_, n) => ({ id: `t-${n}`, required: true, checked: n < 7 })));
  seedChecklist("cl-mine", MY_ITEMS_TEMPLATE_ID, "My items", 1, [
    { id: "p-1", required: true, checked: true },
    { id: "p-2", required: true, checked: false },
  ]);
  // Looks like the reserved id but is not it: a broker reader must keep it.
  seedChecklist("cl-near", "keepr:my-items-2", "Near miss", 2, [{ id: "n-1", required: true, checked: false }]);
});

afterEach(() => db.close());

describe("BACKLOG-3966 — the private checklist and its audience", () => {
  it("runs on the real SQLite driver, not the jest mock", () => {
    expect(db.prepare("SELECT sqlite_version() AS v").get()).toEqual({ v: expect.stringMatching(/^3\.\d+\.\d+$/) });
  });

  it("isPrivateChecklist is an EXACT match on the reserved id", () => {
    expect(MY_ITEMS_TEMPLATE_ID).toBe("keepr:my-items");
    expect(isPrivateChecklist("keepr:my-items")).toBe(true);
    for (const other of ["keepr:", "keepr:my-items-2", "keepr:other", "KEEPR:MY-ITEMS", " keepr:my-items", "", null, undefined]) {
      expect([other, isPrivateChecklist(other)]).toEqual([other, false]);
    }
  });

  it("the SQL fragment names the same literal as the constant", () => {
    expect(NOT_PRIVATE_CHECKLIST_SQL).toBe(`cl.template_id <> '${MY_ITEMS_TEMPLATE_ID}'`);
  });

  it("broker read: the private checklist and its items are absent; a near-miss id is kept", async () => {
    const got = await getChecklistsForTransaction(TX, "broker");
    expect(got.checklists.map((d) => [d.checklist.templateId, d.checklist.isPrivate])).toEqual([
      ["tpl-purchase", false],
      ["keepr:my-items-2", false],
    ]);
    const itemIds = got.checklists.flatMap((d) => d.items.map((i) => i.id));
    expect(itemIds.filter((id) => id.startsWith("p-"))).toEqual([]);
    expect([got.requiredDone, got.requiredTotal]).toEqual([7, 13]);
  });

  it("agent read: the private checklist is present, flagged, and counted (8 of 14 + the near miss)", async () => {
    const got = await getChecklistsForTransaction(TX, "agent");
    expect(got.checklists.map((d) => [d.checklist.templateId, d.checklist.isPrivate])).toEqual([
      ["tpl-purchase", false],
      [MY_ITEMS_TEMPLATE_ID, true],
      ["keepr:my-items-2", false],
    ]);
    const mine = got.checklists[1];
    expect([mine.requiredDone, mine.requiredTotal]).toEqual([1, 2]);
    expect([got.requiredDone, got.requiredTotal]).toEqual([8, 15]);
  });

  it("the audience argument is required, with no default (type level)", () => {
    // A default or `?` makes the arity `1 | 2`, and this line stops compiling
    // under `npm run type-check:tests`.
    type Arity = Parameters<typeof getChecklistsForTransaction>["length"];
    type Exactly<T, U> = [T] extends [U] ? ([U] extends [T] ? true : false) : false;
    const audienceRequired: Exactly<Arity, 2> = true;
    expect(audienceRequired).toBe(true);
  });
});
