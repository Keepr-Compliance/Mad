/**
 * @jest-environment node
 *
 * BACKLOG-2366 — removing a contact from a transaction tombstones the ROLE
 * instead of destroying it.
 *
 * WHY THIS FILE EXISTS. `transaction_contacts` is where a party's role lives —
 * buyer's agent, lender, title company. Removal used to be a hard DELETE at three
 * call sites, so taking someone off a deal erased the only record that they had
 * ever held that role on it. On a transaction under audit that is evidence
 * disappearing with no trace.
 *
 * FIXTURE CHOICE — REAL SCHEMA, REAL MIGRATION CHAIN. This suite deliberately
 * does NOT hand-roll a schema. It seeds the migration harness at v55 and runs the
 * real chain, so `removed_at`/`removed_reason` arrive from migration v56 exactly
 * as they do in the field, and `UNIQUE(transaction_id, contact_id)` is the real
 * constraint rather than one the test author remembered to type. That constraint
 * is the whole reason re-adding must revive rather than insert: an invented
 * fixture without it would let a duplicate-row bug pass green.
 *
 * The production functions read the DB through `dbConnection`, which the harness
 * populates via `setDb()` — so these are the real queries, not re-implementations.
 *
 * COVERAGE OF THE THREE FORMER DELETE SITES (each has its own control; see the
 * "injected defect" notes on the individual cases):
 *   site 1 — unlinkContactFromTransaction              (was :312)
 *   site 2 — batchUpdateContactAssignments, role-scoped (was :351)
 *   site 3 — batchUpdateContactAssignments, all-roles    (was :356)
 *
 * Fixtures use reserved values only (example.com, +1 555 01xx) per BACKLOG-2485.
 */

import type { Database as DatabaseType } from "better-sqlite3";

jest.mock("electron", () => ({ app: { getPath: jest.fn(() => "/mock/user/data") } }));
jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  setUser: jest.fn(),
  addBreadcrumb: jest.fn(),
}));
jest.mock("../../logService", () => {
  const m = {
    info: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
  };
  return { __esModule: true, default: m, logService: m };
});
jest.mock("../../databaseEncryptionService", () => {
  const m = {
    initialize: jest.fn().mockResolvedValue(undefined),
    getEncryptionKey: jest.fn().mockResolvedValue("test-encryption-key-hex"),
    isDatabaseEncrypted: jest.fn().mockResolvedValue(false),
    getCachedKey: jest.fn(() => "test-encryption-key-hex"),
    getKeyMetadata: jest.fn().mockResolvedValue({}),
  };
  return { __esModule: true, default: m, databaseEncryptionService: m };
});
jest.mock("../../contactsService", () => ({
  getContactNames: jest.fn(() => Promise.resolve([])),
}));
jest.mock("../../../workers/contactWorkerPool", () => ({
  queryContacts: jest.fn(),
  isPoolReady: jest.fn(() => false),
}));

import {
  createMigrationHarness,
  type MigrationHarness,
} from "../../__tests__/helpers/migrationTestHarness";

import {
  assignContactToTransaction,
  batchUpdateContactAssignments,
  getRemovedTransactionContacts,
  getTransactionContacts,
  getTransactionContactsByRole,
  getTransactionContactsWithRoles,
  isContactAssignedToTransaction,
  linkContactToTransaction,
  unlinkContactFromTransaction,
} from "../transactionContactDbService";

const USER_ID = "user-2366";

const TXN_A = "txn-alpha";
const TXN_B = "txn-beta";

const JANE = "contact-jane";
const OMAR = "contact-omar";

interface JunctionRow {
  id: string;
  transaction_id: string;
  contact_id: string;
  role: string | null;
  role_category: string | null;
  specific_role: string | null;
  removed_at: string | null;
  removed_reason: string | null;
  created_at: string;
}

let harness: MigrationHarness;
let db: DatabaseType;

/** Every junction row for a transaction, tombstoned or not. */
function allRows(transactionId: string): JunctionRow[] {
  return db
    .prepare(
      `SELECT id, transaction_id, contact_id, role, role_category, specific_role,
              removed_at, removed_reason, created_at
         FROM transaction_contacts
        WHERE transaction_id = ?
        ORDER BY contact_id`,
    )
    .all(transactionId) as JunctionRow[];
}

