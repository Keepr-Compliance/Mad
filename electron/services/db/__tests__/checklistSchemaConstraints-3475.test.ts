/**
 * @jest-environment node
 *
 * BACKLOG-3475 — THE CHECKLIST TABLES' CONSTRAINTS, ON THE REAL DRIVER.
 *
 * ===========================================================================
 * WHY THIS SUITE CARRIES THE WHOLE LOAD FOR EVERY CHECK
 * ===========================================================================
 * `databaseService.schema-parity.test.ts` fingerprints the schema through
 * `PRAGMA table_info`, **which does not report CHECK constraints at all**. So a
 * green parity run is not evidence for any of:
 *
 *   - the paired `(is_checked = 0) = (checked_at IS NULL)` rule
 *   - the `expected_document_type` value list
 *   - the exactly-one-target rule on a link member
 *   - the length bounds on template name, title, description and label
 *
 * Its own ALLOWED_EVOLUTION entry says so in writing. If a CHECK were dropped
 * from `schema.sql` tomorrow, parity would stay green and only this file would
 * notice.
 *
 * ===========================================================================
 * THE WRONG IMPLEMENTATIONS EACH TEST CATCHES
 * ===========================================================================
 * Not merely "the fix is absent" — the plausible wrong build:
 *
 *   transaction FK without ON DELETE CASCADE
 *       Does NOT orphan, which is the intuition. It makes
 *       `DELETE FROM transactions` THROW, so every transaction that has a
 *       checklist becomes undeletable. Measured: nothing else in the repo
 *       catches this.
 *   transaction FK omitted entirely
 *       Rows survive their transaction as orphans.
 *   items FK without cascade
 *       Removing a checklist throws instead of removing it.
 *   single-column FK on link_id (the obvious shape)
 *       An attachment member can be filed under an email group. The composite
 *       (link_id, kind) FK is what makes that impossible, and it is the reason
 *       the group table carries UNIQUE (id, kind) at all.
 *   checked_at written by a second statement, or forgotten
 *       A ticked item with no tick time, or an unticked item that still claims
 *       one. The pair CHECK refuses both.
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

import { deleteTransaction } from "../transactionDbService";

const SCHEMA = nodePath.join(__dirname, "..", "..", "..", "database", "schema.sql");
const USER = "user-3475-constraints";

const rows = (q: string) => db.prepare(q).all() as Array<Record<string, unknown>>;
const ids = (table: string) => rows(`SELECT id FROM ${table} ORDER BY id`).map((r) => r.id as string);
const run = (q: string, ...p: unknown[]) => db.prepare(q).run(...(p as never[]));

/** Seed a transaction carrying a full checklist: one item, one group, one member. */
function seedChecklist(suffix: string, emailId: string): void {
  run(`INSERT INTO transactions (id, user_id, property_address) VALUES (?, ?, ?)`, `txn-${suffix}`, USER, `${suffix} Road`);
  run(
    `INSERT INTO emails (id, user_id, external_id, source, account_id, subject, sender, recipients, sent_at)
     VALUES (?, ?, ?, 'outlook', 'acct', 'Offer', 's@example.com', 'me@example.com', '2026-03-01T10:00:00Z')`,
    emailId,
    USER,
    `ext-${suffix}`,
  );
  run(`INSERT INTO communications (id, user_id, transaction_id, email_id, link_source) VALUES (?, ?, ?, ?, 'manual')`, `comm-${suffix}`, USER, `txn-${suffix}`, emailId);
  run(`INSERT INTO transaction_checklists (id, transaction_id, template_id, template_name) VALUES (?, ?, 'tpl', 'Residential')`, `c-${suffix}`, `txn-${suffix}`);
  run(`INSERT INTO transaction_checklist_items (id, checklist_id, title, is_required) VALUES (?, ?, 'Signed offer', 1)`, `i-${suffix}`, `c-${suffix}`);
  run(`INSERT INTO transaction_checklist_links (id, item_id, kind, label) VALUES (?, ?, 'email', 'Offer')`, `L-${suffix}`, `i-${suffix}`);
  run(`INSERT INTO transaction_checklist_link_members (id, link_id, kind, email_id) VALUES (?, ?, 'email', ?)`, `m-${suffix}`, `L-${suffix}`, emailId);
}

beforeEach(() => {
  db = new Database(":memory:") as unknown as DatabaseType;
  db.pragma("foreign_keys = OFF");
  db.exec(fs.readFileSync(SCHEMA, "utf8"));
  db.pragma("foreign_keys = ON");
  run(`INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'c@example.test', 'google', 'oa-c')`, USER);
});

