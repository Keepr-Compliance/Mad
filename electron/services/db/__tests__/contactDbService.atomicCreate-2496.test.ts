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

import {
  createContact,
  createContactsBatch,
  syncContactEmails,
  syncContactPhones,
  setContactPrimaryEmail,
  getContactEmailEntries,
} from "../contactDbService";

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
  /**
   * ASSERTED BEFORE ANYTHING RELIES ON IT.
   *
   * Every test below is worthless if the injected crash does not actually fire:
   * the create would succeed, `rejects` would have nothing to catch, and the
   * test would report a pass while being unable to detect the defect it exists
   * to detect. THAT IS THE FAILURE MODE THIS WHOLE ITEM IS ABOUT, one level up.
   *
   * `insertOriginRow` uses `INSERT OR IGNORE`, and SQLite's conflict-resolution
   * can in principle downgrade a trigger's `RAISE(ABORT)`. Measured on both
   * engines this repo runs (better-sqlite3 3.53.2, node:sqlite 3.51.3) it does
   * NOT — the abort fires for plain INSERT, OR IGNORE and OR REPLACE alike.
   * This pins that, so an engine where it stops being true turns CI red HERE,
   * loudly, instead of quietly disarming every assertion below.
   */
  it("PRECONDITION — the injected crash actually fires on this engine", () => {
    const version = (
      mockDb!.prepare("SELECT sqlite_version() AS v").get() as { v: string }
    ).v;
    // Printed so a CI failure carries the engine that produced it.
    console.log(`[BACKLOG-2496] engine=${currentEngine()} sqlite=${version}`);

    forceOriginWriteToFail();

    expect(() =>
      mockDb!
        .prepare(
          `INSERT OR IGNORE INTO contact_source_links
             (id, user_id, contact_id, source_type, source_record_id, external_uuid,
              match_method, confidence, evidence_ref)
           VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, NULL)`,
        )
        .run("diag-1", USER, "diag-contact", "manual", "origin:diag-contact", "origin"),
    ).toThrow(/forced crash between the contact and its origin/);
  });

  it("createContact — no contact row, no addresses, no crosswalk row", async () => {
    forceOriginWriteToFail();

    let outcome = "RESOLVED — the create completed, so nothing was rolled back";
    try {
      await createContact(
        {
          user_id: USER,
          display_name: "Rosalind Ferrier",
          email: "r.ferrier@example.com",
          phone: "+15550101",
          source: "manual",
          is_imported: true,
        },
        { kind: "derived" },
      );
    } catch (error) {
      outcome = `REJECTED: ${(error as Error).message}`;
    }
    console.log(`[BACKLOG-2496] createContact outcome = ${outcome}`);

    /**
     * =====================================================================
     * WHY THIS CAPTURES THE ERROR INSTEAD OF USING `.rejects.toThrow()`
     * =====================================================================
     * IT IS NOT A WEAKER ASSERTION — IT IS THE ONE THAT WORKS ON CI.
     *
     * Written first as `await expect(createContact(...)).rejects.toThrow(...)`,
     * this test was RED on CI (macOS and Windows) with "Received function did
     * not throw", while passing locally on both engines. That is the most
     * dangerous shape a test can have: on the machine that gates merges it
     * could not observe the failure it exists to observe, so removing the
     * transaction would NOT have turned it red there.
     *
     * Established by a controlled comparison, in one CI run: the PRECONDITION
     * test above passed (so the injected crash does fire on CI), this test
     * passed once rewritten to capture the error, and the sibling test still
     * using `.rejects.toThrow()` stayed red. Same suite, same run, same
     * trigger — THE ONLY VARIABLE WAS THE ASSERTION STYLE.
     *
     * Contributing cause, measured: two copies of `expect` exist in the tree —
     * `node_modules/expect` at 30.4.1 (hoisted) and
     * `node_modules/jest-circus/node_modules/expect` at 29.7.0, which is what
     * jest 29.7.0 actually runs, and which the CI stack trace named. The
     * rejection also carries a SqliteError constructed inside a NATIVE addon,
     * which is the kind of value `.rejects.toThrow()`'s Error handling is
     * least reliable about.
     *
     * The capture asserts MORE than the original did: that it rejected AND the
     * exact message. Paired with the precondition above — which fails loudly if
     * the crash ever stops firing — this suite cannot pass vacuously.
     */
    expect(outcome).toMatch(/^REJECTED: .*forced crash between the contact and its origin/);

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

    // Captured, not asserted through `.rejects` — see the note on the first
    // forced-crash test. `.rejects.toThrow()` reported "did not throw" on CI
    // for a rejection this same suite proves is raised.
    let outcome = "RESOLVED — the create completed, so nothing was rolled back";
    try {
      await createContact(
        { user_id: USER, display_name: "Doomed Person", source: "manual", is_imported: true },
        { kind: "derived" },
      );
    } catch (error) {
      outcome = `REJECTED: ${(error as Error).message}`;
    }
    expect(outcome).toMatch(/^REJECTED: .*forced crash between the contact and its origin/);

    // The rollback is scoped to the failed create — it must not take the
    // earlier contact with it. Exact id set, and its addresses still there.
    expect(contactIds()).toEqual([survivor.id]);
    expect(sourcePairs()).toEqual([`manual|origin:${survivor.id}`]);
    expect(emailsOf(survivor.id)).toEqual(["w.oyelaran@example.com"]);
  });
});

