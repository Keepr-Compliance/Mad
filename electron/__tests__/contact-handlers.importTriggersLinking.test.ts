/**
 * @jest-environment node
 *
 * BACKLOG-2474 — importing a contact must run the duplicate check, with NO
 * further sync.
 *
 * ---------------------------------------------------------------------------
 * THE FOUNDER'S ACCEPTANCE TEST, VERBATIM
 * ---------------------------------------------------------------------------
 * "Import a second record of a person already imported from another source.
 * Without any further sync, the review count must reflect it."
 *
 * Importing is the single action most likely to CREATE a duplicate: the user is
 * deliberately adding a second record of someone. Before this change nothing
 * looked for that duplicate until the next macOS sync — so on Windows, where
 * that sync never runs, the feature did not exist at all, and on macOS it
 * appeared only after an unrelated action the user had no reason to connect.
 *
 * ---------------------------------------------------------------------------
 * HOW THIS SUITE PROVES "WITHOUT A SYNC"
 * ---------------------------------------------------------------------------
 * `externalContactDbService` is mocked, so NO write to `external_contacts`
 * happens and therefore NO write-triggered signal can fire. `isStale` is false
 * and the shadow table is non-empty, so `contacts:get-available` takes neither
 * of its sync branches. `fullSync` is a jest.fn that would record a call if any
 * path reached it, and it is asserted to have none.
 *
 * Every proposal asserted below was therefore produced by the import itself.
 * The linker and the name rule are the REAL ones, against real SQLite.
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
  /**
   * A REAL TRANSACTION, NOT A PASSTHROUGH (BACKLOG-2537).
   *
   * This used to be `(fn) => fn()`. Every statement still ran and every caller
   * was still satisfied, so no test here changed colour — which is precisely
   * what made it dangerous. It is the exact mutant `syncSqliteDriver.transaction.test.ts`
   * exists to reject: it removes the atomicity while leaving the suite green.
   *
   * The consequence was not that some test was wrong today. It was that ANY
   * atomicity test written in this file tomorrow COULD NOT FAIL — the writes
   * would land, nothing would roll back, and the assertion would pass whether
   * or not the production path had a transaction at all.
   *
   * `TestDb.transaction()` is a real BEGIN/COMMIT/ROLLBACK (SAVEPOINT when
   * nested), pinned on both engines by BACKLOG-2368 and BACKLOG-2496.
   */
  dbTransaction: <T>(fn: () => T): T => mockDb!.transaction(fn)(),
  getDbPath: () => "/fake/path/mad.db",
  getEncryptionKey: () => "fake-key",
}));

let mockImportedContacts: any[] = [];
let mockShadowRows: any[] = [];

const createdContactIds: string[] = [];

