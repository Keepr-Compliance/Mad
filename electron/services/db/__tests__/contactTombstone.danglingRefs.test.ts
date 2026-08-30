/**
 * @jest-environment node
 *
 * BACKLOG-2368 — removing a contact must not leave a DANGLING reference behind
 * it, and must not hard-DELETE any of the rows that hang off it.
 *
 * ===========================================================================
 * WHY email_participants IS A SEPARATE CASE FROM THE CASCADE
 * ===========================================================================
 * `contactTombstone.test.ts` already proves the three CASCADING children —
 * `contact_emails`, `contact_phones`, `transaction_contacts` — survive a
 * removal, and arms that claim with a control showing a raw DELETE really does
 * destroy them.
 *
 * `email_participants.resolved_contact_id` fails DIFFERENTLY, which is why it
 * needs its own suite rather than another line in that one. From
 * `schema.sql:447`:
 *
 *     resolved_contact_id TEXT,          -- nullable, NO FK constraint
 *     PRIMARY KEY (email_id, role, position),
 *     FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE
 *
 * The FK is on `email_id`, not on `resolved_contact_id`. So when the old code
 * did `DELETE FROM contacts`, no cascade fired here and nothing was cleaned up:
 * the participant row survived holding an id that no longer resolved to
 * anything. The row does not vanish — it goes QUIET, resolving to NULL, which
 * is the harder failure to notice. A contact who was demonstrably on an email
 * stops being attributable to a person, on a product whose job is proving who
 * was on what.
 *
 * ===========================================================================
 * THE CONTROL IS INSIDE THE SUITE, NOT A NOTE ABOUT ONE
 * ===========================================================================
 * The first case below performs the hard DELETE and asserts the reference
 * dangles. That is not scenery: without it, "the reference still resolves after
 * removal" is indistinguishable from "this fixture cannot produce a dangling
 * reference at all", and the suite would stay green if `resolved_contact_id`
 * quietly gained an `ON DELETE SET NULL` or if the join were written so it
 * could never miss.
 *
 * Every assertion names exact id sets. `toHaveLength` is satisfied by the wrong
 * rows, and "the wrong person got attributed" is the defect that matters.
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

import { deleteContact, removeContact } from "../contactDbService";

const USER = "user-2368-refs";
const TXN = "txn-2368-refs";
const EMAIL_ID = "email-2368";

const SCHEMA_PATH = path.join(__dirname, "../../../database/schema.sql");

/** The two columns migration v56 appends, applied with v56's exact DDL. */
const V56_TOMBSTONE_DDL = [
];

/**
 * Who each participant row currently resolves to.
 *
 * The LEFT JOIN is the assertion: a reference that still points at a live row
 * yields that contact's name; one that dangles yields NULL. Read raw — never
 * through the code under test.
 */
function resolution(): Array<{ hash: string; resolvesTo: string | null }> {
  return (
    db
      .prepare(
        `SELECT ep.participant_hash AS hash, c.display_name AS name
           FROM email_participants ep
           LEFT JOIN contacts c ON c.id = ep.resolved_contact_id
          ORDER BY ep.participant_hash`,
      )
      .all() as Array<{ hash: string; name: string | null }>
  ).map((r) => ({ hash: r.hash, resolvesTo: r.name }));
}

