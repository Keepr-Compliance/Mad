/**
 * @jest-environment node
 *
 * BACKLOG-2367 — restoring a removed contact, and listing what can be restored.
 *
 * ===========================================================================
 * WHAT THIS SUITE HAS TO PROVE
 * ===========================================================================
 * BACKLOG-2365 made removal non-destructive. That is only half a promise: a
 * tombstone that cannot be reversed is just a slower delete, and a tombstone
 * that reverses INCOMPLETELY is worse than either, because the user believes
 * they got their data back.
 *
 * So the claim under test is not "restore clears two columns". It is that a
 * remove -> restore round trip returns the contact to the state she was in
 * before, and returns her ROLES with her. Three things follow:
 *
 *   - Every assertion names EXACT ID SETS. `toHaveLength(2)` is satisfied by
 *     the wrong two rows, and "the wrong contact came back" is precisely the
 *     defect that would matter.
 *   - The round trip is asserted against a snapshot taken BEFORE the removal,
 *     not against hand-written expectations, so a field that silently changes
 *     shows up as a diff rather than passing because nobody thought to check it.
 *   - `is_imported` is asserted explicitly. `removeContact`'s docblock records
 *     that an earlier revision also wrote `is_imported = 0` and thereby made
 *     restore return the contact to the wrong bucket. That is a live trap for
 *     the restore side too.
 *
 * The negative controls below establish that this fixture CAN see those
 * failures before any of it is believed.
 *
 * Fixture values are reserved-for-documentation only: `example.com` and the
 * `+1 555 01xx` reserved fictional range.
 */

import { readFileSync } from "fs";
import path from "path";
import { openTestDb, type TestDb } from "../../__tests__/helpers/syncSqliteDriver";
import { CONTACT_SOURCE_LINKS_TABLE_SQL } from "../contactIdentitySchemaSql";

let db: TestDb;

jest.mock("../core/dbConnection", () => ({
  dbAll: (sql: string, params: unknown[] = []) => db.prepare(sql).all(...params),
  dbGet: (sql: string, params: unknown[] = []) => db.prepare(sql).get(...params),
  dbRun: (sql: string, params: unknown[] = []) => db.prepare(sql).run(...params),
}));

import {
  deleteContact,
  removeContact,
  restoreContact,
  getRemovedContacts,
  getImportedContactsByUserId,
  getContactById,
} from "../contactDbService";

const USER = "user-2367";
const TXN = "txn-2367";
const TXN_B = "txn-2367-b";

const SCHEMA_PATH = path.join(__dirname, "../../../database/schema.sql");

/** The two columns migration v56 appends. Applied with v56's exact DDL. */
const V56_TOMBSTONE_DDL = [
  "ALTER TABLE contacts ADD COLUMN removed_at DATETIME",
  "ALTER TABLE contacts ADD COLUMN removed_reason TEXT",
  "ALTER TABLE transaction_contacts ADD COLUMN removed_at DATETIME",
  "ALTER TABLE transaction_contacts ADD COLUMN removed_reason TEXT",
];

function ids(rows: Array<{ id: string }>): string[] {
  return rows.map((r) => r.id).sort();
}

function addContact(id: string, displayName: string): void {
  db.prepare(
    "INSERT INTO contacts (id, user_id, display_name, source, is_imported) VALUES (?, ?, ?, 'manual', 1)",
  ).run(id, USER, displayName);
}

function addEmail(contactId: string, email: string): void {
  db.prepare(
    "INSERT INTO contact_emails (id, contact_id, email, is_primary) VALUES (?, ?, ?, 1)",
  ).run(`em-${contactId}`, contactId, email);
}

function addPhone(contactId: string, e164: string): void {
  db.prepare(
    "INSERT INTO contact_phones (id, contact_id, phone_e164, phone_normalized, is_primary) VALUES (?, ?, ?, ?, 1)",
  ).run(`ph-${contactId}`, contactId, e164, e164.replace(/\D/g, ""));
}

function addRole(
  rowId: string,
  transactionId: string,
  contactId: string,
  specificRole: string,
): void {
  db.prepare(
    `INSERT INTO transaction_contacts
       (id, transaction_id, contact_id, role, role_category, specific_role)
     VALUES (?, ?, ?, ?, 'agent', ?)`,
  ).run(rowId, transactionId, contactId, specificRole, specificRole);
}

/** The whole contact row, read RAW — never through the code under test. */
function rawContact(contactId: string): Record<string, unknown> {
  return db
    .prepare("SELECT * FROM contacts WHERE id = ?")
    .get(contactId) as Record<string, unknown>;
}

