/**
 * @jest-environment node
 *
 * =============================================================================
 * BACKLOG-2707 — the door behind the Import button stops disagreeing with it
 * =============================================================================
 * `hasNothingToImport` calls a record with no name but a phone IMPORTABLE, so
 * the picker offers it with an enabled Import button. `contacts:import` then
 * refused it at the IPC door. Measured by driving the registered handler on
 * `9d97e9c38`, one record per call:
 *
 *   {name:"",  phone:"+14155550142"}   -> REFUSED "Validation error: name is required"
 *   {name:null, phone:"+14155550143"}  -> REFUSED "Validation error: name is required"
 *   {name absent, phone}               -> REFUSED "Validation error: name is required"
 *   {name:"",  email:"dana@example.com"} -> REFUSED same
 *   {name:"",  company:"Vantrees Realty"} -> REFUSED same
 *   {name:"   ", phone}                -> REFUSED "Validation error: name must be at
 *                                                  least 1 characters"
 *   {name:"Rosalind Vance", phone}     -> accepted
 *
 * TWO messages, not one — the item body records only the first. The whitespace
 * spelling is refused by `minLength: 1`, which is why relaxing `required` alone
 * would not have been a fix.
 *
 * `name: null` IS THE PRIMARY FIXTURE, not `""`. Four of the five producers
 * that write `external_contacts.name` emit `null` for a nameless record —
 * `localSyncService` (android_sync), `outlookContactProvider` and
 * `googleContactProvider` (via `contactSyncService`), and
 * `iPhoneSyncStorageService` when the iPhone display name is null. Only
 * iPhone's empty-string case emits `""`. The macOS address book emits NEITHER:
 * `contactsService.buildContactLabel` bakes name -> email -> formatted phone
 * before the row is ever written, so a nameless-but-phoned Mac contact arrives
 * carrying its phone number AS its name and imports today. That is
 * BACKLOG-2464, a different item.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE CAN AND CANNOT PROVE
 * ---------------------------------------------------------------------------
 * It drives the REGISTERED handlers, and its `databaseService` mock delegates
 * the three write paths to the REAL `contactDbService` against a real database.
 * So the stored value here is genuine. It is still not a substitute for
 * `contactDbService.namelessDisplayName-2707.test.ts`: that suite pins the
 * WRITER's own behaviour, which is where the `|| "Unknown"` substitution lived
 * and where a validator-only fix went vacuous. This file pins the HANDLERS.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { IpcMainInvokeEvent } from "electron";
import { CONTACT_IDENTITY_SCHEMA } from "../services/__tests__/helpers/contactIdentitySchema";
import { openTestDb, type TestDb } from "../services/__tests__/helpers/syncSqliteDriver";

let mockDb: TestDb | null = null;

const registeredHandlers = new Map<string, any>();

jest.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: any) => {
      registeredHandlers.set(channel, fn);
    },
  },
  BrowserWindow: jest.fn(),
  app: { isPackaged: false },
}));

jest.mock("../services/db/core/dbConnection", () => ({
  ensureDb: () => mockDb,
  dbAll: (sql: string, params: unknown[] = []) =>
    mockDb!.prepare(sql).all(...(params as never[])),
  dbGet: (sql: string, params: unknown[] = []) =>
    mockDb!.prepare(sql).get(...(params as never[])),
  dbRun: (sql: string, params: unknown[] = []) => {
    const r = mockDb!.prepare(sql).run(...(params as never[]));
    return { lastInsertRowid: r.lastInsertRowid, changes: r.changes };
  },
  dbTransaction: <T>(fn: () => T): T => mockDb!.transaction(fn)(),
  getDbPath: () => "/fake/path/mad.db",
  getEncryptionKey: () => "fake-key",
}));

/**
 * THE WRITE PATHS ARE REAL, AND THAT IS THE POINT.
 *
 * The sibling BACKLOG-2684 suite mocks `createContactsBatch` with an insert
 * that writes `row.display_name` raw and omits `company`/`title` from its
 * column list. That mock structurally cannot go red on the writer's own
 * `|| "Unknown"` substitution — the defect half of this item. Delegating to the
 * real functions costs nothing here and removes a control that cannot fail.
 */
