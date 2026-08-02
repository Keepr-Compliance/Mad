/**
 * @jest-environment node
 *
 * BACKLOG-2407 — iOS contacts parser against a REAL AddressBook.sqlitedb.
 *
 * ---------------------------------------------------------------------------
 * THE GAP THIS FILE CLOSES
 * ---------------------------------------------------------------------------
 * `iosContactsParser.test.ts` mocks the database with hand-built rows shaped
 * `{ ROWID, First, Last, Organization }` (:13-16). That mock returns whatever it
 * is told to return regardless of what the parser's SQL asks for, so it cannot
 * observe a missing column, a `prepare()` failure, or a column name typo — the
 * three ways this parser can actually break. The task's own acceptance called
 * that out: "no test currently touches a real iOS schema, so a missing column
 * would go unnoticed".
 *
 * So this file drives the real driver against a real file with the real ABPerson
 * shape, through the real `open()`.
 *
 * ---------------------------------------------------------------------------
 * WHY THE MOCK-BYPASS IS SHAPED LIKE THIS
 * ---------------------------------------------------------------------------
 * `jest.config.js:37` maps `better-sqlite3-multiple-ciphers` to a stub for EVERY
 * test file. `migrationTestHarness.ts` escapes that by injecting a real driver
 * through `setDb`, which does NOT work here: `iOSContactsParser.open()`
 * constructs its own `Database` from a module-scope import, so there is no
 * injection seam and a harness-style test would run against the stub and assert
 * nothing. The idiom below — re-pointing the module itself — is the one the
 * sibling parser's suite uses for exactly this reason
 * (`iosMessagesParser.test.ts:28-40`). Depth is `../../../` from
 * `electron/services/__tests__/`.
 */

import { describe, it, expect, beforeAll, afterAll, jest } from "@jest/globals";

// Force Jest to use the real better-sqlite3-multiple-ciphers module.
// Must precede any import that depends on it.
const actualModulePath = require.resolve("better-sqlite3-multiple-ciphers", {
  paths: [require("path").join(__dirname, "../../../node_modules")],
});

