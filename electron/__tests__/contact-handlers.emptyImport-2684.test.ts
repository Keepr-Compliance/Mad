/**
 * @jest-environment node
 *
 * BACKLOG-2684 — `contacts:import` must refuse a record with nothing on it.
 *
 * ---------------------------------------------------------------------------
 * WHY A RENDERER TEST WOULD PROVE NOTHING HERE
 * ---------------------------------------------------------------------------
 * BACKLOG-2672 already stops this import IN THE RENDERER: the button is
 * disabled and says why (`src/utils/importableRecord.ts`). The whole of this
 * item is the door behind that button. So every assertion below drives the
 * REGISTERED IPC HANDLER DIRECTLY — `registeredHandlers.get("contacts:import")`
 * — with no renderer in the picture at all. A test that went through
 * `ContactSearchList` would pass on the pre-fix tree and gate nothing.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE PRE-FIX TREE ACTUALLY DID, MEASURED RATHER THAN ASSUMED
 * ---------------------------------------------------------------------------
 * `contacts:import` already calls `validateContactData(record, false)`, which
 * requires a non-empty `name`. That refuses a LITERALLY empty `{}` — so the
 * item's phrase "an empty record" is not the whole story, and the interesting
 * shape is the one that gets PAST that check.
 *
 * The founder's own record is exactly that shape. `getMessageDerivedContacts`
 * projects `participants.$.from` into BOTH the name and the phone slot, and a
 * message with no resolvable handle gets the literal string `"unknown"` from
 * `sanitizeString(msg.handle_id, MAX_HANDLE_LENGTH, "unknown")`
 * (`macOSMessagesImportService.ts:909-913`). So the record arrives as
 * `{ name: "unknown", phone: "unknown" }` — a non-empty name as far as
 * `validateContactData` is concerned, and nothing at all as far as a human is
 * concerned.
 *
 * `contactHandlers.ts` then does `display_name: validatedData.name || "Unknown"`
 * and creates the nameless contact BACKLOG-2461 exists to eliminate.
 *
 * The pre-fix colours of every case below are recorded in the PR body and in
 * the Supabase comment. `SENTINEL_NAME_ONLY` and `SENTINEL_NAME_AND_PHONE` are
 * the two that were ACCEPTED before this change.
 *
 * ---------------------------------------------------------------------------
 * THE BOUNDARY THAT MUST NOT MOVE
 * ---------------------------------------------------------------------------
 * A record with NO NAME but WITH A PHONE stays importable. That is control 2 of
 * the founder's BACKLOG-2672 decision, 23 such records were parsed at his last
 * app start, and it is the leg a too-broad predicate breaks. It is asserted
 * here as well as in the renderer, because the guard added by this item is a
 * SECOND place that could break it.
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

const createdRows: Array<{ display_name: string }> = [];

jest.mock("../services/databaseService", () => ({
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
      Promise.resolve(mockDb!.prepare("SELECT * FROM contacts WHERE id = ?").get(id) ?? null),
    ),
    /**
     * REAL ROWS. The crosswalk has a foreign key onto `contacts`, so invented
     * ids would let links be written that production would have rejected — and
     * `display_name` is the field this item is about, so it is recorded rather
     * than discarded.
     */
    createContactsBatch: jest.fn((rows: any[]) => {
      const ids: string[] = [];
      rows.forEach((row, i) => {
        const id = `created-${createdRows.length + i}`;
        mockDb!
          .prepare(
            "INSERT INTO contacts (id, user_id, display_name, source, is_imported) VALUES (?, ?, ?, ?, 1)",
          )
          .run(id, row.user_id, row.display_name, row.source ?? "contacts_app");
        createdRows.push({ display_name: row.display_name });
        ids.push(id);
      });
      return ids;
    }),
  },
}));

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

const USER = "550e8400-e29b-41d4-a716-446655440000";
const mockEvent = {} as IpcMainInvokeEvent;

/**
 * Drive the IPC handler exactly as `contactBridge.ts` does, and report the
 * outcome in the one shape both a thrown ValidationError and a returned
 * `{success:false}` collapse to.
 *
 * Both are "refused" for this item's purposes — what matters is that the caller
 * is TOLD. A silently-dropped import is worse than a rejected one, so a
 * `{success:true}` that created nothing would NOT count as a refusal, and the
 * `rowsCreated` assertions below pin that.
 */
async function importRecords(
  records: unknown[],
): Promise<{ refused: boolean; error: string | null }> {
  try {
    const result = await registeredHandlers.get("contacts:import")(mockEvent, USER, records);
    return { refused: result.success !== true, error: result.error ?? null };
  } catch (e) {
    return { refused: true, error: e instanceof Error ? e.message : String(e) };
  }
}

function rowsCreated(): number {
  return (
    mockDb!.prepare("SELECT COUNT(*) n FROM contacts WHERE user_id = ?").get(USER) as {
      n: number;
    }
  ).n;
}