function rowFor(transactionId: string, contactId: string): JunctionRow | undefined {
  return allRows(transactionId).find((r) => r.contact_id === contactId);
}

/** Exact identity set of the contacts a transaction currently lists. */
async function currentContactIds(transactionId: string): Promise<string[]> {
  const rows = await getTransactionContactsWithRoles(transactionId);
  return rows.map((r) => r.contact_id).sort();
}

beforeEach(async () => {
  harness = createMigrationHarness({ seedV29Schema: true });
  // Seed just below the tombstone migration so v56 (the columns) and v62 (the
  // participant_count view) both run for real.
  harness.seedSchemaVersion(55);
  await harness.service._runVersionedMigrations();
  db = harness.db;

  // The harness seeds `contacts` at its v29 shape, which predates two columns
  // that every assign/update path in the service under test writes:
  //   default_role — schema.sql:177, "Most-recently-assigned role for auto-fill"
  //   updated_at   — touched by the same `UPDATE contacts SET default_role = ?,
  //                  updated_at = CURRENT_TIMESTAMP` statement
  // Both are real production columns; without them the suite dies with "no such
  // column" before reaching a single tombstone assertion.
  db.exec(`ALTER TABLE contacts ADD COLUMN default_role TEXT`);
  db.exec(`ALTER TABLE contacts ADD COLUMN updated_at DATETIME`);

  db.prepare(`INSERT INTO users_local (id) VALUES (?)`).run(USER_ID);

  for (const [id, name] of [
    [JANE, "Jane Example"],
    [OMAR, "Omar Example"],
  ]) {
    db.prepare(
      `INSERT INTO contacts (id, user_id, display_name, source, is_imported)
       VALUES (?, ?, ?, 'manual', 1)`,
    ).run(id, USER_ID, name);
  }

  db.prepare(
    `INSERT INTO contact_emails (id, contact_id, email, is_primary)
     VALUES (?, ?, ?, 1)`,
  ).run("email-jane", JANE, "jane@example.com");
  db.prepare(
    `INSERT INTO contact_phones (id, contact_id, phone_e164, is_primary)
     VALUES (?, ?, ?, 1)`,
  ).run("phone-jane", JANE, "+15550101");

  for (const txn of [TXN_A, TXN_B]) {
    db.prepare(`INSERT INTO transactions (id) VALUES (?)`).run(txn);
  }
});

afterEach(async () => {
  await harness.cleanup();
});

// ---------------------------------------------------------------------------
// The columns must actually be present — otherwise every assertion below is
// vacuous ("no such column" would fail loudly, but a silently skipped v56 would
// not).
// ---------------------------------------------------------------------------
describe("fixture integrity", () => {
  it("has the v56 tombstone columns AND the real UNIQUE constraint", () => {
    const cols = (
      db.prepare(`PRAGMA table_info(transaction_contacts)`).all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["removed_at", "removed_reason"]));

    // The constraint that makes "revive" mandatory rather than optional.
    db.prepare(
      `INSERT INTO transaction_contacts (id, transaction_id, contact_id) VALUES (?, ?, ?)`,
    ).run("dupe-1", TXN_A, JANE);
    expect(() =>
      db
        .prepare(
          `INSERT INTO transaction_contacts (id, transaction_id, contact_id) VALUES (?, ?, ?)`,
        )
        .run("dupe-2", TXN_A, JANE),
    ).toThrow(/UNIQUE/i);
  });
});