jest.mock("../services/databaseService", () => ({
  __esModule: true,
  default: {
    getImportedContactsByUserIdAsync: jest.fn(() => Promise.resolve(mockImportedContacts)),
    getRemovedContactIdentifiers: jest.fn(() => Promise.resolve([])),
    getImportedContactsByUserId: jest.fn(() => Promise.resolve(mockImportedContacts)),
    getUnimportedContactsByUserId: jest.fn(() => Promise.resolve([])),
    getUserById: jest.fn((id: string) => Promise.resolve({ id })),
    isInitialized: jest.fn(() => true),
    backfillContactEmails: jest.fn(() => Promise.resolve(0)),
    backfillContactPhones: jest.fn(() => Promise.resolve(0)),
    markContactAsImported: jest.fn(() => Promise.resolve()),
    getContactById: jest.fn((id: string) =>
      Promise.resolve(mockDb!.prepare("SELECT * FROM contacts WHERE id = ?").get(id) ?? null),
    ),
    // Real rows: the crosswalk has a foreign key onto `contacts`, so invented
    // ids would let links be written that production would have rejected.
    createContactsBatch: jest.fn((rows: any[]) => {
      const ids: string[] = [];
      rows.forEach((row, i) => {
        const id = `created-${createdContactIds.length + i}-${row.display_name
          .replace(/\W+/g, "-")
          .toLowerCase()}`;
        mockDb!
          .prepare(
            "INSERT INTO contacts (id, user_id, display_name, source, is_imported) VALUES (?, ?, ?, ?, 1)",
          )
          .run(id, row.user_id, row.display_name, row.source ?? "contacts_app");
        ids.push(id);
      });
      createdContactIds.push(...ids);
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

/** Windows: no macOS, no iPhone. The import must work here too. */
let macosEnabled = false;
let iphoneEnabled = false;
jest.mock("../utils/preferenceHelper", () => ({
  __esModule: true,
  isContactSourceEnabled: jest.fn((_userId: string, _kind: string, key: string) => {
    if (key === "macosContacts") return Promise.resolve(macosEnabled);
    if (key === "iphone" || key === "iphoneContacts") return Promise.resolve(iphoneEnabled);
    return Promise.resolve(true);
  }),
}));

jest.mock("../services/outlookFetchService", () => ({
  __esModule: true,
  default: { initialize: jest.fn(), fetchContacts: jest.fn() },
}));

const fullSync = jest.fn();
jest.mock("../services/db/externalContactDbService", () => ({
  __esModule: true,
  getCount: jest.fn(() => mockShadowRows.length),
  getAllForUser: jest.fn(() => mockShadowRows),
  getAllForUserAsync: jest.fn(() => Promise.resolve(mockShadowRows)),
  // Never stale, never empty — NO SYNC MAY RUN.
  isStale: jest.fn(() => false),
  fullSync,
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

function shadowRow(recordId: string, name: string, source: string, emails: string[], phones: string[]) {
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

/**
 * Put the same rows in the REAL `external_contacts` table.
 *
 * `externalContactDbService` is mocked here so that no sync can run, but the
 * matching pass does not go through that service — `collectNameGroups` reads
 * `external_contacts` directly. In production those are the same rows; a
 * fixture that populated only the mock would leave the pass looking at an empty
 * table and every assertion below would pass for the wrong reason (nothing to
 * match rather than nothing triggering the match).
 */
function seedShadowTable(): void {
  const stmt = mockDb!.prepare(
    `INSERT INTO external_contacts
      (id, user_id, name, phones_json, phones_normalized_json, emails_json, company, external_record_id, source, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
  );
  for (const row of mockShadowRows) {
    stmt.run(
      row.id,
      row.user_id,
      row.name,
      JSON.stringify(row.phones ?? []),
      JSON.stringify(row.phones ?? []),
      JSON.stringify(row.emails ?? []),
      row.external_record_id,
      row.source,
      row.synced_at,
    );
  }
}

/** The picker's rows, exactly as the renderer receives them. */
async function getAvailable(): Promise<any[]> {
  const result = await registeredHandlers.get("contacts:get-available")(mockEvent, USER);
  expect(result.success).toBe(true);
  return result.contacts as any[];
}

/**
 * Import the rows the renderer would have sent — the SAME objects
 * `getAvailable` returned, filtered, never rebuilt.
 */
async function importRows(rows: any[]): Promise<void> {
  const result = await registeredHandlers.get("contacts:import")(mockEvent, USER, rows);
  if (!result.success) throw new Error(`import failed: ${result.error}`);
}

function reviewQueueCount(): number {
  const row = mockDb!
    .prepare("SELECT COUNT(*) n FROM contact_link_proposals WHERE user_id = ?")
    .get(USER) as { n: number };
  return row.n;
}

function proposalTriples(): string[] {
  return (
    mockDb!
      .prepare(
        "SELECT contact_id, source_type, source_record_id FROM contact_link_proposals WHERE user_id = ?",
      )
      .all(USER) as Array<{ contact_id: string; source_type: string; source_record_id: string }>
  )
    .map((p) => `${p.contact_id}/${p.source_type}/${p.source_record_id}`)
    .sort();
}

function contactIdByName(name: string): string {
  const row = mockDb!
    .prepare("SELECT id FROM contacts WHERE user_id = ? AND display_name = ?")
    .get(USER, name) as { id: string } | undefined;
  if (!row) throw new Error(`no saved contact named ${name}`);
  return row.id;
}

beforeEach(() => {
  mockDb = openTestDb();
  mockDb.exec(CONTACT_IDENTITY_SCHEMA);
  mockImportedContacts = [];
  mockShadowRows = [];
  createdContactIds.length = 0;
  macosEnabled = false;
  iphoneEnabled = false;
  fullSync.mockClear();
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

describe("importing a duplicate", () => {
  it("files the review question immediately, with no sync of any kind", async () => {
    // Juan is already saved, imported earlier from Outlook and crosswalked.
    mockDb!
      .prepare(
        "INSERT INTO contacts (id, user_id, display_name, source, is_imported) VALUES (?, ?, ?, ?, 1)",
      )
      .run("c-out", USER, "Pat Riverton", "outlook");
    mockDb!
      .prepare(
        `INSERT INTO contact_source_links (id, user_id, contact_id, source_type, source_record_id, match_method, created_at)
         VALUES ('l1', ?, 'c-out', 'outlook', 'out-juan', 'source_id', '2026-08-04T00:00:00.000Z')`,
      )
      .run(USER);

    // The picker offers his OTHER record — same name, no shared identifier.
    //
    // macOS + Outlook, the founder's literal reported case. The two must be in
    // DIFFERENT source families for a cross-source identity question to exist
    // at all: agreement within one family is a duplicate, a different problem
    // (BACKLOG-2370). macos/iphone/android_sync are "phone"; outlook and
    // google_contacts are both "email".
    //
    // That constraint is why this test is not the Windows case. A Windows
    // user's only phone-family source is `android_sync`, and the picker drops
    // it — see the FINDING in the PR description, `contactHandlers.ts:1399`.
    // The Windows proof therefore lives in
    // `contact-handlers.universalLinking.test.ts`, which drives the writers
    // directly and does not go through the picker.
    macosEnabled = true;
    mockShadowRows = [
      shadowRow("mac-juan", "Pat Riverton", "macos", [], ["+14085550106"]),
      shadowRow("out-juan", "Pat Riverton", "outlook", ["patriverton@example.com"], []),
    ];
    seedShadowTable();

    expect(reviewQueueCount()).toBe(0);

    // out-juan is already imported, so the picker offers only the macOS record.
    const rows = await getAvailable();
    // The picker labels a macOS record `contacts_app`; the crosswalk keeps the
    // underlying `macos` source type, which is what the assertions below use.
    expect(rows.map((r) => `${r.source}/${r.name}`)).toEqual([
      "contacts_app/Pat Riverton",
    ]);

    await importRows(rows);

    // NO SYNC RAN — this is what makes the assertion below meaningful.
    expect(fullSync).not.toHaveBeenCalled();

    // The questions exist the moment the import returns, and they are the RIGHT
    // ones: each saved contact against the OTHER source's record. Exact set, so
    // this cannot pass by filing a question about the wrong pair.
    const newContactId = createdContactIds[0];
    expect(proposalTriples()).toEqual(
      [`c-out/macos/mac-juan`, `${newContactId}/outlook/out-juan`].sort(),
    );
    expect(reviewQueueCount()).toBe(2);
  });

  it("asks nothing when the imported contact is a different person", async () => {
    // Discriminating control: the same wiring must not invent a question.
    mockDb!
      .prepare(
        "INSERT INTO contacts (id, user_id, display_name, source, is_imported) VALUES (?, ?, ?, ?, 1)",
      )
      .run("c-out", USER, "Pat Riverton", "outlook");
    mockDb!
      .prepare(
        `INSERT INTO contact_source_links (id, user_id, contact_id, source_type, source_record_id, match_method, created_at)
         VALUES ('l1', ?, 'c-out', 'outlook', 'out-juan', 'source_id', '2026-08-04T00:00:00.000Z')`,
      )
      .run(USER);

    mockShadowRows = [
      shadowRow("goo-maria", "Robin Marsh", "google_contacts", ["robin@example.com"], []),
      shadowRow("out-juan", "Pat Riverton", "outlook", ["patriverton@example.com"], []),
    ];
    seedShadowTable();

    const rows = await getAvailable();
    const mariaRow = rows.find((r) => r.name === "Robin Marsh");
    expect(mariaRow).toBeDefined();

    await importRows([mariaRow]);

    expect(fullSync).not.toHaveBeenCalled();
    expect(proposalTriples()).toEqual([]);
  });
});
