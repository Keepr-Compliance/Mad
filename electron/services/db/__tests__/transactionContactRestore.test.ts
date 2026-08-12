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
 * FIXTURE CHOICE — THE REAL `schema.sql`, PLUS MIGRATION v56'S EXACT DDL.
 *
 * The tables are created from `electron/database/schema.sql`, so the foreign
 * keys carry their real `ON DELETE CASCADE` and `UNIQUE(transaction_id,
 * contact_id)` is the real constraint rather than one the test author
 * remembered to type. `PRAGMA foreign_keys = ON` is set, because SQLite does
 * not enforce foreign keys by default. Both are asserted in the fixture-integrity
 * block below rather than assumed. The functions under test read through
 * `dbConnection`, which is pointed at this database — these are the production
 * queries, not re-implementations.
 *
 * This suite deliberately does NOT use `createMigrationHarness` (the BACKLOG-2366
 * suite beside it does). That harness drives the real `databaseService`, which
 * loads the NATIVE better-sqlite3 binding; under plain `node` that binding is
 * whatever ABI the last rebuild targeted, so the suite is unrunnable outside
 * Electron and the pre-push hook can never green it. What v56 contributes to THIS
 * suite is two columns, and they are added here with v56's own DDL, verbatim. The
 * migration-chain path itself is already covered next door.
 *
 * Fixtures use reserved values only (example.com, +1 555 01xx).
 */

import { readFileSync } from "fs";
import path from "path";
import { openTestDb, type TestDb } from "../../__tests__/helpers/syncSqliteDriver";

let db: TestDb;

jest.mock("../core/dbConnection", () => ({
  dbAll: (sql: string, params: unknown[] = []) => db.prepare(sql).all(...params),
  dbGet: (sql: string, params: unknown[] = []) => db.prepare(sql).get(...params),
  dbRun: (sql: string, params: unknown[] = []) => db.prepare(sql).run(...params),
}));

import {
  assignContactToTransaction,
  getRemovedTransactionContacts,
  getTransactionContactsWithRoles,
  isContactAssignedToTransaction,
  restoreContactToTransaction,
  unlinkContactFromTransaction,
} from "../transactionContactDbService";

const SCHEMA_PATH = path.join(__dirname, "../../../database/schema.sql");

/** The two columns migration v56 appends. Applied with v56's exact DDL. */
const V56_TOMBSTONE_DDL = [
  "ALTER TABLE contacts ADD COLUMN removed_at DATETIME",
  "ALTER TABLE contacts ADD COLUMN removed_reason TEXT",
  "ALTER TABLE transaction_contacts ADD COLUMN removed_at DATETIME",
  "ALTER TABLE transaction_contacts ADD COLUMN removed_reason TEXT",
];

const USER_ID = "user-2367";

const TXN_A = "txn-alpha";
const TXN_B = "txn-beta";

const JANE = "contact-jane";
const OMAR = "contact-omar";

/**
 * Fixed, distant seed value for `transaction_contacts.created_at`. See the
 * back-dating step in `seedAssignments` for why a value that cannot collide
 * with CURRENT_TIMESTAMP is what makes the created_at assertion meaningful.
 */
const SEEDED_CREATED_AT = "2020-03-15 09:30:00";

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

beforeEach(() => {
  db = openTestDb();
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  for (const ddl of V56_TOMBSTONE_DDL) db.exec(ddl);

  db.prepare(
    `INSERT INTO users_local (id, email, oauth_provider, oauth_id)
     VALUES (?, 'owner@example.com', 'google', 'oauth-2367')`,
  ).run(USER_ID);

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
    `INSERT INTO contact_phones (id, contact_id, phone_e164, phone_normalized, is_primary)
     VALUES (?, ?, ?, ?, 1)`,
  ).run("phone-jane", JANE, "+15550101", "15550101");

  for (const txn of [TXN_A, TXN_B]) {
    db.prepare(
      `INSERT INTO transactions (id, user_id, property_address) VALUES (?, ?, '1 Example Way')`,
    ).run(txn, USER_ID);
  }
});

/**
 * Seed the starting assignments through the PRODUCTION assign path.
 *
 * Called per-test rather than in `beforeEach` because the UNIQUE-constraint
 * fixture check needs a table it can collide with deliberately, and inserting
 * the same pair twice from a shared setup would collide before the test ran.
 *
 * Jane is the listing agent on deal A and the buyer's agent on deal B.
 * Omar is the lender on deal A. Nobody starts removed.
 */
async function seedAssignments(): Promise<void> {
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

  // Back-date every junction row to a fixed, distant timestamp.
  //
  // WITHOUT THIS THE created_at ASSERTION CANNOT FAIL. SQLite's
  // CURRENT_TIMESTAMP has one-second resolution, so a seed and a restore inside
  // the same tick produce the SAME string — and `expect(after.created_at)
  // .toBe(before.created_at)` then passes just as happily against an
  // implementation that REWRITES the column as against one that preserves it.
  // Review of PR #2211 confirmed exactly that: a control setting
  // `created_at = CURRENT_TIMESTAMP` inside the restore stayed GREEN, and only
  // forcing an obviously different value turned it red. An assertion whose
  // inputs cannot separate pass from fail is not evidence.
  //
  // A date years in the past cannot collide with CURRENT_TIMESTAMP under any
  // clock, so the assertion now carries its own weight.
  db.prepare(
    `UPDATE transaction_contacts SET created_at = ? WHERE transaction_id IN (?, ?)`,
  ).run(SEEDED_CREATED_AT, TXN_A, TXN_B);
}

