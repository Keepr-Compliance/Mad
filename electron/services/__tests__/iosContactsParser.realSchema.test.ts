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
 * WHY THERE ARE EIGHT FIXTURES AND NOT TWO
 * ---------------------------------------------------------------------------
 * All-present and none-present are the two shapes a WRONG probe also gets
 * right, so on their own they assert far less than they appear to. Each of the
 * six fixtures added beyond them exists to make one specific wrong
 * implementation fail, and the "CONTROL RUN" note above each section records
 * the counts from actually substituting it:
 *
 *   partial-identifiers / partial-dates — disjoint subsets covering all six
 *     columns, so an all-or-nothing probe is wrong on both (3 failed / 16).
 *   mixed-case — identity columns DECLARED in a case the parser does not read,
 *     so a SELECT that omits the alias drops the values (1 failed / 18).
 *   implicit-rowid / lowercase-rowid / lowercase-names (BACKLOG-2413) — the
 *     same trap on the REQUIRED columns, invisible to all five fixtures above
 *     because every one of them declares ROWID explicitly and canonically
 *     (5 failed / 23; without these three the same bug passed 19/19).
 *
 * A fixture that no wrong implementation fails is decoration; these are the
 * cheapest ones that are not.
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
 * BACKLOG-2413: that last sentence was right about THIS fixture and wrong as a
 * conclusion. Modelling the real shape here is correct, but it meant no fixture
 * anywhere exercised the implicit rowid, so the failure mode this note
 * DESCRIBES was never actually run — and production carried it. It is now the
 * ABPERSON_IMPLICIT_ROWID_SCHEMA fixture below.
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

/**
 * ---------------------------------------------------------------------------
 * PARTIAL SHAPES — the fixtures that make the probe falsifiable
 * ---------------------------------------------------------------------------
 * With only all-present and none-present fixtures, an ALL-OR-NOTHING probe —
 * emit all six columns if every one is there, otherwise emit none — is
 * indistinguishable from the real thing and passes the entire suite. It is
 * wrong for every backup that has some of these columns and not others, which
 * is the exact case the probe was written for.
 *
 * The two schemas below are DISJOINT and together cover all six columns, so
 * that variant is wrong on both of them: on A it would null the identifiers it
 * has, on B the dates. Each is also a shape iOS really produces, ABPerson
 * having gained these columns across several releases rather than at once.
 */

/** Has the external identifiers and StoreID; has NEITHER date column. */
const ABPERSON_PARTIAL_IDENTIFIERS_SCHEMA = `
  CREATE TABLE ABPerson (
    ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
    First TEXT,
    Last TEXT,
    Middle TEXT,
    Organization TEXT,
    Note TEXT,
    ExternalIdentifier TEXT,
    ExternalModificationTag TEXT,
    ExternalUUID TEXT,
    StoreID INTEGER,
    guid TEXT
  );
`;

/** The reverse: has both date columns and NONE of the external identifiers. */
const ABPERSON_PARTIAL_DATES_SCHEMA = `
  CREATE TABLE ABPerson (
    ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
    First TEXT,
    Last TEXT,
    Middle TEXT,
    Organization TEXT,
    Note TEXT,
    CreationDate INTEGER,
    ModificationDate INTEGER,
    guid TEXT
  );
`;

/**
 * ---------------------------------------------------------------------------
 * MIXED CASE — the fixture that makes the case-insensitive probe falsifiable
 * ---------------------------------------------------------------------------
 * SQLite resolves identifiers case-insensitively but names each RESULT column
 * after its DECLARED case. So `SELECT ExternalUUID` against the table below
 * succeeds and returns the row keyed `EXTERNALUUID` — `row.ExternalUUID` is
 * `undefined`, and the parser's `?? null` turns a real identifier into null.
 * The probe correctly reports the column PRESENT the whole time; the loss is
 * downstream of it, which is what made it invisible.
 *
 * Every declared case here is legal SQL for the same logical column. Four
 * differ from the case the parser reads (`EXTERNALUUID`, `externalidentifier`,
 * `modificationdate`, `STOREID`) and two match it exactly — so this fixture
 * pins the fix without asserting that the matching-case path broke.
 */
