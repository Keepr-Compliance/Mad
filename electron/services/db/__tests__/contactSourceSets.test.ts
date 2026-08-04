/**
 * @jest-environment node
 *
 * BACKLOG-2472 — a contact's LIVE source set, read from the crosswalk.
 *
 * ---------------------------------------------------------------------------
 * ASSERTION STYLE — EXACT SETS, NEVER COUNTS
 * ---------------------------------------------------------------------------
 * `expect(sources).toHaveLength(2)` is equally satisfied by returning the WRONG
 * two sources, and "the contact is filed under the wrong source" is precisely
 * the defect this module exists to end. Every assertion below names the exact
 * values, and the id they belong to, in one `toEqual`.
 *
 * ---------------------------------------------------------------------------
 * THE REAL DDL, NOT A PARAPHRASE
 * ---------------------------------------------------------------------------
 * `contact_source_links` is created from `CONTACT_SOURCE_LINKS_TABLE_SQL` — the
 * same constant migration v59 execs. That is load-bearing here rather than
 * tidy: the whole translation under test rests on `source_type` being drawn
 * from a five-value CHECK vocabulary in which the Mac address book is `macos`
 * and never `contacts_app`. A hand-written table without the CHECK would let a
 * test seed `contacts_app` directly and pass while production could not.
 */

import { openTestDb, type TestDb } from "../../__tests__/helpers/syncSqliteDriver";
import {
  CONTACT_SOURCE_LINKS_INDEX_SQL,
  CONTACT_SOURCE_LINKS_TABLE_SQL,
} from "../contactIdentitySchemaSql";

let db: TestDb;

jest.mock("../core/dbConnection", () => ({
  dbAll: (sql: string, params: unknown[] = []) => db.prepare(sql).all(...params),
  dbGet: (sql: string, params: unknown[] = []) => db.prepare(sql).get(...params),
}));

import {
  attachLiveSources,
  getLiveSourcesByContact,
  getLiveSourcesForContact,
} from "../contactSourceSets";
import type { Contact, ContactSource } from "../../../types/models";

const USER = "user-2472";
const OTHER_USER = "user-someone-else";

const SCHEMA = [
  `CREATE TABLE contacts (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,
     display_name TEXT NOT NULL,
     source TEXT DEFAULT 'manual',
     is_imported INTEGER DEFAULT 1
   );`,
  CONTACT_SOURCE_LINKS_TABLE_SQL,
  CONTACT_SOURCE_LINKS_INDEX_SQL,
].join("\n");

function addContact(id: string, source: ContactSource, userId: string = USER): void {
  db.prepare("INSERT INTO contacts (id, user_id, display_name, source) VALUES (?, ?, ?, ?)").run(
    id,
    userId,
    id,
    source,
  );
}

function addLink(
  contactId: string,
  sourceType: string,
  recordId: string,
  userId: string = USER,
): void {
  db.prepare(
    `INSERT INTO contact_source_links
       (id, user_id, contact_id, source_type, source_record_id, match_method)
     VALUES (?, ?, ?, ?, ?, 'source_id')`,
  ).run(`${contactId}-${sourceType}-${recordId}`, userId, contactId, sourceType, recordId);
}

function dropLink(sourceType: string, recordId: string, userId: string = USER): void {
  db.prepare(
    `DELETE FROM contact_source_links WHERE user_id = ? AND source_type = ? AND source_record_id = ?`,
  ).run(userId, sourceType, recordId);
}

/** Minimal Contact rows for the attach path — only the id is read. */
function asContacts(...ids: string[]): Contact[] {
  return ids.map(
    (id) =>
      ({
        id,
        user_id: USER,
        display_name: id,
        source: "manual" as ContactSource,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      }) as Contact,
  );
}

beforeEach(() => {
  db = openTestDb();
  db.exec(SCHEMA);
});

afterEach(() => {
  db.close();
});

// ===========================================================================
describe("sanity", () => {
  it("runs against a real SQLite engine with the production crosswalk CHECK", () => {
    addContact("c1", "manual");
    // `contacts_app` belongs to the OTHER vocabulary and must be rejected here.
    expect(() => addLink("c1", "contacts_app", "r1")).toThrow();
  });
});