afterEach(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// NEGATIVE CONTROLS — without these, every test below is vacuous
// ---------------------------------------------------------------------------
describe("fixture integrity", () => {
  it("has the v56 tombstone columns", () => {
    const cols = (
      db.prepare(`PRAGMA table_info(transaction_contacts)`).all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["removed_at", "removed_reason"]));
  });

  it("foreign keys are ENFORCED, and the real UNIQUE constraint is present", () => {
    const [{ foreign_keys }] = db.prepare("PRAGMA foreign_keys").all() as Array<{
      foreign_keys: number;
    }>;
    expect(foreign_keys).toBe(1);

    // UNIQUE(transaction_id, contact_id) is why a tombstoned pair still holds
    // its slot, and therefore why restore must clear the row rather than insert.
    db.prepare(
      `INSERT INTO transaction_contacts (id, transaction_id, contact_id) VALUES (?, ?, ?)`,
    ).run("dupe-0", TXN_A, JANE);
    expect(() =>
      db
        .prepare(
          `INSERT INTO transaction_contacts (id, transaction_id, contact_id) VALUES (?, ?, ?)`,
        )
        .run("dupe-1", TXN_A, JANE),
    ).toThrow(/UNIQUE/i);
  });

  it("everyone starts assigned — the pre-state every test below assumes", async () => {
    await seedAssignments();
    expect(await currentContactIds(TXN_A)).toEqual([JANE, OMAR]);
    expect(await currentContactIds(TXN_B)).toEqual([JANE]);
    expect(await removedContactIds(TXN_A)).toEqual([]);
  });

  it("removal really does hide the party — otherwise restore proves nothing", async () => {
    await seedAssignments();
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
    await seedAssignments();
    await unlinkContactFromTransaction(TXN_A, JANE);
    expect(await currentContactIds(TXN_A)).toEqual([OMAR]);

    expect(await restoreContactToTransaction(TXN_A, JANE)).toBe(true);

    expect(await currentContactIds(TXN_A)).toEqual([JANE, OMAR]);
    expect(await removedContactIds(TXN_A)).toEqual([]);
  });

  it("preserves the row identity, the role, the primary flag, the notes AND created_at", async () => {
    await seedAssignments();
    const before = rowFor(TXN_A, JANE)!;
    expect(before).toBeDefined();

    await unlinkContactFromTransaction(TXN_A, JANE);
    await restoreContactToTransaction(TXN_A, JANE);

    const after = rowFor(TXN_A, JANE)!;

    // Same physical row — an INSERT would mint a new id and a new created_at.
    expect(after.id).toBe(before.id);
    // Asserted against the SEEDED value, not merely against `before`: this is
    // what makes a rewrite to CURRENT_TIMESTAMP detectable at all.
    expect(before.created_at).toBe(SEEDED_CREATED_AT);
    expect(after.created_at).toBe(SEEDED_CREATED_AT);
    expect(after.role).toBe(before.role);
    expect(after.role_category).toBe(before.role_category);
    expect(after.specific_role).toBe(before.specific_role);
    expect(after.is_primary).toBe(before.is_primary);
    expect(after.notes).toBe(before.notes);
  });

  it("clears BOTH tombstone columns, not just removed_at", async () => {
    await seedAssignments();
    await unlinkContactFromTransaction(TXN_A, JANE, "Taken off the deal");
    expect(rowFor(TXN_A, JANE)!.removed_at).not.toBeNull();
    expect(rowFor(TXN_A, JANE)!.removed_reason).toBe("Taken off the deal");

    await restoreContactToTransaction(TXN_A, JANE);

    expect(rowFor(TXN_A, JANE)!.removed_at).toBeNull();
    expect(rowFor(TXN_A, JANE)!.removed_reason).toBeNull();
  });

  it("makes isContactAssignedToTransaction true again", async () => {
    await seedAssignments();
    await unlinkContactFromTransaction(TXN_A, JANE);
    expect(await isContactAssignedToTransaction(TXN_A, JANE)).toBe(false);

    await restoreContactToTransaction(TXN_A, JANE);

    expect(await isContactAssignedToTransaction(TXN_A, JANE)).toBe(true);
  });

  it("restoring an ALREADY-ASSIGNED party is a no-op returning false", async () => {
    await seedAssignments();
    const before = rowFor(TXN_A, JANE)!;

    expect(await restoreContactToTransaction(TXN_A, JANE)).toBe(false);

    const after = rowFor(TXN_A, JANE)!;
    expect(after.removed_at).toBeNull();
    expect(after.created_at).toBe(before.created_at);
    expect(after.role).toBe(before.role);
  });

  it("returns false for a pair that was never on the deal", async () => {
    await seedAssignments();
    expect(await restoreContactToTransaction(TXN_B, OMAR)).toBe(false);
  });

  it("is scoped to ONE deal — the same party stays removed from the other", async () => {
    await seedAssignments();
    await unlinkContactFromTransaction(TXN_A, JANE);
    await unlinkContactFromTransaction(TXN_B, JANE);

    await restoreContactToTransaction(TXN_A, JANE);

    expect(await currentContactIds(TXN_A)).toEqual([JANE, OMAR]);
    expect(await currentContactIds(TXN_B)).toEqual([]);
    expect(await removedContactIds(TXN_B)).toEqual([JANE]);
  });

  it("restores only the NAMED party — the other removal on the same deal survives", async () => {
    await seedAssignments();
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
    await seedAssignments();
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
    await seedAssignments();
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
    await seedAssignments();
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