// ===========================================================================
// EDITING A CONTACT'S ADDRESSES — the highest-damage row in the write-path audit
// ===========================================================================
/**
 * `syncContactEmails` DELETES FIRST AND INSERTS SECOND. Unwrapped, an
 * interruption between the two loops left the contact with NEITHER the old set
 * NOR the new one — no addresses at all.
 *
 * That state is silent and unrecoverable in the ways that matter:
 * `getContactEmailsForTransaction` drives the audit's email sweep off this
 * table, so a party on a live deal stops matching their own correspondence and
 * the deal's communication set quietly narrows. Nothing errors.
 *
 * The identity set is asserted EXACTLY — the same row ids, not "still three
 * rows". A rollback that recreated equivalent rows with new ids would satisfy a
 * count and would still have destroyed the originals.
 */
describe("editing a contact's addresses is all-or-nothing", () => {
  /** Abort every INSERT into contact_emails: a real failure, mid-sequence. */
  function forceEmailInsertToFail(): void {
    mockDb!.exec(`
      CREATE TRIGGER crash_between_delete_and_insert
      BEFORE INSERT ON contact_emails
      BEGIN
        SELECT RAISE(ABORT, 'forced crash between the delete loop and the insert loop');
      END;
    `);
  }

  async function seedWithThreeEmails() {
    const contact = await createContact(
      {
        user_id: USER,
        display_name: "Anneliese Fotheringham",
        source: "manual",
        is_imported: true,
        allEmails: [
          "a.fotheringham@example.com",
          "annie@example.test",
          "a.f@example.org",
        ],
      } as Parameters<typeof createContact>[0],
      { kind: "derived" },
    );
    return contact;
  }

  it("a failed email edit leaves the EXACT original rows — not zero, not replacements", async () => {
    const contact = await seedWithThreeEmails();
    const before = getContactEmailEntries(contact.id);
    expect(before).toHaveLength(3);
    const beforeIds = before.map((e) => e.id).sort();

    forceEmailInsertToFail();

    // The edit the founder would make: keep one, add a new one.
    expect(() =>
      syncContactEmails(contact.id, [
        { id: before[0].id, email: before[0].email, is_primary: true },
        { email: "new.address@example.com", is_primary: false },
      ]),
    ).toThrow(/forced crash between the delete loop and the insert loop/);

    const after = getContactEmailEntries(contact.id);

    // Without the transaction the two deletes have already committed and this
    // reads ONE row — the contact has lost two addresses and gained nothing.
    expect(after.map((e) => e.id).sort()).toEqual(beforeIds);
    expect(after.map((e) => e.email).sort()).toEqual(
      ["a.f@example.org", "a.fotheringham@example.com", "annie@example.test"],
    );
  });

  it("a failed setContactPrimaryEmail does not leave the contact with zero addresses", async () => {
    const contact = await seedWithThreeEmails();
    const beforeIds = getContactEmailEntries(contact.id).map((e) => e.id).sort();

    forceEmailInsertToFail();

    // The `else` branch: DELETE every address, then INSERT one. One statement
    // of window in which the contact has no email at all.
    expect(() =>
      setContactPrimaryEmail(contact.id, "brand.new@example.com"),
    ).toThrow(/forced crash between the delete loop and the insert loop/);

    expect(getContactEmailEntries(contact.id).map((e) => e.id).sort()).toEqual(beforeIds);
  });

  it("phones have the same shape, and the same guarantee", async () => {
    const contact = await createContact(
      {
        user_id: USER,
        display_name: "Casimir Oyelowo-Brandt",
        source: "manual",
        is_imported: true,
        allPhones: ["+15550110", "+15550111"],
      } as Parameters<typeof createContact>[0],
      { kind: "derived" },
    );
    const beforePhones = allPhoneRows();
    expect(beforePhones).toEqual(["+15550110", "+15550111"]);

    mockDb!.exec(`
      CREATE TRIGGER crash_on_phone_insert
      BEFORE INSERT ON contact_phones
      BEGIN
        SELECT RAISE(ABORT, 'forced crash mid phone sync');
      END;
    `);

    expect(() =>
      syncContactPhones(contact.id, [{ phone: "+15550199", is_primary: true }]),
    ).toThrow(/forced crash mid phone sync/);

    // Established by running it, not assumed from the email case.
    expect(allPhoneRows()).toEqual(beforePhones);
  });
});