const ABPERSON_MIXED_CASE_SCHEMA = `
  CREATE TABLE ABPerson (
    ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
    First TEXT,
    Last TEXT,
    Organization TEXT,
    Note TEXT,
    EXTERNALUUID TEXT,
    externalidentifier TEXT,
    ExternalModificationTag TEXT,
    modificationdate INTEGER,
    CreationDate INTEGER,
    STOREID INTEGER
  );
`;

/**
 * ---------------------------------------------------------------------------
 * THE REQUIRED COLUMNS — the same trap, on the columns that carry the id
 * ---------------------------------------------------------------------------
 * BACKLOG-2413. Every fixture above declares `ROWID` explicitly and in the
 * parser's own case, so all five are blind to the identical result-key trap on
 * `ROWID, First, Last, Organization`. The mixed-case fixture pinned the fix for
 * the OPTIONAL columns and, by declaring `ROWID` canonically, left the REQUIRED
 * ones unexercised — a fix to them would have shipped green against a suite
 * that could not have failed.
 *
 * The three schemas below are each ONE variable off canonical, so a failure
 * names its own cause instead of leaving three candidates:
 *
 *   implicit-rowid   — no rowid column declared at all. `SELECT ROWID` returns
 *                      the key `rowid`; `row.ROWID` is undefined; `id` is
 *                      undefined; every contact loses every phone and email and
 *                      the cache collapses to a single entry. This is also the
 *                      shape NO probe can reach: `PRAGMA table_info` does not
 *                      list an implicit rowid, so a PRAGMA-driven "alias it only
 *                      when the declared case differs" fix is wrong here and
 *                      right on the next one — which is why both exist.
 *   lowercase-rowid  — `rowid INTEGER PRIMARY KEY`, a legal alias of the rowid.
 *                      Same undefined id, but the column IS in `table_info`.
 *   lowercase-names  — canonical `ROWID`, lower-case `first`/`last`/
 *                      `organization`. Isolates the cosmetic half: ids and
 *                      handles survive, display names all become "Unknown".
 *
 * These are far less likely than the shapes above — ABPerson's four original
 * columns have been canonical for the life of the format. They are here because
 * the failure is SILENT and total, and because the fix is one string.
 */

/** No rowid column declared — `SELECT ROWID` comes back keyed `rowid`. */
const ABPERSON_IMPLICIT_ROWID_SCHEMA = `
  CREATE TABLE ABPerson (
    First TEXT,
    Last TEXT,
    Middle TEXT,
    Organization TEXT,
    Note TEXT,
    guid TEXT
  );
`;

/** Declares the rowid, but lower-case: a legal rowid alias, same result key. */
const ABPERSON_LOWERCASE_ROWID_SCHEMA = `
  CREATE TABLE ABPerson (
    rowid INTEGER PRIMARY KEY,
    First TEXT,
    Last TEXT,
    Middle TEXT,
    Organization TEXT,
    Note TEXT,
    guid TEXT
  );
`;

