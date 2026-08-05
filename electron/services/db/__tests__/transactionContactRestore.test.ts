/**
 * @jest-environment node
 *
 * BACKLOG-2367 — putting a party back on a transaction they were removed from.
 *
 * WHY THIS FILE EXISTS. BACKLOG-2366 turned "remove a party from a deal" from a
 * hard DELETE into a tombstone, so the row carrying their ROLE survived. It
 * shipped the data path with no reader and no writer for the reverse direction.
 * A preserved row nobody can reach is not preservation — this suite covers the
 * function that reaches it.
 *
 * WHAT HAS TO BE PROVEN, beyond "two columns became NULL":
 *
 *   1. The ORIGINAL row comes back, not a new one. `transaction_contacts`
 *      carries `role`, `role_category`, `specific_role`, `is_primary`, `notes`
 *      and `created_at`. An INSERT would satisfy "the party is on the deal
 *      again" while silently losing every one of those, and re-dating when they
 *      joined. `created_at` is asserted explicitly for that reason.
 *   2. The two tombstones are INDEPENDENT. "Off this deal" (BACKLOG-2366) and
 *      "removed from the database" (BACKLOG-2365) are different statements made
 *      in different places. Restoring one must not quietly undo the other.
 *   3. Restore is scoped. A party on two deals, removed from both, restored on
 *      one, must still be removed from the other.
 *
 * FIXTURE CHOICE — REAL SCHEMA, REAL MIGRATION CHAIN, matching the BACKLOG-2366
 * suite beside it. The harness seeds at v55 and runs the real chain, so the
 * tombstone columns arrive from migration v56 exactly as they do in the field
 * and `UNIQUE(transaction_id, contact_id)` is the real constraint. The functions
 * under test read through `dbConnection`, which the harness populates — these
 * are the production queries, not re-implementations.
 *
 * Fixtures use reserved values only (example.com, +1 555 01xx).
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
  getRemovedTransactionContacts,
  getTransactionContactsWithRoles,
  isContactAssignedToTransaction,
  restoreContactToTransaction,
  unlinkContactFromTransaction,
} from "../transactionContactDbService";

const USER_ID = "user-2367";

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
  is_primary: number | null;
  notes: string | null;
  removed_at: string | null;
  removed_reason: string | null;
  created_at: string;
}

let harness: MigrationHarness;
let db: DatabaseType;

/** One junction row read RAW — never through the code under test. */
function rowFor(transactionId: string, contactId: string): JunctionRow | undefined {
  return db
    .prepare(
      `SELECT id, transaction_id, contact_id, role, role_category, specific_role,
              is_primary, notes, removed_at, removed_reason, created_at
         FROM transaction_contacts
        WHERE transaction_id = ? AND contact_id = ?`,
    )
    .get(transactionId, contactId) as JunctionRow | undefined;
}

/** Exact identity set of the contacts a transaction currently lists. */
async function currentContactIds(transactionId: string): Promise<string[]> {
  const rows = await getTransactionContactsWithRoles(transactionId);
  return rows.map((r) => r.contact_id).sort();
}

/** Exact identity set of the contacts shown as removed from a transaction. */
async function removedContactIds(transactionId: string): Promise<string[]> {
  const rows = await getRemovedTransactionContacts(transactionId);
  return rows.map((r) => r.contact_id).sort();
}

beforeEach(async () => {
  harness = createMigrationHarness({ seedV29Schema: true });
  // Seed just below the tombstone migration so v56 (the columns) runs for real.
  harness.seedSchemaVersion(55);
  await harness.service._runVersionedMigrations();
  db = harness.db;

  // The harness seeds `contacts` at its v29 shape, which predates two columns
  // every assign path writes. Same two ALTERs as the BACKLOG-2366 suite.
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

  // Jane is the listing agent on deal A and the buyer's agent on deal B.
  // Omar is the lender on deal A. Nobody starts removed.
  await assignContactToTransaction(TXN_A, {
    contact_id: JANE,
    specific_role: "listing_agent",
    role_category: "agent",
    is_primary: 1,
    notes: "Primary listing contact",
  });
  await assignContactToTransaction(TXN_B, {
    contact_id: JANE,
    specific_role: "buyer_agent",
    role_category: "agent",
    is_primary: 0,
  });
  await assignContactToTransaction(TXN_A, {
    contact_id: OMAR,
    specific_role: "lender",
    role_category: "lender",
    is_primary: 0,
  });
});

