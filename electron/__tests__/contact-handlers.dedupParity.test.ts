/**
 * @jest-environment node
 *
 * BACKLOG-2416 — THE PICKER AND THE BACKEND MUST ANSWER "IS THIS THE SAME
 * PERSON?" THE SAME WAY.
 *
 * ---------------------------------------------------------------------------
 * WHY A CROSS-LAYER SUITE AND NOT TWO SEPARATE ONES
 * ---------------------------------------------------------------------------
 * The defect was never that either rule was wrong in isolation. It was that
 * there were TWO rules. `contactHandlers`' dedup required `namesAreCompatible`
 * before a shared phone could collapse two records; the renderer's
 * `contactPickerList.matchesSeen` matched on the phone unconditionally. Both
 * suites were green. The disagreement lived in the gap between them, and only a
 * test that runs THE SAME PAIR through BOTH layers and compares the verdicts can
 * see it.
 *
 * `contactNameCompat.parity.test.ts` pins the shared NAME rule. This pins the
 * DEDUP DECISION that consumes it — the layer above, where the two
 * implementations still diverge if one is changed without the other.
 *
 * ---------------------------------------------------------------------------
 * WHAT "AGREE" MEANS HERE
 * ---------------------------------------------------------------------------
 * Given two external records and no saved contacts, both layers must offer the
 * same NUMBER OF DISTINCT PEOPLE, identified by which source records survive —
 * never by a count alone. The backend is driven through the real
 * `contacts:get-available` IPC handler; the renderer through the real
 * `assembleDedupedContacts`. Neither rule is reimplemented here.
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
  dbTransaction: <T,>(fn: () => T): T => fn(),
  getDbPath: () => "/fake/path/mad.db",
  getEncryptionKey: () => "fake-key",
}));

let mockShadowRows: any[] = [];

jest.mock("../services/databaseService", () => ({
  __esModule: true,
  default: {
    getImportedContactsByUserIdAsync: jest.fn(() => Promise.resolve([])),
    getImportedContactsByUserId: jest.fn(() => Promise.resolve([])),
    getUnimportedContactsByUserId: jest.fn(() => Promise.resolve([])),
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
// The REAL renderer rule. It cannot import from `electron/`, and this suite is
// the only place both halves are loaded at once.
import { assembleDedupedContacts } from "../../src/utils/contactPickerList";

const USER = "550e8400-e29b-41d4-a716-446655440000";
const mockEvent = {} as IpcMainInvokeEvent;

interface Record {
  recordId: string;
  name: string;
  source: string;
  emails: string[];
  phones: string[];
}

/** The source record ids the BACKEND picker keeps, sorted. */
async function backendKeeps(records: Record[]): Promise<string[]> {
  mockShadowRows = records.map((r) => ({
    id: `ext-${r.recordId}`,
    user_id: USER,
    name: r.name,
    phones: r.phones,
    emails: r.emails,
    company: null,
    source: r.source,
    external_record_id: r.recordId,
    external_uuid: null,
    last_message_at: null,
    synced_at: "2026-08-03T00:00:00.000Z",
  }));
  const handler = registeredHandlers.get("contacts:get-available");
  const result = await handler(mockEvent, USER);
  expect(result.success).toBe(true);
  return (result.contacts as Array<{ externalRecordId: string }>)
    .map((c) => c.externalRecordId)
    .sort();
}

/** The source record ids the RENDERER rule keeps, sorted. */
function rendererKeeps(records: Record[]): string[] {
  const externals = records.map(
    (r) =>
      ({
        id: r.recordId,
        name: r.name,
        display_name: r.name,
        email: r.emails[0] ?? null,
        phone: r.phones[0] ?? null,
        allEmails: r.emails,
        allPhones: r.phones,
      }) as never,
  );
  return assembleDedupedContacts([], externals)
    .map((c) => c.id)
    .sort();
}

/** Both layers, same input, same answer — or the test names which disagreed. */
async function assertLayersAgree(records: Record[], expected: string[]): Promise<void> {
  const backend = await backendKeeps(records);
  const renderer = rendererKeeps(records);
  expect({ backend, renderer }).toEqual({ backend: expected, renderer: expected });
}

beforeEach(() => {
  mockDb = openTestDb();
  mockDb.exec(CONTACT_IDENTITY_SCHEMA);
  mockShadowRows = [];
  registeredHandlers.clear();
  registerContactHandlers({
    isDestroyed: () => false,
    webContents: { send: jest.fn() },
  } as any);
});

afterEach(() => {
  mockDb?.close();
  mockDb = null;
});