/** Canonical ROWID; the three NAME columns declared lower-case. */
const ABPERSON_LOWERCASE_NAMES_SCHEMA = `
  CREATE TABLE ABPerson (
    ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
    first TEXT,
    last TEXT,
    middle TEXT,
    organization TEXT,
    note TEXT,
    guid TEXT
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
 * The identity columns, named in the parser's canonical case.
 *
 * A fixture declares whichever SUBSET it wants; the INSERT below always names
 * them in this case regardless of how the schema declared them, because SQLite
 * resolves the write case-insensitively too. That is deliberate: it keeps the
 * mixed-case fixture's oddity confined to its `CREATE TABLE`, where the
 * behaviour under test actually lives.
 */
const IDENTITY_COLUMNS = [
  "ExternalUUID",
  "ExternalIdentifier",
  "ExternalModificationTag",
  "ModificationDate",
  "CreationDate",
  "StoreID",
] as const;
type IdentityColumn = (typeof IDENTITY_COLUMNS)[number];

/** The fixture value each identity column is written from. Exhaustive by type. */
function identityValue(
  p: PersonFixture,
  col: IdentityColumn
): string | number | null {
  switch (col) {
    case "ExternalUUID":
      return p.externalUuid;
    case "ExternalIdentifier":
      return p.externalIdentifier;
    case "ExternalModificationTag":
      return p.externalModificationTag;
    case "ModificationDate":
      return p.modificationDate;
    case "CreationDate":
      return p.creationDate;
    case "StoreID":
      return p.storeId;
  }
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
 *
 * `identityColumns` must list exactly the identity columns `schema` declares.
 * Naming one the schema lacks makes the INSERT throw at fixture-build time,
 * which is the intended failure: a fixture whose data silently did not match
 * its own schema would make every assertion below meaningless.
 */
function writeAddressBook(
  dir: string,
  schema: string,
  people: PersonFixture[],
  identityColumns: readonly IdentityColumn[]
): string {
  const hashDir = path.join(dir, iOSContactsParser.ADDRESSBOOK_DB_HASH.substring(0, 2));
  fs.mkdirSync(hashDir, { recursive: true });
  const dbPath = path.join(hashDir, iOSContactsParser.ADDRESSBOOK_DB_HASH);

  const db = new Database(dbPath);
  db.exec(schema);
  db.exec(ABMULTIVALUE_SCHEMA);

  db.prepare("INSERT INTO ABMultiValueLabel (ROWID, value) VALUES (1, '_$!<Mobile>!$_')").run();
  db.prepare("INSERT INTO ABMultiValueLabel (ROWID, value) VALUES (2, '_$!<Home>!$_')").run();

  const columns = ["ROWID", "First", "Last", "Organization", ...identityColumns];
  const insertPerson = db.prepare(
    `INSERT INTO ABPerson (${columns.join(", ")})
     VALUES (${columns.map(() => "?").join(", ")})`
  );

  const insertMv = db.prepare(
    "INSERT INTO ABMultiValue (record_id, property, identifier, label, value) VALUES (?, ?, ?, ?, ?)"
  );

  for (const p of people) {
    insertPerson.run(
      p.rowid,
      p.first,
      p.last,
      p.organization,
      ...identityColumns.map((col) => identityValue(p, col))
    );
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
  let partialIdentifiersBackup: string;
  let partialDatesBackup: string;
  let mixedCaseBackup: string;
  let implicitRowidBackup: string;
  let lowercaseRowidBackup: string;
  let lowercaseNamesBackup: string;

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-ab-2407-"));
    modernBackup = writeAddressBook(
      path.join(tmpRoot, "modern"),
      ABPERSON_REAL_SCHEMA,
      PEOPLE,
      IDENTITY_COLUMNS
    );
    legacyBackup = writeAddressBook(
      path.join(tmpRoot, "legacy"),
      ABPERSON_LEGACY_SCHEMA,
      PEOPLE,
      []
    );
    partialIdentifiersBackup = writeAddressBook(
      path.join(tmpRoot, "partial-identifiers"),
      ABPERSON_PARTIAL_IDENTIFIERS_SCHEMA,
      PEOPLE,
      ["ExternalUUID", "ExternalIdentifier", "ExternalModificationTag", "StoreID"]
    );
    partialDatesBackup = writeAddressBook(
      path.join(tmpRoot, "partial-dates"),
      ABPERSON_PARTIAL_DATES_SCHEMA,
      PEOPLE,
      ["ModificationDate", "CreationDate"]
    );
    mixedCaseBackup = writeAddressBook(
      path.join(tmpRoot, "mixed-case"),
      ABPERSON_MIXED_CASE_SCHEMA,
      PEOPLE,
      IDENTITY_COLUMNS
    );
    // BACKLOG-2413. None of these declare an identity column, so the identity
    // capture is uniformly null on all three and cannot confound the reading:
    // what varies between them and the legacy fixture is ONLY the declared case
    // of the required columns.
    implicitRowidBackup = writeAddressBook(
      path.join(tmpRoot, "implicit-rowid"),
      ABPERSON_IMPLICIT_ROWID_SCHEMA,
      PEOPLE,
      []
    );
    lowercaseRowidBackup = writeAddressBook(
      path.join(tmpRoot, "lowercase-rowid"),
      ABPERSON_LOWERCASE_ROWID_SCHEMA,
      PEOPLE,
      []
    );
    lowercaseNamesBackup = writeAddressBook(
      path.join(tmpRoot, "lowercase-names"),
      ABPERSON_LOWERCASE_NAMES_SCHEMA,
      PEOPLE,
      []
    );
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
  // PARTIAL SHAPES — what makes the probe per-column rather than all-or-nothing
  //
  // CONTROL RUN, measured. Replacing identitySelectList()'s body with the
  // all-or-nothing variant — emit all six columns when all six are present,
  // otherwise `NULL AS <col>` for all six — gives 3 failed / 16 passed, and the
  // three failures are exactly the three tests below. Against this file WITHOUT
  // these fixtures the same variant passed 14/14: it is wrong for every backup
  // that has some of these columns and not others, and nothing in CI said so.
  // -------------------------------------------------------------------------

  describe("an ABPerson with only SOME of the identity columns", () => {
    it("captures the identifiers it has when the DATE columns are absent", () => {
      const parser = new iOSContactsParser();
      expect(() => parser.open(partialIdentifiersBackup)).not.toThrow();
      try {
        const contacts = parser.getAllContacts();

        // Present on this shape — captured in full, as an exact set.
        expect(new Map(contacts.map((c) => [c.id, c.externalUuid]))).toEqual(
          new Map([
            [1, "11111111-1111-4111-8111-111111111111"],
            [2, "22222222-2222-4222-8222-222222222222"],
            [3, null],
            [4, null],
          ])
        );
        expect(new Map(contacts.map((c) => [c.id, c.storeId]))).toEqual(
          new Map([
            [1, 2],
            [2, 2],
            [3, 1],
            [4, null],
          ])
        );

        // Absent on this shape — null, and reported as MISSING rather than as a
        // population of zero.
        for (const c of contacts) {
          expect(c.modifiedAt).toBeNull();
          expect(c.createdAt).toBeNull();
        }
        expect(new Set(parser.getIdentityStats().missingColumns)).toEqual(
          new Set(["ModificationDate", "CreationDate"])
        );
      } finally {
        parser.close();
      }
    });

    it("captures the dates it has when the IDENTIFIER columns are absent", () => {
      // The mirror image of the test above. One partial fixture alone could be
      // satisfied by a probe that happened to guess right for that subset; two
      // disjoint subsets covering all six columns cannot be.
      const parser = new iOSContactsParser();
      expect(() => parser.open(partialDatesBackup)).not.toThrow();
      try {
        const contacts = parser.getAllContacts();

        expect(new Map(contacts.map((c) => [c.id, c.modifiedAt]))).toEqual(
          new Map([
            [1, "2023-03-08T20:26:40.000Z"],
            [2, "2021-01-01T00:00:00.000Z"],
            [3, "2023-03-08T20:26:40.000Z"],
            [4, null],
          ])
        );
        expect(new Map(contacts.map((c) => [c.id, c.createdAt]))).toEqual(
          new Map([
            [1, "2021-01-01T00:00:00.000Z"],
            [2, "2021-01-01T00:00:00.000Z"],
            [3, "2021-01-01T00:00:00.000Z"],
            [4, null],
          ])
        );

        for (const c of contacts) {
          expect(c.externalUuid).toBeNull();
          expect(c.externalIdentifier).toBeNull();
          expect(c.externalModificationTag).toBeNull();
          expect(c.storeId).toBeNull();
        }
        expect(new Set(parser.getIdentityStats().missingColumns)).toEqual(
          new Set([
            "ExternalUUID",
            "ExternalIdentifier",
            "ExternalModificationTag",
            "StoreID",
          ])
        );
      } finally {
        parser.close();
      }
    });

    it("counts the population only over the columns that shape actually has", () => {
      // A partial shape must not report the same numbers as the full one. This
      // is the counter-side of the two tests above: the stats line is what the
      // capture is FOR, and it has to stay readable when a column is absent.
      const identifiers = new iOSContactsParser();
      identifiers.open(partialIdentifiersBackup);
      const dates = new iOSContactsParser();
      dates.open(partialDatesBackup);
      try {
        const a = identifiers.getIdentityStats();
        const b = dates.getIdentityStats();

        // Same 4 contacts either way; the identity population differs entirely.
        expect([a.total, b.total]).toEqual([4, 4]);
        expect([a.externalUuid, a.modifiedAt, a.distinctStores]).toEqual([2, 0, 2]);
        expect([b.externalUuid, b.modifiedAt, b.distinctStores]).toEqual([0, 3, 0]);
      } finally {
        identifiers.close();
        dates.close();
      }
    });
  });

  // -------------------------------------------------------------------------
  // DECLARED CASE — the result key, not just the lookup
  //
  // CONTROL RUN, measured. Reverting identitySelectList()'s present branch to
  // the bare `${col}` gives 1 failed / 18 passed, the failure being the capture
  // test below. (The premise test above it stays green on purpose — it asserts
  // the FIXTURE's declared cases, not the parser, so it cannot mask a
  // regression by failing alongside.) Against this file WITHOUT this fixture
  // the bare form passed 14/14: the probe reported the column present, the
  // SELECT resolved it, and the value was dropped between the two.
  // -------------------------------------------------------------------------

  describe("an ABPerson whose identity columns are declared in a different case", () => {
    it("declares them in a different case — the premise, asserted not assumed", () => {
      // Without this, a fixture that quietly normalised its own column cases
      // would leave the two tests below passing while testing nothing.
      const dbPath = path.join(
        mixedCaseBackup,
        iOSContactsParser.ADDRESSBOOK_DB_HASH.substring(0, 2),
        iOSContactsParser.ADDRESSBOOK_DB_HASH
      );
      const db = new Database(dbPath, { readonly: true });
      try {
        const declared = new Set(
          (db.prepare("PRAGMA table_info(ABPerson)").all() as Array<{ name: string }>).map(
            (r) => r.name
          )
        );
        // Four differ from the case the parser reads, two match it exactly.
        expect(declared.has("EXTERNALUUID")).toBe(true);
        expect(declared.has("externalidentifier")).toBe(true);
        expect(declared.has("modificationdate")).toBe(true);
        expect(declared.has("STOREID")).toBe(true);
        expect(declared.has("ExternalUUID")).toBe(false);
        expect(declared.has("ExternalModificationTag")).toBe(true);
        expect(declared.has("CreationDate")).toBe(true);
      } finally {
        db.close();
      }
    });

    it("captures the value rather than dropping it on the result key", () => {
      const parser = new iOSContactsParser();
      expect(() => parser.open(mixedCaseBackup)).not.toThrow();
      try {
        const contacts = parser.getAllContacts();

        // THE REGRESSION. `SELECT ExternalUUID` against a declared
        // `EXTERNALUUID` returns the row keyed `EXTERNALUUID`, so
        // `row.ExternalUUID` is undefined and `?? null` writes null. Every
        // value below came back null before the SELECT aliased each column to
        // the case production reads.
        expect(new Map(contacts.map((c) => [c.id, c.externalUuid]))).toEqual(
          new Map([
            [1, "11111111-1111-4111-8111-111111111111"],
            [2, "22222222-2222-4222-8222-222222222222"],
            [3, null],
            [4, null],
          ])
        );
        expect(new Map(contacts.map((c) => [c.id, c.externalIdentifier]))).toEqual(
          new Map([
            [1, "ext-ada-001"],
            [2, "ext-grace-002"],
            [3, null],
            [4, null],
          ])
        );
        expect(new Map(contacts.map((c) => [c.id, c.modifiedAt]))).toEqual(
          new Map([
            [1, "2023-03-08T20:26:40.000Z"],
            [2, "2021-01-01T00:00:00.000Z"],
            [3, "2023-03-08T20:26:40.000Z"],
            [4, null],
          ])
        );
        expect(new Map(contacts.map((c) => [c.id, c.storeId]))).toEqual(
          new Map([
            [1, 2],
            [2, 2],
            [3, 1],
            [4, null],
          ])
        );

        // The two columns declared in the matching case still work — the alias
        // fixes the mismatched ones without disturbing the ordinary path.
        expect(new Map(contacts.map((c) => [c.id, c.externalModificationTag]))).toEqual(
          new Map([
            [1, "etag-ada-v3"],
            [2, "etag-grace-v9"],
            [3, null],
            [4, null],
          ])
        );

        // And the population rate is the real one, not a floor of zero. A
        // silently-dropped capture would report 0/4 here while claiming every
        // column present — the worst of both readings.
        const stats = parser.getIdentityStats();
        expect(stats.missingColumns).toEqual([]);
        expect([stats.externalUuid, stats.modifiedAt, stats.distinctStores]).toEqual([
          2, 3, 2,
        ]);
      } finally {
        parser.close();
      }
    });
  });

  // -------------------------------------------------------------------------
  // THE REQUIRED COLUMNS — the declared case of the columns that carry the id
  //
  // CONTROL RUN, measured. Reverting ABPERSON_REQUIRED_COLUMNS to the bare
  // `"ROWID, First, Last, Organization"` gives 5 failed / 23 passed of 28, and
  // the five failures are exactly the five capture tests below. Four tests stay
  // green on purpose and are not weakened by it: the three premise tests assert
  // the FIXTURES and the driver rather than the parser, so they cannot mask a
  // regression by failing alongside it, and the last lower-case-names test
  // asserts the ids that shape's canonical ROWID legitimately preserves.
  //
  // Against this file WITHOUT these three fixtures the bare form passed 19/19 —
  // all five earlier fixtures declare ROWID explicitly and canonically, so the
  // whole suite was blind to a defect that empties every contact.
  //
  // What the six failures look like under the bare form, measured: on the two
  // rowid shapes every contact comes back with 0 phones and 0 emails and
  // getAllContacts() returns ONE contact with id undefined, not four; on the
  // name shape ids and handles survive and all four display names are "Unknown".
  // -------------------------------------------------------------------------

  describe("an ABPerson with an IMPLICIT rowid (BACKLOG-2413)", () => {
    it("declares no rowid column, and a bare SELECT keys it `rowid` — the premise", () => {
      // Asserted against the real driver rather than assumed, for two reasons.
      // First, a fixture that quietly declared a rowid would leave the tests
      // below passing while testing nothing. Second, the second assertion is the
      // whole argument for fixing this with an unconditional alias instead of
      // extending the PRAGMA probe: table_info cannot see this column, so no
      // probe can decide to alias it.
      const dbPath = path.join(
        implicitRowidBackup,
        iOSContactsParser.ADDRESSBOOK_DB_HASH.substring(0, 2),
        iOSContactsParser.ADDRESSBOOK_DB_HASH
      );
      const db = new Database(dbPath, { readonly: true });
      try {
        const declared = (
          db.prepare("PRAGMA table_info(ABPerson)").all() as Array<{ name: string }>
        ).map((r) => r.name);
        // No spelling of the rowid appears at all — this is the shape a probe
        // provably cannot handle.
        expect(declared.some((n) => n.toLowerCase() === "rowid")).toBe(false);

        // And the trap itself: the row resolves, under the WRONG key.
        const bare = db.prepare("SELECT ROWID, First FROM ABPerson ORDER BY ROWID").get() as Record<
          string,
          unknown
        >;
        expect(Object.keys(bare)).toEqual(["rowid", "First"]);
        expect(bare.ROWID).toBeUndefined();
      } finally {
        db.close();
      }
    });

    it("keeps every contact's phones and emails attached to it", () => {
      // THE REGRESSION, and the reason this is filed above a cosmetic bug.
      // `row.ROWID` undefined makes `id` undefined, so buildLookupIndexes()
      // misses on multiValuesByContact.get(undefined) and every contact below
      // came back with an EMPTY phone list and an EMPTY email list — an import
      // that reports success and yields contacts that can match nothing.
      const parser = new iOSContactsParser();
      expect(() => parser.open(implicitRowidBackup)).not.toThrow();
      try {
        const contacts = parser.getAllContacts();

        expect(
          new Map(contacts.map((c) => [c.id, c.phoneNumbers.map((p) => p.number)]))
        ).toEqual(
          new Map([
            [1, ["(555) 111-2222"]],
            [2, ["555-333-4444"]],
            [3, ["555-555-6666"]],
            [4, []],
          ])
        );
        expect(new Map(contacts.map((c) => [c.id, c.emails.map((e) => e.email)]))).toEqual(
          new Map([
            [1, ["ada@example.com"]],
            [2, ["grace@example.com"]],
            [3, []],
            [4, ["info@orgonly.example"]],
          ])
        );
      } finally {
        parser.close();
      }
    });

    it("keeps the four contacts distinct instead of collapsing the address book", () => {
      // The second half of the same defect. `contactCache` is keyed on the id,
      // so four undefined ids overwrite one another: getAllContacts() returned a
      // SINGLE contact — the last row parsed — for the entire address book.
      // Asserted as the exact id set, because a length of 4 would also pass with
      // the ids permuted.
      const parser = new iOSContactsParser();
      parser.open(implicitRowidBackup);
      try {
        expect(new Set(parser.getAllContacts().map((c) => c.id))).toEqual(
          new Set([1, 2, 3, 4])
        );
        expect(parser.getContactCount()).toBe(4);

        // And the indexes those ids feed: a handle from a message has to reach
        // the right contact, which is what this parser exists to do.
        expect(parser.lookupByHandle("+15553334444").contact?.displayName).toBe(
          "Grace Hopper"
        );
        expect(parser.lookupByHandle("info@orgonly.example").contact?.displayName).toBe(
          "Org Only LLC"
        );
      } finally {
        parser.close();
      }
    });

    it("carries the id through getContactById(), not only the bulk read", () => {
      // getContactById() falls through to stmtContactById on a cache miss, and
      // that statement is built from the same constant. Fixing only the bulk
      // read would leave this path returning a contact with an undefined id.
      const parser = new iOSContactsParser();
      parser.open(implicitRowidBackup);
      try {
        const contact = parser.getContactById(3);
        expect(contact).not.toBeNull();
        expect(contact!.id).toBe(3);
        expect(contact!.displayName).toBe("Local Only");
      } finally {
        parser.close();
      }
    });
  });

  describe("an ABPerson whose rowid is declared LOWER-CASE (BACKLOG-2413)", () => {
    it("declares it as `rowid`, visibly, in table_info — the premise", () => {
      // The contrast with the implicit fixture, and the reason both exist: this
      // shape IS visible to PRAGMA table_info. A fix that probed the declared
      // case and aliased only on a mismatch would pass here and still be wrong
      // on the implicit shape above.
      const dbPath = path.join(
        lowercaseRowidBackup,
        iOSContactsParser.ADDRESSBOOK_DB_HASH.substring(0, 2),
        iOSContactsParser.ADDRESSBOOK_DB_HASH
      );
      const db = new Database(dbPath, { readonly: true });
      try {
        const declared = (
          db.prepare("PRAGMA table_info(ABPerson)").all() as Array<{ name: string }>
        ).map((r) => r.name);
        expect(declared).toContain("rowid");
        expect(declared).not.toContain("ROWID");
      } finally {
        db.close();
      }
    });

    it("still reads the id, so handles stay attached to the right contact", () => {
      const parser = new iOSContactsParser();
      expect(() => parser.open(lowercaseRowidBackup)).not.toThrow();
      try {
        const contacts = parser.getAllContacts();

        expect(new Set(contacts.map((c) => c.id))).toEqual(new Set([1, 2, 3, 4]));
        expect(
          new Map(contacts.map((c) => [c.id, c.phoneNumbers.map((p) => p.number)]))
        ).toEqual(
          new Map([
            [1, ["(555) 111-2222"]],
            [2, ["555-333-4444"]],
            [3, ["555-555-6666"]],
            [4, []],
          ])
        );
        expect(new Map(contacts.map((c) => [c.id, c.emails.map((e) => e.email)]))).toEqual(
          new Map([
            [1, ["ada@example.com"]],
            [2, ["grace@example.com"]],
            [3, []],
            [4, ["info@orgonly.example"]],
          ])
        );
      } finally {
        parser.close();
      }
    });
  });

  describe("an ABPerson whose NAME columns are declared lower-case (BACKLOG-2413)", () => {
    it("declares them lower-case while ROWID stays canonical — the premise", () => {
      // One variable off canonical: if the test below fails, the declared case
      // of the names is the only thing it can be.
      const dbPath = path.join(
        lowercaseNamesBackup,
        iOSContactsParser.ADDRESSBOOK_DB_HASH.substring(0, 2),
        iOSContactsParser.ADDRESSBOOK_DB_HASH
      );
      const db = new Database(dbPath, { readonly: true });
      try {
        const declared = new Set(
          (db.prepare("PRAGMA table_info(ABPerson)").all() as Array<{ name: string }>).map(
            (r) => r.name
          )
        );
        expect(declared.has("first")).toBe(true);
        expect(declared.has("last")).toBe(true);
        expect(declared.has("organization")).toBe(true);
        expect(declared.has("First")).toBe(false);
        expect(declared.has("ROWID")).toBe(true);
      } finally {
        db.close();
      }
    });

    it("reads the names rather than labelling every contact Unknown", () => {
      // The cosmetic half of the same trap. `row.First` undefined makes
      // computeDisplayName optional-chain past all three fields to its "Unknown"
      // fallback — for the whole address book, including the organization-only
      // contact whose fallback name is the one thing it has.
      const parser = new iOSContactsParser();
      expect(() => parser.open(lowercaseNamesBackup)).not.toThrow();
      try {
        const contacts = parser.getAllContacts();

        expect(new Map(contacts.map((c) => [c.id, c.displayName]))).toEqual(
          new Map([
            [1, "Ada Lovelace"],
            [2, "Grace Hopper"],
            [3, "Local Only"],
            [4, "Org Only LLC"],
          ])
        );
        expect(new Map(contacts.map((c) => [c.id, c.firstName]))).toEqual(
          new Map([
            [1, "Ada"],
            [2, "Grace"],
            [3, "Local"],
            [4, null],
          ])
        );
        expect(new Map(contacts.map((c) => [c.id, c.organization]))).toEqual(
          new Map([
            [1, null],
            [2, "Navy"],
            [3, null],
            [4, "Org Only LLC"],
          ])
        );
      } finally {
        parser.close();
      }
    });

    it("keeps the handles attached, which the canonical ROWID here preserves", () => {
      // The counter-side of the test above: on THIS shape the ids are fine, so a
      // reader can see that the two halves of the defect are separable and that
      // the name columns alone cost only the display name.
      const parser = new iOSContactsParser();
      parser.open(lowercaseNamesBackup);
      try {
        expect(new Set(parser.getAllContacts().map((c) => c.id))).toEqual(
          new Set([1, 2, 3, 4])
        );
        expect(parser.lookupByHandle("ada@example.com").contact?.id).toBe(1);
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
