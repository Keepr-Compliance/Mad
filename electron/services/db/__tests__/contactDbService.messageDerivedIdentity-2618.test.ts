/**
 * @jest-environment node
 *
 * BACKLOG-2618 — A SECOND PERSON WITH THE SAME NAME MUST BE ABLE TO APPEAR.
 *
 * ===========================================================================
 * WHAT WAS WRONG
 * ===========================================================================
 * `getMessageDerivedContacts` had three suppression filters and only one of
 * them could ever fire:
 *
 *   email — the SQL's WHERE excludes any `from` containing `@`, so the
 *           projected `email` column is ALWAYS NULL and the branch is dead.
 *   phone — the same WHERE excludes `+%` and `[0-9]*`, so the projected
 *           `phone` column holds a DISPLAY NAME, compared against
 *           `LOWER(phone_e164)`. Also dead.
 *   name  — exact lowercase display-name equality against EVERY saved contact.
 *           The live one.
 *
 * So Michael Chen the lender is a saved contact, a different Michael Chen texts
 * the user, and the second Michael never appears in Clients & Contacts, is
 * never importable, and there is no disclosure and no undo. That is the rule
 * BACKLOG-2316 believed it had removed — it removed it from the PICKER, and it
 * was still here.
 *
 * ===========================================================================
 * THE TWO DEAD FILTERS ARE PROVEN DEAD, NOT ASSERTED DEAD
 * ===========================================================================
 * "This branch cannot fire" is exactly the kind of claim that is read off the
 * source and believed. The first describe block below establishes it by
 * EXECUTION: messages whose `from` is an address and whose `from` is a phone
 * number are seeded, and the projection is shown to drop them — which is what
 * makes `email` structurally NULL and `phone` structurally a name. Without that
 * block, deleting those two filters would be a change nobody had measured.
 *
 * ===========================================================================
 * WHAT REPLACED THE NAME FILTER, AND WHY IT WAS NOT SIMPLY DELETED
 * ===========================================================================
 * Only a contact whose NAME IS ALL IT IS may suppress a same-named sender:
 * removed (BACKLOG-2365), or carrying no `contact_source_links` row.
 *
 * Deleting the filter outright fails a case that is measured here rather than
 * argued: importing a message-derived row mints a contact with a fresh uuid,
 * and no crosswalk row is possible for it — the `source_type` CHECK admits
 * address-book sources only, never `messages`. With no name filter the twin
 * renders beside the contact the user just created from it, permanently, with
 * no undo. That is the same defect class BACKLOG-2608 exists to remove, and
 * "the imported twin stays suppressed" below is the case that pins it.
 *
 * ===========================================================================
 * FIXTURE
 * ===========================================================================
 * The REAL `electron/database/schema.sql`, v56's exact tombstone DDL, and the
 * REAL `CONTACT_SOURCE_LINKS_TABLE_SQL` — so the `NOT EXISTS` predicate under
 * test runs against the table the app actually has. Values are reserved
 * documentation forms only: `example.com`, and 555 in the EXCHANGE slot.
 *
 * Exact ID SETS, never counts: a count of 1 is equally satisfied by the wrong
 * person surviving, and the wrong person is the whole subject of this item.
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
  getMessageDerivedContacts,
  getImportedContactsByUserId,
  getContactsSortedByActivity,
  searchContactsForSelection,
  removeContact,
} from "../contactDbService";

const USER = "user-2618";
const SCHEMA_PATH = path.join(__dirname, "../../../database/schema.sql");

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
    "INSERT INTO contacts (id, user_id, display_name, source, is_imported) VALUES (?, ?, ?, 'contacts_app', 1)",
  ).run(id, USER, displayName);
}

/** The crosswalk row that makes a contact an ADDRESS-BOOK person. */
function linkToAddressBook(contactId: string, sourceRecordId: string): void {
  db.prepare(
    `INSERT INTO contact_source_links
       (id, user_id, contact_id, source_type, source_record_id, match_method)
     VALUES (?, ?, ?, 'macos', ?, 'source_id')`,
  ).run(`l-${contactId}`, USER, contactId, sourceRecordId);
}

