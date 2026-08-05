/**
 * @jest-environment node
 *
 * BACKLOG-2459 — the picker says what it folded away.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SUITE IS IN THE MAIN PROCESS
 * ---------------------------------------------------------------------------
 * The founder watched `picker: 1126 in -> dup-suppressed 21 -> shown 1105` and
 * said *"i like that we do dedup upon import but a user must have a way to see
 * that"*. That decision is made HERE, in `contacts:get-available`. The losing
 * record hits a `continue` and never enters `availableContacts`, so it is not
 * merely hidden from the screen — it is absent from the array the renderer
 * receives, and no renderer-side pass can name what it never got.
 *
 * A first attempt instrumented the renderer's own dedup pass instead. Its unit
 * tests passed, because they fed raw duplicates straight into a pure function;
 * on the real data path that pass runs over a list the suppressed records had
 * already been removed from, and since `findDuplicateOwner` here applies the
 * same email and phone rules, it would have found almost nothing.
 *
 * So these assertions run the REAL handler over a corpus shaped like the
 * founder's — several address books, the same people in more than one of them —
 * and check what comes out the other side of the IPC boundary.
 *
 * Assertions are on exact identity SETS. A count would pass while naming the
 * wrong people, which on a surface where a contact is a party to an audit is the
 * failure that matters.
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
  dbTransaction: <T>(fn: () => T): T => fn(),
  getDbPath: () => "/fake/path/mad.db",
  getEncryptionKey: () => "fake-key",
}));

let mockImportedContacts: any[] = [];
let mockShadowRows: any[] = [];
let mockUnimportedDbContacts: any[] = [];

jest.mock("../services/databaseService", () => ({
  __esModule: true,
  default: {
    getImportedContactsByUserIdAsync: jest.fn(() => Promise.resolve(mockImportedContacts)),
    getRemovedContactIdentifiers: jest.fn(() => Promise.resolve([])),
    getImportedContactsByUserId: jest.fn(() => Promise.resolve(mockImportedContacts)),
    getUnimportedContactsByUserId: jest.fn(() => Promise.resolve(mockUnimportedDbContacts)),
    getUserById: jest.fn((id: string) => Promise.resolve({ id })),
    isInitialized: jest.fn(() => true),
    backfillContactEmails: jest.fn(() => Promise.resolve(0)),
    backfillContactPhones: jest.fn(() => Promise.resolve(0)),
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
  getCount: jest.fn(() => mockShadowRows.length),
  getAllForUser: jest.fn(() => mockShadowRows),
  getAllForUserAsync: jest.fn(() => Promise.resolve(mockShadowRows)),
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
  default: { registerProvider: jest.fn(), sync: jest.fn() },
}));

jest.mock("../workers/contactWorkerPool", () => ({
  __esModule: true,
  isPoolReady: jest.fn(() => false),
  queryContacts: jest.fn(() => Promise.resolve([])),
}));

import { registerContactHandlers } from "../handlers/contactHandlers";

const USER = "550e8400-e29b-41d4-a716-446655440000";
const mockEvent = {} as IpcMainInvokeEvent;

// ---------------------------------------------------------------------------
// FIXTURES — reserved ranges only (RFC 2606 domains, +1 555 01xx numbers).
// ---------------------------------------------------------------------------

/** A shadow-table row as `getAllForUserAsync` returns it. */
function shadowRow(
  recordId: string,
  name: string,
  source: string,
  emails: string[],
  phones: string[],
) {
  return {
    id: `ext-${recordId}`,
    user_id: USER,
    name,
    phones,
    emails,
    company: null,
    source,
    external_record_id: recordId,
    external_uuid: null,
    last_message_at: null,
    synced_at: "2026-08-04T00:00:00.000Z",
  };
}

interface PickerRow {
  id: string;
  name: string | null;
  absorbedRecords?: Array<{
    label: string | null;
    sourceLabel: string | null;
    matchedOn: string;
    matchedValue: string;
  }>;
}

async function picker(): Promise<PickerRow[]> {
  const handler = registeredHandlers.get("contacts:get-available");
  const result = await handler(mockEvent, USER);
  expect(result.success).toBe(true);
  return result.contacts as PickerRow[];
}

/** Row name -> the exact labels folded into it. The identity set, not a count. */
function disclosureByRow(rows: PickerRow[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const row of rows) {
    if (!row.absorbedRecords?.length) continue;
    out[row.name ?? "(no name)"] = row.absorbedRecords.map((r) => r.label ?? "(no name)");
  }
  return out;
}

beforeEach(() => {
  mockDb = openTestDb();
  mockDb.exec(CONTACT_IDENTITY_SCHEMA);
  mockImportedContacts = [];
  mockShadowRows = [];
  mockUnimportedDbContacts = [];
  registeredHandlers.clear();
  registerContactHandlers({} as any);
});

afterEach(() => {
  mockDb?.close();
  mockDb = null;
});

