/**
 * @jest-environment node
 *
 * =============================================================================
 * BACKLOG-3193 — no door may save a contact that no filter can find
 * =============================================================================
 * The `contacts.source` CHECK admits nine values. Six have a filter leaf of
 * their own. The other three — `email`, `sms`, `inferred` — are placed only by
 * the two Inferred leaves, and those require `is_message_derived`. Every SAVED
 * contact reaches the filter with that flag at 0 (`0 as is_message_derived` in
 * the one projection behind `contacts:get-all`). So a saved contact carrying one
 * of the three matched NO leaf: hidden under the default selection, hidden with
 * every box ticked, and not found by searching its own name.
 *
 * Measured before the fix at `075d0cc68`, both engines, one record per call,
 * read back through the real `getImportedContactsByUserId`:
 *
 *     door    inbound    stored     source_types   DEFAULT  ALL    leaves
 *     import  email      email      ["email"]      false    false  []
 *     import  sms        sms        ["sms"]        false    false  []
 *     import  inferred   inferred   ["inferred"]   false    false  []
 *     create  (the same three rows)
 *
 * Nothing in the tree sends those values today. The first likely sender is an
 * unsaved email-derived record spelled `email` or `inferred`, which the filter
 * already files under Inferred > From Email — so Import on it would have saved a
 * contact nobody could find. `toStorableContactSource` now refuses the three:
 * `contacts:import` refuses the whole call, `contacts:create` folds them to
 * `manual`.
 *
 * -----------------------------------------------------------------------------
 * WHAT EACH BLOCK CATCHES — every mutation below was run before this was written
 * -----------------------------------------------------------------------------
 *   C1   both doors, all nine values, BY VALUE. Reds on a partial refusal (only
 *        `email`), on mapping the three to `manual` instead of refusing, on a
 *        refusal placed in the import handler instead of the boundary, and on a
 *        fix that folds every value to `manual`.
 *   C1b  the import door's `isFromDatabase` branch, which reaches the
 *        `UPDATE contacts SET source = ?` writer rather than the insert.
 *   C2   end to end through the real read path: whatever a door saves is on
 *        screen under the default selection, asserted as an identity set.
 *   C4   the projection. "Fixing" this item by computing `is_message_derived`
 *        from `source` left all 42 contact-handler/projection suites green (581
 *        tests) while moving saved contacts under Inferred — hidden by default,
 *        and offered Import instead of Link on their own card. C4 is the only
 *        test that goes red on it.
 *
 * Never the error text: `better-sqlite3` and the `node:sqlite` fallback surface
 * different messages (see the BACKLOG-2481 suite). Refused, and zero rows.
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
      backfillContactEmailsSync: jest.fn(() => 0),
      backfillContactPhonesSync: jest.fn(() => 0),
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

function rows(): Array<{ id: string; display_name: string; source: string }> {
  return mockDb!
    .prepare("SELECT id, display_name, source FROM contacts WHERE user_id = ? ORDER BY rowid")
    .all(USER) as any;
}

function originLinks(): Array<{ source_type: string; match_method: string }> {
  return mockDb!
    .prepare(
      "SELECT source_type, match_method FROM contact_source_links WHERE user_id = ? ORDER BY rowid",
    )
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

import { DEFAULT_SOURCE_SELECTION, matchesSourceFilter } from "../../src/utils/contactFilterModel";
import { PERSISTED_CONTACT_SOURCES } from "../utils/contactSourceVocabulary";

/**
 * One record as both live screens hand it over — the text-derived row from the
 * BACKLOG-2481 suite, transcribed there from `getMessageDerivedContacts`, with
 * `is_message_derived` already stripped at the IPC boundary (`Contacts.tsx`,
 * `ContactAssignmentStep.tsx`). Only `source` and the name vary per call.
 */
function record(source: string | undefined, name = "Rosalind Quill") {
  return {
    id: `msg_${name.toLowerCase()}`,
    display_name: name,
    name,
    email: null,
    phone: name,
    company: null,
    source,
    is_imported: 0,
    last_communication_at: "2026-02-04 13:00:00",
    communication_count: 3,
  };
}

/** Named BY VALUE, not read from the module under test. */
const UNFILTERABLE = ["email", "sms", "inferred"];
const ADDRESS_BOOK = ["manual", "contacts_app", "android_sync", "iphone", "outlook", "google_contacts"];