jest.mock("../services/databaseService", () => {
  const real = jest.requireActual("../services/db/contactDbService");
  return {
    __esModule: true,
    default: {
      getImportedContactsByUserIdAsync: jest.fn(() => Promise.resolve([])),
      getRemovedContactIdentifiers: jest.fn(() => Promise.resolve([])),
      getImportedContactsByUserId: jest.fn(() => Promise.resolve([])),
      getUnimportedContactsByUserId: jest.fn(() => Promise.resolve([])),
      getUserById: jest.fn((id: string) => Promise.resolve({ id })),
      isInitialized: jest.fn(() => true),
      backfillContactEmails: jest.fn(() => Promise.resolve(0)),
      backfillContactPhones: jest.fn(() => Promise.resolve(0)),
      markContactAsImported: jest.fn(() => Promise.resolve()),
      getContactById: jest.fn((id: string) =>
        Promise.resolve(
          mockDb!.prepare("SELECT * FROM contacts WHERE id = ?").get(id) ?? null,
        ),
      ),
      createContactsBatch: jest.fn((rows: any[]) => real.createContactsBatch(rows)),
      createContact: jest.fn((data: any, origin: any) => real.createContact(data, origin)),
      updateContactSync: jest.fn((id: string, updates: any) =>
        real.updateContactSync(id, updates),
      ),
    },
  };
});

jest.mock("../services/contactsService", () => ({
  __esModule: true,
  getContactNames: jest.fn(() =>
    Promise.resolve({ phoneToContactInfo: {}, contacts: [], status: { loaded: true } }),
  ),
}));

jest.mock("../services/auditService", () => ({
  __esModule: true,
  default: { log: jest.fn(), logContactAction: jest.fn() },
}));

jest.mock("../services/logService", () => {
  const m = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { __esModule: true, default: m, logService: m };
});

jest.mock("../utils/preferenceHelper", () => ({
  __esModule: true,
  isContactSourceEnabled: jest.fn(() => Promise.resolve(true)),
}));

jest.mock("../services/outlookFetchService", () => ({
  __esModule: true,
  default: { initialize: jest.fn(), fetchContacts: jest.fn() },
}));

jest.mock("../services/db/externalContactDbService", () => ({
  __esModule: true,
  getCount: jest.fn(() => 0),
  getAllForUser: jest.fn(() => []),
  getAllForUserAsync: jest.fn(() => Promise.resolve([])),
  isStale: jest.fn(() => false),
  fullSync: jest.fn(),
  getLastSyncTime: jest.fn(() => null),
  updateLastMessageAtFromLookupTable: jest.fn(() => 0),
  syncOutlookContacts: jest.fn(),
  getContactSourceStats: jest.fn(() => ({})),
  markSourceRecordsCurrent: jest.fn(),
}));

jest.mock("../services/db/contactDbService", () => ({
  ...(jest.requireActual("../services/db/contactDbService") as object),
  getContactEmailEntries: jest.fn(() => []),
  getContactPhoneEntries: jest.fn(() => []),
}));

jest.mock("../services/contactSyncService", () => ({
  __esModule: true,
  default: { registerProvider: jest.fn(), sync: jest.fn(), syncAll: jest.fn() },
}));

jest.mock("../workers/contactWorkerPool", () => ({
  __esModule: true,
  isPoolReady: jest.fn(() => false),
  queryContacts: jest.fn(() => Promise.resolve([])),
}));

import { registerContactHandlers } from "../handlers/contactHandlers";
import { __resetContactLinkingScheduler } from "../services/contactLinkingScheduler";

// The RFC 4122 example UUID, copied verbatim from the sibling BACKLOG-2684 suite.
const USER = "550e8400-e29b-41d4-a716-446655440000"; // pii-allow-uuid: RFC 4122 example value, not from any live row
const mockEvent = {} as IpcMainInvokeEvent;

type Outcome = { refused: boolean; error: string | null };

async function drive(channel: string, ...args: unknown[]): Promise<Outcome> {
  try {
    const result = await registeredHandlers.get(channel)(mockEvent, ...args);
    return { refused: result.success !== true, error: result.error ?? null };
  } catch (e) {
    return { refused: true, error: e instanceof Error ? e.message : String(e) };
  }
}

const importRecords = (records: unknown[]) => drive("contacts:import", USER, records);
const createContact = (payload: unknown) => drive("contacts:create", USER, payload);
const updateContact = (id: string, updates: unknown) =>
  drive("contacts:update", id, updates);

function rows(): Array<{ id: string; display_name: string; company: string | null }> {
  return mockDb!
    .prepare("SELECT id, display_name, company FROM contacts WHERE user_id = ? ORDER BY rowid")
    .all(USER) as any;
}