// ---------------------------------------------------------------------------
// SITE 1 — unlinkContactFromTransaction (was a hard DELETE at :312)
//
// INJECTED-DEFECT CONTROL: restore the original
//   "DELETE FROM transaction_contacts WHERE transaction_id = ? AND contact_id = ?"
// in unlinkContactFromTransaction and "keeps the row, with the role intact"
// fails on the `expect(row).toBeDefined()` assertion.
// ---------------------------------------------------------------------------
describe("site 1 — unlinkContactFromTransaction", () => {
  beforeEach(async () => {
    await assignContactToTransaction(TXN_A, {
      contact_id: JANE,
      specific_role: "Buyer Agent",
      role_category: "agent",
    });
  });

  it("keeps the row, with the role intact and removed_at/removed_reason set", async () => {
    const before = rowFor(TXN_A, JANE);
    expect(before).toBeDefined();
    expect(before!.removed_at).toBeNull();

    await unlinkContactFromTransaction(TXN_A, JANE, "Wrong agent on this deal");

    const row = rowFor(TXN_A, JANE);
    expect(row).toBeDefined();
    expect(row!.removed_at).not.toBeNull();
    expect(row!.removed_reason).toBe("Wrong agent on this deal");

    // The point of the ticket: the ROLE survives the removal.
    expect(row!.specific_role).toBe("Buyer Agent");
    expect(row!.role).toBe("Buyer Agent");
    expect(row!.role_category).toBe("agent");

    // Same row, not a replacement.
    expect(row!.id).toBe(before!.id);
    expect(row!.created_at).toBe(before!.created_at);
  });

  it("records a default reason when the caller does not give one", async () => {
    await unlinkContactFromTransaction(TXN_A, JANE);
    expect(rowFor(TXN_A, JANE)!.removed_reason).toBe(
      "Removed from transaction by user",
    );
  });

  it("does not overwrite the original removal timestamp when replayed", async () => {
    await unlinkContactFromTransaction(TXN_A, JANE, "First removal");
    const first = rowFor(TXN_A, JANE)!;

    await unlinkContactFromTransaction(TXN_A, JANE, "Second removal");
    const second = rowFor(TXN_A, JANE)!;

    // When the party came off is the audit-relevant fact; a replay must not
    // move it.
    expect(second.removed_at).toBe(first.removed_at);
    expect(second.removed_reason).toBe("First removal");
  });
});

// ---------------------------------------------------------------------------
// SITE 2 — batchUpdateContactAssignments, role-scoped (was a hard DELETE at :351)
//
// INJECTED-DEFECT CONTROL: restore
//   "DELETE FROM transaction_contacts WHERE transaction_id = ? AND contact_id = ?
//     AND (role = ? OR specific_role = ?)"
// in the `op.role || op.specificRole` branch and "tombstones rather than deletes
// when the role matches" fails on `expect(row).toBeDefined()`.
// ---------------------------------------------------------------------------
describe("site 2 — batchUpdateContactAssignments, role-scoped remove", () => {
  beforeEach(async () => {
    await assignContactToTransaction(TXN_A, {
      contact_id: JANE,
      specific_role: "Lender",
      role_category: "finance",
    });
  });

  it("tombstones rather than deletes when the role matches", async () => {
    await batchUpdateContactAssignments(TXN_A, [
      { action: "remove", contactId: JANE, specificRole: "Lender" },
    ]);

    const row = rowFor(TXN_A, JANE);
    expect(row).toBeDefined();
    expect(row!.removed_at).not.toBeNull();
    expect(row!.specific_role).toBe("Lender");
    expect(await currentContactIds(TXN_A)).toEqual([]);
  });

  it("leaves the row untouched when the role does NOT match", async () => {
    await batchUpdateContactAssignments(TXN_A, [
      { action: "remove", contactId: JANE, specificRole: "Title Company" },
    ]);

    const row = rowFor(TXN_A, JANE);
    expect(row!.removed_at).toBeNull();
    expect(await currentContactIds(TXN_A)).toEqual([JANE]);
  });
});