/**
 * The contact row with `updated_at` removed.
 *
 * `updated_at` is NOT owned by any code in this file — `schema.sql:1056`
 * declares an `AFTER UPDATE ON contacts` trigger that rewrites it on every
 * write, so both the removal and the restore move it by design. Including it in
 * a whole-row equality made that assertion a CLOCK RACE: it passed only while
 * the seed and the restore landed inside the same one-second SQLite tick, and
 * failed as soon as anything slowed the suite down. Caught in review of PR
 * #2211 by inserting a 1.2s delay, which turned it red (`04:03:36` vs
 * `04:03:38`) — a latent CI flake, not a product defect.
 *
 * Excluding it is also the honest claim. A tombstone round trip must restore
 * the contact's DATA; it is not required to pretend the row was never written.
 * `updated_at` is asserted separately below, for what it actually guarantees.
 */
function rawContactWithoutMtime(contactId: string): Record<string, unknown> {
  const { updated_at, ...rest } = rawContact(contactId);
  void updated_at;
  return rest;
}

/** Child-row ids of a contact, read raw. */
function childRows(contactId: string) {
  return {
    emails: ids(
      db
        .prepare("SELECT id FROM contact_emails WHERE contact_id = ? ORDER BY id")
        .all(contactId) as Array<{ id: string }>,
    ),
    phones: ids(
      db
        .prepare("SELECT id FROM contact_phones WHERE contact_id = ? ORDER BY id")
        .all(contactId) as Array<{ id: string }>,
    ),
    roles: ids(
      db
        .prepare("SELECT id FROM transaction_contacts WHERE contact_id = ? ORDER BY id")
        .all(contactId) as Array<{ id: string }>,
    ),
  };
}

beforeEach(() => {
  db = openTestDb();
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  for (const ddl of V56_TOMBSTONE_DDL) db.exec(ddl);
  db.exec(CONTACT_SOURCE_LINKS_TABLE_SQL);

  db.prepare(
    `INSERT INTO users_local (id, email, oauth_provider, oauth_id)
     VALUES (?, 'owner@example.com', 'google', 'oauth-2367')`,
  ).run(USER);
  db.prepare(
    "INSERT INTO transactions (id, user_id, property_address) VALUES (?, ?, '1 Example Way')",
  ).run(TXN, USER);
  db.prepare(
    "INSERT INTO transactions (id, user_id, property_address) VALUES (?, ?, '2 Example Way')",
  ).run(TXN_B, USER);

  // Dana holds a role on BOTH deals. Reese holds none. Nobody starts removed.
  addContact("c-dana", "Dana Example");
  addEmail("c-dana", "dana@example.com");
  addPhone("c-dana", "+15550100");
  addRole("tc-dana-a", TXN, "c-dana", "listing_agent");
  addRole("tc-dana-b", TXN_B, "c-dana", "buyer_agent");

  addContact("c-reese", "Reese Example");
  addEmail("c-reese", "reese@example.com");
  addPhone("c-reese", "+15550101");
});

afterEach(() => {
  db.close();
});

