/**
 * @jest-environment node
 */

/**
 * BACKLOG-2467 — `searchContactsForSelection` must find a contact by phone
 * number, in the formats people type, across EVERY number they have.
 *
 * BACKLOG-2515 deleted the picker this query was written for. The SQL is
 * deliberately NOT deleted with it — see BACKLOG-2599, which owns deciding
 * whether `searchContactsForSelection` gets a live caller again or goes. Until
 * that is settled these assertions stay: they pin the phone-matching behaviour
 * itself, which is what any future caller would need, and deleting them would
 * throw away the BACKLOG-2467 evidence along with the dead consumer.
 *
 * Before that fix the phone clause was
 *
 *     LEFT JOIN contact_phones cp_primary ON ... AND cp_primary.is_primary = 1
 *     ... OR cp_primary.phone_e164 LIKE '%<raw query>%'
 *
 * which is two defects in one line: only the PRIMARY number was searchable, and
 * the comparison was a raw substring, so the formatted "+1 (415) 555-0100" that
 * the UI itself prints could never match the stored "+14155550100".
 *
 * ## Why this test runs REAL SQL
 *
 * Asserting that the query STRING contains a clause proves nothing about what
 * SQLite does with it — a mis-bound parameter, a join that silently drops rows,
 * or a REPLACE chain that does not reduce to the stored key would all sail past
 * a string assertion. So `dbAll` is routed to a real in-memory
 * better-sqlite3-multiple-ciphers database holding a minimal subset of the
 * production schema, and every assertion is an EXACT ID SET of the rows the
 * engine actually returned.
 */

import path from "path";
// The default Jest moduleNameMapper rewrites "better-sqlite3-multiple-ciphers"
// to a stub; require the real package via an explicit node_modules path so this
// test exercises actual SQL (same approach as phoneNormalizedJoin.test.ts).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  path.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

let db: DatabaseType;

// Route the module's SQL straight at the real in-memory database.
jest.mock("../core/dbConnection", () => ({
  dbGet: (sql: string, params: unknown[] = []) => db.prepare(sql).get(...params),
  dbAll: (sql: string, params: unknown[] = []) => db.prepare(sql).all(...params),
  dbRun: (sql: string, params: unknown[] = []) => db.prepare(sql).run(...params),
  /**
   * A REAL TRANSACTION, NOT A PASSTHROUGH (BACKLOG-2537).
   *
   * `db` here IS the shipping driver, so `db.transaction(fn)` is production's
   * own mechanism — BEGIN/COMMIT/ROLLBACK, escalating to a SAVEPOINT when
   * nested. The previous `(fn) => fn()` ran the callback and returned, leaving
   * every write committed even when the callback threw.
   *
   * Nothing in this file reaches a transaction today — measured, by replacing
   * this with a throwing stub and watching all 13 tests stay green. It is a
   * read-path suite. The passthrough is removed anyway, because the hazard is
   * not what this file asserts now, it is what the NEXT write test written here
   * would silently fail to assert.
   */
  dbTransaction: (fn: () => unknown) => db.transaction(fn)(),
}));

jest.mock("../../logService", () => ({
  default: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
  info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn(),
}));

jest.mock("../../contactsService", () => ({ getContactNames: jest.fn() }));

jest.mock("../../../workers/contactWorkerPool", () => ({
  queryContacts: jest.fn(),
  isPoolReady: () => false,
}));

jest.mock("../../../schemas", () => ({
  ContactSchema: {},
  validateResponse: (_schema: unknown, data: unknown) => data,
}));

import { searchContactsForSelection } from "../contactDbService";
import { toLookupKey } from "../../../utils/phoneNormalization";

const USER_ID = "user-1";

/** The columns `searchContactsForSelection` actually reads. */
function createSchema(database: DatabaseType): void {
  database.exec(`
    CREATE TABLE contacts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      display_name TEXT,
      company TEXT,
      title TEXT,
      source TEXT,
      is_imported INTEGER DEFAULT 0,
      -- Migration v56 tombstone columns. Present because the picker search now
      -- filters removed contacts (BACKLOG-2365). Every fixture row leaves them
      -- NULL = active, so the assertions below are unaffected by that filter.
      removed_at DATETIME,
      removed_reason TEXT
    );

    CREATE TABLE contact_emails (
      id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL,
      email TEXT NOT NULL,
      is_primary INTEGER DEFAULT 0
    );

    CREATE TABLE contact_phones (
      id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL,
      phone_e164 TEXT NOT NULL,
      phone_display TEXT,
      phone_normalized TEXT,
      is_primary INTEGER DEFAULT 0
    );

    CREATE TABLE emails (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      sent_at DATETIME
    );

    CREATE TABLE email_participants (
      email_id TEXT,
      email_address TEXT
    );

    CREATE TABLE communications (
      id TEXT PRIMARY KEY,
      email_id TEXT
    );

    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      participants TEXT,
      sent_at DATETIME,
      associated_message_type INTEGER
    );
  `);
}

