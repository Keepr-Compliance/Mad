/**
 * @jest-environment node
 *
 * BACKLOG-2496 — CREATING A CONTACT AND RECORDING WHERE IT CAME FROM ARE ONE
 * ATOMIC WRITE.
 *
 * ===========================================================================
 * THE DEFECT
 * ===========================================================================
 * The contact row was inserted, and the crosswalk row saying where it came from
 * was written afterwards by a DIFFERENT function. Nothing forced the second to
 * happen, and nothing tied the two together, so an interruption between them
 * left a contact with no origin — no error, no warning, and afterwards
 * INDISTINGUISHABLE from a contact created by a path that never wrote one.
 *
 * That is not a hypothetical. It is BACKLOG-2510 (an import path that wrote no
 * crosswalk row) and then BACKLOG-2525, which read the absent row as "this
 * address-book entry is unclaimed" and created a SECOND contact for a person
 * already imported.
 *
 * `better-sqlite3` is synchronous, so every statement outside a transaction
 * commits before the next line runs. An exception halfway through an unwrapped
 * sequence therefore leaves exactly the wreckage a crash would — and a throw is
 * far likelier than a crash.
 *
 * ===========================================================================
 * WHAT THIS SUITE ASSERTS, AND WHY IT IS SHAPED THIS WAY
 * ===========================================================================
 * A test that creates a contact successfully and checks the result PASSES
 * WHETHER OR NOT A TRANSACTION EXISTS. It cannot separate the fixed code from
 * the broken code, so it proves nothing about atomicity. The case that
 * separates them is a FORCED FAILURE partway through, and that is what the
 * "forced crash" describes below do.
 *
 * The crash is forced with a SQLite trigger that aborts the origin INSERT. That
 * is a real failure of the real statement, at the real point in the sequence —
 * not a mock standing in for one.
 *
 * Identity sets are asserted EXACTLY — the precise
 * `(source_type, source_record_id)` pairs, and the precise surviving row ids —
 * never a count and never "a row exists". A count cannot tell a correct row
 * from a wrong one.
 *
 * ===========================================================================
 * ENGINES
 * ===========================================================================
 * `openTestDb` prefers the SHIPPING driver (`better-sqlite3-multiple-ciphers`)
 * and falls back to `node:sqlite`, so this runs on whichever is present: the
 * production driver in CI and under ELECTRON_RUN_AS_NODE, the fallback under
 * plain node on a dev machine whose binary is an Electron build. Every
 * assertion here is engine-agnostic and both engines were run.
 *
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --bail=0 \
 *     electron/services/db/__tests__/contactDbService.atomicCreate-2496.test.ts
 *
 * Fixture values are reserved-for-documentation only: `example.com` /
 * `example.test` and the `+1 555 01xx` reserved fictional range. Names invented.
 */

import { openTestDb, currentEngine, type TestDb } from "../../__tests__/helpers/syncSqliteDriver";
import { CONTACT_IDENTITY_SCHEMA } from "../../__tests__/helpers/contactIdentitySchema";

let mockDb: TestDb | null = null;

jest.mock("../core/dbConnection", () => ({
  ensureDb: () => mockDb,
  dbAll: (sql: string, params: unknown[] = []) =>
    mockDb!.prepare(sql).all(...(params as never[])),
  dbGet: (sql: string, params: unknown[] = []) =>
    mockDb!.prepare(sql).get(...(params as never[])),
  dbRun: (sql: string, params: unknown[] = []) => {
    const r = mockDb!.prepare(sql).run(...(params as never[]));
    return { lastInsertRowid: r.lastInsertRowid, changes: r.changes };
  },
  /**
   * ROUTED TO A REAL TRANSACTION, AND THAT IS LOAD-BEARING.
   *
   * Ten sibling suites mock this as `(fn) => fn()`. That passthrough is the
   * exact mutant BACKLOG-2368's suite exists to reject: it runs every statement
   * and satisfies every caller, while silently removing the atomicity. A suite
   * that used it could not fail any test in this file — the thing under test
   * would have been mocked away.
   */
  dbTransaction: <T>(fn: () => T): T => mockDb!.transaction(fn)(),
  getDbPath: () => "/fake/path/mad.db",
  getEncryptionKey: () => "fake-key",
}));

jest.mock("../../logService", () => {
  const m = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { __esModule: true, default: m, logService: m };
});