afterEach(async () => {
  await harness.cleanup();
});

// ---------------------------------------------------------------------------
// NEGATIVE CONTROLS — without these, every test below is vacuous
// ---------------------------------------------------------------------------
describe("fixture integrity", () => {
  it("has the v56 tombstone columns, from the real migration chain", () => {
    const cols = (
      db.prepare(`PRAGMA table_info(transaction_contacts)`).all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["removed_at", "removed_reason"]));
  });

  it("everyone starts assigned — the pre-state every test below assumes", async () => {
    expect(await currentContactIds(TXN_A)).toEqual([JANE, OMAR]);
    expect(await currentContactIds(TXN_B)).toEqual([JANE]);
    expect(await removedContactIds(TXN_A)).toEqual([]);
  });

  it("removal really does hide the party — otherwise restore proves nothing", async () => {
    await unlinkContactFromTransaction(TXN_A, JANE);

    expect(await currentContactIds(TXN_A)).toEqual([OMAR]);
    expect(await removedContactIds(TXN_A)).toEqual([JANE]);
  });
});

// ---------------------------------------------------------------------------
// restoreContactToTransaction
// ---------------------------------------------------------------------------
describe("restoreContactToTransaction brings back the ORIGINAL row", () => {
  it("returns the party to the deal, by exact id set", async () => {
    await unlinkContactFromTransaction(TXN_A, JANE);
    expect(await currentContactIds(TXN_A)).toEqual([OMAR]);

    expect(await restoreContactToTransaction(TXN_A, JANE)).toBe(true);

    expect(await currentContactIds(TXN_A)).toEqual([JANE, OMAR]);
    expect(await removedContactIds(TXN_A)).toEqual([]);
  });

  it("preserves the row identity, the role, the primary flag, the notes AND created_at", async () => {
    const before = rowFor(TXN_A, JANE)!;
    expect(before).toBeDefined();

    await unlinkContactFromTransaction(TXN_A, JANE);
    await restoreContactToTransaction(TXN_A, JANE);

    const after = rowFor(TXN_A, JANE)!;

    // Same physical row — an INSERT would mint a new id and a new created_at.
    expect(after.id).toBe(before.id);
    expect(after.created_at).toBe(before.created_at);
    expect(after.role).toBe(before.role);
    expect(after.role_category).toBe(before.role_category);
    expect(after.specific_role).toBe(before.specific_role);
    expect(after.is_primary).toBe(before.is_primary);
    expect(after.notes).toBe(before.notes);
  });

  it("clears BOTH tombstone columns, not just removed_at", async () => {
    await unlinkContactFromTransaction(TXN_A, JANE, "Taken off the deal");
    expect(rowFor(TXN_A, JANE)!.removed_at).not.toBeNull();
    expect(rowFor(TXN_A, JANE)!.removed_reason).toBe("Taken off the deal");

    await restoreContactToTransaction(TXN_A, JANE);

    expect(rowFor(TXN_A, JANE)!.removed_at).toBeNull();
    expect(rowFor(TXN_A, JANE)!.removed_reason).toBeNull();
  });

  it("makes isContactAssignedToTransaction true again", async () => {
    await unlinkContactFromTransaction(TXN_A, JANE);
    expect(await isContactAssignedToTransaction(TXN_A, JANE)).toBe(false);

    await restoreContactToTransaction(TXN_A, JANE);

    expect(await isContactAssignedToTransaction(TXN_A, JANE)).toBe(true);
  });

  it("restoring an ALREADY-ASSIGNED party is a no-op returning false", async () => {
    const before = rowFor(TXN_A, JANE)!;

    expect(await restoreContactToTransaction(TXN_A, JANE)).toBe(false);

    const after = rowFor(TXN_A, JANE)!;
    expect(after.removed_at).toBeNull();
    expect(after.created_at).toBe(before.created_at);
    expect(after.role).toBe(before.role);
  });

  it("returns false for a pair that was never on the deal", async () => {
    expect(await restoreContactToTransaction(TXN_B, OMAR)).toBe(false);
  });

  it("is scoped to ONE deal — the same party stays removed from the other", async () => {
    await unlinkContactFromTransaction(TXN_A, JANE);
    await unlinkContactFromTransaction(TXN_B, JANE);

    await restoreContactToTransaction(TXN_A, JANE);

    expect(await currentContactIds(TXN_A)).toEqual([JANE, OMAR]);
    expect(await currentContactIds(TXN_B)).toEqual([]);
    expect(await removedContactIds(TXN_B)).toEqual([JANE]);
  });

  it("restores only the NAMED party — the other removal on the same deal survives", async () => {
    await unlinkContactFromTransaction(TXN_A, JANE);
    await unlinkContactFromTransaction(TXN_A, OMAR);

    await restoreContactToTransaction(TXN_A, JANE);

    expect(await currentContactIds(TXN_A)).toEqual([JANE]);
    expect(await removedContactIds(TXN_A)).toEqual([OMAR]);
  });
});