function addMessage(id: string, from: string, sentAt = "2026-08-09T10:00:00Z"): void {
  db.prepare(
    `INSERT INTO messages (id, user_id, channel, direction, participants, sent_at)
     VALUES (?, ?, 'sms', 'inbound', ?, ?)`,
  ).run(id, USER, JSON.stringify({ from }), sentAt);
}

beforeEach(() => {
  db = openTestDb();
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  for (const ddl of V56_TOMBSTONE_DDL) db.exec(ddl);
  db.exec(CONTACT_SOURCE_LINKS_TABLE_SQL);

  db.prepare(
    `INSERT INTO users_local (id, email, oauth_provider, oauth_id)
     VALUES (?, 'owner@example.com', 'google', 'oauth-2618')`,
  ).run(USER);
});

afterEach(() => {
  db.close();
});

// ===========================================================================
describe("the two deleted filters were structurally incapable of firing", () => {
  /**
   * ESTABLISHED BY EXECUTION, because this is the claim that licensed the
   * deletion. If either of these seeded rows DID reach the projection, the
   * corresponding filter was live and deleting it changed behaviour.
   */
  it("a sender that IS an email address never reaches the projection", () => {
    addMessage("m-email", "sender@example.com");
    expect(ids(getMessageDerivedContacts(USER))).toEqual([]);
  });

  it("a sender that IS a phone number never reaches the projection", () => {
    addMessage("m-e164", "+16285550188");
    addMessage("m-digits", "6285550188");
    expect(ids(getMessageDerivedContacts(USER))).toEqual([]);
  });

  /**
   * And the positive half: a sender that IS a display name DOES reach it, and
   * the columns the two deleted filters read carry exactly what the item said.
   * Without this, the two cases above are equally satisfied by a projection
   * that returns nothing at all.
   */
  it("a display-name sender arrives with email NULL and phone holding the NAME", () => {
    addMessage("m-name", "Michael Chen");

    const [row] = getMessageDerivedContacts(USER);
    expect(row.id).toBe("msg_michael chen");
    expect(row.email).toBeNull();
    expect(row.phone).toBe("Michael Chen");
  });
});

// ===========================================================================
describe("CONTROL — a different person who shares a saved contact's name appears", () => {
  /**
   * THE HARM THIS ITEM WAS FILED FOR. Michael Chen the lender is saved from the
   * macOS address book. A different Michael Chen, a buyer's agent, texts.
   *
   * OBSERVED RED, 2026-08-09: widening the predicate back to every saved
   * contact (dropping the `removed_at IS NOT NULL OR NOT EXISTS (...)` clause)
   * gives `Expected ["msg_michael chen"] / Received []` — the second Michael
   * disappears from every surface below.
   */
  beforeEach(() => {
    addContact("c-michael-lender", "Michael Chen");
    linkToAddressBook("c-michael-lender", "mac-michael");
    addMessage("m-michael", "Michael Chen");
  });

  it("the message-derived person is produced", () => {
    expect(ids(getMessageDerivedContacts(USER))).toEqual(["msg_michael chen"]);
  });

  /**
   * ALL FOUR SURFACES, asserted separately. `getImportedContactsByUserId` and
   * `getContactsSortedByActivity` are two producers of the same screen and
   * BACKLOG-2514 exists because they had already disagreed about who appears;
   * `searchContactsForSelection` is the transaction picker and had NO name
   * filter at all before this change, so it is the one that could silently
   * diverge in the other direction.
   */
  it("...and reaches Clients & Contacts, the activity sort, and the picker search", async () => {
    expect(ids(await getImportedContactsByUserId(USER))).toEqual([
      "c-michael-lender",
      "msg_michael chen",
    ]);
    expect(ids(await getContactsSortedByActivity(USER))).toEqual([
      "c-michael-lender",
      "msg_michael chen",
    ]);
    expect(ids(searchContactsForSelection(USER, "Michael"))).toEqual([
      "c-michael-lender",
      "msg_michael chen",
    ]);
  });
});