jest.mock("../../contactsService", () => ({ getContactNames: () => new Map() }));
jest.mock("../../../workers/contactWorkerPool", () => ({
  queryContacts: jest.fn(),
  isPoolReady: () => false,
}));

import { createContact, createContactsBatch } from "../contactDbService";

const USER = "user-2496";

/** Every contact id on disk, sorted. Exact set, never a count. */
function contactIds(): string[] {
  return (mockDb!.prepare("SELECT id FROM contacts ORDER BY id").all() as Array<{
    id: string;
  }>).map((r) => r.id);
}

/** Every crosswalk pair on disk, sorted. THE assertion this item is about. */
function sourcePairs(): string[] {
  return (
    mockDb!
      .prepare(
        "SELECT source_type, source_record_id FROM contact_source_links ORDER BY source_type, source_record_id",
      )
      .all() as Array<{ source_type: string; source_record_id: string }>
  ).map((r) => `${r.source_type}|${r.source_record_id}`);
}

function emailsOf(contactId: string): string[] {
  return (
    mockDb!
      .prepare("SELECT email FROM contact_emails WHERE contact_id = ? ORDER BY email")
      .all(contactId) as Array<{ email: string }>
  ).map((r) => r.email);
}

function allEmailRows(): string[] {
  return (
    mockDb!.prepare("SELECT email FROM contact_emails ORDER BY email").all() as Array<{
      email: string;
    }>
  ).map((r) => r.email);
}

function allPhoneRows(): string[] {
  return (
    mockDb!
      .prepare("SELECT phone_e164 FROM contact_phones ORDER BY phone_e164")
      .all() as Array<{ phone_e164: string }>
  ).map((r) => r.phone_e164);
}

/**
 * Abort every write to the crosswalk — a REAL failure of the REAL statement, at
 * the exact point the old code committed the contact and then went on to write
 * the origin separately.
 */
function forceOriginWriteToFail(): void {
  mockDb!.exec(`
    CREATE TRIGGER crash_between_contact_and_origin
    BEFORE INSERT ON contact_source_links
    BEGIN
      SELECT RAISE(ABORT, 'forced crash between the contact and its origin');
    END;
  `);
}

beforeEach(() => {
  mockDb = openTestDb();
  // One joined string, not a list — the identity tables are taken verbatim from
  // the migration's own constants so this fixture cannot drift from the schema
  // the app actually builds.
  mockDb.exec(CONTACT_IDENTITY_SCHEMA);
});

afterEach(() => {
  mockDb?.close();
  mockDb = null;
});

it("runs on a known engine", () => {
  expect(["better-sqlite3", "node:sqlite"]).toContain(currentEngine());
});

// ===========================================================================
// PER CALLER — the exact (source_type, source_record_id) that lands
// ===========================================================================
describe("each create path records a real origin", () => {
  it("contacts:create — a hand-typed contact gets a synthetic origin keyed on its own id", async () => {
    const contact = await createContact(
      {
        user_id: USER,
        display_name: "Marguerite Alderweireld",
        email: "m.alderweireld@example.com",
        source: "manual",
        is_imported: true,
      },
      { kind: "derived" },
    );

    // EXACT pair. `manual` because that is the contact's source; the record id
    // is the contact's own id, which is what makes it unique per contact rather
    // than collapsing every manual contact onto one crosswalk row.
    expect(sourcePairs()).toEqual([`manual|origin:${contact.id}`]);
    expect(contactIds()).toEqual([contact.id]);
  });

  it("localSyncService promote — an Android contact gets an android_sync origin", () => {
    const [id] = createContactsBatch([
      {
        user_id: USER,
        display_name: "Teodor Wrenfield",
        source: "android_sync",
        is_imported: true,
        allPhones: ["+15550100"],
        allEmails: [],
        origin: { kind: "derived" },
      },
    ]);

    // Before this item the Android promote wrote NO crosswalk row at all.
    expect(sourcePairs()).toEqual([`android_sync|origin:${id}`]);
  });

  it("contacts:import — the address-book record id lands, alongside the origin row", () => {
    const [id] = createContactsBatch([
      {
        user_id: USER,
        display_name: "Perpetua Danforth",
        source: "contacts_app",
        is_imported: true,
        allEmails: ["p.danforth@example.com"],
        origin: {
          kind: "sourceRecords",
          identities: [
            { sourceType: "macos", sourceRecordId: "ABPerson-4417", externalUuid: null },
          ],
        },
      },
    ]);

    // BOTH rows, and they say different true things: the origin row says WHERE
    // THE CONTACT CAME FROM, the record row says WHICH CARD IT IS. `macos`
    // because the desktop Contacts app is spelled `macos` in the crosswalk.
    expect(sourcePairs()).toEqual([`macos|ABPerson-4417`, `macos|origin:${id}`]);
  });

  it("contacts:import — a COLLAPSED picker row links every record it stands for", () => {
    const [id] = createContactsBatch([
      {
        user_id: USER,
        display_name: "Ignatius Blackwood",
        source: "contacts_app",
        is_imported: true,
        origin: {
          kind: "sourceRecords",
          identities: [
            { sourceType: "macos", sourceRecordId: "ABPerson-11", externalUuid: null },
            { sourceType: "iphone", sourceRecordId: "iOS-22", externalUuid: "uuid-22" },
          ],
        },
      },
    ]);

    // A picker row can stand for several source records (BACKLOG-2458). Missing
    // one leaves that record readable as unclaimed, which is how a duplicate
    // gets created on the next import.
    expect(sourcePairs()).toEqual([
      `iphone|iOS-22`,
      `macos|ABPerson-11`,
      `macos|origin:${id}`,
    ]);
  });
});

