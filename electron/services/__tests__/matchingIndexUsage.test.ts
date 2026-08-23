/**
 * @jest-environment node
 *
 * BACKLOG-2621 — the contact-matching lookups must be served BY AN INDEX, and
 * must return exactly what they returned before.
 *
 * ===========================================================================
 * WHY THE CONTROL IS A QUERY PLAN AND NOT A STOPWATCH
 * ===========================================================================
 * A timing measurement on a fixture cannot distinguish an indexed lookup from
 * a scan — at a few hundred rows both are sub-millisecond and the numbers are
 * noise. `EXPLAIN QUERY PLAN` states which access path SQLite chose, which is
 * the property being changed. Each assertion below therefore names the index.
 *
 * The corresponding negative controls are asserted too: the OLD form of each
 * predicate is run against the SAME database, WITH the new indexes present,
 * and asserted NOT to use them. Without that half, "the new form uses the
 * index" would be compatible with the old form having used it all along.
 *
 * ===========================================================================
 * WHAT THE MEASUREMENT ACTUALLY SHOWED — the item's premise, corrected
 * ===========================================================================
 * BACKLOG-2621 predicted the old predicates degrade to a table SCAN. They do
 * not, and the plans below record what they do instead: SQLite anchors
 * `contacts` as the outer loop on `c.user_id = ?` and performs ONE index seek
 * into the child table PER CONTACT, applying the function-wrapped predicate as
 * a filter. No SCAN appears — but the value indexes are never used either, and
 * the cost is O(contacts owned by the user) per call rather than O(values
 * probed). That is the same quadratic shape, reached by a different route, and
 * it is why the fix needed the unary-`+` change as well as an indexable
 * predicate: rewriting the predicate ALONE leaves the plan untouched.
 *
 * The schema comes from the REAL `electron/database/schema.sql` plus the
 * `idx_contact_phones_normalized` statement migration v40 runs, so these plans
 * are the plans production gets, not the plans a hand-written fixture gets.
 */

import path from "path";
import fs from "fs";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

import { legacyDigitKey, toLookupKey } from "../../utils/phoneNormalization";
import * as dbConnection from "../db/core/dbConnection";
import { setDb } from "../db/core/dbConnection";
import { resolveSourceRecord } from "../contactSourceLinker";
import {
  createContact,
  syncContactPhones,
  getContactPhoneEntries,
  findContactByNormalizedPhone,
} from "../db/contactDbService";
import {
  CONTACT_SOURCE_LINKS_TABLE_SQL,
  CONTACT_SOURCE_LINKS_INDEX_SQL,
} from "../db/contactIdentitySchemaSql";

const SCHEMA_SQL = fs.readFileSync(
  path.join(__dirname, "..", "..", "database", "schema.sql"),
  "utf8",
);

/** Migration v40, verbatim from databaseService.ts. */
const V40_INDEX_SQL =
  "CREATE INDEX IF NOT EXISTS idx_contact_phones_normalized ON contact_phones(phone_normalized)";

/**
 * The expression index this change adds. Named here so the "before" database
 * can be built WITHOUT it — the pre-2621 state — rather than pretending a
 * database that has the index is the before state. It is not: with the index
 * present the planner sometimes reaches it from the old query too, which is a
 * fact worth recording (see the plan tests) but is not what shipped.
 */
const NEW_EMAIL_INDEX = "idx_contact_emails_email_lower";

const USER_ID = "user-2621";

function makeDb(opts: { pre2621?: boolean } = {}): DatabaseType {
  const db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  db.exec(V40_INDEX_SQL);
  // contact_source_links is created from a constant by migration, not by
  // schema.sql; creating a contact writes its origin row in the same
  // transaction, so a database without it is one the app could never run on.
  db.exec(CONTACT_SOURCE_LINKS_TABLE_SQL);
  db.exec(CONTACT_SOURCE_LINKS_INDEX_SQL);
  if (opts.pre2621) db.exec(`DROP INDEX IF EXISTS ${NEW_EMAIL_INDEX}`);
  db.pragma("foreign_keys = ON");
  db.prepare(
    `INSERT INTO users_local (id, email, oauth_provider, oauth_id)
     VALUES (?, ?, 'google', 'oauth-2621')`,
  ).run(USER_ID, "owner@example.com");
  return db;
}