// ===========================================================================
// NEGATIVE CONTROLS — without these, every test below is vacuous
// ===========================================================================
describe("fixture integrity", () => {
  it("foreign keys are ENFORCED on this handle", () => {
    const [{ foreign_keys }] = db.prepare("PRAGMA foreign_keys").all() as Array<{
      foreign_keys: number;
    }>;
    expect(foreign_keys).toBe(1);
  });

  it("the tombstone columns really exist on contacts", () => {
    const cols = (
      db.prepare("PRAGMA table_info(contacts)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["removed_at", "removed_reason"]));
  });

  it("both contacts start ACTIVE and visible — the pre-state every test assumes", async () => {
    expect(ids(await getImportedContactsByUserId(USER))).toEqual([
      "c-dana",
      "c-reese",
    ]);
    expect(await getRemovedContacts(USER)).toEqual([]);
  });
});

// ===========================================================================
// restoreContact
// ===========================================================================
describe("restoreContact is the exact inverse of a removal", () => {
  it("round-trips the ENTIRE contact row back to its pre-removal state", async () => {
    const before = rawContactWithoutMtime("c-dana");

    await removeContact("c-dana");
    // Removal really did change something — otherwise the restore below proves
    // nothing (it would 'pass' against a row that never moved). Asserted on the
    // TOMBSTONE COLUMNS specifically rather than on whole-row inequality, which
    // the `updated_at` trigger would satisfy on its own and thereby pass even
    // if the removal had written nothing at all.
    expect(rawContact("c-dana").removed_at).not.toBeNull();
    expect(rawContactWithoutMtime("c-dana")).not.toEqual(before);

    const restored = await restoreContact("c-dana");
    expect(restored).toBe(true);

    // Whole-row equality: any field the restore touched that it should not have
    // shows up here, including ones this test never thought to name.
    // `updated_at` is excluded and asserted separately — see the helper.
    expect(rawContactWithoutMtime("c-dana")).toEqual(before);
  });

  it("leaves updated_at to the trigger, and never moves it BACKWARDS", async () => {
    // The one honest guarantee about `updated_at` across a round trip: the
    // trigger owns it, so it may advance, but a restore must never rewrite it
    // to an older value — that would misreport when the row was last touched.
    // Compared as timestamps, not for equality, so this cannot race the clock.
    const before = String(rawContact("c-dana").updated_at);

    await removeContact("c-dana");
    await restoreContact("c-dana");

    const after = String(rawContact("c-dana").updated_at);
    expect(new Date(after).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
  });

  it("clears BOTH tombstone columns, not just removed_at", async () => {
    await deleteContact("c-dana");
    expect(rawContact("c-dana").removed_at).not.toBeNull();
    expect(rawContact("c-dana").removed_reason).toBe("user_deleted");

    await restoreContact("c-dana");

    expect(rawContact("c-dana").removed_at).toBeNull();
    expect(rawContact("c-dana").removed_reason).toBeNull();
  });

  it("does NOT touch is_imported (the trap that made an earlier removal irreversible)", async () => {
    await removeContact("c-dana");
    expect(rawContact("c-dana").is_imported).toBe(1);

    await restoreContact("c-dana");

    // Restoring must return her to the IMPORTED bucket she came from, which is
    // only possible because neither removal nor restore ever moved this flag.
    expect(rawContact("c-dana").is_imported).toBe(1);
  });

  it("brings the contact back into the visible list, by exact id set", async () => {
    await removeContact("c-dana");
    expect(ids(await getImportedContactsByUserId(USER))).toEqual(["c-reese"]);

    await restoreContact("c-dana");

    expect(ids(await getImportedContactsByUserId(USER))).toEqual([
      "c-dana",
      "c-reese",
    ]);
  });

  it("returns every transaction role with her, by exact id set", async () => {
    const before = childRows("c-dana");
    expect(before.roles).toEqual(["tc-dana-a", "tc-dana-b"]);

    await removeContact("c-dana");
    await restoreContact("c-dana");

    expect(childRows("c-dana")).toEqual(before);
  });

  it("restoring an ALREADY-ACTIVE contact is a no-op returning false", async () => {
    const before = rawContact("c-dana");

    expect(await restoreContact("c-dana")).toBe(false);

    expect(rawContact("c-dana")).toEqual(before);
  });

  it("restores ONLY the named contact — the other removal survives", async () => {
    await removeContact("c-dana");
    await removeContact("c-reese");

    await restoreContact("c-dana");

    expect(ids(await getImportedContactsByUserId(USER))).toEqual(["c-dana"]);
    expect((await getRemovedContacts(USER)).map((r) => r.id)).toEqual(["c-reese"]);
  });

  it("restoring a contact id that does not exist returns false and throws nothing", async () => {
    expect(await restoreContact("c-does-not-exist")).toBe(false);
  });
});

// ===========================================================================
// getRemovedContacts
// ===========================================================================
describe("getRemovedContacts lists exactly what can be restored", () => {
  it("returns removed contacts ONLY, by exact id set", async () => {
    await removeContact("c-reese");

    expect((await getRemovedContacts(USER)).map((r) => r.id)).toEqual(["c-reese"]);
  });

  it("excludes another user's removed contacts", async () => {
    const OTHER = "user-other-2367";
    db.prepare(
      `INSERT INTO users_local (id, email, oauth_provider, oauth_id)
       VALUES (?, 'other@example.com', 'google', 'oauth-other-2367')`,
    ).run(OTHER);
    db.prepare(
      "INSERT INTO contacts (id, user_id, display_name, source, is_imported) VALUES ('c-other', ?, 'Other Example', 'manual', 1)",
    ).run(OTHER);

    await removeContact("c-other");
    await removeContact("c-reese");

    expect((await getRemovedContacts(USER)).map((r) => r.id)).toEqual(["c-reese"]);
    expect((await getRemovedContacts(OTHER)).map((r) => r.id)).toEqual(["c-other"]);
  });

  it("carries the display fields, the removal reason and the primary email/phone", async () => {
    await deleteContact("c-dana");

    const [row] = await getRemovedContacts(USER);
    expect(row).toMatchObject({
      id: "c-dana",
      display_name: "Dana Example",
      email: "dana@example.com",
      phone: "+15550100",
      removed_reason: "user_deleted",
      source: "manual",
    });
    expect(row.removed_at).toEqual(expect.any(String));
  });

  it("counts the transaction roles that SURVIVED — the point of the epic", async () => {
    await removeContact("c-dana");

    const [row] = await getRemovedContacts(USER);
    // Two live junction rows, on two different deals. Under the old cascading
    // DELETE this number was necessarily 0, because the roles were gone.
    expect(row.active_role_count).toBe(2);
  });

  it("does NOT count a role the party was separately removed from", async () => {
    // Dana is taken off ONE deal (BACKLOG-2366 tombstone on the junction), then
    // removed from the database (BACKLOG-2365 tombstone on the contact). The two
    // removals are independent, so restoring HER must not silently also restore
    // the deal she was deliberately taken off.
    db.prepare(
      "UPDATE transaction_contacts SET removed_at = CURRENT_TIMESTAMP, removed_reason = 'off the deal' WHERE id = 'tc-dana-b'",
    ).run();
    await removeContact("c-dana");

    const [row] = await getRemovedContacts(USER);
    expect(row.active_role_count).toBe(1);
  });

  it("reports 0 surviving roles for a contact who never had any", async () => {
    await removeContact("c-reese");

    const [row] = await getRemovedContacts(USER);
    expect(row.active_role_count).toBe(0);
  });

  it("drops a contact off the list as soon as she is restored", async () => {
    await removeContact("c-dana");
    expect((await getRemovedContacts(USER)).map((r) => r.id)).toEqual(["c-dana"]);

    await restoreContact("c-dana");

    expect(await getRemovedContacts(USER)).toEqual([]);
  });
});

// ===========================================================================
// THE TOMBSTONE FIELDS MUST SURVIVE THE RESPONSE SCHEMA
// ===========================================================================
/**
 * `getContactById` ends in
 * `validateResponse(ContactSchema, contact, …)`, and `validateResponse` parses
 * with a plain (non-strict) `z.object`, which STRIPS undeclared keys. So a
 * column can exist in the database, be declared on the `Contact` interface in
 * `models.ts`, type-check at every call site — and still arrive as `undefined`,
 * with no error raised anywhere.
 *
 * That is not hypothetical here. The restore audit entry reads
 * `contact?.removed_reason` to record what the contact was removed FOR, and
 * `ContactSchema` declared neither tombstone field, so it wrote
 * `restored_from: null` on every restore. Caught in review of PR #2211; the
 * same trap is documented on `source_types` in that file from BACKLOG-2472.
 *
 * These assertions are the control. They fail the moment either field is
 * dropped from `ContactSchema`, which is the only way to observe the erasure —
 * `tsc` cannot, because `models.ts` declares both.
 */
describe("getContactById preserves the tombstone fields through ContactSchema", () => {
  it("returns removed_reason and removed_at after a delete", async () => {
    await deleteContact("c-dana");

    const contact = await getContactById("c-dana");

    expect(contact).not.toBeNull();
    // Asserting the VALUE, not just presence: a schema that stripped the key
    // yields `undefined`, which a `toBeDefined()` on a nullable field would
    // not reliably catch.
    expect(contact?.removed_reason).toBe("user_deleted");
    expect(contact?.removed_at).toEqual(expect.any(String));
  });

  it("returns removed_reason after an un-import, distinguishing the two reasons", async () => {
    await removeContact("c-reese");

    const contact = await getContactById("c-reese");

    // The two removal paths are told apart ONLY by this value, both in the UI
    // wording and in the audit trail. Collapsing them to null loses that.
    expect(contact?.removed_reason).toBe("user_unimported");
  });

  it("returns both fields as null for an ACTIVE contact", async () => {
    const contact = await getContactById("c-dana");

    // The negative half: the fields must round-trip their NULL too, or "not
    // removed" and "removed but stripped" become indistinguishable.
    expect(contact?.removed_at ?? null).toBeNull();
    expect(contact?.removed_reason ?? null).toBeNull();
  });

  it("clears them again after a restore", async () => {
    await deleteContact("c-dana");
    expect((await getContactById("c-dana"))?.removed_reason).toBe("user_deleted");

    await restoreContact("c-dana");

    expect((await getContactById("c-dana"))?.removed_at ?? null).toBeNull();
    expect((await getContactById("c-dana"))?.removed_reason ?? null).toBeNull();
  });
});