// ===========================================================================
// THE CONTROL — force a crash between the two writes
// ===========================================================================
describe("a failure writing the origin leaves NOTHING behind", () => {
  it("createContact — no contact row, no addresses, no crosswalk row", async () => {
    forceOriginWriteToFail();

    await expect(
      createContact(
        {
          user_id: USER,
          display_name: "Rosalind Ferrier",
          email: "r.ferrier@example.com",
          phone: "+15550101",
          source: "manual",
          is_imported: true,
        },
        { kind: "derived" },
      ),
    ).rejects.toThrow(/forced crash between the contact and its origin/);

    /**
     * THE ASSERTION THE WHOLE ITEM IS ABOUT.
     *
     * Without the transaction the contact INSERT has already committed by the
     * time the origin write fails, and this reads one id — a contact with no
     * origin, which nothing downstream can distinguish from a contact whose
     * path never wrote one.
     */
    expect(contactIds()).toEqual([]);
    expect(sourcePairs()).toEqual([]);

    // The addresses are inside the same transaction too. This is the half that
    // was PERMANENT before: a retry hits the duplicate-by-name guard in
    // `contacts:create`, which returns the existing contact and never re-runs
    // the address backfill, so anything half-written stayed half-written.
    expect(allEmailRows()).toEqual([]);
    expect(allPhoneRows()).toEqual([]);
  });

  it("createContactsBatch — an interrupted import leaves no contacts at all", () => {
    forceOriginWriteToFail();

    expect(() =>
      createContactsBatch([
        {
          user_id: USER,
          display_name: "Cordelia Vasquez-Thorne",
          source: "contacts_app",
          is_imported: true,
          allEmails: ["c.vt@example.com"],
          origin: {
            kind: "sourceRecords",
            identities: [
              { sourceType: "macos", sourceRecordId: "ABPerson-77", externalUuid: null },
            ],
          },
        },
        {
          user_id: USER,
          display_name: "Bartholomew Quinn",
          source: "contacts_app",
          is_imported: true,
          origin: { kind: "derived" },
        },
      ]),
    ).toThrow(/forced crash between the contact and its origin/);

    // Not "the failing one is absent" — NONE of them. A batch that committed
    // the first contact and failed on the second would leave exactly the state
    // BACKLOG-2525's guard misreads.
    expect(contactIds()).toEqual([]);
    expect(sourcePairs()).toEqual([]);
    expect(allEmailRows()).toEqual([]);
  });

  it("a contact already on disk is untouched by a failed create", async () => {
    const survivor = await createContact(
      {
        user_id: USER,
        display_name: "Wilhelmina Oyelaran",
        email: "w.oyelaran@example.com",
        source: "manual",
        is_imported: true,
      },
      { kind: "derived" },
    );

    forceOriginWriteToFail();

    await expect(
      createContact(
        { user_id: USER, display_name: "Doomed Person", source: "manual", is_imported: true },
        { kind: "derived" },
      ),
    ).rejects.toThrow();

    // The rollback is scoped to the failed create — it must not take the
    // earlier contact with it. Exact id set, and its addresses still there.
    expect(contactIds()).toEqual([survivor.id]);
    expect(sourcePairs()).toEqual([`manual|origin:${survivor.id}`]);
    expect(emailsOf(survivor.id)).toEqual(["w.oyelaran@example.com"]);
  });
});