/**
 * The tables the imported-contacts read path touches beyond the identity
 * schema. All four are built from their `CREATE TABLE` statements in
 * `schema.sql`, not written here, so the fixture cannot describe a table
 * production does not have.
 */
function seedReadPathTables(): void {
  const schema = (jest.requireActual("fs") as typeof import("fs")).readFileSync(
    (jest.requireActual("path") as typeof import("path")).join(__dirname, "..", "database", "schema.sql"),
    "utf8",
  );
  for (const table of ["messages", "phone_last_message", "emails", "email_participants"]) {
    const ddl = schema.match(
      new RegExp(`CREATE TABLE IF NOT EXISTS "?${table}"? \\([\\s\\S]*?\\n\\s*\\);`),
    );
    if (!ddl) throw new Error(`schema.sql has no CREATE TABLE for ${table}`);
    mockDb!.exec(ddl[0]);
  }
}

async function savedContacts(): Promise<any[]> {
  const real = jest.requireActual("../services/db/contactDbService");
  const all = await real.getImportedContactsByUserId(USER);
  // The read path also merges unsaved message-derived rows; none exist here, and
  // they would be `msg_` ids if they did.
  return all.filter((c: any) => !String(c.id).startsWith("msg_"));
}

/* ==========================================================================
 * C0 — the sweep is the whole CHECK, not a sample of it
 * ========================================================================== */
describe("the sweep covers every contacts.source value (BACKLOG-3193)", () => {
  it("is exactly the nine values the CHECK admits", () => {
    expect([...UNFILTERABLE, ...ADDRESS_BOOK].sort()).toEqual([...PERSISTED_CONTACT_SOURCES].sort());
  });
});

/* ==========================================================================
 * C1 — both doors, by value
 * ========================================================================== */
describe("contacts:import will not save a contact no filter can find (BACKLOG-3193)", () => {
  it.each(UNFILTERABLE)("refuses %s, and lands nothing", async (source) => {
    const outcome = await importRecords([record(source)]);

    expect(outcome.refused).toBe(true);
    expect(rows()).toEqual([]);
    expect(originLinks()).toEqual([]);
  });

  it.each(ADDRESS_BOOK)("still stores %s unchanged", async (source) => {
    expect(await importRecords([record(source)])).toEqual({ refused: false, error: null });
    expect(rows()).toEqual([
      { id: expect.any(String), display_name: "Rosalind Quill", source },
    ]);
  });
});

describe("contacts:create will not save a contact no filter can find (BACKLOG-3193)", () => {
  it.each(UNFILTERABLE)("folds %s to manual, with a manual origin row", async (source) => {
    const outcome = await createContact({ ...record(source), id: undefined });

    expect(outcome).toEqual({ refused: false, error: null });
    expect(rows()).toEqual([
      { id: expect.any(String), display_name: "Rosalind Quill", source: "manual" },
    ]);
    expect(originLinks()).toEqual([{ source_type: "manual", match_method: "origin" }]);
  });

  it.each(ADDRESS_BOOK)("still stores %s unchanged", async (source) => {
    expect(await createContact({ ...record(source), id: undefined })).toEqual({
      refused: false,
      error: null,
    });
    expect(rows()).toEqual([
      { id: expect.any(String), display_name: "Rosalind Quill", source },
    ]);
  });
});

/* ==========================================================================
 * C1b — the import door's other writer: an already-saved row being imported
 * ==========================================================================
 * A record flagged `isFromDatabase` does not reach the insert. It reaches
 * `UPDATE contacts SET source = ?` through the import-marking facade on
 * `databaseService`, which this harness mocks. The source is decided once,
 * before the branch, so the refusal must fire before that call.
 *
 * THE SPY TARGET FOLLOWS WHICHEVER FACADE THE HANDLER CALLS — today
 * `markContactAsImported`. If the handler ever calls a differently named
 * facade, the "not called" rows would pass against a function nobody calls any
 * more. So the positive CONTROL sits in this same block: it asserts the SAME spy
 * IS called for an address-book value on the same branch. If the facade is
 * renamed and this spy is not, the CONTROL goes red, not green. Re-point both
 * together.
 */