// ---------------------------------------------------------------------------
// SITE 3 — batchUpdateContactAssignments, all-roles fallback (was :356)
//
// INJECTED-DEFECT CONTROL: restore
//   "DELETE FROM transaction_contacts WHERE transaction_id = ? AND contact_id = ?"
// in the `else` branch and "tombstones rather than deletes when no role is given"
// fails on `expect(row).toBeDefined()`.
// ---------------------------------------------------------------------------
describe("site 3 — batchUpdateContactAssignments, all-roles remove", () => {
  beforeEach(async () => {
    await assignContactToTransaction(TXN_A, {
      contact_id: JANE,
      specific_role: "Inspector",
    });
  });

  it("tombstones rather than deletes when no role is given", async () => {
    await batchUpdateContactAssignments(TXN_A, [
      { action: "remove", contactId: JANE },
    ]);

    const row = rowFor(TXN_A, JANE);
    expect(row).toBeDefined();
    expect(row!.removed_at).not.toBeNull();
    expect(row!.specific_role).toBe("Inspector");
    expect(await currentContactIds(TXN_A)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The transaction must stop listing a removed party — everywhere.
// ---------------------------------------------------------------------------
describe("a removed role never reads as current", () => {
  beforeEach(async () => {
    await assignContactToTransaction(TXN_A, {
      contact_id: JANE,
      specific_role: "Buyer Agent",
    });
    await assignContactToTransaction(TXN_A, {
      contact_id: OMAR,
      specific_role: "Seller Agent",
    });
    await unlinkContactFromTransaction(TXN_A, JANE, "Removed for test");
  });

  it("getTransactionContactsWithRoles returns exactly the surviving party", async () => {
    // This is the query the AUDIT EXPORT reads through
    // (transactionExportHandlers -> getTransactionDetails ->
    //  getTransactionContactsWithRoles -> folderExport/summaryHelpers), so this
    // assertion is what keeps a removed party out of a regenerated export.
    expect(await currentContactIds(TXN_A)).toEqual([OMAR]);
  });

  it("getTransactionContacts returns exactly the surviving party", async () => {
    const ids = (await getTransactionContacts(TXN_A)).map((c) => c.id).sort();
    expect(ids).toEqual([OMAR]);
  });

  it("getTransactionContactsByRole no longer answers for the removed role", async () => {
    expect(await getTransactionContactsByRole(TXN_A, "Buyer Agent")).toEqual([]);
    expect(
      (await getTransactionContactsByRole(TXN_A, "Seller Agent")).map(
        (r) => r.contact_id,
      ),
    ).toEqual([OMAR]);
  });

  it("isContactAssignedToTransaction reports false for the removed party", async () => {
    expect(await isContactAssignedToTransaction(TXN_A, JANE)).toBe(false);
    expect(await isContactAssignedToTransaction(TXN_A, OMAR)).toBe(true);
  });

  // NOT COVERED HERE, DELIBERATELY: `transaction_summary.participant_count`
  // still counts tombstoned rows. Fixing that view is filed separately — see the
  // PR description. Short version: schema.sql's copy of the view cannot
  // reference `removed_at`, because SQLite re-validates every view on the next
  // table rebuild and migration v33 rebuilds `audit_logs` long before v56 adds
  // the column, so the whole chain dies on a fresh install. The view has no
  // readers, so nothing user-facing depends on the wrong count today.
  //
  // ALSO NOT COVERED HERE, AND THIS ONE IS AN OPEN DECISION (BACKLOG-2569):
  // "a removed party's role is a historical fact, not an editable field" was
  // asserted here, against `updateContactRole` and its `AND removed_at IS NULL`
  // scoping. BACKLOG-2569 DELETED that function as unreachable — no IPC handler,
  // no preload bridge, no renderer caller — so the assertion went with it.
  // The LIVE path does the opposite: `batchUpdateContactAssignments` looks up an
  // existing row deliberately UNFILTERED by `removed_at` and REVIVES it
  // (`removed_at = NULL, removed_reason = NULL`) with the new role. So the app
  // as shipped does not refuse the edit; it un-removes the party.
  // **If a single-contact role-edit path is ever built, the tombstone policy is
  // a decision to make, not one to inherit** — do not assume the historical-fact
  // rule still holds just because it was once written down here.

  it("still exposes the removed party through the tombstone read", async () => {
    const removed = await getRemovedTransactionContacts(TXN_A);
    expect(removed.map((r) => r.contact_id)).toEqual([JANE]);
    expect(removed[0].specific_role).toBe("Buyer Agent");
    expect(removed[0].removed_reason).toBe("Removed for test");
  });
});

// ---------------------------------------------------------------------------
// Re-adding revives. With UNIQUE(transaction_id, contact_id) an INSERT would
// throw rather than duplicate, so "no second row" and "does not throw" are the
// same property observed twice.
// ---------------------------------------------------------------------------
describe("re-adding revives the original row", () => {
  it("assignContactToTransaction clears the tombstone and adds no second row", async () => {
    const originalId = await assignContactToTransaction(TXN_A, {
      contact_id: JANE,
      specific_role: "Buyer Agent",
    });
    const originalCreatedAt = rowFor(TXN_A, JANE)!.created_at;

    await unlinkContactFromTransaction(TXN_A, JANE, "Removed by mistake");
    expect(rowFor(TXN_A, JANE)!.removed_at).not.toBeNull();

    const revivedId = await assignContactToTransaction(TXN_A, {
      contact_id: JANE,
      specific_role: "Buyer Agent",
    });

    expect(revivedId).toBe(originalId);

    const rows = allRows(TXN_A);
    expect(rows).toHaveLength(1); // not two
    expect(rows[0].removed_at).toBeNull();
    expect(rows[0].removed_reason).toBeNull();
    expect(rows[0].created_at).toBe(originalCreatedAt); // same row, full history
    expect(await currentContactIds(TXN_A)).toEqual([JANE]);
    expect(await getRemovedTransactionContacts(TXN_A)).toEqual([]);
  });

  it("linkContactToTransaction revives instead of throwing on the UNIQUE constraint", async () => {
    await linkContactToTransaction(TXN_A, JANE, "Buyer Agent");
    await unlinkContactFromTransaction(TXN_A, JANE);

    // Before BACKLOG-2366 this was a bare INSERT: with a surviving tombstone
    // occupying the UNIQUE slot it would raise SQLITE_CONSTRAINT.
    await expect(
      linkContactToTransaction(TXN_A, JANE, "Lender"),
    ).resolves.toBeUndefined();

    const rows = allRows(TXN_A);
    expect(rows).toHaveLength(1);
    expect(rows[0].removed_at).toBeNull();
    expect(rows[0].specific_role).toBe("Lender");
  });

  it("revives through the batch path, including remove+add in one batch", async () => {
    await assignContactToTransaction(TXN_A, {
      contact_id: JANE,
      specific_role: "Buyer Agent",
    });
    const originalId = rowFor(TXN_A, JANE)!.id;

    await batchUpdateContactAssignments(TXN_A, [
      { action: "remove", contactId: JANE },
      { action: "add", contactId: JANE, specificRole: "Seller Agent" },
    ]);

    const rows = allRows(TXN_A);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(originalId);
    expect(rows[0].removed_at).toBeNull();
    expect(rows[0].specific_role).toBe("Seller Agent");
    expect(await currentContactIds(TXN_A)).toEqual([JANE]);
  });
});

// ---------------------------------------------------------------------------
// Removal is scoped to ONE deal.
// ---------------------------------------------------------------------------
describe("removal is scoped to a single transaction", () => {
  it("leaves the same contact's role on another transaction untouched", async () => {
    await assignContactToTransaction(TXN_A, {
      contact_id: JANE,
      specific_role: "Buyer Agent",
    });
    await assignContactToTransaction(TXN_B, {
      contact_id: JANE,
      specific_role: "Seller Agent",
    });

    await unlinkContactFromTransaction(TXN_A, JANE, "Off this deal only");

    expect(await currentContactIds(TXN_A)).toEqual([]);
    expect(await currentContactIds(TXN_B)).toEqual([JANE]);

    expect(rowFor(TXN_A, JANE)!.removed_at).not.toBeNull();
    expect(rowFor(TXN_B, JANE)!.removed_at).toBeNull();
    expect(rowFor(TXN_B, JANE)!.specific_role).toBe("Seller Agent");

    expect(await isContactAssignedToTransaction(TXN_A, JANE)).toBe(false);
    expect(await isContactAssignedToTransaction(TXN_B, JANE)).toBe(true);
  });
});
