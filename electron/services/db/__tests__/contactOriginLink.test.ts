/**
 * @jest-environment node
 *
 * WHERE A CONTACT CAME FROM, RECORDED AT THE MOMENT IT IS CREATED (BACKLOG-2473)
 *
 * Two properties, and the second is the one that could break the app:
 *
 *  1. Every newly created contact gets exactly one crosswalk row naming its
 *     origin, so provenance stops being answered from the crosswalk for imported
 *     contacts and from the `contacts.source` scalar for everyone else.
 *
 *  2. AN ORIGIN ROW MUST NOT SUPPRESS THE CONTENT FALLBACK.
 *     `CONTACT_SOURCE_RECORDS_SQL` enables its email/phone matching only for a
 *     contact with no crosswalk rows. Before this work that gate was a bare
 *     `NOT EXISTS`, so handing every new contact an origin row would have turned
 *     the fallback off for all of them — a hand-typed contact would silently
 *     stop picking up the addresses of an address-book record carrying the same
 *     email. No error, no failing count; the data just stops arriving.
 *
 *     The gate therefore excludes `match_method = 'origin'`, and the last
 *     describe below is what holds it there.
 *
 *     NEGATIVE CONTROL RUN: reverted BOTH branches of the query to the bare
 *     `NOT EXISTS (... WHERE x.contact_id = @contactId)`. Observed: 1 failed /
 *     15 passed — exactly `STILL resolves by email once the contact carries an
 *     origin row`, on `Expected ["email:MAC-SHARED"], Received []`.
 *
 *     ONE test, not two, and the count is recorded because it is the useful
 *     part: the baseline and the record-backed cases pass either way, so
 *     neither of them is defending this. Removing that one test would leave the
 *     gate unguarded while the file still looked like it covered the subject.
 */

import path from "path";
import type { Database as DatabaseType } from "better-sqlite3";

// Bypass the jest moduleNameMapper that rewrites better-sqlite3-multiple-ciphers
// to the auto-mock. These tests execute real SQL — CHECK constraints, a UNIQUE
// collision and a multi-branch UNION query — none of which the mock evaluates.
// Imported through the mapper, every assertion here passes or fails for reasons
// unrelated to the code under test.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

