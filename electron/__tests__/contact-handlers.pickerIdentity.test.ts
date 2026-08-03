/**
 * @jest-environment node
 *
 * BACKLOG-2416 + BACKLOG-2427 (second half) — what the import picker is allowed
 * to call "already imported".
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SUITE PINS
 * ---------------------------------------------------------------------------
 * Two defects with one cause: `contacts:get-available` inferred that a source
 * record belonged to a saved contact from A PHONE NUMBER ALONE
 * (`importedPhones.has(normalized)`), with no name check and no reference to
 * the crosswalk or to anything the user had said.
 *
 *   BACKLOG-2416  Two people on one office line hide each other. The backend's
 *                 own `isDuplicate` had always required `namesAreCompatible`
 *                 before a shared phone could collapse two records; this filter
 *                 did not, so the two layers disagreed about who is one person.
 *
 *   BACKLOG-2427  A record the user RELEASED with "Not this person" disappears
 *                 instead of becoming importable — it still carries the phone
 *                 the saved contact carries, so it reads as already imported.
 *                 Founder, 2026-08-02: *"Does the unlinked Outlook record
 *                 appear as its own person? no. i also went to the settings,
 *                 clicked the blue re-import button and still nothing."*
 *
 * ---------------------------------------------------------------------------
 * WHY THE CROSSWALK AND VERDICT READS ARE **NOT** MOCKED
 * ---------------------------------------------------------------------------
 * They are the thing under test. `getLinkedSourceKeys` and
 * `getRejectedSourceKeys` run for real against a real in-memory SQLite
 * (`node:sqlite`, the engine shipped inside Node 22 — the repo's
 * better-sqlite3 binary is an Electron build and cannot load under plain node).
 * So these assertions exercise the actual SQL that decides which records the
 * user has released, not a stub that says what the test wants to hear.
 *
 * Only the layers AROUND that decision — the saved-contact list and the shadow
 * table — are mocked, because they are the inputs, not the rule.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { IpcMainInvokeEvent } from "electron";
import { jest } from "@jest/globals";
import { CONTACT_IDENTITY_SCHEMA } from "../services/__tests__/helpers/contactIdentitySchema";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
type Db = InstanceType<typeof DatabaseSync>;

let mockDb: Db | null = null;

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

// REAL SQL for the crosswalk and the verdicts.
jest.mock("../services/db/core/dbConnection", () => ({
  ensureDb: () => mockDb,
  dbAll: (sql: string, params: unknown[] = []) =>
    mockDb!.prepare(sql).all(...(params as never[])),
  dbGet: (sql: string, params: unknown[] = []) =>
    mockDb!.prepare(sql).get(...(params as never[])),
  dbRun: (sql: string, params: unknown[] = []) => {
    const r = mockDb!.prepare(sql).run(...(params as never[]));
    return { lastInsertRowid: Number(r.lastInsertRowid), changes: Number(r.changes) };
  },
  dbTransaction: <T>(fn: () => T): T => fn(),
  getDbPath: () => "/fake/path/mad.db",
  getEncryptionKey: () => "fake-key",
}));

let mockImportedContacts: any[] = [];
let mockShadowRows: any[] = [];

jest.mock("../services/databaseService", () => ({
  __esModule: true,
  default: {
    getImportedContactsByUserIdAsync: jest.fn(() => Promise.resolve(mockImportedContacts)),
    getImportedContactsByUserId: jest.fn(() => Promise.resolve(mockImportedContacts)),
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
  // Never stale — no sync path may run, so the picker reads exactly what the
  // test seeded.
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
import { createLink, sourceKey } from "../services/db/contactSourceLinkDbService";
import {
  recordVerdict,
  getRejectedSourceKeys,
} from "../services/db/contactLinkReviewDbService";

const USER = "550e8400-e29b-41d4-a716-446655440000";
const mockEvent = {} as IpcMainInvokeEvent;

// The founder's case.
const PAUL = "contact-paul-dorian";
const PAUL_PHONE_E164 = "+14082104874";
const PAUL_PHONE_RAW = "(408) 210-4874";

// ---------------------------------------------------------------------------
// SEED HELPERS
// ---------------------------------------------------------------------------

/**
 * The saved contact's ROW, needed by the crosswalk's foreign key.
 *
 * The picker reads its saved contacts through the mocked service, but
 * `createLink` writes real SQL — so a link test needs the real row to exist.
 */