afterEach(() => db.close());

describe("BACKLOG-3475 — deleting a transaction takes its checklist and leaves every other one alone", () => {
  it("delete succeeds, this transaction's four tables are empty, the OTHER transaction's rows are untouched (id sets)", async () => {
    seedChecklist("a", "email-a");
    seedChecklist("b", "email-b");

    await deleteTransaction("txn-a");

    // A count of "1 checklist left" would pass even if the WRONG one survived.
    expect(ids("transaction_checklists")).toEqual(["c-b"]);
    expect(ids("transaction_checklist_items")).toEqual(["i-b"]);
    expect(ids("transaction_checklist_links")).toEqual(["L-b"]);
    expect(ids("transaction_checklist_link_members")).toEqual(["m-b"]);
  });

  it("removing a checklist takes its items, groups and members, and leaves the other checklist whole", () => {
    seedChecklist("a", "email-a");
    seedChecklist("b", "email-b");

    run(`DELETE FROM transaction_checklists WHERE id = 'c-a'`);

    expect(ids("transaction_checklist_items")).toEqual(["i-b"]);
    expect(ids("transaction_checklist_links")).toEqual(["L-b"]);
    expect(ids("transaction_checklist_link_members")).toEqual(["m-b"]);
    // The transaction itself survives: removing a checklist is not a delete.
    expect(ids("transactions")).toEqual(["txn-a", "txn-b"]);
  });
});

describe("BACKLOG-3475 — a member cannot disagree with its group", () => {
  it("an attachment member may not be filed under an email group", () => {
    seedChecklist("a", "email-a");
    run(`INSERT INTO attachments (id, email_id, filename) VALUES ('att-a', 'email-a', 'offer.pdf')`);

    // L-a is kind 'email'. The composite (link_id, kind) FK has no parent row
    // (L-a, 'attachment'), so this is refused at the database.
    expect(() =>
      run(
        `INSERT INTO transaction_checklist_link_members (id, link_id, kind, attachment_id) VALUES ('bad', 'L-a', 'attachment', 'att-a')`,
      ),
    ).toThrow(/FOREIGN KEY constraint failed/);
    expect(ids("transaction_checklist_link_members")).toEqual(["m-a"]);
  });

  it("a member must carry exactly one target, matching its kind", () => {
    seedChecklist("a", "email-a");
    run(`INSERT INTO attachments (id, email_id, filename) VALUES ('att-a', 'email-a', 'offer.pdf')`);

    // Both targets set.
    expect(() =>
      run(
        `INSERT INTO transaction_checklist_link_members (id, link_id, kind, email_id, attachment_id) VALUES ('bad1', 'L-a', 'email', 'email-a', 'att-a')`,
      ),
    ).toThrow(/CHECK constraint failed/);
    // Neither target set.
    expect(() =>
      run(
        `INSERT INTO transaction_checklist_link_members (id, link_id, kind) VALUES ('bad2', 'L-a', 'email')`,
      ),
    ).toThrow(/CHECK constraint failed/);
    expect(ids("transaction_checklist_link_members")).toEqual(["m-a"]);
  });

  it("the same evidence cannot be added to one group twice", () => {
    seedChecklist("a", "email-a");
    expect(() =>
      run(
        `INSERT INTO transaction_checklist_link_members (id, link_id, kind, email_id) VALUES ('dup', 'L-a', 'email', 'email-a')`,
      ),
    ).toThrow(/UNIQUE constraint failed/);
  });
});