beforeEach(() => {
  mockDb = openTestDb();
  mockDb.exec(CONTACT_IDENTITY_SCHEMA);
  registeredHandlers.clear();
  __resetContactLinkingScheduler();
  registerContactHandlers({
    isDestroyed: () => false,
    webContents: { send: jest.fn() },
  } as any);
});

afterEach(() => {
  __resetContactLinkingScheduler();
  mockDb?.close();
  mockDb = null;
});

/* ==========================================================================
 * C2 + C5 — the defect itself, and the whitespace boundary the item body missed
 * ========================================================================== */
describe("contacts:import accepts a record with no name but an identifier (BACKLOG-2707)", () => {
  /**
   * Every spelling of "no name" a producer can emit, SWEPT rather than sampled.
   * One input per branch cannot catch the boundary that was actually broken —
   * `"   "` was refused by a different clause with a different message and is
   * absent from every suite on this tree before this file.
   */
  it.each([
    ["null — android_sync, outlook, google_contacts, iPhone-null", null],
    ["an empty string — iPhone's empty-displayName case", ""],
    ["whitespace only — refused by minLength, a SECOND message", "   "],
  ])("a record whose name is %s but which has a phone imports", async (_label, name) => {
    const outcome = await importRecords([
      {
        id: "ext-1",
        name,
        phone: "+14155550142",
        email: null,
        company: null,
        source: "contacts_app",
        allPhones: ["+14155550142"],
        allEmails: [],
        isFromDatabase: false,
        externalRecordId: "rec-1",
        externalSourceType: "macos",
      },
    ]);

    expect(outcome).toEqual({ refused: false, error: null });
    // BY VALUE, not "a row exists" — that would pass while storing "Unknown".
    expect(rows()).toEqual([
      { id: expect.any(String), display_name: "", company: null },
    ]);
  });

  it("a record with an email and no name imports", async () => {
    const outcome = await importRecords([
      {
        id: "ext-4",
        name: null,
        email: "dana@example.com",
        allPhones: [],
        allEmails: ["dana@example.com"],
        isFromDatabase: false,
        externalRecordId: "rec-4",
        externalSourceType: "macos",
      },
    ]);

    expect(outcome.refused).toBe(false);
    expect(rows()[0].display_name).toBe("");
  });

  /**
   * REVERSED by founder ruling `a41a805b` / PM decision `5fac2d84`
   * (2026-09-07). This asserted that a company-only record imports. It does
   * not, any more — a company is not somebody you can import. It IS still
   * saveable through `contacts:create`, which is asserted in the create
   * describe below, and that asymmetry is the decision, not an accident.
   *
   * Rewritten rather than deleted: the trail from BACKLOG-2672's "COMPANY
   * COUNTS" to here is the only thing that stops the next reader reopening it.
   */
  it("a company-only record is refused, with a reason true of its own row", async () => {
    const outcome = await importRecords([
      {
        id: "ext-5",
        name: null,
        company: "Vantrees Realty",
        allPhones: [],
        allEmails: [],
        isFromDatabase: false,
        externalRecordId: "rec-5",
        externalSourceType: "macos",
      },
    ]);

    expect(outcome.refused).toBe(true);
    // The row this record renders is labelled "Vantrees Realty" — the company —
    // so a refusal claiming it has nothing on it would be false to the reader.
    expect(outcome.error).toMatch(/company on its own/i);
    expect(outcome.error).not.toMatch(/nothing to import/i);
    expect(rows()).toHaveLength(0);
  });

  it("a named record is untouched — the regression baseline", async () => {
    const outcome = await importRecords([
      {
        id: "ext-6",
        name: "Rosalind Vance",
        phone: "+14155550145",
        allPhones: ["+14155550145"],
        allEmails: [],
        isFromDatabase: false,
        externalRecordId: "rec-6",
        externalSourceType: "macos",
      },
    ]);

    expect(outcome.refused).toBe(false);
    expect(rows()[0].display_name).toBe("Rosalind Vance");
  });

  /**
   * The literal this PR stops writing must not reappear by any route. Asserting
   * its ABSENCE separately matters because `realContactName` reads "Unknown" as
   * no name, so every LABEL assertion in this repo passes either way — the
   * stored value is the only place the two designs differ.
   */
  it("no import writes the literal 'Unknown' any more", async () => {
    await importRecords([
      { id: "a", name: null, phone: "+14155550142", allPhones: ["+14155550142"], isFromDatabase: false },
      { id: "c", name: "   ", email: "x@example.com", allEmails: ["x@example.com"], isFromDatabase: false },
    ]);

    // Two records now, not three: the company-only one moved to the refusal
    // describe above when founder ruling `a41a805b` made it un-importable.
    expect(rows().map((r) => r.display_name)).toEqual(["", ""]);
  });
});