function seedContactRow(id: string, name: string): void {
  mockDb!
    .prepare("INSERT INTO contacts (id, user_id, display_name, is_imported) VALUES (?, ?, ?, 1)")
    .run(id, USER, name);
}

/** A saved contact as `getImportedContactsByUserIdAsync` returns it. */
function importedContact(id: string, name: string, phone: string | null, email: string | null) {
  return {
    id,
    user_id: USER,
    display_name: name,
    name,
    email,
    phone,
    company: null,
    allEmails: email ? [email] : [],
    allPhones: phone ? [phone] : [],
    is_imported: 1,
    last_communication_at: null,
  };
}

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
    synced_at: "2026-08-02T00:00:00.000Z",
  };
}

/** The names the picker actually offered, sorted. Identity, never a count. */
async function pickerNames(): Promise<string[]> {
  const handler = registeredHandlers.get("contacts:get-available");
  const result = await handler(mockEvent, USER);
  expect(result.success).toBe(true);
  return (result.contacts as Array<{ name: string }>).map((c) => c.name).sort();
}

beforeEach(() => {
  mockDb = new DatabaseSync(":memory:");
  mockDb.exec(CONTACT_IDENTITY_SCHEMA);
  mockImportedContacts = [];
  mockShadowRows = [];
  registeredHandlers.clear();
  registerContactHandlers({} as any);
});

afterEach(() => {
  mockDb?.close();
  mockDb = null;
});

// ===========================================================================
describe("BACKLOG-2427 — a released record comes back to the picker", () => {
  /**
   * THE FOUNDER'S SECOND HALF.
   *
   * Paul Dorian is saved and carries `4082104874`. The Outlook record he
   * rejected carries the same number and the SAME NAME, so neither a name rule
   * nor the BACKLOG-2427 removal can rescue it — the number is legitimately on
   * the still-linked macOS card. Only his recorded answer can.
   *
   * NEGATIVE CONTROL (executed, see PR): restore the phone-only filter
   * (`importedPhones.has(normalized)`) and the "reappears" case goes red with
   * an empty picker.
   */
  beforeEach(() => {
    mockImportedContacts = [
      importedContact(PAUL, "Paul Dorian", PAUL_PHONE_E164, "paul@pauljdorian.com"),
    ];
    mockShadowRows = [
      shadowRow("out-paul", "Paul Dorian", "outlook", ["dorian@bluespaces.com"], [PAUL_PHONE_RAW]),
    ];
  });

  it("hides the record while it is still linked to the contact", async () => {
    seedContactRow(PAUL, "Paul Dorian");
    createLink({
      userId: USER,
      contactId: PAUL,
      sourceType: "outlook",
      sourceRecordId: "out-paul",
      matchMethod: "email",
    });

    expect(await pickerNames()).toEqual([]);
  });

  it("hides the record on the shared phone when nothing has been said about it", async () => {
    // No link, no verdict. The phone matches and the names are compatible, so
    // this is a genuine "already imported" — the filter must still work.
    expect(await pickerNames()).toEqual([]);
  });

  it("OFFERS the record once the user has said it is a different person", async () => {
    recordVerdict({
      userId: USER,
      contactId: PAUL,
      sourceType: "outlook",
      sourceRecordId: "out-paul",
      identityVerdict: "different_people",
      reason: "manual_unlink",
      decidedBy: "provenance_unlink",
    });

    expect(await pickerNames()).toEqual(["Paul Dorian"]);
  });

  it("hides it again if the user changes their mind back", async () => {
    recordVerdict({
      userId: USER,
      contactId: PAUL,
      sourceType: "outlook",
      sourceRecordId: "out-paul",
      identityVerdict: "different_people",
      decidedBy: "provenance_unlink",
    });
    recordVerdict({
      userId: USER,
      contactId: PAUL,
      sourceType: "outlook",
      sourceRecordId: "out-paul",
      identityVerdict: "same_person",
      decidedBy: "review_queue",
    });

    expect(await pickerNames()).toEqual([]);
  });

  it("keeps a released record hidden if ANOTHER contact legitimately claims it", async () => {
    // Rejected from Paul, but the crosswalk says it belongs to someone else.
    // The crosswalk check runs first and must win — otherwise a rejection from
    // one contact would re-offer a record that is already imported as another.
    recordVerdict({
      userId: USER,
      contactId: PAUL,
      sourceType: "outlook",
      sourceRecordId: "out-paul",
      identityVerdict: "different_people",
      decidedBy: "provenance_unlink",
    });
    seedContactRow("some-other-contact", "Someone Else");
    createLink({
      userId: USER,
      contactId: "some-other-contact",
      sourceType: "outlook",
      sourceRecordId: "out-paul",
      matchMethod: "source_id",
    });

    expect(await pickerNames()).toEqual([]);
  });

  it("keys the release on the PAIR, so another source's identical id is unaffected", async () => {
    mockShadowRows.push(
      shadowRow("out-paul", "Paul Dorian", "google_contacts", [], [PAUL_PHONE_RAW]),
    );
    recordVerdict({
      userId: USER,
      contactId: PAUL,
      sourceType: "outlook",
      sourceRecordId: "out-paul",
      identityVerdict: "different_people",
      decidedBy: "provenance_unlink",
    });

    // Only the OUTLOOK record was released. The Google record with the same id
    // string is still suppressed by the shared phone.
    const handler = registeredHandlers.get("contacts:get-available");
    const result = await handler(mockEvent, USER);
    expect(
      (result.contacts as Array<{ source: string }>).map((c) => c.source),
    ).toEqual(["outlook"]);
    expect([...getRejectedSourceKeys(USER)]).toEqual([sourceKey("outlook", "out-paul")]);
  });
});

