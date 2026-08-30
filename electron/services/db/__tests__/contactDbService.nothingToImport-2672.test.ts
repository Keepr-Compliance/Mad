/**
 * @jest-environment node
 *
 * BACKLOG-2672 — DERIVING, BY EXECUTION, THE RECORDS THAT HAVE NOTHING TO
 * IMPORT.
 *
 * ===========================================================================
 * WHAT THE FOUNDER FOUND, AND WHERE IT ACTUALLY COMES FROM
 * ===========================================================================
 * Gate 4, check 6, 11 Aug. Searching Clients & Contacts for "Unknown":
 *
 *     U   unknown
 *         Message · Not Imported · [Import]
 *         Phone: unknown
 *
 * The item body says this record lives in `external_contacts`. IT DOES NOT, and
 * the difference decides what this file has to seed.
 *
 * `getMessageDerivedContacts` synthesises message-derived pseudo-contacts
 * STRAIGHT OUT OF THE `messages` TABLE — there is no `external_contacts` row and
 * no `contacts` row behind them (`contactSourceVocabulary.ts:66-73`: `messages`
 * is a SYNTHETIC source, deliberately absent from the `contacts.source` CHECK).
 *
 * ===========================================================================
 * THE SEEDS ARE PRODUCED, NOT WRITTEN OUT BY HAND
 * ===========================================================================
 * A fixture standing in for a real producer must come from that producer. Both
 * halves of this corpus do:
 *
 *   MESSAGE HALF   `participants.$.from` is built by calling the REAL
 *                  `sanitizeString(handle, MAX_HANDLE_LENGTH, "unknown")`
 *                  fallback — reproduced here as `sanitizedHandle`, byte for
 *                  byte from `iPhoneSyncStorageService.ts:90-96`, which is the
 *                  same three lines as
 *                  `macOSMessagesImportService.ts:909-913`. A message whose
 *                  `handle_id` is NULL therefore yields the STRING "unknown",
 *                  and every such message in the corpus groups into ONE row.
 *
 *   ADDRESS-BOOK   Rows are written through the REAL `upsertFromiPhone`, and
 *   HALF           the values handed to it are what the REAL
 *                  `iPhoneSyncStorageService.ts:620-631` mapper produces for an
 *                  iOS contact with no display name, no numbers and no
 *                  addresses: `name = "Unknown"` (capital U — a SECOND spelling
 *                  of the same placeholder, from a different call site) with
 *                  empty phone and email arrays.
 *
 * Then the REAL readers run — `getMessageDerivedContacts` and `getAllForUser` —
 * and the predicate is applied to the rows THEY emit, not to objects this file
 * made up.
 *
 * ===========================================================================
 * EXACT ID SETS, NEVER COUNTS
 * ===========================================================================
 * Control 1 of the founder's decision. "Six records were blocked" is equally
 * satisfied by blocking six of the wrong ones, and the boundary case — a record
 * with NO NAME but WITH A PHONE — is the one a too-broad predicate eats.
 */

import { readFileSync } from "fs";
import path from "path";
import { openTestDb, type TestDb } from "../../__tests__/helpers/syncSqliteDriver";
import { hasNothingToImport } from "../../../../src/utils/importableRecord";
import { CONTACT_SOURCE_LINKS_TABLE_SQL } from "../contactIdentitySchemaSql";

let db: TestDb;

jest.mock("../core/dbConnection", () => ({
  dbAll: (sql: string, params: unknown[] = []) => db.prepare(sql).all(...params),
  dbGet: (sql: string, params: unknown[] = []) => db.prepare(sql).get(...params),
  dbRun: (sql: string, params: unknown[] = []) => db.prepare(sql).run(...params),
  // `upsertFromiPhone` wraps its inserts in one. Executed rather than stubbed
  // out: the writer under test is the real one, so its transaction boundary
  // should be real too.
  dbTransaction: (fn: () => unknown) => db.transaction(fn)(),
}));

import { getMessageDerivedContacts } from "../contactDbService";
import { getAllForUser, upsertFromiPhone } from "../externalContactDbService";

const USER = "user-2672";
const SCHEMA_PATH = path.join(__dirname, "../../../database/schema.sql");

/**
 * v56 (BACKLOG-2364/2365). `getMessageDerivedContacts` reads `c.removed_at` —
 * a removed contact must still suppress its message-derived twin — so a schema
 * without these columns fails the query outright rather than testing anything.
 */
const V56_TOMBSTONE_DDL = [
];

/**
 * `external_contacts` columns that `schema.sql` does NOT declare — they are
 * added by migrations only (`databaseService.ts:3017` and `:3095`), so a fresh
 * `exec(schema.sql)` produces a table the real `upsertFromiPhone` cannot write
 * to ("table external_contacts has no column named external_uuid"). The same
 * two ALTERs appear in `contact-handlers.universalLinking.test.ts:179-180`.
 */