/* ==========================================================================
 * C7 — the create-side guard that replaces the deleted name requirement
 * ========================================================================== */
describe("contacts:create still refuses a record with nothing on it (BACKLOG-2707 / 2684)", () => {
  /**
   * `contacts:create` is LIVE — `contactBridge.ts` bridges it and
   * `ContactFormModal.tsx` calls it, mounted in four places. Removing the name
   * requirement without this guard would let the IPC door mint an empty
   * contact. The renderer refuses an empty name box, but a renderer guard
   * cannot protect a caller that does not go through the renderer.
   */
  it.each([
    ["a literally empty payload", {}],
    ["every field blank", { name: "", company: "", phone: "", email: "" }],
    ["the message-derived sentinel", { name: "unknown", phone: "unknown" }],
    ["only empty plural arrays", { name: null, allPhones: [], allEmails: [] }],
  ])("refuses %s", async (_label, payload) => {
    const outcome = await createContact(payload);

    expect(outcome.refused).toBe(true);
    expect(outcome.error).toMatch(/needs at least a name, company, phone, or email/i);
    expect(rows()).toHaveLength(0);
  });

  /**
   * A payload that is not an object at all must still get the validator's own
   * clean message. `hasNothingToImport` reads fields off its argument, so
   * running it FIRST on a `null` would raise a TypeError and report a message
   * about reading properties of null — a worse error than the one it replaced.
   */
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "Rosalind Vance"],
  ])("refuses %s with the validator's own message, not a TypeError", async (_label, payload) => {
    const outcome = await createContact(payload);

    expect(outcome.refused).toBe(true);
    expect(outcome.error).toMatch(/must be an object/i);
    expect(outcome.error).not.toMatch(/cannot read propert/i);
  });

  /**
   * SR Required Change A. A non-string FIELD is the second axis of the same
   * defect the non-object payload tests above cover — `hasNothingToImport`
   * assumes both that its argument is an object and that every field it reads
   * is a string, because `realContactName` is `(name || "").trim()`.
   *
   * Running the predicate BEFORE the validator turned a clean
   * `name must be a string` into `(name || "").trim is not a function` on a
   * live channel. Measured through the registered handler, not read.
   *
   * `{allPhones: [42]}` is the case that must stay REFUSED rather than merely
   * stop crashing: with the guard absent it created a row, which is the hole
   * the guard exists to close.
   */
  it.each([
    ["a number name", { name: 42 }, /name must be a string/i],
    ["an object name", { name: {} }, /name must be a string/i],
    ["an array name", { name: ["Rosalind"] }, /name must be a string/i],
    [
      "a number name alongside a real phone",
      { name: 42, phone: "+14155550142" },
      /name must be a string/i,
    ],
    [
      "a non-string entry in allPhones and nothing else",
      { allPhones: [42] },
      /needs at least a name, company, phone, or email/i,
    ],
  ])("refuses %s with a real message, never a TypeError", async (_label, payload, expected) => {
    const outcome = await createContact(payload);

    expect(outcome.refused).toBe(true);
    expect(outcome.error).toMatch(expected);
    expect(outcome.error).not.toMatch(/is not a function/i);
    expect(outcome.error).not.toMatch(/cannot read propert/i);
    expect(rows()).toHaveLength(0);
  });

  /**
   * The array filter must not turn an empty record into a full one. A record
   * whose ONLY identifier is a real string still imports; one whose only
   * identifier was a number does not.
   */
  it("keeps a real phone that sits beside a non-string entry", async () => {
    const outcome = await createContact({ allPhones: [42, "+14155550142"] });

    expect(outcome.refused).toBe(false);
    expect(rows()[0].display_name).toBe("");
  });

  it("accepts a nameless record that has a phone, and stores no name", async () => {
    const outcome = await createContact({ name: null, phone: "+14155550151" });

    expect(outcome.refused).toBe(false);
    expect(rows()[0].display_name).toBe("");
  });

  /**
   * =========================================================================
   * PM DECISION `5fac2d84` — CREATE IS LOOSER THAN IMPORT, ON PURPOSE
   * =========================================================================
   * Import is inference; creation is intent. A company-only record arriving
   * from a sync is Keepr guessing a scrap is worth keeping. A person typing a
   * company name and pressing Save has said exactly what they want — and
   * blocking them does not stop the data, it makes them type "Vantrees Realty"
   * into the NAME field, which pollutes every name-based match.
   *
   * THIS BEHAVIOUR HAD NO TEST ANYWHERE before BACKLOG-2707. SR found it by
   * driving the handler, not by reading a suite. Without this, a future
   * tightening of `hasNothingToSave` deletes the founder's decision silently.
   */
  it("accepts a COMPANY-ONLY contact — which import refuses (PM 5fac2d84)", async () => {
    const outcome = await createContact({ name: null, company: "Vantrees Realty" });

    expect(outcome.refused).toBe(false);
    expect(rows()[0]).toMatchObject({ display_name: "", company: "Vantrees Realty" });
  });

  /**
   * The other half of the same asymmetry, and the one the Add Contact form used
   * to refuse: a name with no phone and no email. The handler has always taken
   * it; only the renderer said otherwise.
   */
  it("accepts a NAME-ONLY contact, with no phone and no email", async () => {
    const outcome = await createContact({ name: "Gus Example" });

    expect(outcome.refused).toBe(false);
    expect(rows()[0].display_name).toBe("Gus Example");
  });

  it("accepts an ordinary named contact — the form's normal path", async () => {
    const outcome = await createContact({ name: "Dana Whitlock", phone: "4155550142" });

    expect(outcome.refused).toBe(false);
    expect(rows()[0].display_name).toBe("Dana Whitlock");
  });
});