// ===========================================================================
describe("BACKLOG-2416 — both layers give the same verdict on the same pair", () => {
  /**
   * NEGATIVE CONTROL (executed, output in the PR): revert
   * `contactPickerList.matchesSeen` to an unconditional phone match and the two
   * office-line cases go red, naming the renderer as the side that disagreed.
   */
  it("two people on one office line: BOTH kept, by both layers", async () => {
    await assertLayersAgree(
      [
        { recordId: "chen", name: "Margaret Chen", source: "macos", emails: [], phones: ["(415) 555-0000"] },
        { recordId: "torres", name: "Margaret Torres", source: "outlook", emails: [], phones: ["415-555-0000"] },
      ],
      ["chen", "torres"],
    );
  });

  it("the same person twice on one line: ONE kept, by both layers", async () => {
    await assertLayersAgree(
      [
        { recordId: "chen-mac", name: "Margaret Chen", source: "macos", emails: [], phones: ["(415) 555-0000"] },
        { recordId: "chen-out", name: "Margaret Chen", source: "outlook", emails: [], phones: ["415-555-0000"] },
      ],
      ["chen-mac"],
    );
  });

  it("an abbreviated spelling on one line: ONE kept, by both layers", async () => {
    await assertLayersAgree(
      [
        { recordId: "chen-full", name: "Margaret Chen", source: "macos", emails: [], phones: ["(415) 555-0000"] },
        { recordId: "chen-abbrev", name: "Margaret C.", source: "outlook", emails: [], phones: ["415-555-0000"] },
      ],
      ["chen-full"],
    );
  });

  it("a generational suffix on one line: BOTH kept, by both layers", async () => {
    // Jr never collapses into Sr (catalogue L6), on either side.
    await assertLayersAgree(
      [
        { recordId: "sr", name: "Robert King Sr", source: "macos", emails: [], phones: ["(415) 555-0100"] },
        { recordId: "jr", name: "Robert King Jr", source: "outlook", emails: [], phones: ["415-555-0100"] },
      ],
      ["jr", "sr"],
    );
  });

  it("a shared email with INCOMPATIBLE names: ONE kept, by both layers", async () => {
    // Email is a strong identity signal and is deliberately NOT name-gated —
    // the asymmetry with the phone rule has to be shared too, or the layers
    // disagree in the opposite direction.
    await assertLayersAgree(
      [
        { recordId: "a", name: "Margaret Chen", source: "macos", emails: ["office@brokerage.com"], phones: [] },
        { recordId: "b", name: "Margaret Torres", source: "outlook", emails: ["office@brokerage.com"], phones: [] },
      ],
      ["a"],
    );
  });

  it("no shared identifier at all: BOTH kept, by both layers", async () => {
    await assertLayersAgree(
      [
        { recordId: "a", name: "Jane Seller", source: "outlook", emails: ["jane@realty.com"], phones: [] },
        { recordId: "b", name: "Jane Seller", source: "macos", emails: [], phones: ["(415) 555-1234"] },
      ],
      ["a", "b"],
    );
  });
});

// ===========================================================================
describe("BACKLOG-2416 — the ONE case where the layers still disagree", () => {
  /**
   * ⚠️ OPEN QUESTION, RECORDED RATHER THAN GUESSED.
   *
   * Two records carrying a name and NOTHING ELSE — no email, no phone
   * (catalogue R7, which requires them to be kept and read).
   *
   *   BACKEND  keeps both. `findDuplicateOwner` has no name-only branch:
   *            BACKLOG-2316 removed name matching outright because it hid
   *            distinct people who share a name.
   *   RENDERER keeps one. `matchesSeen` has a `nameOnly` branch, guarded to
   *            contacts with no stronger token, on the reasoning that a name is
   *            a last-resort identity when there is nothing else.
   *
   * BOTH ARE DEFENSIBLE AND BACKLOG-2462 DOES NOT CHOOSE. Making them agree
   * means either resurrecting name matching in the backend or removing it from
   * the renderer, and each has a real cost — so it is a founder decision, not
   * something to settle inside a bug fix.
   *
   * This test asserts the divergence AS IT IS, so it is visible in a green
   * suite instead of hiding in the gap between two green suites. Deciding the
   * question turns it red, which is exactly when it should be rewritten.
   */
  it("name-only records: backend keeps BOTH, renderer keeps ONE", async () => {
    const records: Record[] = [
      { recordId: "nm-out", name: "Name Only", source: "outlook", emails: [], phones: [] },
      { recordId: "nm-mac", name: "Name Only", source: "macos", emails: [], phones: [] },
    ];

    expect(await backendKeeps(records)).toEqual(["nm-mac", "nm-out"]);
    expect(rendererKeeps(records)).toEqual(["nm-out"]);
  });

  it("is NOT reachable from the import surface, which applies no renderer dedup", async () => {
    // ImportContactsModal — the only component that reaches `contacts:import` —
    // does not use `contactPickerList` at all; it filters `availableContacts`
    // inline on the search string. So the divergence above cannot currently
    // cost a crosswalk row on the import path. It is a display difference on
    // the assignment surfaces, which reach `contacts:create` instead.
    //
    // This is asserted so that wiring the picker list INTO the import path — a
    // reasonable future tidy-up — cannot silently start dropping identities.
    const modal = require("fs").readFileSync(
      require("path").join(
        __dirname,
        "../../src/components/contact/components/ImportContactsModal.tsx",
      ),
      "utf8",
    );
    expect(modal).not.toContain("contactPickerList");
    expect(modal).not.toContain("assembleDedupedContacts");
  });
});