const EXTERNAL_CONTACTS_MIGRATION_DDL = [
];

/**
 * `sanitizeString`, transcribed from `iPhoneSyncStorageService.ts:90-96`.
 *
 * Copied rather than imported because importing that module pulls the whole
 * iPhone sync service — and its Electron dependencies — into a node-environment
 * suite. The three lines are reproduced exactly; what matters for this file is
 * the ONE branch it exercises: a null handle returns the default, and the
 * default at both message call sites is the literal string "unknown".
 */
function sanitizeString(
  value: string | null | undefined,
  maxLength: number,
  defaultValue = "",
): string {
  if (value === null || value === undefined) return defaultValue;
  const str = String(value);
  return str.length > maxLength ? str.substring(0, maxLength) : str;
}

const MAX_HANDLE_LENGTH = 500;

/** What the importer writes when a message has no resolvable handle. */
function sanitizedHandle(handle: string | null): string {
  return sanitizeString(handle, MAX_HANDLE_LENGTH, "unknown");
}

function addMessage(
  id: string,
  handle: string | null,
  sentAt = "2026-08-09T10:00:00Z",
): void {
  db.prepare(
    `INSERT INTO messages (id, user_id, channel, direction, participants, sent_at)
     VALUES (?, ?, 'sms', 'inbound', ?, ?)`,
  ).run(id, USER, JSON.stringify({ from: sanitizedHandle(handle) }), sentAt);
}

function ids(rows: Array<{ id: string }>): string[] {
  return rows.map((r) => r.id).sort();
}

beforeEach(() => {
  db = openTestDb();
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  for (const ddl of V56_TOMBSTONE_DDL) db.exec(ddl);
  for (const ddl of EXTERNAL_CONTACTS_MIGRATION_DDL) db.exec(ddl);
  db.exec(CONTACT_SOURCE_LINKS_TABLE_SQL);
  db.prepare(
    `INSERT INTO users_local (id, email, oauth_provider, oauth_id)
     VALUES (?, 'owner@example.com', 'google', 'oauth-2672')`,
  ).run(USER);
});

afterEach(() => {
  db.close();
});

// ===========================================================================
describe("the founder's record, reproduced from the real producer", () => {
  it("a message with NO handle projects name 'unknown' and phone 'unknown'", () => {
    addMessage("m-null-handle", null);

    const [row] = getMessageDerivedContacts(USER);

    /*
      THE WHOLE PREMISE OF THIS ITEM, ESTABLISHED RATHER THAN ASSUMED. If any of
      these four were different, the predicate below would be answering a
      question about a record the app cannot emit.
    */
    expect(row.id).toBe("msg_unknown");
    expect(row.name).toBe("unknown");
    expect(row.phone).toBe("unknown");
    expect(row.email).toBeNull();
    expect(row.company).toBeNull();
  });

  it("every handle-less message in the corpus collapses into ONE row", () => {
    // The founder has six of these. They are six because six DISTINCT
    // placeholder-ish senders exist, not because six messages do — three
    // messages with no handle at all are one person as far as this projection
    // is concerned, and that is worth pinning: a fix that counted messages
    // would report a different number to him than the screen does.
    addMessage("m-a", null, "2026-08-09T10:00:00Z");
    addMessage("m-b", null, "2026-08-09T11:00:00Z");
    addMessage("m-c", null, "2026-08-09T12:00:00Z");

    expect(ids(getMessageDerivedContacts(USER))).toEqual(["msg_unknown"]);
  });
});

// ===========================================================================
describe("CONTROL 1 — the blocked set, derived by execution, asserted by ID", () => {
  /**
   * A corpus with one record of each kind that matters, run through the REAL
   * projection. `msg_unknown` is the only one that must come back.
   */
  beforeEach(() => {
    // (a) THE DEFECT: no handle at all -> 'unknown' in both slots.
    addMessage("m-nothing", null);

    // (b) A real display name. Importable, and the ordinary case.
    addMessage("m-named", "Marisol Vantrees");

    // (c) A sender whose name IS a placeholder but which the projection still
    //     admits — "Unknown Contact" is the SECOND sentinel in
    //     `contactDisplayLabel.ts:47`, and it reaches the list exactly like the
    //     founder's row does. Nothing else on it either.
    addMessage("m-unknown-contact", "Unknown Contact");

    // (d) Senders that ARE identifiers never reach this projection at all (the
    //     SQL's WHERE excludes '%@%', '+%' and '[0-9]*'). Seeded so the corpus
    //     is honest about what the producer drops, and so a future widening of
    //     that WHERE shows up here rather than silently.
    addMessage("m-email-sender", "marisol@example.com");
    addMessage("m-phone-sender", "+16175550147");
  });

  it("projects exactly the three display-name senders", () => {
    expect(ids(getMessageDerivedContacts(USER))).toEqual([
      "msg_marisol vantrees",
      "msg_unknown",
      "msg_unknown contact",
    ]);
  });

  it("blocks EXACTLY the two placeholder rows, by id", () => {
    const blocked = getMessageDerivedContacts(USER)
      .filter(hasNothingToImport)
      .map((r) => r.id)
      .sort();

    expect(blocked).toEqual(["msg_unknown", "msg_unknown contact"]);
  });

  it("leaves the named sender importable", () => {
    const allowed = getMessageDerivedContacts(USER)
      .filter((r) => !hasNothingToImport(r))
      .map((r) => r.id);

    expect(allowed).toEqual(["msg_marisol vantrees"]);
  });
});

