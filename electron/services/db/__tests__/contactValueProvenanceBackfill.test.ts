/**
 * @jest-environment node
 *
 * Migration v60 — recovering hand-typed provenance for values already on disk
 * (BACKLOG-2427).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS TESTED AS A FUNCTION, NOT THROUGH `_runVersionedMigrations`
 * ---------------------------------------------------------------------------
 * The repo's migration suites drive the real chain through the real
 * `better-sqlite3-multiple-ciphers`. That binary is an ELECTRON build
 * (NODE_MODULE_VERSION 139); under plain node (127) it cannot be loaded, so
 * every one of those suites is red on a developer machine regardless of what
 * the code does. A migration whose test cannot be executed is not a tested
 * migration — and this one DELETES-OR-SPARES user data by classifying it.
 *
 * So the rule lives in its own module taking a structural db handle, and is
 * exercised here against `node:sqlite` — the SQLite inside Node 22 — with the
 * real production DDL for the tables it touches. The v60 migration entry is a
 * thin call to `relabelTypedContactValues`; what is asserted here is the whole
 * of its behaviour.
 *
 * ---------------------------------------------------------------------------
 * WHAT MUST NOT REGRESS
 * ---------------------------------------------------------------------------
 * Two failures, in opposite directions:
 *   - relabel too little -> the unlink deletes a client's typed phone number;
 *   - relabel too much   -> the rejected person's address stays in the audit,
 *                           which is the bug BACKLOG-2427 exists to fix.
 * Both directions are asserted below.
 */

import { jest } from "@jest/globals";
import { relabelTypedContactValues } from "../contactValueProvenanceBackfill";
import { openTestDb, type TestDb } from "../../__tests__/helpers/syncSqliteDriver";

let db: TestDb;

const USER = "user-v60";

const SCHEMA = `
  CREATE TABLE contacts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    is_imported INTEGER DEFAULT 1
  );
  CREATE TABLE contact_emails (
    id TEXT PRIMARY KEY,
    contact_id TEXT NOT NULL,
    email TEXT NOT NULL,
    is_primary INTEGER DEFAULT 0,
    source TEXT CHECK (source IN ('import', 'manual', 'inferred')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(contact_id, email)
  );
  CREATE TABLE contact_phones (
    id TEXT PRIMARY KEY,
    contact_id TEXT NOT NULL,
    phone_e164 TEXT NOT NULL,
    phone_display TEXT,
    phone_normalized TEXT,
    is_primary INTEGER DEFAULT 0,
    source TEXT CHECK (source IN ('import', 'manual', 'inferred')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(contact_id, phone_e164)
  );
  CREATE TABLE external_contacts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT,
    phones_json TEXT,
    phones_normalized_json TEXT,
    emails_json TEXT,
    external_record_id TEXT,
    source TEXT DEFAULT 'macos',
    synced_at DATETIME,
    UNIQUE(user_id, source, external_record_id)
  );
  CREATE TABLE contact_source_links (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    contact_id TEXT NOT NULL,
    source_type TEXT NOT NULL,
    source_record_id TEXT NOT NULL,
    match_method TEXT,
    UNIQUE(user_id, source_type, source_record_id)
  );
`;

function addContact(id: string): void {
  db.prepare("INSERT INTO contacts (id, user_id, display_name) VALUES (?, ?, ?)").run(id, USER, id);
}

function addEmail(contactId: string, email: string, source: string | null): void {
  db.prepare(
    "INSERT INTO contact_emails (id, contact_id, email, source) VALUES (?, ?, ?, ?)",
  ).run(`${contactId}-${email}`, contactId, email, source);
}

function addPhone(contactId: string, e164: string, source: string | null): void {
  db.prepare(
    "INSERT INTO contact_phones (id, contact_id, phone_e164, phone_normalized, source) VALUES (?, ?, ?, ?, ?)",
  ).run(`${contactId}-${e164}`, contactId, e164, e164.replace(/\D/g, "").slice(-10), source);
}