// ===========================================================================
describe("PIN — a contact whose NAME is all it is still suppresses its twin", () => {
  /**
   * THE CASE THAT STOPPED THIS BEING A DELETION, and it is measured here rather
   * than argued in a comment.
   *
   * The user imports the message-derived row. A `contacts` row is minted with a
   * fresh uuid, and no crosswalk row is possible for it — `source_type` admits
   * `macos` / `iphone` / `outlook` / `google_contacts` / `android_sync` and
   * never `messages`. Delete the name filter and this contact and its own twin
   * render side by side forever, with nothing the user can do about it.
   *
   * OBSERVED RED, 2026-08-09: deleting the name filter entirely gives
   * `Expected ["c-michael-imported"] / Received ["c-michael-imported",
   * "msg_michael chen"]` — the permanent duplicate, on both list producers.
   */
  it("the contact created FROM a message-derived row hides that row", async () => {
    addContact("c-michael-imported", "Michael Chen"); // no crosswalk row: name-only
    addMessage("m-michael", "Michael Chen");

    expect(ids(getMessageDerivedContacts(USER))).toEqual([]);
    expect(ids(await getImportedContactsByUserId(USER))).toEqual(["c-michael-imported"]);
    expect(ids(searchContactsForSelection(USER, "Michael"))).toEqual(["c-michael-imported"]);
  });

  /**
   * The discriminating pair: SAME fixture, one difference — a crosswalk row —
   * and the answer flips. Stated as its own case because "the twin is hidden"
   * and "the twin is shown" being decided by that single row is the whole of
   * the new rule, and a reader should be able to see both halves at once.
   */
  it("...and the identical fixture WITH a crosswalk row shows it", () => {
    addContact("c-michael-imported", "Michael Chen");
    linkToAddressBook("c-michael-imported", "mac-michael");
    addMessage("m-michael", "Michael Chen");

    expect(ids(getMessageDerivedContacts(USER))).toEqual(["msg_michael chen"]);
  });
});

// ===========================================================================
describe("REGRESSION — removal must not undo itself (BACKLOG-2365)", () => {
  /**
   * Dana is a saved contact who has texted the user. She is removed. She
   * vanishes from the DB-backed rows and must NOT reappear one line later as
   * `msg_dana example`, because `getImportedContactsByUserId` merges the
   * message-derived rows into the very list it just filtered.
   *
   * SHE IS AN ADDRESS-BOOK CONTACT ON PURPOSE. A removed contact with no
   * crosswalk row would stay suppressed by the second half of the predicate and
   * prove nothing about the tombstone term. With the link present, `removed_at
   * IS NOT NULL` is the ONLY term that can hold her back — which is exactly
   * what BACKLOG-2365 requires and exactly what a careless narrowing removes.
   *
   * OBSERVED RED, 2026-08-09: dropping `c.removed_at IS NOT NULL OR` from the
   * predicate gives `Expected [] / Received ["msg_dana example"]`.
   */
  beforeEach(() => {
    addContact("c-dana", "Dana Example");
    linkToAddressBook("c-dana", "mac-dana");
    addMessage("m-dana", "Dana Example");
    addContact("c-reese", "Reese Example");
  });

  it("control: the twin IS produced when she is not a saved contact at all", () => {
    // Without this, "no twin after removal" cannot be told apart from "this
    // fixture never produces a twin".
    db.prepare("UPDATE contacts SET display_name = 'Someone Else' WHERE id = ?").run("c-dana");
    expect(ids(getMessageDerivedContacts(USER))).toEqual(["msg_dana example"]);
  });

  it("no twin appears after she is removed", async () => {
    await removeContact("c-dana");

    expect(ids(getMessageDerivedContacts(USER))).toEqual([]);
    expect(ids(await getImportedContactsByUserId(USER))).toEqual(["c-reese"]);
    expect(ids(await getContactsSortedByActivity(USER))).toEqual(["c-reese"]);
  });

  /**
   * BACKLOG-2618 also brought `searchContactsForSelection` under the same rule.
   * It had NO name filter at all, so before this change removing Dana hid her
   * from Clients & Contacts and left `msg_dana example` sitting in the
   * transaction picker's search — the BACKLOG-2365 defect surviving in the one
   * surface nobody had checked.
   *
   * OBSERVED RED, 2026-08-09: putting `searchContactsForSelection` back to
   * having no effective name filter — `return true` in its message-derived
   * filter, which is behaviourally identical to the deleted email-only filter
   * because that one could never fire — gives
   * `Expected [] / Received ["msg_dana example"]`.
   */
  it("and none in the transaction picker's search either", async () => {
    await removeContact("c-dana");

    expect(ids(searchContactsForSelection(USER, "Dana"))).toEqual([]);
  });
});