function plan(db: DatabaseType, sql: string, params: unknown[]): string[] {
  return (db.prepare("EXPLAIN QUERY PLAN " + sql).all(...params) as Array<{ detail: string }>).map(
    (r) => r.detail,
  );
}

// ---------------------------------------------------------------------------
// The two forms of each predicate. `OLD_*` are transcribed from the pre-2621
// source; `NEW_*` are transcribed from the current source. Both are run against
// the same database so the comparison is of the SQL, nothing else.
// ---------------------------------------------------------------------------
const ph3 = "?, ?, ?";

const OLD_EMAIL = `SELECT DISTINCT c.id FROM contacts c
   JOIN contact_emails ce ON ce.contact_id = c.id
  WHERE c.user_id = ? AND LOWER(ce.email) IN (${ph3})
  ORDER BY c.id`;
/**
 * ===========================================================================
 * THE "NEW" QUERIES ARE NOT WRITTEN HERE — THEY ARE CAPTURED FROM PRODUCTION
 * ===========================================================================
 * The first version of this file transcribed the new SQL into a constant, the
 * way `OLD_*` below transcribes the old. Then the control was run — the unary
 * `+` was deleted from `contactSourceLinker.ts` — AND EVERY TEST STILL PASSED.
 * Of course it did: the tests were reading a copy. A plan assertion against a
 * string literal proves something about the literal and nothing about the
 * shipped query.
 *
 * So the new SQL is now taken from the production modules at runtime, by
 * recording what they hand to `dbAll`/`dbGet`. Delete the `+`, or put the
 * COALESCE back, and the captured text changes and the plan assertions go red.
 * Verified by doing exactly that.
 */
let PROD_EMAIL = "";
let PROD_PHONE = "";
let PROD_FIND = "";

/** Runs the real entry points once and records the SQL they execute. */
function captureProductionSql(db: DatabaseType): void {
  const seen: string[] = [];
  const realAll = dbConnection.dbAll;
  const realGet = dbConnection.dbGet;
  const allSpy = jest
    .spyOn(dbConnection, "dbAll")
    .mockImplementation((sql: string, params?: unknown[]) => {
      seen.push(sql);
      return realAll(sql, params as unknown[]);
    });
  const getSpy = jest
    .spyOn(dbConnection, "dbGet")
    .mockImplementation((sql: string, params?: unknown[]) => {
      seen.push(sql);
      return realGet(sql, params as unknown[]);
    });

  try {
    setDb(db);
    // Three of each so the generated placeholder lists are three wide, matching
    // the probe arguments the plan tests use. Values that match nothing, so the
    // email arm returns empty and the phone arm is reached too.
    resolveSourceRecord(USER_ID, {
      sourceType: "macos",
      sourceRecordId: "rec-capture",
      emails: ["nobody-a@example.com", "nobody-b@example.com", "nobody-c@example.com"],
      phones: ["+14155550191", "+14155550192", "+14155550193"],
    });
    findContactByNormalizedPhone(USER_ID, toLookupKey("+14155550191"));
  } finally {
    allSpy.mockRestore();
    getSpy.mockRestore();
  }

  const emailQ = seen.filter((s) => s.includes("contact_emails ce"));
  const phoneQ = seen.filter((s) => s.includes("contact_phones cp") && s.includes("DISTINCT"));
  const findQ = seen.filter((s) => s.includes("contact_phones cp") && s.includes("LIMIT 1"));

  // If the production shape changes so much that nothing is captured, fail
  // loudly here rather than silently asserting on an empty string.
  if (emailQ.length !== 1 || phoneQ.length !== 1 || findQ.length !== 1) {
    throw new Error(
      `capture failed: email=${emailQ.length} phone=${phoneQ.length} find=${findQ.length}`,
    );
  }
  PROD_EMAIL = emailQ[0];
  PROD_PHONE = phoneQ[0];
  PROD_FIND = findQ[0];
}

const OLD_PHONE = `SELECT DISTINCT c.id FROM contacts c
   JOIN contact_phones cp ON cp.contact_id = c.id
  WHERE c.user_id = ?
    AND COALESCE(NULLIF(cp.phone_normalized, ''), cp.phone_e164) IN (${ph3})
  ORDER BY c.id`;

const OLD_FIND = `SELECT c.id, c.display_name
  FROM contacts c
  JOIN contact_phones cp ON c.id = cp.contact_id
  WHERE c.user_id = ?
    AND SUBSTR(REPLACE(REPLACE(REPLACE(REPLACE(cp.phone_e164, '+', ''), '-', ''), ' ', ''), '(', ''), -10) = ?
  LIMIT 1`;