function addLinkedSource(
  contactId: string,
  recordId: string,
  sourceType: string,
  emails: string[],
  phones: string[],
): void {
  db.prepare(
    `INSERT INTO external_contacts
      (id, user_id, name, phones_json, phones_normalized_json, emails_json, external_record_id, source, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `ext-${sourceType}-${recordId}`,
    USER,
    "Whoever",
    JSON.stringify(phones),
    JSON.stringify(phones.map((p) => p.replace(/\D/g, "").slice(-10))),
    JSON.stringify(emails),
    recordId,
    sourceType,
    "2026-08-03T00:00:00.000Z",
  );
  db.prepare(
    `INSERT INTO contact_source_links (id, user_id, contact_id, source_type, source_record_id, match_method)
     VALUES (?, ?, ?, ?, ?, 'source_id')`,
  ).run(`link-${sourceType}-${recordId}`, USER, contactId, sourceType, recordId);
}

/** `email -> source`, so an assertion names values rather than counting rows. */
function emailSources(contactId: string): Record<string, string | null> {
  const rows = db
    .prepare("SELECT email, source FROM contact_emails WHERE contact_id = ? ORDER BY email")
    .all(contactId) as Array<{ email: string; source: string | null }>;
  return Object.fromEntries(rows.map((r) => [r.email, r.source]));
}

function phoneSources(contactId: string): Record<string, string | null> {
  const rows = db
    .prepare("SELECT phone_e164, source FROM contact_phones WHERE contact_id = ? ORDER BY phone_e164")
    .all(contactId) as Array<{ phone_e164: string; source: string | null }>;
  return Object.fromEntries(rows.map((r) => [r.phone_e164, r.source]));
}

beforeEach(() => {
  db = openTestDb();
  db.exec(SCHEMA);
});

afterEach(() => {
  db.close();
});

// ===========================================================================
describe("values no linked source carries are reclassified as hand-typed", () => {
  it("relabels a typed value and spares one a linked source really has", () => {
    addContact("c1");
    // Both say 'import' — that is the whole problem this pass exists for.
    addEmail("c1", "typed@byhand.com", "import");
    addEmail("c1", "fromsource@example.com", "import");
    addPhone("c1", "+14082104874", "import");
    addPhone("c1", "+14155550000", "import");

    addLinkedSource("c1", "mac-1", "macos", ["fromsource@example.com"], ["(415) 555-0000"]);

    const moved = relabelTypedContactValues(db);

    expect(moved).toEqual({ emails: 1, phones: 1 });
    expect(emailSources("c1")).toEqual({
      "typed@byhand.com": "manual",
      "fromsource@example.com": "import",
    });
    expect(phoneSources("c1")).toEqual({
      "+14082104874": "manual",
      "+14155550000": "import",
    });
  });

  it("matches emails case-insensitively, as every other comparison does", () => {
    addContact("c2");
    addEmail("c2", "mixed@case.com", "import");
    addLinkedSource("c2", "mac-2", "macos", ["MIXED@Case.COM"], []);

    relabelTypedContactValues(db);

    expect(emailSources("c2")).toEqual({ "mixed@case.com": "import" });
  });

  it("matches phones on the normalized key, not the stored spelling", () => {
    addContact("c3");
    addPhone("c3", "+14082104874", "import");
    // The source spells it differently, as address books do.
    addLinkedSource("c3", "mac-3", "macos", [], ["(408) 210-4874"]);

    relabelTypedContactValues(db);

    expect(phoneSources("c3")).toEqual({ "+14082104874": "import" });
  });

  it("leaves 'manual' and 'inferred' and NULL exactly as they are", () => {
    addContact("c4");
    addEmail("c4", "already-manual@x.com", "manual");
    addEmail("c4", "inferred@x.com", "inferred");
    addEmail("c4", "unknown@x.com", null);

    const moved = relabelTypedContactValues(db);

    expect(moved).toEqual({ emails: 0, phones: 0 });
    expect(emailSources("c4")).toEqual({
      "already-manual@x.com": "manual",
      "inferred@x.com": "inferred",
      "unknown@x.com": null,
    });
  });

  it("does not let ANOTHER contact's linked source vouch for this value", () => {
    // The NOT EXISTS is correlated on contact_id. Dropping that correlation
    // would spare a typed value because some unrelated contact's address book
    // happens to list the same address — and would then let the unlink delete
    // it.
    addContact("owner");
    addContact("stranger");
    addEmail("owner", "shared@example.com", "import");
    addLinkedSource("stranger", "mac-s", "macos", ["shared@example.com"], []);

    relabelTypedContactValues(db);

    expect(emailSources("owner")).toEqual({ "shared@example.com": "manual" });
  });

  it("relabels everything when the crosswalk has not converged — the safe direction", () => {
    // No links at all: nothing can vouch for anything, so every 'import' value
    // becomes non-removable. Accepted and deliberate — see the module header.
    addContact("c5");
    addEmail("c5", "a@x.com", "import");
    addEmail("c5", "b@x.com", "import");

    expect(relabelTypedContactValues(db)).toEqual({ emails: 2, phones: 0 });
    expect(emailSources("c5")).toEqual({ "a@x.com": "manual", "b@x.com": "manual" });
  });

  it("is idempotent — a second run moves nothing", () => {
    addContact("c6");
    addEmail("c6", "typed@byhand.com", "import");
    addPhone("c6", "+14082104874", "import");

    expect(relabelTypedContactValues(db)).toEqual({ emails: 1, phones: 1 });
    expect(relabelTypedContactValues(db)).toEqual({ emails: 0, phones: 0 });
  });

  it("does not abort the pass on MALFORMED json — and fails safe", () => {
    // `json_each('')` raises `malformed JSON`. Left unguarded that aborts v60,
    // the migration rolls back to v59, and the user then runs the NEW removal
    // code against values still labelled 'import' — the exact deletion this
    // pass exists to prevent, landing on the one user with a corrupt row.
    addContact("c8");
    addEmail("c8", "typed@byhand.com", "import");
    db.prepare(
      `INSERT INTO external_contacts (id, user_id, name, phones_json, phones_normalized_json, emails_json, external_record_id, source, synced_at)
       VALUES (?, ?, ?, '', '', 'not json at all', ?, 'macos', ?)`,
    ).run("ext-bad", USER, "Corrupt Row", "mac-bad", "2026-08-03T00:00:00.000Z");
    db.prepare(
      `INSERT INTO contact_source_links (id, user_id, contact_id, source_type, source_record_id, match_method)
       VALUES (?, ?, ?, 'macos', 'mac-bad', 'source_id')`,
    ).run("link-bad", USER, "c8");

    expect(() => relabelTypedContactValues(db)).not.toThrow();
    // A record whose JSON cannot be read vouches for nothing, so the value is
    // protected rather than left removable.
    expect(emailSources("c8")).toEqual({ "typed@byhand.com": "manual" });
  });

  it("tolerates NULL and corrupt json on the source record", () => {
    addContact("c7");
    addEmail("c7", "typed@byhand.com", "import");
    db.prepare(
      `INSERT INTO external_contacts (id, user_id, name, phones_json, phones_normalized_json, emails_json, external_record_id, source, synced_at)
       VALUES (?, ?, ?, NULL, NULL, NULL, ?, 'macos', ?)`,
    ).run("ext-null", USER, "No Values", "mac-null", "2026-08-03T00:00:00.000Z");
    db.prepare(
      `INSERT INTO contact_source_links (id, user_id, contact_id, source_type, source_record_id, match_method)
       VALUES (?, ?, ?, 'macos', 'mac-null', 'source_id')`,
    ).run("link-null", USER, "c7");

    expect(() => relabelTypedContactValues(db)).not.toThrow();
    expect(emailSources("c7")).toEqual({ "typed@byhand.com": "manual" });
  });
});

// ===========================================================================
describe("the founder's case still works after the pass", () => {
  /**
   * The pass must protect typed values WITHOUT disarming BACKLOG-2427.
   *
   * Paul Dorian has two live links at migration time, and the Outlook record
   * carries `dorian@bluespaces.com`. So that address stays 'import' and stays
   * removable — while anything he typed becomes 'manual'.
   */
  it("leaves the rejected source's address removable, and protects the typed one", () => {
    addContact("paul");
    addEmail("paul", "dorian@bluespaces.com", "import"); // Outlook only
    addEmail("paul", "paul@pauljdorian.com", "import"); // both sources
    addEmail("paul", "paul.typed@example.com", "import"); // typed, mislabelled
    addPhone("paul", "+14082104874", "import"); // both sources

    addLinkedSource("paul", "mac-paul", "macos", ["paul@pauljdorian.com"], ["(408) 210-4874"]);
    addLinkedSource(
      "paul",
      "out-paul",
      "outlook",
      ["dorian@bluespaces.com", "paul@pauljdorian.com"],
      ["(408) 210-4874"],
    );

    relabelTypedContactValues(db);

    expect(emailSources("paul")).toEqual({
      "dorian@bluespaces.com": "import", // still removable — the fix survives
      "paul@pauljdorian.com": "import",
      "paul.typed@example.com": "manual", // now protected
    });
    expect(phoneSources("paul")).toEqual({ "+14082104874": "import" });
  });
});

// ===========================================================================
describe("missing tables", () => {
  it("is a no-op rather than a failure, and leaves rows alone", () => {
    const bare = openTestDb();
    bare.exec(`
      CREATE TABLE contact_emails (
        id TEXT PRIMARY KEY, contact_id TEXT, email TEXT,
        source TEXT CHECK (source IN ('import', 'manual', 'inferred'))
      );
    `);
    bare.prepare("INSERT INTO contact_emails VALUES (?, ?, ?, 'import')").run("1", "c", "a@x.com");

    expect(relabelTypedContactValues(bare)).toEqual({ emails: 0, phones: 0 });
    // Leaving them 'import' is the safe reading here: relabelling everything
    // because a table is missing would silently disarm the removal.
    expect(bare.prepare("SELECT source FROM contact_emails").get()).toEqual({ source: "import" });
    bare.close();
  });
});

// Keep the linter honest about the unused import guard in CI.
void jest;