// ===========================================================================
describe("BACKLOG-2459 — every record the picker suppresses is disclosed", () => {
  /**
   * The founder's corpus in miniature: the same people held in more than one
   * address book, which is the shape that produced `dup-suppressed 21`.
   */
  beforeEach(() => {
    mockShadowRows = [
      // Alice is in the Mac address book AND in Outlook, on one email.
      shadowRow("mac-alice", "Alice Example", "macos", ["alice@example.test"], []),
      shadowRow("out-alice", "Alice E", "outlook", ["ALICE@example.test"], []),
      // Bea is on one number, written two ways, in two books.
      shadowRow("mac-bea", "Bea Example", "macos", [], ["+1 (415) 555-0177"]),
      shadowRow("gc-bea", "Bea Example", "google_contacts", [], ["4155550177"]),
      // Cleo and Dov share an office line and are NOT the same person.
      shadowRow("mac-cleo", "Cleo Example", "macos", [], ["+1 (415) 555-0100"]),
      shadowRow("mac-dov", "Dov Example", "macos", [], ["+1 (415) 555-0100"]),
      // Fenn appears once and is nobody's duplicate.
      shadowRow("mac-fenn", "Fenn Example", "macos", ["fenn@example.test"], []),
    ];
  });

  it("surfaces the suppressed records, attributed to the row that absorbed them", async () => {
    const rows = await picker();

    // Seven records in, five rows out — two were folded away.
    expect(rows.map((r) => r.name).sort()).toEqual([
      "Alice Example",
      "Bea Example",
      "Cleo Example",
      "Dov Example",
      "Fenn Example",
    ]);

    // And the screen can now say exactly which records went where.
    expect(disclosureByRow(rows)).toEqual({
      "Alice Example": ["Alice E"],
      "Bea Example": ["Bea Example"],
    });
  });

  it("names the address book each folded record came from, and the agreed detail", async () => {
    const rows = await picker();

    const alice = rows.find((r) => r.name === "Alice Example");
    expect(alice?.absorbedRecords).toEqual([
      {
        label: "Alice E",
        // In words, resolved here — the renderer's own source vocabulary has no
        // member for `outlook`-the-address-book at all.
        sourceLabel: "Outlook contacts",
        matchedOn: "email",
        // As SAVED on the losing record, not the lowercased comparison key.
        matchedValue: "ALICE@example.test",
      },
    ]);

    const bea = rows.find((r) => r.name === "Bea Example");
    expect(bea?.absorbedRecords).toEqual([
      {
        label: "Bea Example",
        sourceLabel: "Google contacts",
        matchedOn: "phone",
        // The formatting the losing record actually carried.
        matchedValue: "4155550177",
      },
    ]);
  });

  it("discloses nothing on rows that absorbed nothing", async () => {
    const rows = await picker();

    for (const name of ["Cleo Example", "Dov Example", "Fenn Example"]) {
      const row = rows.find((r) => r.name === name);
      expect(row).toBeDefined();
      // Absent, not an empty array — the row renders nothing without a check.
      expect(row?.absorbedRecords).toBeUndefined();
    }
  });

  it("never reports a collapse the picker refused to make (BACKLOG-2416)", async () => {
    // Cleo and Dov share an office line with incompatible names. Two rows
    // survive and neither claims to stand for the other — a disclosure here
    // would be advertising a merge that did not happen, on a screen where that
    // reads as a compliance error.
    const rows = await picker();

    expect(rows.find((r) => r.name === "Cleo Example")?.absorbedRecords).toBeUndefined();
    expect(rows.find((r) => r.name === "Dov Example")?.absorbedRecords).toBeUndefined();
  });

  it("discloses a suppressed LOCAL contact too, with no address book to name", async () => {
    // Rows from the local `contacts` table carry no source record, so BACKLOG-2458
    // has nothing to hand the import. The user still loses a row, so they are
    // still told — with the source clause omitted rather than guessed.
    mockShadowRows = [];
    mockUnimportedDbContacts = [
      {
        id: "db-1",
        user_id: USER,
        name: "Gus Example",
        display_name: "Gus Example",
        email: "gus@example.test",
        phone: null,
        company: null,
        source: "contacts_app",
        last_communication_at: null,
      },
      {
        id: "db-2",
        user_id: USER,
        name: "Gus Example",
        display_name: "Gus Example",
        email: "GUS@example.test",
        phone: null,
        company: null,
        source: "contacts_app",
        last_communication_at: null,
      },
    ];

    const rows = await picker();

    expect(rows.map((r) => r.id)).toEqual(["db-1"]);
    expect(rows[0].absorbedRecords).toEqual([
      {
        label: "Gus Example",
        sourceLabel: null,
        matchedOn: "email",
        matchedValue: "GUS@example.test",
      },
    ]);
  });

  it("keeps the disclosure in step with the funnel counter it explains", async () => {
    // The count the founder saw and the records now shown must come from the
    // same event. If a suppression ever incremented the counter without
    // recording a record, the screen would under-report the collapse exactly
    // where it is being trusted to report it.
    const rows = await picker();

    const disclosed = rows.reduce((n, r) => n + (r.absorbedRecords?.length ?? 0), 0);
    const suppressed = mockShadowRows.length - rows.length;

    expect(disclosed).toBe(suppressed);
    expect(disclosed).toBeGreaterThan(0);
  });
});
