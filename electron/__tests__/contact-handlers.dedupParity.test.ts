/**
 * @jest-environment node
 *
 * BACKLOG-2416, closed by BACKLOG-2370 — THERE IS NOW ONE RULE, SO THERE IS
 * NOTHING LEFT TO KEEP IN PARITY.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SUITE USED TO BE, AND WHY IT CHANGED
 * ---------------------------------------------------------------------------
 * The BACKLOG-2416 defect was never that either rule was wrong in isolation. It
 * was that there were TWO. `contactHandlers` required `namesAreCompatible`
 * before a shared phone could collapse two records; the renderer's
 * `contactPickerList` matched on the phone unconditionally. Both suites were
 * green; the disagreement lived in the gap between them. This suite existed to
 * run THE SAME PAIR through BOTH layers and compare the verdicts.
 *
 * It also recorded one case where the layers still disagreed — two records
 * carrying a name and nothing else — and said, in as many words, that
 * reconciling them "IS A FOUNDER DECISION, not something to settle inside a bug
 * fix", because it means either resurrecting name matching in the backend or
 * removing it from the renderer, and each has a real cost.
 *
 * ---------------------------------------------------------------------------
 * THE DECISION, 2026-08-04
 * ---------------------------------------------------------------------------
 * The founder was shown the second rule and chose removal: *"ok sounds good we
 * can remove it then simple is better."* His reasoning is the product's — a
 * combination worth showing a user is worth STORING, and once stored it is a
 * link. The renderer's pass stored nothing, so a merge it made could not be
 * audited, undone or explained, and on 2026-08-04 it silently reversed an unlink
 * he had just performed.
 *
 * So the question this suite asked is now answered by subtraction. Parity is no
 * longer something to check pair by pair; it is structural. What is worth
 * pinning is the property that replaced it, and there are exactly two halves:
 *
 *   1. The BACKEND rule still behaves exactly as BACKLOG-2416 left it. Every
 *      case below is the ORIGINAL case with the same expectation — an office
 *      line, an abbreviated spelling, a generational suffix, a shared email with
 *      incompatible names. If the founder's decision had been reversed onto the
 *      backend instead, these would move.
 *   2. The RENDERER applies NO rule. It is handed a set and returns that set.
 *
 * Together those say what "one matching rule" means operationally: the only
 * thing that can remove a record is the main process, and what it removes it
 * records.
 *
 * `contact-handlers.oneMatchingRule.test.ts` pins the consequence end to end,
 * including the released-record case that made the decision necessary.
 * `contactNameCompat.parity.test.ts` still pins the shared NAME rule, which the
 * backend continues to consume.
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
    getRemovedContactIdentifiers: jest.fn(() => Promise.resolve([])),
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
// The REAL renderer assembly. It cannot import from `electron/`, and this suite
// is the only place both halves are loaded at once.
import { assembleContacts } from "../../src/utils/contactPickerList";

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

/**
 * The source record ids the RENDERER keeps, sorted.
 *
 * Since BACKLOG-2370 this is simply "all of them, by id". It is still driven
 * through the real `assembleContacts` rather than replaced with `records.map` —
 * the point of the assertions below is that the renderer applies no rule, and
 * that is only worth stating if the real function is the thing being asked.
 */
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
  return assembleContacts([], externals)
    .map((c) => c.id)
    .sort();
}

/**
 * The BACKEND keeps exactly `expected`, and the RENDERER keeps everything it is
 * given.
 *
 * These are no longer the same assertion, and that asymmetry is the point. The
 * renderer is checked against `everyRecord` — the full input — so a dedup rule
 * reappearing in that layer turns this red no matter which shape it matches on.
 */