describe("the isFromDatabase branch refuses before the import-marking write (BACKLOG-3193)", () => {
  const SAVED_ID = "saved-contact-3193";

  function markImportedSpy(): jest.Mock {
    return jest.requireMock("../services/databaseService").default.markContactAsImported;
  }

  it.each(UNFILTERABLE)("refuses %s without calling the import-marking facade", async (source) => {
    markImportedSpy().mockClear();

    const outcome = await importRecords([{ ...record(source), id: SAVED_ID, isFromDatabase: true }]);

    expect(outcome.refused).toBe(true);
    expect(markImportedSpy()).not.toHaveBeenCalled();
  });

  it("CONTROL: an address-book value on the same branch DOES reach the facade, with that value", async () => {
    markImportedSpy().mockClear();

    const outcome = await importRecords([
      { ...record("outlook"), id: SAVED_ID, isFromDatabase: true },
    ]);

    expect(outcome.refused).toBe(false);
    expect(markImportedSpy()).toHaveBeenCalledWith(SAVED_ID, "outlook");
  });
});

/* ==========================================================================
 * C2 — whatever a door saves is on screen under the DEFAULT selection
 * ==========================================================================
 * One record per call, as both live screens send it: a batch carrying one
 * refused record is refused whole, which would make a single ten-record call
 * prove nothing about the other nine.
 *
 * Asserted as an identity set of (source, display_name) — a door that saved
 * nothing, or saved the wrong person under the right source, cannot pass it.
 * Read through the real `getImportedContactsByUserId`: the projection AND
 * `attachLiveSources`, whose `source_types` the filter prefers over the scalar.
 */
describe("every contact a door saves is visible under the default filter (BACKLOG-3193)", () => {
  const INBOUND = [...PERSISTED_CONTACT_SOURCES, "messages"];

  it.each([
    [
      "contacts:import",
      (source: string, name: string) => importRecords([record(source, name)]),
      [
        ...ADDRESS_BOOK.map((s) => ({ source: s, display_name: `Person ${s}` })),
        { source: "manual", display_name: "Person messages" },
      ],
      UNFILTERABLE,
    ],
    [
      "contacts:create",
      (source: string, name: string) => createContact({ ...record(source, name), id: undefined }),
      [
        ...ADDRESS_BOOK.map((s) => ({ source: s, display_name: `Person ${s}` })),
        ...[...UNFILTERABLE, "messages"].map((s) => ({ source: "manual", display_name: `Person ${s}` })),
      ],
      [],
    ],
  ])("%s", async (_door, send, expectedSaved, expectedRefused) => {
    seedReadPathTables();

    const refused: string[] = [];
    for (const source of INBOUND) {
      const outcome = await send(source, `Person ${source}`);
      if (outcome.refused) refused.push(source);
    }

    const saved = await savedContacts();
    const identity = (c: { source: string; display_name: string }) => `${c.source}|${c.display_name}`;

    expect(refused.sort()).toEqual([...expectedRefused].sort());
    expect(saved.map(identity).sort()).toEqual(expectedSaved.map(identity).sort());
    expect(
      saved
        .filter((c) => !matchesSourceFilter(c, new Set(DEFAULT_SOURCE_SELECTION)))
        .map(identity),
    ).toEqual([]);
  });
});

/* ==========================================================================
 * C4 — the saved projection never calls a saved row message-derived
 * ==========================================================================
 * Rows are seeded straight into `contacts`, one per CHECK value. That is a
 * state no door can produce for `email`/`sms`/`inferred` any more, and it is a
 * state the CHECK still admits — an older database or a restored backup can
 * hold it. The claim under test is the projection's, not the doors'.
 */
describe("the imported-contacts projection keeps is_message_derived at 0 (BACKLOG-3193)", () => {
  it("for a saved row of every contacts.source value", async () => {
    seedReadPathTables();
    const seededIds = PERSISTED_CONTACT_SOURCES.map((source) => `seed-${source}`);
    for (const source of PERSISTED_CONTACT_SOURCES) {
      mockDb!
        .prepare(
          "INSERT INTO contacts (id, user_id, display_name, source, is_imported) VALUES (?, ?, ?, ?, 1)",
        )
        .run(`seed-${source}`, USER, `Seed ${source}`, source);
    }

    const saved = await savedContacts();

    expect(saved.map((c) => c.id).sort()).toEqual([...seededIds].sort());
    expect(saved.filter((c) => c.is_message_derived !== 0).map((c) => c.id)).toEqual([]);
  });
});
