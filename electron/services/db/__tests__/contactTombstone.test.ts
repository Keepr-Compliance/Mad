/**
 * @jest-environment node
 *
 * BACKLOG-2365 — removing a contact tombstones it instead of destroying it.
 *
 * ===========================================================================
 * WHAT THIS SUITE HAS TO PROVE, AND WHY A WEAKER ONE WOULD PROVE NOTHING
 * ===========================================================================
 * `deleteContact` used to be `DELETE FROM contacts WHERE id = ?`. Four tables
 * hang off that foreign key with ON DELETE CASCADE. One of them is
 * `transaction_contacts`, which is where a party's ROLE on a deal lives. So the
 * old delete did not hide a person — it erased the record that they had ever
 * been on an audited transaction, and there was no undo.
 *
 * The claim under test is therefore a claim about a CASCADE NOT FIRING. That
 * makes the schema the load-bearing part of this fixture, not scenery:
 *
 *   - The tables are created from the REAL `electron/database/schema.sql`, so
 *     the foreign keys carry the real `ON DELETE CASCADE`.
 *   - `PRAGMA foreign_keys = ON` is set, because SQLite does not enforce
 *     foreign keys by default and a fixture that forgot it would let the OLD
 *     hard-delete code pass every assertion below.
 *
 * Both are asserted explicitly in "negative control" tests rather than assumed,
 * because if either silently regressed this file would go green while the
 * product destroyed data. `cascadeIsArmed` proves the cascade really does fire
 * on a raw DELETE against this exact database handle — which is what earns the
 * right to conclude anything from the fact that it does not fire on removal.
 *
 * ===========================================================================
 * EXACT ID SETS, NEVER COUNTS
 * ===========================================================================
 * `expect(rows).toHaveLength(2)` is satisfied just as well by the WRONG two
 * rows, and "the wrong contact disappeared" is precisely the defect that would
 * matter here. Every assertion names the exact ids, sorted, in one `toEqual`.
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
  getContacts,
  getImportedContactsByUserId,
  searchContacts,
  searchContactsForSelection,
  getContactsSortedByActivity,
  getTransactionsByContact,
} from "../contactDbService";

const USER = "user-2365";
const TXN = "txn-2365";

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

function addContact(
  id: string,
  displayName: string,
  opts: { isImported?: number } = {},
): void {
  db.prepare(
    "INSERT INTO contacts (id, user_id, display_name, source, is_imported) VALUES (?, ?, ?, 'manual', ?)",
  ).run(id, USER, displayName, opts.isImported ?? 1);
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

function addRole(contactId: string, specificRole: string): void {
  db.prepare(
    `INSERT INTO transaction_contacts
       (id, transaction_id, contact_id, role, role_category, specific_role)
     VALUES (?, ?, ?, ?, 'agent', ?)`,
  ).run(`tc-${contactId}`, TXN, contactId, specificRole, specificRole);
}

/** Child-row ids of a contact, read raw — never through the code under test. */
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
     VALUES (?, 'owner@example.com', 'google', 'oauth-2365')`,
  ).run(USER);
  db.prepare(
    "INSERT INTO transactions (id, user_id, property_address) VALUES (?, ?, '1 Example Way')",
  ).run(TXN, USER);

  // Dana is on the deal as the listing agent. Reese is not on any deal.
  // Neither is removed at the start of any test.
  addContact("c-dana", "Dana Example");
  addEmail("c-dana", "dana@example.com");
  addPhone("c-dana", "+15550100");
  addRole("c-dana", "listing_agent");

  addContact("c-reese", "Reese Example");
  addEmail("c-reese", "reese@example.com");
  addPhone("c-reese", "+15550101");
});

afterEach(() => {
  db.close();
});

// ===========================================================================
// NEGATIVE CONTROLS — these establish that the fixture can detect the bug
// ===========================================================================
describe("fixture integrity (without these, every test below is vacuous)", () => {
  it("foreign keys are ENFORCED on this handle", () => {
    const [{ foreign_keys }] = db.prepare("PRAGMA foreign_keys").all() as Array<{
      foreign_keys: number;
    }>;
    expect(foreign_keys).toBe(1);
  });

  it("cascadeIsArmed: a raw hard DELETE really does destroy all three child sets", () => {
    // This is the behaviour BACKLOG-2365 exists to stop. Proving it fires HERE
    // is what makes "it did not fire after removal" a meaningful result rather
    // than an artefact of a fixture with no foreign keys.
    expect(childRows("c-dana")).toEqual({
      emails: ["em-c-dana"],
      phones: ["ph-c-dana"],
      roles: ["tc-c-dana"],
    });

    db.prepare("DELETE FROM contacts WHERE id = ?").run("c-dana");

    expect(childRows("c-dana")).toEqual({ emails: [], phones: [], roles: [] });
    expect(
      db.prepare("SELECT id FROM contacts WHERE id = ?").all("c-dana"),
    ).toEqual([]);
  });
});

// ===========================================================================
// THE DATA PATH
// ===========================================================================
describe("deleteContact writes a tombstone and destroys nothing", () => {
  it("keeps the contact row, its emails, its phones AND its transaction roles", async () => {
    await deleteContact("c-dana");

    // Every child row still present, by exact id.
    expect(childRows("c-dana")).toEqual({
      emails: ["em-c-dana"],
      phones: ["ph-c-dana"],
      roles: ["tc-c-dana"],
    });

    const row = db
      .prepare("SELECT id, removed_reason, removed_at FROM contacts WHERE id = ?")
      .get("c-dana") as { id: string; removed_reason: string; removed_at: string };
    expect(row.id).toBe("c-dana");
    expect(row.removed_reason).toBe("user_deleted");
    expect(row.removed_at).not.toBeNull();
  });

  it("the transaction still knows the role existed, with its role fields intact", async () => {
    await deleteContact("c-dana");

    const roles = db
      .prepare(
        `SELECT contact_id, role, role_category, specific_role
           FROM transaction_contacts WHERE transaction_id = ? ORDER BY contact_id`,
      )
      .all(TXN);
    expect(roles).toEqual([
      {
        contact_id: "c-dana",
        role: "listing_agent",
        role_category: "agent",
        specific_role: "listing_agent",
      },
    ]);
  });

  it("records the reason, and a second delete does not overwrite the first tombstone", async () => {
    await deleteContact("c-dana", "user_deleted");
    const first = (
      db.prepare("SELECT removed_at FROM contacts WHERE id = ?").get("c-dana") as {
        removed_at: string;
      }
    ).removed_at;

    await deleteContact("c-dana", "user_unimported");

    const after = db
      .prepare("SELECT removed_at, removed_reason FROM contacts WHERE id = ?")
      .get("c-dana") as { removed_at: string; removed_reason: string };
    expect(after.removed_at).toBe(first);
    expect(after.removed_reason).toBe("user_deleted");
  });
});

describe("removeContact (un-import) tombstones too — including address-book contacts", () => {
  it.each(["contacts_app", "outlook"])(
    "a %s contact is tombstoned, not deleted, and keeps its roles",
    async (source) => {
      db.prepare("UPDATE contacts SET source = ? WHERE id = ?").run(source, "c-dana");

      await removeContact("c-dana");

      expect(childRows("c-dana")).toEqual({
        emails: ["em-c-dana"],
        phones: ["ph-c-dana"],
        roles: ["tc-c-dana"],
      });
      const row = db
        .prepare("SELECT id, is_imported, removed_reason FROM contacts WHERE id = ?")
        .get("c-dana") as { id: string; is_imported: number; removed_reason: string };
      expect(row).toEqual({
        id: "c-dana",
        is_imported: 0,
        removed_reason: "user_unimported",
      });
    },
  );
});

// ===========================================================================
// THE READ PATHS
// ===========================================================================
describe("a removed contact disappears from every list, picker and search", () => {
  /**
   * Each entry returns the ids a surface would show. Asserting the WHOLE set
   * both ways round means one table drives "the removed one is gone" and
   * "everyone else is still here" — a filter that dropped both contacts, or the
   * wrong one, fails.
   */
  const surfaces: Array<{ name: string; read: () => Promise<string[]> }> = [
    {
      name: "Clients & Contacts list (getImportedContactsByUserId)",
      read: async () => ids(await getImportedContactsByUserId(USER)),
    },
    {
      name: "generic list (getContacts)",
      read: async () => ids(await getContacts({ user_id: USER })),
    },
    {
      name: "name search (searchContacts)",
      read: async () => ids(await searchContacts("Example", USER)),
    },
    {
      name: "picker search (searchContactsForSelection)",
      read: async () => ids(searchContactsForSelection(USER, "Example")),
    },
    {
      name: "activity-sorted picker (getContactsSortedByActivity)",
      read: async () => ids(await getContactsSortedByActivity(USER)),
    },
  ];

  it.each(surfaces)("$name shows both contacts before any removal", async ({ read }) => {
    expect(await read()).toEqual(["c-dana", "c-reese"]);
  });

  it.each(surfaces)("$name drops ONLY the removed contact", async ({ read }) => {
    await deleteContact("c-dana");
    expect(await read()).toEqual(["c-reese"]);
  });

  it.each(surfaces)("$name drops an un-imported contact too", async ({ read }) => {
    await removeContact("c-dana");
    expect(await read()).toEqual(["c-reese"]);
  });

  it("removing everyone empties the list rather than falling back to unfiltered", async () => {
    await deleteContact("c-dana");
    await deleteContact("c-reese");
    expect(ids(await getImportedContactsByUserId(USER))).toEqual([]);
  });

  it("the CCPA subject-access export still sees a removed contact", async () => {
    // A tombstoned row still physically holds that person's data, so an
    // "everything we hold about you" export that omitted it would be false.
    await deleteContact("c-dana");
    expect(ids(await getContacts({ user_id: USER, include_removed: true }))).toEqual([
      "c-dana",
      "c-reese",
    ]);
  });
});

// ===========================================================================
// THE LIFTED GUARD
// ===========================================================================
describe("the transaction guard is gone", () => {
  it("a contact attached to a live transaction can be removed, roles surviving", async () => {
    // Pre-condition: this is exactly the contact the old guard refused to touch.
    expect(ids(await getTransactionsByContact("c-dana"))).toEqual([TXN]);

    await deleteContact("c-dana");

    expect(ids(await getImportedContactsByUserId(USER))).toEqual(["c-reese"]);
    expect(childRows("c-dana").roles).toEqual(["tc-c-dana"]);
  });
});