describe("BACKLOG-3475 — a tick and its time cannot disagree (parity cannot see this)", () => {
  it("ticked with no time, and unticked with a time, are both refused", () => {
    seedChecklist("a", "email-a");

    expect(() => run(`UPDATE transaction_checklist_items SET is_checked = 1 WHERE id = 'i-a'`)).toThrow(
      /CHECK constraint failed/,
    );
    expect(() =>
      run(`UPDATE transaction_checklist_items SET checked_at = '2026-03-02T10:00:00Z' WHERE id = 'i-a'`),
    ).toThrow(/CHECK constraint failed/);

    // The row is still in its original, consistent state.
    expect(rows(`SELECT is_checked, checked_at FROM transaction_checklist_items WHERE id = 'i-a'`)).toEqual([
      { is_checked: 0, checked_at: null },
    ]);
  });

  it("ticking and unticking together is accepted in both directions", () => {
    seedChecklist("a", "email-a");

    run(`UPDATE transaction_checklist_items SET is_checked = 1, checked_at = CURRENT_TIMESTAMP WHERE id = 'i-a'`);
    const ticked = rows(`SELECT is_checked, checked_at FROM transaction_checklist_items WHERE id = 'i-a'`)[0];
    expect(ticked.is_checked).toBe(1);
    expect(ticked.checked_at).not.toBeNull();

    run(`UPDATE transaction_checklist_items SET is_checked = 0, checked_at = NULL WHERE id = 'i-a'`);
    expect(rows(`SELECT is_checked, checked_at FROM transaction_checklist_items WHERE id = 'i-a'`)).toEqual([
      { is_checked: 0, checked_at: null },
    ]);
  });
});

describe("BACKLOG-3475 — the value lists and bounds parity cannot see", () => {
  it("expected_document_type accepts the ten DocumentType values and refuses one that only exists elsewhere", () => {
    seedChecklist("a", "email-a");
    const accepted = [
      "offer",
      "inspection",
      "disclosure",
      "contract",
      "appraisal",
      "amendment",
      "addendum",
      "title",
      "closing",
      "other",
    ];
    accepted.forEach((value, index) => {
      run(
        `INSERT INTO transaction_checklist_items (id, checklist_id, title, expected_document_type, sort_order) VALUES (?, 'c-a', 'Doc', ?, ?)`,
        `dt-${index}`,
        value,
        index + 1,
      );
    });
    expect(ids("transaction_checklist_items").length).toBe(accepted.length + 1);

    // `correspondence` is a real value in the cloud's submission_attachments
    // CHECK, so this is a value a careless copy could produce — not a nonsense
    // string chosen to make the test pass.
    expect(() =>
      run(
        `INSERT INTO transaction_checklist_items (id, checklist_id, title, expected_document_type) VALUES ('dt-bad', 'c-a', 'Doc', 'correspondence')`,
      ),
    ).toThrow(/CHECK constraint failed/);
  });

  it("BACKLOG-3476: a transaction holds several checklists, each from a different template", () => {
    seedChecklist("a", "email-a");
    run(
      `INSERT INTO transaction_checklists (id, transaction_id, template_id, template_name, sort_order) VALUES ('c-a2', 'txn-a', 'tpl2', 'Commercial', 1)`,
    );
    expect(ids("transaction_checklists")).toEqual(["c-a", "c-a2"]);
  });

  it("BACKLOG-3476: the same template twice on one transaction is refused", () => {
    seedChecklist("a", "email-a");
    const templateId = (
      db.prepare(`SELECT template_id FROM transaction_checklists WHERE id = 'c-a'`).get() as { template_id: string }
    ).template_id;
    expect(() =>
      run(
        `INSERT INTO transaction_checklists (id, transaction_id, template_id, template_name) VALUES ('c-a2', 'txn-a', ?, 'Again')`,
        templateId,
      ),
    ).toThrow(/UNIQUE constraint failed: transaction_checklists.transaction_id, transaction_checklists.template_id/);
    expect(ids("transaction_checklists")).toEqual(["c-a"]);
  });

  it("empty and over-long text is refused where the column bounds it", () => {
    seedChecklist("a", "email-a");

    expect(() =>
      run(
        `INSERT INTO transaction_checklists (id, transaction_id, template_id, template_name) VALUES ('c-blank', 'txn-a', 'tpl', '   ')`,
      ),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      run(`INSERT INTO transaction_checklist_items (id, checklist_id, title) VALUES ('i-blank', 'c-a', '  ')`),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      run(
        `INSERT INTO transaction_checklist_items (id, checklist_id, title, description) VALUES ('i-long', 'c-a', 'T', ?)`,
        "x".repeat(2001),
      ),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      run(`INSERT INTO transaction_checklist_links (id, item_id, kind, label) VALUES ('L-blank', 'i-a', 'email', ' ')`),
    ).toThrow(/CHECK constraint failed/);
    // The boundary on the other side: 2000 characters is accepted.
    run(
      `INSERT INTO transaction_checklist_items (id, checklist_id, title, description, sort_order) VALUES ('i-ok', 'c-a', 'T', ?, 9)`,
      "x".repeat(2000),
    );
    expect(ids("transaction_checklist_items")).toEqual(["i-a", "i-ok"]);
  });
});