// ---------------------------------------------------------------------------
// The two tombstones are independent (BACKLOG-2365 vs BACKLOG-2366)
// ---------------------------------------------------------------------------
describe("the deal tombstone and the contact tombstone are independent", () => {
  it("restoring a role does NOT un-remove the contact from the database", async () => {
    await unlinkContactFromTransaction(TXN_A, JANE);
    // Jane is ALSO removed from the database entirely (BACKLOG-2365).
    db.prepare(
      `UPDATE contacts SET removed_at = CURRENT_TIMESTAMP, removed_reason = 'user_deleted' WHERE id = ?`,
    ).run(JANE);

    await restoreContactToTransaction(TXN_A, JANE);

    // Her role is back...
    expect(await currentContactIds(TXN_A)).toEqual([JANE, OMAR]);
    // ...and she is still removed from the contact list. Two removals, two
    // undos; this one did not silently perform the other.
    const contact = db
      .prepare(`SELECT removed_at, removed_reason FROM contacts WHERE id = ?`)
      .get(JANE) as { removed_at: string | null; removed_reason: string | null };
    expect(contact.removed_at).not.toBeNull();
    expect(contact.removed_reason).toBe("user_deleted");
  });

  it("a globally-removed party is still listed as removed FROM THE DEAL she was taken off", async () => {
    // The removed-from-deal list must not start hiding people because they were
    // also removed from the database — that would make her role unrestorable.
    await unlinkContactFromTransaction(TXN_A, JANE);
    db.prepare(
      `UPDATE contacts SET removed_at = CURRENT_TIMESTAMP, removed_reason = 'user_deleted' WHERE id = ?`,
    ).run(JANE);

    expect(await removedContactIds(TXN_A)).toEqual([JANE]);
  });
});

// ---------------------------------------------------------------------------
// Shape of what the UI actually renders
// ---------------------------------------------------------------------------
describe("getRemovedTransactionContacts carries what the card renders", () => {
  it("carries the role, the contact display fields and the removal metadata", async () => {
    await unlinkContactFromTransaction(TXN_A, JANE, "Taken off the deal");

    const rows = await getRemovedTransactionContacts(TXN_A);
    expect(rows.map((r) => r.contact_id)).toEqual([JANE]);
    expect(rows[0]).toMatchObject({
      contact_id: JANE,
      contact_name: "Jane Example",
      contact_email: "jane@example.com",
      contact_phone: "+15550101",
      specific_role: "listing_agent",
      removed_reason: "Taken off the deal",
    });
    expect(rows[0].removed_at).toEqual(expect.any(String));
    // The junction row id is what the UI keys restores on — a contact can hold
    // more than one role on a deal, so contact_id is not a safe key.
    expect(rows[0].id).toEqual(expect.any(String));
  });
});