interface SeedContact {
  id: string;
  displayName: string;
  company?: string;
  emails?: string[];
  /** In order; index 0 is stored as the PRIMARY number. */
  phones?: string[];
  /**
   * When false the row is written with a NULL `phone_normalized`, simulating a
   * contact stored before that column existed (the COALESCE fallback path).
   */
  writeNormalized?: boolean;
}

function seedContact(c: SeedContact): void {
  db.prepare(
    "INSERT INTO contacts (id, user_id, display_name, company, is_imported) VALUES (?, ?, ?, ?, 1)",
  ).run(c.id, USER_ID, c.displayName, c.company ?? null);

  (c.emails ?? []).forEach((email, i) => {
    db.prepare(
      "INSERT INTO contact_emails (id, contact_id, email, is_primary) VALUES (?, ?, ?, ?)",
    ).run(`${c.id}-e${i}`, c.id, email, i === 0 ? 1 : 0);
  });

  (c.phones ?? []).forEach((phone, i) => {
    db.prepare(
      "INSERT INTO contact_phones (id, contact_id, phone_e164, phone_display, phone_normalized, is_primary) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      `${c.id}-p${i}`,
      c.id,
      phone,
      phone,
      c.writeNormalized === false ? null : toLookupKey(phone),
      i === 0 ? 1 : 0,
    );
  });
}

/** Exact, sorted id set actually returned by the engine. */
function idsFor(query: string): string[] {
  return searchContactsForSelection(USER_ID, query)
    .map((c) => c.id)
    .sort();
}

beforeEach(() => {
  db = new Database(":memory:");
  createSchema(db);

  // The number the UI prints as "+1 (415) 555-0100".
  seedContact({
    id: "maria",
    displayName: "Maria Delgado",
    emails: ["maria@example.com"],
    phones: ["+14155550100"],
  });

  // Reachable only on her SECOND number — the case the is_primary = 1 join lost.
  seedContact({
    id: "ray",
    displayName: "Ray Okafor",
    emails: ["ray@example.com"],
    phones: ["+12125550100", "+16505550110"],
  });

  // Same second number, but written before `phone_normalized` existed, and in a
  // legacy non-E.164 shape. Exercises the COALESCE + REPLACE fallback.
  seedContact({
    id: "legacy",
    displayName: "Dana Whitfield",
    emails: ["dana@example.com"],
    phones: ["(917) 555-0143", "(213) 555-0177"],
    writeNormalized: false,
  });

  // No phone at all; company carries the digits "415".
  seedContact({
    id: "tom",
    displayName: "Tom Alvarez",
    company: "415 Realty",
    emails: ["tom@example.com"],
  });
});

afterEach(() => {
  db.close();
});

describe("searchContactsForSelection — phone search (BACKLOG-2467)", () => {
  describe("the same number, in the shapes a person types it", () => {
    // The first entry is exactly what `formatPhoneNumber` prints on screen. The
    // pre-2467 raw-substring clause could not find a string the UI displays.
    it.each([
      ["as displayed (formatted, +1)", "+1 (415) 555-0100"],
      ["as dashes without a country code", "415-555-0100"],
      ["as bare digits", "4155550100"],
      ["with dots", "415.555.0100"],
    ])("finds the contact %s", (_desc, query) => {
      expect(idsFor(query)).toEqual(["maria"]);
    });
  });

  it("finds a contact whose match is on a SECONDARY number", () => {
    expect(idsFor("(650) 555-0110")).toEqual(["ray"]);
  });

  it("still finds that contact by the PRIMARY number", () => {
    expect(idsFor("212-555-0100")).toEqual(["ray"]);
  });

  it("finds a secondary number on a row written before phone_normalized existed", () => {
    // COALESCE(NULLIF(phone_normalized,''), phone_e164) + REPLACE stripping.
    expect(idsFor("(213) 555-0177")).toEqual(["legacy"]);
    expect(idsFor("2135550177")).toEqual(["legacy"]);
  });

  it("does not treat a company name containing digits as a phone query", () => {
    // "415 Realty" has letters -> stays on the text path. Maria's number
    // contains 415 and must NOT be dragged in.
    expect(idsFor("415 Realty")).toEqual(["tom"]);
  });

  it("returns each matching contact exactly once despite the all-phones join", () => {
    // Ray has two phone rows; the GROUP BY must collapse the fan-out.
    const results = searchContactsForSelection(USER_ID, "212-555-0100");
    expect(results.map((c) => c.id)).toEqual(["ray"]);
  });

  describe("controls — the text paths this change must not disturb", () => {
    it.each([
      ["display_name", "Maria", ["maria"]],
      ["email", "dana@example.com", ["legacy"]],
      ["company", "Realty", ["tom"]],
      ["no match", "zzz-nobody", []],
    ])("matches by %s", (_desc, query, expected) => {
      expect(idsFor(query as string)).toEqual(expected);
    });
  });
});