beforeEach(() => {
  mockDb = openTestDb();
  mockDb.exec(CONTACT_IDENTITY_SCHEMA);
  createdRows.length = 0;
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

describe("contacts:import refuses a record with nothing on it (BACKLOG-2684)", () => {
  /**
   * THE FOUNDER'S OWN RECORD, AND THE CASE THAT WAS ACCEPTED BEFORE THIS FIX.
   *
   * Measured on the pre-fix tree: `refused=false`, one row created. The literal
   * "unknown" is a non-empty string, so `validateContactData` waved it through
   * and `display_name: validatedData.name || "Unknown"` wrote it to the DB.
   */
  it("refuses the message-derived sentinel record — name and phone both 'unknown'", async () => {
    const outcome = await importRecords([
      { name: "unknown", display_name: "unknown", phone: "unknown", email: null, company: null },
    ]);

    expect(outcome.refused).toBe(true);
    expect(outcome.error).toMatch(/nothing to import/i);
    expect(rowsCreated()).toBe(0);
  });

  /** Also ACCEPTED pre-fix: `refused=false`, one row created. */
  it("refuses the 'Unknown Contact' sentinel with no other identifier", async () => {
    const outcome = await importRecords([{ name: "Unknown Contact" }]);

    expect(outcome.refused).toBe(true);
    expect(outcome.error).toMatch(/nothing to import/i);
    expect(rowsCreated()).toBe(0);
  });

  /**
   * Case and whitespace are part of the predicate, not decoration:
   * `realContactName` trims and lowercases before testing the sentinel set. A
   * record differing only in those must not slip past a guard the renderer
   * would have caught.
   */
  it("refuses a sentinel that differs only in case and whitespace", async () => {
    const outcome = await importRecords([{ name: "  UNKNOWN  ", phone: " unknown " }]);

    expect(outcome.refused).toBe(true);
    expect(outcome.error).toMatch(/nothing to import/i);
    expect(rowsCreated()).toBe(0);
  });

  it("refuses when the only identifiers are empty plural arrays", async () => {
    const outcome = await importRecords([
      { name: "unknown", allPhones: [], allEmails: [], company: "  " },
    ]);

    expect(outcome.refused).toBe(true);
    expect(outcome.error).toMatch(/nothing to import/i);
    expect(rowsCreated()).toBe(0);
  });

  /**
   * NOT A SILENT HALF-IMPORT. The batch is refused whole and the GOOD record in
   * it is not created either, so the caller retries without the bad row rather
   * than being left to guess which of the two landed.
   *
   * This is the leg that fails if the guard is implemented as `continue`.
   */
  it("refuses the whole batch rather than silently importing only the good record", async () => {
    const outcome = await importRecords([
      { name: "Dana Whitlock", phone: "5551234567" },
      { name: "unknown", phone: "unknown" },
    ]);

    expect(outcome.refused).toBe(true);
    expect(outcome.error).toMatch(/nothing to import/i);
    expect(rowsCreated()).toBe(0);
  });

  /** The reason names WHICH record, so a batch caller can act on it. */
  it("names the position of the refused record in the batch", async () => {
    const outcome = await importRecords([
      { name: "Dana Whitlock", phone: "5551234567" },
      { name: "unknown", phone: "unknown" },
    ]);

    expect(outcome.error).toMatch(/Record 2/);
  });

  it("still accepts an ordinary named record", async () => {
    const outcome = await importRecords([{ name: "Dana Whitlock", phone: "5551234567" }]);

    expect(outcome.refused).toBe(false);
    expect(rowsCreated()).toBe(1);
  });
});

/**
 * ===========================================================================
 * THE PREDICATE MUST NOT BE THE THING THAT REFUSES THESE
 * ===========================================================================
 * Control 2 of the founder's BACKLOG-2672 decision is that a record with NO
 * NAME but WITH a phone stays importable. Asserting `refused === false` here
 * would be WRONG, and measuring it is what proved that:
 *
 *   {name:"", phone:"+15551234567"}  ->  pre-fix: REFUSED, "name is required"
 *   {name:"", email:"d@e.com"}       ->  pre-fix: REFUSED, "name is required"
 *   {name:"", company:"Vantrees"}    ->  pre-fix: REFUSED, "name is required"
 *
 * `contacts:import` has ALWAYS refused those, because `validateContactData`
 * requires a non-empty `name`. That shape is not hypothetical — it is exactly
 * what `contacts:get-available` emits for an `external_contacts` row with an
 * empty `name`, transcribed from the real producer rather than invented:
 *
 *   { id:"ext-1", name:"", phone:"+15551234567", email:null, company:null,
 *     allPhones:["+15551234567"], allEmails:[], isFromDatabase:false, ... }
 *
 * So the boundary the 2672 decision names is ALREADY crossed in the main
 * process, and the renderer offers an Import button that the handler then
 * rejects. **That is a separate live defect, filed rather than fixed here** —
 * repairing it means deciding what `display_name` a nameless contact gets, and
 * `display_name: validatedData.name || "Unknown"` is BACKLOG-2461/2464
 * territory and a founder call.
 *
 * What these tests DO gate is the thing this PR could break: that the NEW
 * predicate is not too broad. Each record below must be refused by the
 * PRE-EXISTING name check and NOT by `hasNothingToImport` — so if someone
 * widens the predicate later, these go red.
 */
describe("the new predicate is not the thing refusing a nameless-but-identified record", () => {
  it("a record with no name but a phone is not refused by the import predicate", async () => {
    const outcome = await importRecords([
      {
        id: "ext-1",
        name: "",
        phone: "+15551234567",
        email: null,
        company: null,
        allPhones: ["+15551234567"],
        allEmails: [],
        isFromDatabase: false,
      },
    ]);

    expect(outcome.error).toMatch(/name is required/i);
    expect(outcome.error).not.toMatch(/nothing to import/i);
  });

  it("a record with no name but an email is not refused by the import predicate", async () => {
    const outcome = await importRecords([
      { name: "", email: "dana@example.com", allPhones: [], allEmails: ["dana@example.com"] },
    ]);

    expect(outcome.error).toMatch(/name is required/i);
    expect(outcome.error).not.toMatch(/nothing to import/i);
  });

  it("a company-only record is not refused by the import predicate", async () => {
    const outcome = await importRecords([{ name: "", company: "Vantrees Realty" }]);

    expect(outcome.error).toMatch(/name is required/i);
    expect(outcome.error).not.toMatch(/nothing to import/i);
  });
});