async function assertOneRuleDecides(records: Record[], expected: string[]): Promise<void> {
  const backend = await backendKeeps(records);
  const renderer = rendererKeeps(records);
  const everyRecord = records.map((r) => r.recordId).sort();
  expect({ backend, renderer }).toEqual({ backend: expected, renderer: everyRecord });
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
describe("BACKLOG-2370 — the backend decides, and the renderer decides nothing", () => {
  /**
   * NEGATIVE CONTROL (executed, output in the PR): restore any dedup rule to
   * `contactPickerList.assembleContacts` and every case here goes red on the
   * `renderer` half, naming the records that layer removed.
   *
   * Each case keeps its ORIGINAL BACKLOG-2416 backend expectation, so this suite
   * still fails if the backend rule drifts — which is the half of the old parity
   * guarantee that is still meaningful.
   */
  it("two people on one office line: the backend keeps BOTH", async () => {
    await assertOneRuleDecides(
      [
        { recordId: "chen", name: "Margaret Chen", source: "macos", emails: [], phones: ["(415) 555-0102"] },
        { recordId: "torres", name: "Margaret Torres", source: "outlook", emails: [], phones: ["415-555-0102"] },
      ],
      ["chen", "torres"],
    );
  });

  it("the same person twice on one line: the backend keeps ONE", async () => {
    await assertOneRuleDecides(
      [
        { recordId: "chen-mac", name: "Margaret Chen", source: "macos", emails: [], phones: ["(415) 555-0102"] },
        { recordId: "chen-out", name: "Margaret Chen", source: "outlook", emails: [], phones: ["415-555-0102"] },
      ],
      ["chen-mac"],
    );
  });

  it("an abbreviated spelling on one line: the backend keeps ONE", async () => {
    await assertOneRuleDecides(
      [
        { recordId: "chen-full", name: "Margaret Chen", source: "macos", emails: [], phones: ["(415) 555-0102"] },
        { recordId: "chen-abbrev", name: "Margaret C.", source: "outlook", emails: [], phones: ["415-555-0102"] },
      ],
      ["chen-full"],
    );
  });

  it("a generational suffix on one line: the backend keeps BOTH", async () => {
    // Jr never collapses into Sr (catalogue L6).
    await assertOneRuleDecides(
      [
        { recordId: "sr", name: "Robert King Sr", source: "macos", emails: [], phones: ["(415) 555-0100"] },
        { recordId: "jr", name: "Robert King Jr", source: "outlook", emails: [], phones: ["415-555-0100"] },
      ],
      ["jr", "sr"],
    );
  });

  it("a shared email with INCOMPATIBLE names: the backend keeps ONE", async () => {
    // Email is a strong identity signal and is deliberately NOT name-gated. The
    // asymmetry with the phone rule is now the backend's alone to hold.
    await assertOneRuleDecides(
      [
        { recordId: "a", name: "Margaret Chen", source: "macos", emails: ["office@brokerage.com"], phones: [] },
        { recordId: "b", name: "Margaret Torres", source: "outlook", emails: ["office@brokerage.com"], phones: [] },
      ],
      ["a"],
    );
  });

  it("no shared identifier at all: the backend keeps BOTH", async () => {
    await assertOneRuleDecides(
      [
        { recordId: "a", name: "Jane Seller", source: "outlook", emails: ["jane@realty.com"], phones: [] },
        { recordId: "b", name: "Jane Seller", source: "macos", emails: [], phones: ["(415) 555-0109"] },
      ],
      ["a", "b"],
    );
  });
});

// ===========================================================================
describe("BACKLOG-2370 — the name-only question, answered", () => {
  /**
   * ✅ RESOLVED. This described a real divergence, deliberately left as an open
   * question:
   *
   *   BACKEND  keeps both. `findDuplicateOwner` has no name-only branch;
   *            BACKLOG-2316 removed name matching outright because it hid
   *            distinct people who share a name (the two Margarets).
   *   RENDERER kept one, on the reasoning that a name is a last-resort identity
   *            when there is nothing else.
   *
   * BACKLOG-2370 answered it by removing the renderer's rule entirely, so the
   * backend's reading is now the only one. That is the same reading BACKLOG-2316
   * arrived at from field data, and it is the safer one HERE for a reason
   * specific to what these records are: a name-only address-book card has a
   * source pill and an id the user can select and assign, so hiding it removes a
   * REACHABLE record — while showing two cards that turn out to be one person
   * costs a duplicate row the user can see and act on.
   */
  it("name-only records: BOTH kept, by the backend, and the renderer hides neither", async () => {
    const records: Record[] = [
      { recordId: "nm-out", name: "Name Only", source: "outlook", emails: [], phones: [] },
      { recordId: "nm-mac", name: "Name Only", source: "macos", emails: [], phones: [] },
    ];

    // Was: backend ["nm-mac", "nm-out"], renderer ["nm-out"].
    await assertOneRuleDecides(records, ["nm-mac", "nm-out"]);
  });

  it("is NOT reachable from the import surface, which applies no renderer dedup", async () => {
    // ImportContactsModal — the only component that reaches `contacts:import` —
    // does not use `contactPickerList` at all; it filters `availableContacts`
    // inline on the search string.
    //
    // This assertion predates BACKLOG-2370 and is kept: wiring the picker list
    // into the import path is still a reasonable future tidy-up, and it must
    // still be a deliberate one rather than something that happens by accident.
    const modal = require("fs").readFileSync(
      require("path").join(
        __dirname,
        "../../src/components/contact/components/ImportContactsModal.tsx",
      ),
      "utf8",
    );
    expect(modal).not.toContain("contactPickerList");
    expect(modal).not.toContain("assembleDedupedContacts");
    expect(modal).not.toContain("assembleContacts");
  });
});