// ===========================================================================
describe("getLiveSourcesByContact — the macOS translation", () => {
  it("reports a macos link in the DISPLAY vocabulary as contacts_app", () => {
    addContact("paul", "outlook");
    addLink("paul", "macos", "mac-1");

    expect([...getLiveSourcesByContact(USER)]).toEqual([["paul", ["contacts_app"]]]);
  });

  it("reports a contact linked to BOTH macOS and Outlook as both, sorted", () => {
    addContact("paul", "outlook");
    addLink("paul", "macos", "mac-1");
    addLink("paul", "outlook", "out-1");

    expect(getLiveSourcesByContact(USER).get("paul")).toEqual(["contacts_app", "outlook"]);
  });

  it("collapses TWO macOS address books into ONE contacts_app entry", () => {
    // BACKLOG-2392 made the macOS reader return every address book, so one
    // person in both iCloud and Exchange is two `macos` links before any other
    // source exists. The card must not show "Contacts App" twice.
    addContact("jane", "contacts_app");
    addLink("jane", "macos", "icloud-1");
    addLink("jane", "macos", "exchange-1");

    expect(getLiveSourcesByContact(USER).get("jane")).toEqual(["contacts_app"]);
  });

  it("passes the four non-macOS sources through unchanged", () => {
    addContact("multi", "manual");
    addLink("multi", "outlook", "o1");
    addLink("multi", "google_contacts", "g1");
    addLink("multi", "iphone", "i1");
    addLink("multi", "android_sync", "a1");

    expect(getLiveSourcesByContact(USER).get("multi")).toEqual([
      "android_sync",
      "google_contacts",
      "iphone",
      "outlook",
    ]);
  });

  it("OMITS contacts with no links rather than reporting them as source-less", () => {
    addContact("manual-only", "manual");
    addContact("linked", "contacts_app");
    addLink("linked", "macos", "mac-1");

    const map = getLiveSourcesByContact(USER);
    expect([...map.keys()].sort()).toEqual(["linked"]);
    expect(map.has("manual-only")).toBe(false);
  });

  it("does not leak another user's links", () => {
    addContact("mine", "manual");
    addContact("theirs", "manual", OTHER_USER);
    addLink("mine", "macos", "mac-1");
    addLink("theirs", "outlook", "out-1", OTHER_USER);

    expect([...getLiveSourcesByContact(USER).keys()]).toEqual(["mine"]);
    expect([...getLiveSourcesByContact(OTHER_USER).keys()]).toEqual(["theirs"]);
  });

  it("returns an empty map when the crosswalk table does not exist yet", () => {
    // Reachable pre-v57 and from fixtures that seed only `contacts`. Answered
    // exactly as "no links" is answered: the caller falls back to the scalar.
    addContact("c1", "manual");
    db.exec("DROP TABLE contact_source_links");

    expect([...getLiveSourcesByContact(USER)]).toEqual([]);
  });
});

// ===========================================================================
describe("unlinking — the founder's Paul Dorian case", () => {
  it("drops the unlinked source and keeps the rest, with contacts.source untouched", () => {
    addContact("paul", "outlook"); // Outlook imported him first; the scalar is frozen there
    addLink("paul", "macos", "mac-1");
    addLink("paul", "outlook", "out-1");
    expect(getLiveSourcesByContact(USER).get("paul")).toEqual(["contacts_app", "outlook"]);

    dropLink("outlook", "out-1");

    expect(getLiveSourcesByContact(USER).get("paul")).toEqual(["contacts_app"]);
    // The scalar is deliberately NOT rewritten — that is why it cannot be trusted.
    const row = db.prepare("SELECT source FROM contacts WHERE id = ?").get("paul") as {
      source: string;
    };
    expect(row.source).toBe("outlook");
  });

  it("leaves a single-source contact alone when a DIFFERENT contact is unlinked", () => {
    addContact("paul", "outlook");
    addContact("olivia", "outlook");
    addLink("paul", "macos", "mac-1");
    addLink("paul", "outlook", "out-1");
    addLink("olivia", "outlook", "out-2");

    dropLink("outlook", "out-1");

    const map = getLiveSourcesByContact(USER);
    expect([...map].sort()).toEqual([
      ["olivia", ["outlook"]],
      ["paul", ["contacts_app"]],
    ]);
  });

  it("removing the LAST link returns the contact to the no-links state", () => {
    addContact("paul", "outlook");
    addLink("paul", "outlook", "out-1");

    dropLink("outlook", "out-1");

    expect(getLiveSourcesByContact(USER).has("paul")).toBe(false);
    expect(getLiveSourcesForContact("paul")).toEqual([]);
  });
});

// ===========================================================================
describe("getLiveSourcesForContact — the single-contact read", () => {
  it("agrees with the list query for the same contact", () => {
    addContact("paul", "outlook");
    addLink("paul", "macos", "mac-1");
    addLink("paul", "outlook", "out-1");

    expect(getLiveSourcesForContact("paul")).toEqual(["contacts_app", "outlook"]);
    expect(getLiveSourcesForContact("paul")).toEqual(getLiveSourcesByContact(USER).get("paul"));
  });

  it("returns [] for an unlinked contact and when the table is absent", () => {
    addContact("manual-only", "manual");
    expect(getLiveSourcesForContact("manual-only")).toEqual([]);
    db.exec("DROP TABLE contact_source_links");
    expect(getLiveSourcesForContact("manual-only")).toEqual([]);
  });
});

// ===========================================================================
describe("attachLiveSources", () => {
  it("stamps source_types on linked contacts and leaves unlinked ones UNDEFINED", () => {
    addContact("paul", "outlook");
    addContact("manual-only", "manual");
    addLink("paul", "macos", "mac-1");
    addLink("paul", "outlook", "out-1");

    const result = attachLiveSources(USER, asContacts("paul", "manual-only"));

    expect(result.map((c) => [c.id, c.source_types])).toEqual([
      ["paul", ["contacts_app", "outlook"]],
      // undefined, NOT [] — an empty array would hide it from every source leaf.
      ["manual-only", undefined],
    ]);
  });

  it("preserves order and every other field", () => {
    addContact("a", "manual");
    addContact("b", "contacts_app");
    addLink("b", "macos", "mac-1");

    const input = asContacts("a", "b", "c");
    const result = attachLiveSources(USER, input);

    expect(result.map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(result.map((c) => c.display_name)).toEqual(["a", "b", "c"]);
  });

  it("is a no-op on an empty list and when nothing is linked", () => {
    expect(attachLiveSources(USER, [])).toEqual([]);
    addContact("a", "manual");
    const input = asContacts("a");
    expect(attachLiveSources(USER, input)).toBe(input); // same reference: untouched
  });
});