function ids(rows: Array<{ id: string }>): string[] {
  return rows.map((r) => r.id).sort();
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

/** Participant-row primary keys that physically exist. */
function participantHashes(): string[] {
  return (
    db
      .prepare("SELECT participant_hash AS h FROM email_participants ORDER BY participant_hash")
      .all() as Array<{ h: string }>
  ).map((r) => r.h);
}

beforeEach(() => {
  db = openTestDb();
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  for (const ddl of V56_TOMBSTONE_DDL) db.exec(ddl);
  db.exec(CONTACT_SOURCE_LINKS_TABLE_SQL);

  db.prepare(
    `INSERT INTO users_local (id, email, oauth_provider, oauth_id)
     VALUES (?, 'owner@example.com', 'google', 'oauth-2368')`,
  ).run(USER);
  db.prepare(
    "INSERT INTO transactions (id, user_id, property_address) VALUES (?, ?, '1 Example Way')",
  ).run(TXN, USER);

  // Dana is on the deal and on an email. Reese is on the same email and is
  // never removed — she is how "the removal hit only the right row" is checked.
  for (const [id, name, email, phone] of [
    ["c-dana", "Dana Example", "dana@example.com", "+15550100"],
    ["c-reese", "Reese Example", "reese@example.com", "+15550101"],
  ]) {
    db.prepare(
      "INSERT INTO contacts (id, user_id, display_name, source, is_imported) VALUES (?, ?, ?, 'manual', 1)",
    ).run(id, USER, name);
    db.prepare(
      "INSERT INTO contact_emails (id, contact_id, email, is_primary) VALUES (?, ?, ?, 1)",
    ).run(`em-${id}`, id, email);
    db.prepare(
      "INSERT INTO contact_phones (id, contact_id, phone_e164, phone_normalized, is_primary) VALUES (?, ?, ?, ?, 1)",
    ).run(`ph-${id}`, id, phone, phone.replace(/\D/g, ""));
  }

  db.prepare(
    `INSERT INTO transaction_contacts (id, transaction_id, contact_id, role, role_category, specific_role)
     VALUES (?, ?, ?, 'listing_agent', 'agent', 'listing_agent')`,
  ).run("tc-c-dana", TXN, "c-dana");

  db.prepare("INSERT INTO emails (id, user_id, subject) VALUES (?, ?, ?)").run(
    EMAIL_ID,
    USER,
    "Re: 1 Example Way",
  );

  // Three participant rows sweeping every branch of the resolution join:
  //   p-dana   -> the contact that gets removed
  //   p-reese  -> a different contact, must be untouched
  //   p-null   -> already unresolved, must stay NULL (not become non-NULL)
  const participants: Array<[string, string, number, string, string, string | null]> = [
    ["p-dana", "from", 0, "dana@example.com", "Dana Example", "c-dana"],
    ["p-reese", "to", 0, "reese@example.com", "Reese Example", "c-reese"],
    ["p-null", "cc", 0, "nobody@example.com", "Nobody Example", null],
  ];
  for (const [hash, role, position, address, display, resolved] of participants) {
    db.prepare(
      `INSERT INTO email_participants
         (email_id, role, position, participant_hash, email_address, display_name, resolved_contact_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(EMAIL_ID, role, position, hash, address, display, resolved);
  }
});

afterEach(() => {
  db.close();
});

// ===========================================================================
// THE CONTROL — without this, nothing below means anything
// ===========================================================================
describe("fixture integrity", () => {
  it("resolved_contact_id carries NO foreign key, so nothing cleans it up", () => {
    const fks = (
      db.prepare("PRAGMA foreign_key_list(email_participants)").all() as Array<{
        from: string;
      }>
    ).map((f) => f.from);

    // The FK is on email_id only. If resolved_contact_id ever gains one, the
    // dangling-reference control below stops being able to fail and this suite
    // must be rethought rather than silently kept.
    expect(fks).toEqual(["email_id"]);
  });

  it("danglingIsPossible: a raw hard DELETE really does break the resolution", () => {
    // This is the behaviour BACKLOG-2365 exists to stop, reproduced here so that
    // "it still resolves after removal" is a result rather than an artefact.
    expect(resolution()).toEqual([
      { hash: "p-dana", resolvesTo: "Dana Example" },
      { hash: "p-null", resolvesTo: null },
      { hash: "p-reese", resolvesTo: "Reese Example" },
    ]);

    db.prepare("DELETE FROM contacts WHERE id = ?").run("c-dana");

    // The row does not disappear — it goes quiet. That is the failure mode.
    expect(participantHashes()).toEqual(["p-dana", "p-null", "p-reese"]);
    expect(resolution()).toEqual([
      { hash: "p-dana", resolvesTo: null }, // <- dangling
      { hash: "p-null", resolvesTo: null },
      { hash: "p-reese", resolvesTo: "Reese Example" },
    ]);
  });
});

// ===========================================================================
// THE CLAIM
// ===========================================================================
describe("a removed contact is still attributable on the emails they were on", () => {
  it.each([
    ["deleteContact", () => deleteContact("c-dana")],
    ["removeContact", () => removeContact("c-dana")],
  ])("%s leaves every participant reference resolving exactly as before", async (_name, remove) => {
    const before = resolution();

    await remove();

    // Unchanged, in full. Dana still resolves; Reese is untouched; the row that
    // was already unresolved has not acquired a resolution from somewhere.
    expect(resolution()).toEqual(before);
    expect(resolution()).toEqual([
      { hash: "p-dana", resolvesTo: "Dana Example" },
      { hash: "p-null", resolvesTo: null },
      { hash: "p-reese", resolvesTo: "Reese Example" },
    ]);
  });

  it.each([
    ["deleteContact", () => deleteContact("c-dana")],
    ["removeContact", () => removeContact("c-dana")],
  ])("%s hard-DELETEs nothing — the whole child footprint survives", async (_name, remove) => {
    await remove();

    // The three cascading children, by exact id...
    expect(childRows("c-dana")).toEqual({
      emails: ["em-c-dana"],
      phones: ["ph-c-dana"],
      roles: ["tc-c-dana"],
    });
    // ...the non-cascading one, by exact primary key...
    expect(participantHashes()).toEqual(["p-dana", "p-null", "p-reese"]);
    // ...and the contact row itself, tombstoned rather than gone.
    expect(
      db.prepare("SELECT id FROM contacts WHERE removed_at IS NOT NULL ORDER BY id").all(),
    ).toEqual([{ id: "c-dana" }]);
    // Reese is untouched throughout.
    expect(childRows("c-reese")).toEqual({
      emails: ["em-c-reese"],
      phones: ["ph-c-reese"],
      roles: [],
    });
  });

  it("stays resolvable when the removal is replayed", async () => {
    // Removal is idempotent, so a replay must not degrade anything either.
    await deleteContact("c-dana");
    await deleteContact("c-dana");
    await removeContact("c-dana");

    expect(resolution()).toEqual([
      { hash: "p-dana", resolvesTo: "Dana Example" },
      { hash: "p-null", resolvesTo: null },
      { hash: "p-reese", resolvesTo: "Reese Example" },
    ]);
  });

  it("removing EVERY referenced contact still dangles nothing", async () => {
    // Sweeps the far boundary: the case where no live contact is left at all,
    // which is where a filter written as "fall back to unfiltered when empty"
    // would show itself.
    await deleteContact("c-dana");
    await deleteContact("c-reese");

    expect(resolution()).toEqual([
      { hash: "p-dana", resolvesTo: "Dana Example" },
      { hash: "p-null", resolvesTo: null },
      { hash: "p-reese", resolvesTo: "Reese Example" },
    ]);
  });
});