jest.mock("../../logService", () => {
  const m = {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  return { __esModule: true, default: m, logService: m };
});

import { CONTACT_IDENTITY_SCHEMA } from "../../__tests__/helpers/contactIdentitySchema";
import { setDb, setDbPath, setEncryptionKey } from "../core/dbConnection";
import {
  ORIGIN_SOURCE_TYPE_BY_CONTACT_SOURCE,
  originRecordId,
  originSourceTypeFor,
  recordContactOrigin,
} from "../contactOriginLink";
import { CONTACT_SOURCE_RECORDS_SQL } from "../contactSourceLinkSql";
import { PERSISTED_CONTACT_SOURCES } from "../../../utils/contactSourceVocabulary";

const USER_ID = "user-origin";

describe("contact origin links (BACKLOG-2473)", () => {
  let db: DatabaseType;

  beforeEach(() => {
    db = new RealDatabase(":memory:") as DatabaseType;
    db.exec(CONTACT_IDENTITY_SCHEMA);
    setDb(db);
    setDbPath(":memory:");
    setEncryptionKey("test-key");
    jest.clearAllMocks();
  });

  afterEach(() => {
    setDb(null as unknown as DatabaseType);
    try {
      db.close();
    } catch {
      /* already closed */
    }
  });

  function addContact(id: string, source: string): void {
    db.prepare(
      "INSERT INTO contacts (id, user_id, display_name, source) VALUES (?, ?, ?, ?)",
    ).run(id, USER_ID, `Name ${id}`, source);
  }

  function linksOf(contactId: string): Array<{
    source_type: string;
    source_record_id: string;
    match_method: string;
  }> {
    return db
      .prepare(
        `SELECT source_type, source_record_id, match_method
           FROM contact_source_links WHERE contact_id = ? ORDER BY source_type`,
      )
      .all(contactId) as Array<{
      source_type: string;
      source_record_id: string;
      match_method: string;
    }>;
  }

  // =========================================================================
  describe("the vocabulary map", () => {
    /**
     * The map's keys must cover the whole `contacts.source` CHECK, or a contact
     * with a legitimate source silently gets no origin row. Asserted against the
     * shared enumeration rather than a list written here, so it cannot drift.
     */
    it("maps every persisted contacts.source value to a link source_type", () => {
      const unmapped = PERSISTED_CONTACT_SOURCES.filter((s) => originSourceTypeFor(s) === null);
      expect(unmapped).toEqual([]);
    });

    it("folds contacts_app onto the crosswalk's existing macos spelling", () => {
      // A second spelling for one address book is how a filter comes to miss
      // half its rows, so this is pinned rather than left to convention.
      expect(originSourceTypeFor("contacts_app")).toBe("macos");
      expect(originSourceTypeFor("macos")).toBe("macos");
    });

    it("returns null for an unknown source rather than guessing 'manual'", () => {
      // A wrong provenance row is worse than a missing one: nothing will ever
      // correct it, and this is the table meant to be authoritative.
      expect(originSourceTypeFor("whatsapp")).toBeNull();
      expect(originSourceTypeFor("")).toBeNull();
      expect(originSourceTypeFor(null)).toBeNull();
      expect(originSourceTypeFor(undefined)).toBeNull();
    });

    it("does not admit 'messages' — it is a SELECT-time label, never a column value", () => {
      expect(ORIGIN_SOURCE_TYPE_BY_CONTACT_SOURCE["messages"]).toBeUndefined();
    });
  });

  // =========================================================================
  describe("recording an origin", () => {
    it("gives a hand-typed contact a manual origin row", () => {
      addContact("c-typed", "manual");
      expect(recordContactOrigin(USER_ID, "c-typed", "manual")).toBe(true);

      expect(linksOf("c-typed")).toEqual([
        {
          source_type: "manual",
          source_record_id: "origin:c-typed",
          match_method: "origin",
        },
      ]);
    });

    it("gives a message-derived contact an origin row naming the thread source", () => {
      addContact("c-sms", "sms");
      addContact("c-mail", "email");
      recordContactOrigin(USER_ID, "c-sms", "sms");
      recordContactOrigin(USER_ID, "c-mail", "email");

      expect(linksOf("c-sms")[0].source_type).toBe("sms");
      expect(linksOf("c-mail")[0].source_type).toBe("email");
    });

    /**
     * THE UNIQUE IS WHY THE RECORD ID IS KEYED ON THE CONTACT.
     * A constant sentinel would let the FIRST manual contact take the row and
     * every one after it collide — leaving exactly the population this work
     * exists to serve without an origin, and silently, because
     * `INSERT OR IGNORE` reports no error.
     */
    it("gives each of many manual contacts its own row", () => {
      for (const id of ["c-a", "c-b", "c-c"]) {
        addContact(id, "manual");
        expect(recordContactOrigin(USER_ID, id, "manual")).toBe(true);
      }

      expect(
        (db
          .prepare(
            "SELECT contact_id, source_record_id FROM contact_source_links ORDER BY contact_id",
          )
          .all() as Array<{ contact_id: string; source_record_id: string }>)
          .map((r) => `${r.contact_id}=${r.source_record_id}`),
      ).toEqual(["c-a=origin:c-a", "c-b=origin:c-b", "c-c=origin:c-c"]);
    });

    it("is idempotent — a retried create does not collide or duplicate", () => {
      addContact("c-retry", "manual");
      expect(recordContactOrigin(USER_ID, "c-retry", "manual")).toBe(true);
      expect(recordContactOrigin(USER_ID, "c-retry", "manual")).toBe(false);
      expect(linksOf("c-retry")).toHaveLength(1);
    });

    it("writes nothing for an unrecognised source, and does not throw", () => {
      addContact("c-odd", "manual");
      expect(recordContactOrigin(USER_ID, "c-odd", "whatsapp")).toBe(false);
      expect(linksOf("c-odd")).toEqual([]);
    });

    /**
     * A contact the user just typed in has already been saved by the time this
     * runs. Failing the IPC call because a bookkeeping row could not be written
     * would lose their work to fix a lesser problem.
     */
    it("never throws when the crosswalk table is missing entirely", () => {
      db.exec("DROP TABLE contact_source_links;");
      expect(() => recordContactOrigin(USER_ID, "c-typed", "manual")).not.toThrow();
      expect(recordContactOrigin(USER_ID, "c-typed", "manual")).toBe(false);
    });

    it("refuses to write without a user or a contact id", () => {
      expect(recordContactOrigin("", "c-typed", "manual")).toBe(false);
      expect(recordContactOrigin(USER_ID, "", "manual")).toBe(false);
    });

    it("builds the record id from the contact id", () => {
      expect(originRecordId("abc-123")).toBe("origin:abc-123");
    });
  });

  // =========================================================================
  // THE PROPERTY THAT PROTECTS ADDRESS RESOLUTION
  // =========================================================================
  describe("an origin row and the content fallback", () => {
    /**
     * Sets up the situation the gate governs: a contact whose stored email also
     * appears in an address-book record it has NO record-backed link to. The
     * content fallback is the only thing that can connect them.
     */
    function seedContentMatchable(contactId: string): void {
      addContact(contactId, "manual");
      db.prepare(
        "INSERT INTO contact_emails (id, contact_id, email, source) VALUES (?, ?, ?, 'manual')",
      ).run(`ce-${contactId}`, contactId, "shared@example.com");
      db.prepare(
        `INSERT INTO external_contacts
           (id, user_id, name, phones_json, phones_normalized_json, emails_json,
            external_record_id, source, synced_at)
         VALUES (?, ?, 'Shared Person', '[]', '[]', '["shared@example.com"]',
                 'MAC-SHARED', 'macos', '2026-08-04 00:00:00')`,
      ).run(`ec-${contactId}`, USER_ID);
    }

    /**
     * The PHONE twin of the fixture above: the contact and the address-book
     * record share a NUMBER and no email at all, so only the priority-3 branch
     * can connect them.
     *
     * The record spells the number differently from the stored E.164 form, so
     * the normalized-key match is what is exercised rather than string equality.
     */
    function seedPhoneMatchable(contactId: string): void {
      addContact(contactId, "manual");
      db.prepare(
        `INSERT INTO contact_phones (id, contact_id, phone_e164, phone_normalized, source)
         VALUES (?, ?, '+14085550101', '4085550101', 'manual')`,
      ).run(`cp-${contactId}`, contactId);
      db.prepare(
        `INSERT INTO external_contacts
           (id, user_id, name, phones_json, phones_normalized_json, emails_json,
            external_record_id, source, synced_at)
         VALUES (?, ?, 'Phone Person', '["(408) 555-0101"]', '["4085550101"]', '[]',
                 'MAC-PHONE', 'macos', '2026-08-04 00:00:00')`,
      ).run(`ecp-${contactId}`, USER_ID);
    }

    function resolvedRecords(contactId: string): string[] {
      return (
        db.prepare(CONTACT_SOURCE_RECORDS_SQL).all({
          userId: USER_ID,
          contactId,
        }) as Array<{ external_record_id: string; matched_by: string }>
      ).map((r) => `${r.matched_by}:${r.external_record_id}`);
    }

    it("resolves by email when the contact has no links at all (the baseline)", () => {
      seedContentMatchable("c-base");
      expect(resolvedRecords("c-base")).toEqual(["email:MAC-SHARED"]);
    });

    /**
     * THE REGRESSION THIS FILE EXISTS TO PREVENT. Identical to the baseline
     * except the contact now carries its origin row. If the gate counted it,
     * this returns [] — and in production that means a contact quietly stops
     * inheriting addresses it used to inherit.
     */
    it("STILL resolves by email once the contact carries an origin row", () => {
      seedContentMatchable("c-origin");
      recordContactOrigin(USER_ID, "c-origin", "manual");

      expect(linksOf("c-origin")).toHaveLength(1);
      expect(resolvedRecords("c-origin")).toEqual(["email:MAC-SHARED"]);
    });

    it("resolves by phone when the contact has no links at all (the baseline)", () => {
      seedPhoneMatchable("c-phone-base");
      expect(resolvedRecords("c-phone-base")).toEqual(["phone:MAC-PHONE"]);
    });

    /**
     * THE PHONE TWIN — added at SR request on #2198, and it was needed.
     *
     * The gate is TWO branches, priority-2 (email) and priority-3 (phone), and
     * only the email one was defended. SR reverted the PHONE gate alone and ran
     * the entire suite:
     *
     *     Test Suites: 73 failed, 588 passed, 661 total
     *     Tests:       19 failed, 8 skipped, 11452 passed, 11479 total
     *     New failures vs branch baseline: NONE
     *
     * All 11,479 tests stayed green with phone-based address resolution broken
     * for every contact carrying an origin row — i.e. every contact. A later
     * "simplification" of that one line would have shipped silently. Nothing
     * about the email test generalises to this one; they are separate SQL
     * branches and each needs its own witness.
     */
    it("STILL resolves by phone once the contact carries an origin row", () => {
      seedPhoneMatchable("c-phone-origin");
      recordContactOrigin(USER_ID, "c-phone-origin", "manual");

      expect(linksOf("c-phone-origin")).toHaveLength(1);
      expect(resolvedRecords("c-phone-origin")).toEqual(["phone:MAC-PHONE"]);
    });

    /**
     * The other direction: a RECORD-BACKED link must still switch the fallback
     * off. Without this, the gate change could have been "delete the gate", and
     * a contact explicitly linked to one card would start content-matching every
     * other record that shares an address — which is the behaviour the crosswalk
     * was built to end.
     */
    it("stops resolving by content once a REAL record-backed link exists", () => {
      seedContentMatchable("c-linked");
      recordContactOrigin(USER_ID, "c-linked", "manual");
      db.prepare(
        `INSERT INTO contact_source_links
           (id, user_id, contact_id, source_type, source_record_id, match_method)
         VALUES ('l-real', ?, 'c-linked', 'macos', 'MAC-OTHER', 'source_id')`,
      ).run(USER_ID);
      db.prepare(
        `INSERT INTO external_contacts
           (id, user_id, name, phones_json, phones_normalized_json, emails_json,
            external_record_id, source, synced_at)
         VALUES ('ec-other', ?, 'Other Card', '[]', '[]', '["other@example.com"]',
                 'MAC-OTHER', 'macos', '2026-08-04 00:00:00')`,
      ).run(USER_ID);

      // Only the claimed record, by source_id. The email fallback is off, so
      // MAC-SHARED is NOT returned even though it still matches on content.
      expect(resolvedRecords("c-linked")).toEqual(["source_id:MAC-OTHER"]);
    });

    /**
     * An origin row must never resolve to a source record itself. Its
     * `source_record_id` is synthetic and matches nothing in `external_contacts`
     * — asserted rather than assumed, because a JOIN that accidentally matched
     * would put a phantom record into the provenance panel.
     */
    it("never resolves the origin row itself to a source record", () => {
      addContact("c-alone", "manual");
      recordContactOrigin(USER_ID, "c-alone", "manual");
      expect(resolvedRecords("c-alone")).toEqual([]);
    });
  });
});