/* ==========================================================================
 * C6 — the NOT NULL crash this fix must not introduce (SR Required Change 2)
 * ==========================================================================
 * `contacts.display_name` is `TEXT NOT NULL`. `contacts:update` builds its
 * payload by filtering `undefined` ONLY, so a `null` from the validator reaches
 * `updateContactSync` and binds straight into
 * `UPDATE contacts SET display_name = ?`:
 *
 *   updateContactSync("c1", {name: null})  ->  THREW
 *     NOT NULL constraint failed: contacts.display_name
 *
 * That handler wraps the contact row and both address syncs in ONE transaction,
 * so the whole edit rolls back. `{name: null}` and `{name: ""}` already reached
 * it as `null` before this PR; `{name: "   "}` used to raise a clean
 * ValidationError and would have JOINED them under a design that mapped
 * whitespace to `null`. All three now resolve to `""` in the validator.
 *
 * THE CHAIN IS THE CONTROL. Driving `updateContactSync` alone would pass while
 * the real path crashed — the writer stores `""` happily; the `"" -> null`
 * conversion happened upstream in the validator. So these drive the registered
 * handler.
 */
describe("contacts:update survives every spelling of a cleared name (BACKLOG-2707)", () => {
  const SEED_NAME = "Perpetua Danforth";

  async function seed(): Promise<string> {
    await createContact({
      name: SEED_NAME,
      phone: "+14155550160",
    });
    return rows()[0].id;
  }

  it.each([
    ["null", null],
    ["an empty string", ""],
    ["whitespace only", "   "],
  ])("clearing the name with %s stores \"\" and the row survives", async (_label, name) => {
    const id = await seed();

    const outcome = await updateContact(id, { name });

    // `?? ""` because a success carries `error: null`, and `.not.toMatch` on a
    // null is a matcher error rather than a pass — a green that means nothing.
    expect(String(outcome.error ?? "")).not.toMatch(/NOT NULL/i);
    expect(outcome.refused).toBe(false);
    // The row is still there — a rollback would have left the OLD name.
    expect(rows()).toEqual([
      { id, display_name: "", company: null },
    ]);
  });

  it("an ordinary rename still works — the regression baseline", async () => {
    const id = await seed();

    const outcome = await updateContact(id, { name: `${SEED_NAME}-Vance` });

    expect(outcome.refused).toBe(false);
    expect(rows()[0].display_name).toBe(`${SEED_NAME}-Vance`);
  });

  /**
   * The type check is NOT relaxed. A validator that turned a wrong-typed name
   * into a silent `null` would be trading a ValidationError for silence, which
   * is the direction PR #2563 argued against when it deleted the `amount`
   * check. Only the whitespace case is absorbed.
   */
  it("a non-string name still raises rather than resolving to no name", async () => {
    const id = await seed();

    const outcome = await updateContact(id, { name: 42 });

    expect(outcome.refused).toBe(true);
    expect(rows()[0].display_name).toBe(SEED_NAME);
  });
});