jest.mock("better-sqlite3-multiple-ciphers", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(actualModulePath);
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(actualModulePath);

import fs from "fs";
import os from "os";
import path from "path";
import { iOSContactsParser, appleSecondsToIso } from "../iosContactsParser";

/**
 * The real ABPerson column shape.
 *
 * Deliberately includes the unrelated columns that sit BETWEEN the ones the
 * parser wants, and declares them in iOS's own order — so the identity columns
 * are NOT adjacent and NOT in the order the SELECT lists them. A parser that
 * read positionally, or that assumed a column offset, fails here and passes
 * against a tidied-up fixture.
 *
 * `ROWID INTEGER PRIMARY KEY AUTOINCREMENT` is declared EXPLICITLY and that is
 * not cosmetic: with an implicit rowid, `SELECT ROWID` comes back under the key
 * `rowid` (lower-case) and `row.ROWID` — which is what production reads
 * (iosContactsParser.ts) — would be `undefined`. A fixture that omitted this
 * declaration would silently test something the real database never does.
 *
 * `guid` carries no DEFAULT: the real schema defaults it to
 * `ab_generate_guid()`, a function only iOS registers.
 */
const ABPERSON_REAL_SCHEMA = `
  CREATE TABLE ABPerson (
    ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
    First TEXT,
    Last TEXT,
    Middle TEXT,
    FirstPhonetic TEXT,
    MiddlePhonetic TEXT,
    LastPhonetic TEXT,
    Organization TEXT,
    Department TEXT,
    Note TEXT,
    Kind INTEGER,
    Birthday TEXT,
    JobTitle TEXT,
    Nickname TEXT,
    Prefix TEXT,
    Suffix TEXT,
    FirstSort TEXT,
    LastSort TEXT,
    CreationDate INTEGER,
    ModificationDate INTEGER,
    CompositeNameFallback TEXT,
    ExternalIdentifier TEXT,
    ExternalModificationTag TEXT,
    ExternalUUID TEXT,
    StoreID INTEGER,
    DisplayName TEXT,
    ExternalRepresentation BLOB,
    FirstSortSection TEXT,
    LastSortSection TEXT,
    PersonLink INTEGER DEFAULT -1,
    ImageURI TEXT,
    IsPreferredName INTEGER DEFAULT 1,
    guid TEXT
  );
`;

/** ABPerson as it looks on an older backup: the four original columns only. */
const ABPERSON_LEGACY_SCHEMA = `
  CREATE TABLE ABPerson (
    ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
    First TEXT,
    Last TEXT,
    Organization TEXT
  );
`;

const ABMULTIVALUE_SCHEMA = `
  CREATE TABLE ABMultiValue (
    UID INTEGER PRIMARY KEY,
    record_id INTEGER,
    property INTEGER,
    identifier INTEGER,
    label INTEGER,
    value TEXT
  );
  CREATE TABLE ABMultiValueLabel (
    ROWID INTEGER PRIMARY KEY,
    value TEXT
  );
`;

const PROPERTY_PHONE = 3;
const PROPERTY_EMAIL = 4;

/** CF absolute time (seconds since 2001-01-01Z) for two known instants. */
const CF_2023_03_08 = 700000000; // -> 2023-03-08T20:26:40.000Z
const CF_2021_01_01 = 631152000; // -> 2021-01-01T00:00:00.000Z

interface PersonFixture {
  rowid: number;
  first: string | null;
  last: string | null;
  organization: string | null;
  externalUuid: string | null;
  externalIdentifier: string | null;
  externalModificationTag: string | null;
  creationDate: number | null;
  modificationDate: number | null;
  storeId: number | null;
  phone?: string;
  email?: string;
}

/**
 * The fixture population, chosen so every branch of the capture is exercised by
 * a contact that could really exist:
 *
 *  1 Ada     — an account-store contact: every identity column populated.
 *  2 Grace   — SAME store, populated, different values. Proves the ID SET is
 *              real and not one row echoed back.
 *  3 Local   — an "On My iPhone" contact in the LOCAL store: NULL ExternalUUID
 *              with dates present. This is the case the whole population-rate
 *              question is about, and it must not be confused with "column
 *              missing".
 *  4 OrgOnly — organization-only, no name, no ExternalUUID, no dates. Mirrors
 *              the Android structural-null case and the `nameless` population
 *              the import-everything change (BACKLOG-2392) admits.
 */
const PEOPLE: PersonFixture[] = [
  {
    rowid: 1,
    first: "Ada",
    last: "Lovelace",
    organization: null,
    externalUuid: "11111111-1111-4111-8111-111111111111",
    externalIdentifier: "ext-ada-001",
    externalModificationTag: "etag-ada-v3",
    creationDate: CF_2021_01_01,
    modificationDate: CF_2023_03_08,
    storeId: 2,
    phone: "(555) 111-2222",
    email: "ada@example.com",
  },
  {
    rowid: 2,
    first: "Grace",
    last: "Hopper",
    organization: "Navy",
    externalUuid: "22222222-2222-4222-8222-222222222222",
    externalIdentifier: "ext-grace-002",
    externalModificationTag: "etag-grace-v9",
    creationDate: CF_2021_01_01,
    modificationDate: CF_2021_01_01,
    storeId: 2,
    phone: "555-333-4444",
    email: "grace@example.com",
  },
  {
    rowid: 3,
    first: "Local",
    last: "Only",
    organization: null,
    externalUuid: null,
    externalIdentifier: null,
    externalModificationTag: null,
    creationDate: CF_2021_01_01,
    modificationDate: CF_2023_03_08,
    storeId: 1,
    phone: "555-555-6666",
  },
  {
    rowid: 4,
    first: null,
    last: null,
    organization: "Org Only LLC",
    externalUuid: null,
    externalIdentifier: null,
    externalModificationTag: null,
    creationDate: null,
    modificationDate: null,
    storeId: null,
    email: "info@orgonly.example",
  },
];

/**
 * Write a backup-shaped AddressBook database and return the BACKUP DIRECTORY.
 *
 * The file goes at `<backup>/31/31bb7ba8…` — the real two-character-prefix
 * layout iOS backups use — so `open()`'s own path construction is exercised
 * rather than bypassed.
 */
function writeAddressBook(
  dir: string,
  schema: string,
  people: PersonFixture[],
  opts: { withIdentityColumns: boolean }
): string {
  const hashDir = path.join(dir, iOSContactsParser.ADDRESSBOOK_DB_HASH.substring(0, 2));
  fs.mkdirSync(hashDir, { recursive: true });
  const dbPath = path.join(hashDir, iOSContactsParser.ADDRESSBOOK_DB_HASH);

  const db = new Database(dbPath);
  db.exec(schema);
  db.exec(ABMULTIVALUE_SCHEMA);

  db.prepare("INSERT INTO ABMultiValueLabel (ROWID, value) VALUES (1, '_$!<Mobile>!$_')").run();
  db.prepare("INSERT INTO ABMultiValueLabel (ROWID, value) VALUES (2, '_$!<Home>!$_')").run();

  const insertPerson = opts.withIdentityColumns
    ? db.prepare(
        `INSERT INTO ABPerson
           (ROWID, First, Last, Organization, ExternalUUID, ExternalIdentifier,
            ExternalModificationTag, CreationDate, ModificationDate, StoreID)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
    : db.prepare(
        `INSERT INTO ABPerson (ROWID, First, Last, Organization) VALUES (?, ?, ?, ?)`
      );

  const insertMv = db.prepare(
    "INSERT INTO ABMultiValue (record_id, property, identifier, label, value) VALUES (?, ?, ?, ?, ?)"
  );

  for (const p of people) {
    if (opts.withIdentityColumns) {
      insertPerson.run(
        p.rowid,
        p.first,
        p.last,
        p.organization,
        p.externalUuid,
        p.externalIdentifier,
        p.externalModificationTag,
        p.creationDate,
        p.modificationDate,
        p.storeId
      );
    } else {
      insertPerson.run(p.rowid, p.first, p.last, p.organization);
    }
    if (p.phone) insertMv.run(p.rowid, PROPERTY_PHONE, 0, 1, p.phone);
    if (p.email) insertMv.run(p.rowid, PROPERTY_EMAIL, 0, 2, p.email);
  }

  db.close();
  return dir;
}

describe("iOSContactsParser — real AddressBook schema (BACKLOG-2407)", () => {
  let tmpRoot: string;
  let modernBackup: string;
  let legacyBackup: string;

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-ab-2407-"));
    modernBackup = writeAddressBook(path.join(tmpRoot, "modern"), ABPERSON_REAL_SCHEMA, PEOPLE, {
      withIdentityColumns: true,
    });
    legacyBackup = writeAddressBook(path.join(tmpRoot, "legacy"), ABPERSON_LEGACY_SCHEMA, PEOPLE, {
      withIdentityColumns: false,
    });
  });

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // CAPTURE — asserted as exact ID SETS, never counts
  // -------------------------------------------------------------------------

  describe("captures the identity columns", () => {
    it("maps every contact id to its exact ExternalUUID — full set, not a count", () => {
      const parser = new iOSContactsParser();
      parser.open(modernBackup);
      try {
        const actual = new Map(
          parser.getAllContacts().map((c) => [c.id, c.externalUuid])
        );

        // The whole mapping, asserted as an exact set. A count would pass while
        // two contacts swapped identifiers — the precise failure that would make
        // this capture worse than useless.
        expect(actual).toEqual(
          new Map([
            [1, "11111111-1111-4111-8111-111111111111"],
            [2, "22222222-2222-4222-8222-222222222222"],
            [3, null],
            [4, null],
          ])
        );
      } finally {
        parser.close();
      }
    });

    it("captures ExternalIdentifier and ExternalModificationTag as exact sets", () => {
      const parser = new iOSContactsParser();
      parser.open(modernBackup);
      try {
        const contacts = parser.getAllContacts();

        expect(new Map(contacts.map((c) => [c.id, c.externalIdentifier]))).toEqual(
          new Map([
            [1, "ext-ada-001"],
            [2, "ext-grace-002"],
            [3, null],
            [4, null],
          ])
        );
        expect(
          new Map(contacts.map((c) => [c.id, c.externalModificationTag]))
        ).toEqual(
          new Map([
            [1, "etag-ada-v3"],
            [2, "etag-grace-v9"],
            [3, null],
            [4, null],
          ])
        );
      } finally {
        parser.close();
      }
    });

    it("converts ModificationDate/CreationDate from CF SECONDS, not nanoseconds", () => {
      const parser = new iOSContactsParser();
      parser.open(modernBackup);
      try {
        const byId = new Map(parser.getAllContacts().map((c) => [c.id, c]));

        // The trap this pins: the sibling parsers divide by 1e6 because sms.db
        // stores nanoseconds. Applying that here yields 2001-01-01 for every
        // contact — wrong by ~31 years and in a direction nothing would flag.
        expect(byId.get(1)!.modifiedAt).toBe("2023-03-08T20:26:40.000Z");
        expect(byId.get(1)!.createdAt).toBe("2021-01-01T00:00:00.000Z");
        expect(byId.get(2)!.modifiedAt).toBe("2021-01-01T00:00:00.000Z");

        // Absent dates stay null rather than becoming the epoch.
        expect(byId.get(4)!.modifiedAt).toBeNull();
        expect(byId.get(4)!.createdAt).toBeNull();
      } finally {
        parser.close();
      }
    });

    it("captures StoreID, which is what explains a sparse ExternalUUID", () => {
      const parser = new iOSContactsParser();
      parser.open(modernBackup);
      try {
        expect(new Map(parser.getAllContacts().map((c) => [c.id, c.storeId]))).toEqual(
          new Map([
            [1, 2],
            [2, 2],
            [3, 1], // the local "On My iPhone" store — no ExternalUUID
            [4, null],
          ])
        );
      } finally {
        parser.close();
      }
    });

    it("carries the identity through getContactById(), not only the bulk read", () => {
      const parser = new iOSContactsParser();
      parser.open(modernBackup);
      try {
        // Force the cache-miss path, which is served by the SECOND ABPerson
        // statement. Widening only the first would leave this one returning
        // undefined identifiers and nothing else in the suite would notice.
        parser.close();
        parser.open(modernBackup);
        (parser as unknown as { contactCache: Map<number, unknown> }).contactCache.clear();

        const contact = parser.getContactById(1);
        expect(contact).not.toBeNull();
        expect(contact!.externalUuid).toBe("11111111-1111-4111-8111-111111111111");
        expect(contact!.externalIdentifier).toBe("ext-ada-001");
        expect(contact!.modifiedAt).toBe("2023-03-08T20:26:40.000Z");
      } finally {
        parser.close();
      }
    });
  });

  // -------------------------------------------------------------------------
  // RE-IMPORT — the identifiers must be the same values, not merely present
  // -------------------------------------------------------------------------

  it("yields an identical identity set across a simulated re-import", () => {
    const read = (): Array<[number, string | null, string | null, string | null]> => {
      const parser = new iOSContactsParser();
      parser.open(modernBackup);
      try {
        return parser
          .getAllContacts()
          .map(
            (c) =>
              [c.id, c.externalUuid, c.externalIdentifier, c.modifiedAt] as [
                number,
                string | null,
                string | null,
                string | null,
              ]
          )
          .sort((a, b) => a[0] - b[0]);
      } finally {
        parser.close();
      }
    };

    const first = read();
    const second = read();

    // Exact equality of the whole set, both directions — a re-import must be
    // idempotent in the identifiers, which is the property that makes them
    // usable as a key later. Non-empty guard so a parser that returned nothing
    // could not pass this by trivial equality.
    expect(first.length).toBe(PEOPLE.length);
    expect(second).toEqual(first);
  });

  // -------------------------------------------------------------------------
  // THE SAFETY PROPERTY — an older backup must still import
  // -------------------------------------------------------------------------

  describe("an ABPerson without the identity columns", () => {
    it("does not throw on open() and still parses every contact", () => {
      // THE REGRESSION THIS EXISTS FOR. `db.prepare()` validates column names, so
      // a hardcoded widened SELECT throws inside open() — which rethrows — and
      // kills the ENTIRE iPhone contacts import. iPhone sync is the ungated
      // DEFAULT import source for every Windows user, so that is a total-failure
      // blast radius on the most common configuration.
      const parser = new iOSContactsParser();
      expect(() => parser.open(legacyBackup)).not.toThrow();

      try {
        expect(new Set(parser.getAllContacts().map((c) => c.id))).toEqual(
          new Set([1, 2, 3, 4])
        );
        // Names still parse — the legacy path is not merely "not crashing".
        expect(new Map(parser.getAllContacts().map((c) => [c.id, c.displayName]))).toEqual(
          new Map([
            [1, "Ada Lovelace"],
            [2, "Grace Hopper"],
            [3, "Local Only"],
            [4, "Org Only LLC"],
          ])
        );
      } finally {
        parser.close();
      }
    });

    it("reports the columns as MISSING, distinct from present-but-empty", () => {
      const parser = new iOSContactsParser();
      parser.open(legacyBackup);
      try {
        const stats = parser.getIdentityStats();

        // "The backup has no such column" and "every row's value is null" are
        // different findings. Collapsing them would make the population rate
        // unreadable — a zero could mean either.
        expect(new Set(stats.missingColumns)).toEqual(
          new Set([
            "ExternalUUID",
            "ExternalIdentifier",
            "ExternalModificationTag",
            "ModificationDate",
            "CreationDate",
            "StoreID",
          ])
        );
        expect(stats.total).toBe(4);
        expect(stats.externalUuid).toBe(0);
      } finally {
        parser.close();
      }
    });

    it("leaves every identity field null rather than undefined", () => {
      const parser = new iOSContactsParser();
      parser.open(legacyBackup);
      try {
        for (const c of parser.getAllContacts()) {
          // The declared type says `T | null`. `NULL AS <col>` is what makes
          // that true on this path, so undefined here would mean the type lies.
          expect(c.externalUuid).toBeNull();
          expect(c.externalIdentifier).toBeNull();
          expect(c.externalModificationTag).toBeNull();
          expect(c.modifiedAt).toBeNull();
          expect(c.createdAt).toBeNull();
          expect(c.storeId).toBeNull();
        }
      } finally {
        parser.close();
      }
    });
  });

  // -------------------------------------------------------------------------
  // POPULATION RATE — the deliverable of the capture
  // -------------------------------------------------------------------------

  it("reports the population rate, and it distinguishes local-store nulls", () => {
    const parser = new iOSContactsParser();
    parser.open(modernBackup);
    try {
      const stats = parser.getIdentityStats();

      // 2 of 4 — precisely the "sparse" outcome the task predicted for contacts
      // in the local store. This number is the instrument that decides whether
      // ExternalUUID can ever be a key or is only a secondary signal, so it is
      // asserted rather than merely logged.
      expect(stats.total).toBe(4);
      expect(stats.externalUuid).toBe(2);
      expect(stats.externalIdentifier).toBe(2);
      expect(stats.externalModificationTag).toBe(2);

      // Dates are populated more widely than the UUID — the reason capturing
      // ModificationDate is worth it even if the UUID proves unusable.
      expect(stats.modifiedAt).toBe(3);
      expect(stats.createdAt).toBe(3);

      // Two distinct stores present, which is the fact that EXPLAINS the 2/4.
      expect(stats.distinctStores).toBe(2);

      // Columns exist here, so nothing is reported missing.
      expect(stats.missingColumns).toEqual([]);
    } finally {
      parser.close();
    }
  });

  it("resets the probe between backups so one shape cannot leak into the next", () => {
    // The exported singleton is reused across imports, so a cached probe would
    // apply the modern backup's column shape to a legacy one — selecting columns
    // that are not there and throwing exactly where the probe exists to prevent.
    const parser = new iOSContactsParser();

    parser.open(modernBackup);
    expect(parser.getIdentityStats().missingColumns).toEqual([]);
    parser.close();

    expect(() => parser.open(legacyBackup)).not.toThrow();
    expect(parser.getIdentityStats().missingColumns.length).toBe(6);
    parser.close();
  });
});

describe("appleSecondsToIso (BACKLOG-2407)", () => {
  it("treats its input as SECONDS since the Apple epoch", () => {
    expect(appleSecondsToIso(CF_2021_01_01)).toBe("2021-01-01T00:00:00.000Z");
    expect(appleSecondsToIso(CF_2023_03_08)).toBe("2023-03-08T20:26:40.000Z");
  });

  it("returns null for absent, zero and non-finite values", () => {
    expect(appleSecondsToIso(null)).toBeNull();
    expect(appleSecondsToIso(undefined)).toBeNull();
    // 0 is Apple's epoch instant, but in this database it means "unset". Mapping
    // it to 2001-01-01 would manufacture a modification date for every contact
    // that has none.
    expect(appleSecondsToIso(0)).toBeNull();
    expect(appleSecondsToIso(NaN)).toBeNull();
    expect(appleSecondsToIso(Infinity)).toBeNull();
  });

  it("returns null rather than throwing on an out-of-range value", () => {
    // new Date(huge).toISOString() throws RangeError; a corrupt backup must not
    // take down the import.
    expect(appleSecondsToIso(1e18)).toBeNull();
  });
});