describe("BACKLOG-2621 matching lookups use their indexes", () => {
  let db: DatabaseType;

  beforeAll(() => {
    const capture = makeDb();
    captureProductionSql(capture);
    capture.close();
    setDb(undefined as unknown as DatabaseType);
  });

  beforeEach(() => {
    db = makeDb();
    setDb(db);
  });

  afterEach(() => {
    db.close();
    setDb(undefined as unknown as DatabaseType);
  });

  it("captured the three production queries, and they are the ones under test", () => {
    // Reading the captured text is the only place this file looks at the SQL as
    // a string. It exists so a capture that silently grabbed the wrong
    // statement cannot masquerade as a passing plan assertion.
    expect(PROD_EMAIL).toContain("contact_emails ce");
    expect(PROD_EMAIL).toContain("LOWER(ce.email) IN");
    expect(PROD_PHONE).toContain("cp.phone_normalized IN");
    expect(PROD_PHONE).not.toContain("COALESCE");
    expect(PROD_FIND).toContain("cp.phone_normalized = ?");
    expect(PROD_FIND).not.toContain("REPLACE");
    for (const sql of [PROD_EMAIL, PROD_PHONE, PROD_FIND]) {
      expect(sql).toMatch(/\+\s*c\.user_id\s*=\s*\?/);
    }
  });

  // =========================================================================
  // CONTROL 1 — the query plan, before and after, on each of the three sites.
  // =========================================================================
  describe("query plans", () => {
    /**
     * Enough contacts that the planner's choice is not an artefact of an empty
     * table, and both statistics states are covered: the maintenance path
     * (`maintenanceDbService`) runs ANALYZE, so a production database may or
     * may not have `sqlite_stat1` populated, and a plan that only holds in one
     * of those states is not a plan we can rely on.
     */
    function seedInto(db: DatabaseType, analyze: boolean, n: number): void {
      const insC = db.prepare(
        "INSERT INTO contacts (id, user_id, display_name, is_imported) VALUES (?, ?, ?, 1)",
      );
      const insE = db.prepare(
        "INSERT INTO contact_emails (id, contact_id, email, is_primary, source) VALUES (?, ?, ?, 0, 'import')",
      );
      const insP = db.prepare(
        "INSERT INTO contact_phones (id, contact_id, phone_e164, phone_normalized, is_primary, source) VALUES (?, ?, ?, ?, 0, 'import')",
      );
      db.transaction(() => {
        for (let i = 0; i < n; i++) {
          const id = "c" + i;
          insC.run(id, USER_ID, "Person " + i);
          insE.run("e" + i, id, `person${i}@example.com`);
          const d = String(5555550100 + i);
          insP.run("p" + i, id, "+1" + d, d);
        }
      })();
      if (analyze) db.exec("ANALYZE");
    }

    /** Any index that answers "which rows hold this value". */
    const VALUE_INDEXES = [
      NEW_EMAIL_INDEX,
      "idx_contact_emails_email",
      "idx_contact_phones_normalized",
      "idx_contact_phones_phone",
    ];

    function expectNoValueIndex(planLines: string[]): void {
      const text = planLines.join("\n");
      for (const idx of VALUE_INDEXES) expect(text).not.toContain(idx);
    }

    const EMAIL_ARGS = [USER_ID, "a@example.com", "b@example.com", "c@example.com"];
    const PHONE_ARGS = [USER_ID, "5555550100", "5555550101", "5555550102"];
    const FIND_ARGS = [USER_ID, "5555550100"];

    // Two statistics states x two corpus sizes. The planner's choice of OUTER
    // table moves between SCAN and SEARCH across these — recorded below rather
    // than pinned, because it is not the property under change. What is pinned
    // is the invariant that holds in all four: before, the join is driven from
    // `contacts` and no value index is touched; after, it is driven by the
    // value index and `contacts` is reached by primary key.
    for (const analyze of [false, true]) {
      for (const n of [500, 2000]) {
        describe(`ANALYZE=${analyze}, ${n} contacts`, () => {
          let before: DatabaseType;

          beforeEach(() => {
            before = makeDb({ pre2621: true });
            seedInto(before, analyze, n);
            seedInto(db, analyze, n);
          });

          afterEach(() => before.close());

          it("email: the pre-2621 query on the pre-2621 schema reaches no value index; the new one is driven by one", () => {
            const b = plan(before, OLD_EMAIL, EMAIL_ARGS);
            expectNoValueIndex(b);
            expect(b[0]).toMatch(/^(SCAN|SEARCH) c\b/);

            const a = plan(db, PROD_EMAIL, EMAIL_ARGS);
            expect(a[0]).toBe(`SEARCH ce USING INDEX ${NEW_EMAIL_INDEX} (<expr>=?)`);
            expect(a[1]).toBe("SEARCH c USING INDEX sqlite_autoindex_contacts_1 (id=?)");
          });

          it("phone: the pre-2621 query reaches no value index; the new one is driven by one", () => {
            const b = plan(before, OLD_PHONE, PHONE_ARGS);
            expectNoValueIndex(b);
            expect(b[0]).toMatch(/^(SCAN|SEARCH) c\b/);

            const a = plan(db, PROD_PHONE, PHONE_ARGS);
            expect(a[0]).toBe(
              "SEARCH cp USING INDEX idx_contact_phones_normalized (phone_normalized=?)",
            );
            expect(a[1]).toBe("SEARCH c USING INDEX sqlite_autoindex_contacts_1 (id=?)");
          });

          it("findContactByNormalizedPhone: the pre-2621 query reaches no value index; the new one is driven by one", () => {
            const b = plan(before, OLD_FIND, FIND_ARGS);
            expectNoValueIndex(b);
            expect(b[0]).toMatch(/^(SCAN|SEARCH) c\b/);

            const a = plan(db, PROD_FIND, FIND_ARGS);
            expect(a[0]).toBe(
              "SEARCH cp USING INDEX idx_contact_phones_normalized (phone_normalized=?)",
            );
            expect(a[1]).toBe("SEARCH c USING INDEX sqlite_autoindex_contacts_1 (id=?)");
          });
        });
      }
    }

    it("an indexable predicate alone does NOT reliably reach the index — the anchoring term is what decides", () => {
      // The finding that shaped this fix, kept as a test so it cannot be
      // quietly lost. With an indexable predicate but a plain `c.user_id = ?`,
      // whether SQLite reaches idx_contact_phones_normalized depends on the
      // data distribution: it does in some shapes and not in others. A plan
      // that holds only for some corpora is not a fix — the founder's database
      // is one specific corpus and it is not this one. The unary `+` removes
      // the choice, which is why the four configurations above can assert an
      // exact plan and this one can only assert instability.
      //
      // If SQLite ever becomes uniformly right here, this test goes red and
      // the `+` can be reconsidered. That is the intended signal.
      const indexablePredicateOnly = `SELECT DISTINCT c.id FROM contacts c
         JOIN contact_phones cp ON cp.contact_id = c.id
        WHERE c.user_id = ?
          AND cp.phone_normalized IN (?, ?, ?)
        ORDER BY c.id`;

      const reached: boolean[] = [];
      for (const analyze of [false, true]) {
        for (const n of [500, 2000]) {
          const probe = makeDb();
          seedInto(probe, analyze, n);
          reached.push(
            plan(probe, indexablePredicateOnly, PHONE_ARGS)
              .join("\n")
              .includes("idx_contact_phones_normalized"),
          );
          probe.close();
        }
      }
      expect(reached).toContain(false);

      // Whereas the shipped form reaches it in every one of those shapes —
      // asserted exactly by the four describe blocks above.
    });
  });

  // =========================================================================
  // CONTROL 2 — the id SET is identical. Not the count: the set.
  // =========================================================================
  describe("behaviour is unchanged (exact id sets)", () => {
    /**
     * The corpus BACKLOG-2621 asks for. Rows that the write paths can actually
     * produce, plus the one row shape the COALESCE fallback existed for.
     */
    function seedCorpus(): void {
      const insC = db.prepare(
        "INSERT INTO contacts (id, user_id, display_name, is_imported) VALUES (?, ?, ?, 1)",
      );
      const insE = db.prepare(
        "INSERT INTO contact_emails (id, contact_id, email, is_primary, source) VALUES (?, ?, ?, 0, 'import')",
      );
      const insP = db.prepare(
        "INSERT INTO contact_phones (id, contact_id, phone_e164, phone_normalized, is_primary, source) VALUES (?, ?, ?, ?, 0, 'import')",
      );

      // Two contacts whose addresses differ ONLY by case.
      insC.run("k-upper", USER_ID, "Upper");
      insE.run("ke1", "k-upper", "Dana.Reyes@Example.com");
      insC.run("k-lower", USER_ID, "Lower");
      insE.run("ke2", "k-lower", "dana.reyes@example.com");

      // Mixed case with surrounding whitespace variants.
      insC.run("k-mixed", USER_ID, "Mixed");
      insE.run("ke3", "k-mixed", "MORGAN@EXAMPLE.COM");

      // Another user's contact carrying the same address — must never leak.
      db.prepare(
        `INSERT INTO users_local (id, email, oauth_provider, oauth_id)
         VALUES ('other-user', 'other@example.com', 'google', 'oauth-other')`,
      ).run();
      insC.run("k-other-user", "other-user", "Someone Else");
      insE.run("ke4", "k-other-user", "dana.reyes@example.com");
      insP.run("kp4", "k-other-user", "+14155550142", toLookupKey("+14155550142"));

      // Phones in several shapes.
      insC.run("k-e164", USER_ID, "E164");
      insP.run("kp1", "k-e164", "+14155550133", toLookupKey("+14155550133"));

      insC.run("k-intl", USER_ID, "Intl");
      insP.run("kp2", "k-intl", "+442079460958", toLookupKey("+442079460958"));

      // Hand-typed shape — what `syncContactPhones` stores verbatim.
      insC.run("k-typed", USER_ID, "Typed");
      insP.run("kp3", "k-typed", "(415) 555-0144", toLookupKey("(415) 555-0144"));

      // The row the COALESCE fallback was written for: NULL phone_normalized.
      insC.run("k-null", USER_ID, "NullNormalized");
      insP.run("kp5", "k-null", "+14155550155", null);
    }

    beforeEach(seedCorpus);

    function ids(sql: string, params: unknown[]): string[] {
      return (db.prepare(sql).all(...params) as Array<{ id: string }>).map((r) => r.id);
    }

    it("email: identical id set for mixed case, case-only duplicates, and misses", () => {
      const cases: string[][] = [
        ["dana.reyes@example.com", "morgan@example.com", "nobody@example.com"],
        ["MORGAN@EXAMPLE.COM".toLowerCase(), "x@example.com", "y@example.com"],
        ["nobody@example.com", "still@example.com", "none@example.com"],
      ];
      for (const probe of cases) {
        const args = [USER_ID, ...probe];
        expect(ids(PROD_EMAIL, args)).toEqual(ids(OLD_EMAIL, args));
      }
      // And the set is the expected one, named explicitly — a shared empty
      // result would satisfy "identical" without proving anything.
      expect(ids(PROD_EMAIL, [USER_ID, "dana.reyes@example.com", "z@example.com", "q@example.com"])).toEqual([
        "k-lower",
        "k-upper",
      ]);
      expect(ids(PROD_EMAIL, [USER_ID, "morgan@example.com", "z@example.com", "q@example.com"])).toEqual([
        "k-mixed",
      ]);
    });

    it("phone: identical id set across E.164, international, hand-typed and NULL-normalized rows", () => {
      const cases: string[][] = [
        [toLookupKey("+14155550133"), toLookupKey("+442079460958"), toLookupKey("(415) 555-0144")],
        // The NULL-phone_normalized row: the dropped COALESCE arm compared
        // `phone_e164` ("+14155550155") against a lookup key, which can never be
        // equal — so the OLD form did not find it either.
        [toLookupKey("+14155550155"), "0000000000", "1111111111"],
        ["9999999999", "8888888888", "7777777777"],
      ];
      for (const probe of cases) {
        const args = [USER_ID, ...probe];
        expect(ids(PROD_PHONE, args)).toEqual(ids(OLD_PHONE, args));
      }
      expect(
        ids(PROD_PHONE, [
          USER_ID,
          toLookupKey("+14155550133"),
          toLookupKey("+442079460958"),
          toLookupKey("(415) 555-0144"),
        ]),
      ).toEqual(["k-e164", "k-intl", "k-typed"]);
      // The NULL row is found by NEITHER form. Stated rather than implied.
      expect(ids(OLD_PHONE, [USER_ID, toLookupKey("+14155550155"), "0", "1"])).toEqual([]);
      expect(ids(PROD_PHONE, [USER_ID, toLookupKey("+14155550155"), "0", "1"])).toEqual([]);
    });

    it("phone: the dropped COALESCE arm could not have matched any writable row", () => {
      // The arm fires only when phone_normalized is NULL/'' — and then compares
      // phone_e164 to a lookup key. For it to have mattered, a row would need a
      // bare ten-digit phone_e164 AND no phone_normalized. Constructed here by
      // hand because no write path produces it; recorded so the claim is
      // testable rather than asserted in a comment.
      //
      // DELIBERATE 555-555 FALLBACK FIXTURE (BACKLOG-2630). Area code 555 is not
      // assignable, so libphonenumber rejects it and `toLookupKey` routes it
      // through `legacyDigitKey`. That is exactly what this row wants: a bare
      // ten-digit string compared as a raw value, with no country code added.
      db.prepare(
        "INSERT INTO contacts (id, user_id, display_name, is_imported) VALUES ('k-bare', ?, 'Bare', 1)",
      ).run(USER_ID);
      db.prepare(
        "INSERT INTO contact_phones (id, contact_id, phone_e164, phone_normalized, is_primary, source) VALUES ('kp6', 'k-bare', '5555550166', NULL, 0, 'import')",
      ).run();

      expect(ids(OLD_PHONE, [USER_ID, "5555550166", "0", "1"])).toEqual(["k-bare"]);
      expect(ids(PROD_PHONE, [USER_ID, "5555550166", "0", "1"])).toEqual([]);
    });

    it("user scoping survives the unary-plus rewrite", () => {
      // `+c.user_id` removes the term from index consideration; it must not
      // remove it from the WHERE clause.
      expect(ids(PROD_EMAIL, [USER_ID, "dana.reyes@example.com", "z@example.com", "q@example.com"])).not.toContain(
        "k-other-user",
      );
      expect(ids(PROD_PHONE, [USER_ID, toLookupKey("+14155550142"), "0", "1"])).toEqual([]);
      expect(ids(PROD_PHONE, ["other-user", toLookupKey("+14155550142"), "0", "1"])).toEqual([
        "k-other-user",
      ]);
    });

    it("unary-plus drops column affinity — a numeric-looking user id still matches", () => {
      // The one semantic side effect of `+`: the comparison loses TEXT affinity.
      // Every caller passes a string, and this pins that a string of digits —
      // the shape most likely to expose an affinity bug — still resolves.
      //
      // DELIBERATE 555-555 FALLBACK FIXTURE (BACKLOG-2630): this test is about
      // the USER ID's affinity, not about the phone rule, so the fallback path
      // keeps the key a plain ten-digit string and the assertion stays about
      // the thing it names.
      db.prepare(
        `INSERT INTO users_local (id, email, oauth_provider, oauth_id)
         VALUES ('12345', 'numeric@example.com', 'google', 'oauth-num')`,
      ).run();
      db.prepare(
        "INSERT INTO contacts (id, user_id, display_name, is_imported) VALUES ('k-num', '12345', 'Numeric', 1)",
      ).run();
      db.prepare(
        "INSERT INTO contact_phones (id, contact_id, phone_e164, phone_normalized, is_primary, source) VALUES ('kp7', 'k-num', '+15555550177', '5555550177', 0, 'import')",
      ).run();

      expect(ids(PROD_PHONE, ["12345", "5555550177", "0", "1"])).toEqual(["k-num"]);
      expect(ids(OLD_PHONE, ["12345", "5555550177", "0", "1"])).toEqual(["k-num"]);
    });
  });

  // =========================================================================
  // CONTROL 3 — findContactByNormalizedPhone, corpus built by the REAL writers.
  // =========================================================================
  describe("findContactByNormalizedPhone against rows the write paths produce", () => {
    it("imported (toE164) rows resolve identically under both forms", async () => {
      await createContact(
        {
          user_id: USER_ID,
          display_name: "Imported Ivy",
          phone: "+1 (415) 555-0188",
          is_imported: true,
        } as Parameters<typeof createContact>[0],
        { kind: "derived" },
      );
      const row = db
        .prepare("SELECT phone_e164, phone_normalized FROM contact_phones LIMIT 1")
        .get() as { phone_e164: string; phone_normalized: string };
      // Transcribed, not invented: createContact stores E.164.
      expect(row.phone_e164).toBe("+14155550188");
      // BACKLOG-2630: derived from the live rule, and 415 rather than 555 so the
      // row is actually PARSED. With a 555 area code libphonenumber rejects the
      // number and the key falls back to the pre-2630 digits — which is how a
      // caller computing the OLD key stayed green here while being broken.
      expect(row.phone_normalized).toBe(toLookupKey("+14155550188"));
      expect(row.phone_normalized).toBe("14155550188");

      // TWO KEY SPACES, and naming them is the point (BACKLOG-2630).
      //
      // `OLD_FIND` is the deleted pre-2621 query: it re-derives its key from
      // `phone_e164` IN SQL as the last ten digits. The shipped query compares
      // the STORED `phone_normalized`, which now carries the country code. So
      // each form must be probed with the key IT computes — and the property
      // worth asserting is that both still resolve to the SAME contact.
      //
      // Probing both with one key is what made this suite blind: with a 555
      // corpus the two key spaces coincide (the library rejects 555, so the
      // stored key IS the last ten digits) and a caller computing the old key
      // looked correct. That is the exact blindness that hid the Android
      // promotion defect.
      const newKey = toLookupKey("+14155550188");
      const oldKey = legacyDigitKey("+14155550188");
      expect(newKey).not.toBe(oldKey);

      const oldHit = db.prepare(OLD_FIND).get(USER_ID, oldKey) as { id: string } | undefined;
      const newHit = findContactByNormalizedPhone(USER_ID, newKey);
      expect(newHit).not.toBeNull();
      expect(oldHit).toBeDefined();
      expect(newHit!.id).toBe(oldHit!.id);

      // And the cross-probe fails in BOTH directions — a caller that hands one
      // form the other form's key finds nothing. This is the shape of the
      // Android promotion defect, stated as an assertion.
      expect(findContactByNormalizedPhone(USER_ID, oldKey)).toBeNull();
      expect(db.prepare(OLD_FIND).get(USER_ID, newKey)).toBeUndefined();
    });

    it("INTENTIONAL DELTA: a hand-typed number the old SQL missed is now found", async () => {
      // `syncContactPhones` is the contact-edit path and stores the typed
      // string verbatim in phone_e164. The old SQL stripped only + - space (
      // and then took the last ten CHARACTERS, producing "15)5550199".
      await createContact(
        {
          user_id: USER_ID,
          display_name: "Typed Tara",
          phone: "+14155550198",
          is_imported: false,
        } as Parameters<typeof createContact>[0],
        { kind: "derived" },
      );
      const contact = db
        .prepare("SELECT id FROM contacts WHERE display_name = 'Typed Tara'")
        .get() as { id: string };
      const entries = getContactPhoneEntries(contact.id).map((e) => ({
        id: e.id,
        phone: "(415) 555-0199",
        is_primary: true,
      }));
      syncContactPhones(contact.id, entries);

      const row = db
        .prepare("SELECT phone_e164, phone_normalized FROM contact_phones WHERE contact_id = ?")
        .get(contact.id) as { phone_e164: string; phone_normalized: string };
      expect(row.phone_e164).toBe("(415) 555-0199");
      expect(row.phone_normalized).toBe(toLookupKey("(415) 555-0199"));
      expect(row.phone_normalized).toBe("14155550199");

      // What the OLD SQL reduced that row to — computed by SQLite, not by hand.
      const reduced = db
        .prepare(
          "SELECT SUBSTR(REPLACE(REPLACE(REPLACE(REPLACE(phone_e164,'+',''),'-',''),' ',''),'(',''), -10) AS k FROM contact_phones WHERE contact_id = ?",
        )
        .get(contact.id) as { k: string };
      expect(reduced.k).not.toBe(toLookupKey("(415) 555-0199"));

      const typedKey = toLookupKey("(415) 555-0199");
      expect(db.prepare(OLD_FIND).get(USER_ID, typedKey)).toBeUndefined();
      expect(findContactByNormalizedPhone(USER_ID, typedKey)?.id).toBe(contact.id);
    });

    it("still refuses short keys and still scopes by user", async () => {
      await createContact(
        {
          user_id: USER_ID,
          display_name: "Scoped Sam",
          phone: "+14155550197",
          is_imported: true,
        } as Parameters<typeof createContact>[0],
        { kind: "derived" },
      );
      expect(findContactByNormalizedPhone(USER_ID, "55501")).toBeNull();
      const scopedKey = toLookupKey("+14155550197");
      expect(findContactByNormalizedPhone("someone-else", scopedKey)).toBeNull();
      expect(findContactByNormalizedPhone(USER_ID, scopedKey)).not.toBeNull();
    });
  });
});