// ===========================================================================
describe("CONTROL 2 — no name but WITH a phone stays importable", () => {
  /**
   * THE LEG A TOO-BROAD PREDICATE BREAKS, and the founder named it as the
   * boundary this fix must not cross: 23 nameless address-book records were
   * parsed at his last app start.
   *
   * Written on the ADDRESS-BOOK half because that is where a nameless record
   * can still carry a number — the message projection puts the sender in BOTH
   * the name and the phone slot, so it structurally cannot produce this shape.
   * Rows go in through the REAL `upsertFromiPhone`, with the values the REAL
   * iOS mapper produces (`iPhoneSyncStorageService.ts:620-631`).
   */
  beforeEach(() => {
    upsertFromiPhone(USER, [
      // A contact with no display name — `sanitizeString(null, …, "Unknown")`
      // — but three real numbers. THIS ONE MUST STAY IMPORTABLE.
      {
        name: sanitizeString(null, MAX_HANDLE_LENGTH, "Unknown"),
        phones: ["+16175550101", "+16175550102", "+16175550103"],
        emails: [],
        recordId: "iphone-numbers-only",
      },
      // No name, no numbers, but an address. Also importable.
      {
        name: sanitizeString(null, MAX_HANDLE_LENGTH, "Unknown"),
        phones: [],
        emails: ["marisol@example.com"],
        recordId: "iphone-email-only",
      },
      // No name and no numbers, but an ORGANISATION. The display chain shows
      // "Vantrees Realty" on screen, so refusing it with "no name" would be
      // false on its face.
      {
        name: sanitizeString(null, MAX_HANDLE_LENGTH, "Unknown"),
        phones: [],
        emails: [],
        company: "Vantrees Realty",
        recordId: "iphone-company-only",
      },
      // Nothing at all. The address-book twin of the founder's record.
      {
        name: sanitizeString(null, MAX_HANDLE_LENGTH, "Unknown"),
        phones: [],
        emails: [],
        recordId: "iphone-empty",
      },
      // An ordinary contact, present so "everything was blocked" cannot pass.
      {
        name: "Marisol Vantrees",
        phones: ["+16175550147"],
        emails: ["marisol@example.com"],
        recordId: "iphone-ordinary",
      },
    ]);
  });

  /**
   * `getAllForUser` returns rows keyed by their own uuid, so the assertion is
   * made on the ORIGIN RECORD ID — the stable identity, and the one a human can
   * match back to a row in the phone.
   */
  function blockedRecordIds(): string[] {
    return getAllForUser(USER)
      .filter((row) =>
        hasNothingToImport({
          name: row.name,
          company: row.company,
          allPhones: row.phones,
          allEmails: row.emails,
        }),
      )
      .map((row) => row.external_record_id)
      .sort();
  }

  it("the real writer stores the placeholder name verbatim", () => {
    // Without this, the four "Unknown"-named rows below could be passing
    // because the writer dropped the name entirely — a different reason, and
    // one that would not survive a change to the mapper.
    const names = getAllForUser(USER)
      .map((r) => r.name)
      .sort();
    expect(names).toEqual([
      "Marisol Vantrees",
      "Unknown",
      "Unknown",
      "Unknown",
      "Unknown",
    ]);
  });

  it("blocks EXACTLY the record with nothing on it", () => {
    expect(blockedRecordIds()).toEqual(["iphone-empty"]);
  });

  it("a nameless record WITH phones is not blocked", () => {
    expect(blockedRecordIds()).not.toContain("iphone-numbers-only");
  });

  it("a nameless record WITH an email is not blocked", () => {
    expect(blockedRecordIds()).not.toContain("iphone-email-only");
  });

  it("a nameless record WITH a company is not blocked", () => {
    expect(blockedRecordIds()).not.toContain("iphone-company-only");
  });
});