// ===========================================================================
describe("BACKLOG-2416 — two people on one office line", () => {
  /**
   * The disagreement SR measured: the picker matched on phone with no name
   * check while the backend's `isDuplicate` required `namesAreCompatible`.
   *
   * NEGATIVE CONTROL (executed, see PR): restore the phone-only filter and the
   * "distinct person" case goes red — Margaret Torres vanishes.
   */
  beforeEach(() => {
    mockImportedContacts = [
      importedContact("contact-chen", "Margaret Chen", "+14155550000", "chen@brokerage.com"),
    ];
  });

  it("still offers a DISTINCT person who shares the brokerage line", async () => {
    mockShadowRows = [
      shadowRow("mac-torres", "Margaret Torres", "macos", ["torres@brokerage.com"], [
        "(415) 555-0000",
      ]),
    ];

    expect(await pickerNames()).toEqual(["Margaret Torres"]);
  });

  it("still hides the SAME person recorded again on that line", async () => {
    // The other half of the rule, and the one a careless fix breaks: relaxing
    // the filter must not re-offer someone already imported.
    mockShadowRows = [
      shadowRow("mac-chen", "Margaret Chen", "macos", ["chen@brokerage.com"], ["(415) 555-0000"]),
    ];

    expect(await pickerNames()).toEqual([]);
  });

  it("still hides an abbreviated spelling of the same person", async () => {
    // "Margaret C." is prefix-compatible with "Margaret Chen".
    mockShadowRows = [
      shadowRow("mac-chen-abbrev", "Margaret C.", "macos", [], ["(415) 555-0000"]),
    ];

    expect(await pickerNames()).toEqual([]);
  });

  it("keeps BOTH distinct people when they arrive together on one line", async () => {
    mockShadowRows = [
      shadowRow("mac-torres", "Margaret Torres", "macos", ["torres@brokerage.com"], [
        "(415) 555-0000",
      ]),
      shadowRow("mac-okafor", "Margaret Okafor", "macos", ["okafor@brokerage.com"], [
        "(415) 555-0000",
      ]),
    ];

    expect(await pickerNames()).toEqual(["Margaret Okafor", "Margaret Torres"]);
  });

  it("still hides a record whose EMAIL matches an imported contact", async () => {
    // Email is a strong identity signal and is deliberately NOT name-gated.
    mockShadowRows = [
      shadowRow("mac-email", "M. Chen", "macos", ["chen@brokerage.com"], []),
    ];

    expect(await pickerNames()).toEqual([]);
  });
});
