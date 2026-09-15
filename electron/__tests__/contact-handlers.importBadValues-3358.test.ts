/**
 * @jest-environment node
 *
 * =============================================================================
 * BACKLOG-3358 — an address-book value the app cannot use no longer blocks the
 * import
 * =============================================================================
 * `contacts:import` validated each record's scalar `email`/`phone`, and on a
 * picker row those are the address book's FIRST email and FIRST phone. One card
 * whose first address has no dot after the `@` (`name@localhost`), or whose
 * first phone field is over 50 characters, was refused whole on every press.
 *
 * The founder's rule: save the values AS THE ADDRESS BOOK HAS THEM, with a
 * usable one first. Long names, companies and titles are cut. One counts-only
 * Sentry warning per import, after the commit. Add Contact and Edit still
 * refuse bad input.
 *
 * -----------------------------------------------------------------------------
 * THE FIXTURES COME FROM THE REAL PRODUCER
 * -----------------------------------------------------------------------------
 * Every address-book case is seeded through the REAL shadow writers
 * (`upsertFromMacOS` with the `MacOSContact` shape `contactsService` hands
 * `fullSync`, and `upsertFromOutlook` for a nameless record), read back through
 * the REAL `getAllForUser` → `toExternalContact` → `contacts:get-available`,
 * and the row that handler returns is the row imported. An earlier prototype
 * passed 71 of 71 checks on hand-built rows and failed on the real one: the
 * in-import link copy re-adds every value the shadow row holds, which a
 * hand-built row with no shadow row never exercises.
 *
 * Direct records remain only where no producer exists: a title (no picker
 * source carries one), a whitespace-padded address (`toExternalContact` trims
 * before the row), and a message-derived row (fields transcribed from
 * `getMessageDerivedContacts`' SELECT).
 *
 * -----------------------------------------------------------------------------
 * WHAT IS REAL
 * -----------------------------------------------------------------------------
 * The registered handlers; `createContactsBatch`, `createContact`,
 * `updateContactSync` and both backfill writers (delegated to the real
 * `contactDbService` against a real database); the shadow-table reader and
 * writer; the linking pass. Only sync triggers, the address-book reader, the
 * worker pool and Sentry are stubbed.
 *
 * No `setImmediate` polling: the in-import linking pass is awaited by the
 * handler itself, and the relaunch backfill (fire-and-forget inside
 * `contacts:get-all`) is awaited through a promise the phone-backfill spy
 * resolves.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { IpcMainInvokeEvent } from "electron";
import { CONTACT_IDENTITY_SCHEMA } from "../services/__tests__/helpers/contactIdentitySchema";
import { openTestDb, type TestDb } from "../services/__tests__/helpers/syncSqliteDriver";

let mockDb: TestDb | null = null;

/**
 * Test switches read inside the `databaseService` mock. Flags rather than
 * `mockImplementationOnce`, and reset in `beforeEach`: when a case's import is
 * refused before the batch (as it is on the pre-fix handler), a one-shot mock
 * would leak into the NEXT case and red it for the wrong reason.
 */
const mockSwitches = {
  /** `createContactsBatch` throws before writing anything. */
  batchThrows: false,
  /** After the real batch returns, arm the `contact_emails` insert trigger. */
  failNextEmailInsertAfterBatch: false,
  /** Resolved by the phone-backfill spy — see `relaunchBackfill`. */
  afterBackfillPhones: null as null | (() => void),
};

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
      backfillContactEmails: jest.fn((id: string, emails: string[], source: any) =>
        Promise.resolve(real.backfillContactEmailsSync(id, emails, source)),
      ),
      backfillContactPhones: jest.fn((id: string, phones: string[], source: any) => {
        const n = real.backfillContactPhonesSync(id, phones, source);
        mockSwitches.afterBackfillPhones?.();
        return Promise.resolve(n);
      }),
      markContactAsImported: jest.fn(() => Promise.resolve()),
      getContactById: jest.fn((id: string) =>
        Promise.resolve(
          mockDb!.prepare("SELECT * FROM contacts WHERE id = ?").get(id) ?? null,
        ),
      ),
      createContactsBatch: jest.fn((rows: any[]) => {
        if (mockSwitches.batchThrows) {
          mockSwitches.batchThrows = false;
          throw new Error("database is locked");
        }
        const ids = real.createContactsBatch(rows);
        if (mockSwitches.failNextEmailInsertAfterBatch) {
          mockSwitches.failNextEmailInsertAfterBatch = false;
          mockDb!.exec("INSERT INTO fail_email_insert_arm (v) VALUES (1)");
        }
        return ids;
      }),
      createContact: jest.fn((data: any, origin: any) => real.createContact(data, origin)),
      updateContactSync: jest.fn((id: string, updates: any) =>
        real.updateContactSync(id, updates),
      ),
    },
  };
});

jest.mock("@sentry/electron/main", () => ({
  captureMessage: jest.fn(),
  captureException: jest.fn(),
  addBreadcrumb: jest.fn(),
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

// The REAL shadow-table reader and writer. Only the sync triggers are stubbed.
jest.mock("../services/db/externalContactDbService", () => ({
  ...(jest.requireActual("../services/db/externalContactDbService") as object),
  isStale: jest.fn(() => false),
  fullSync: jest.fn(),
  syncOutlookContacts: jest.fn(),
  updateLastMessageAtFromLookupTable: jest.fn(() => 0),
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

import * as SentryMock from "@sentry/electron/main";
import databaseServiceMock from "../services/databaseService";
import logServiceMock from "../services/logService";
import { upsertFromMacOS, upsertFromOutlook } from "../services/db/externalContactDbService";
import { registerContactHandlers, resetContactSessionState } from "../handlers/contactHandlers";
import {
  __resetContactLinkingScheduler,
  cancelPendingContactLinking,
} from "../services/contactLinkingScheduler";
import { importRefusalReason } from "../utils/importableRecord";

// RFC 4122 example value, not from any live row.
const USER = "550e8400-e29b-41d4-a716-446655440000"; // pii-allow-uuid: RFC 4122 example value
const mockEvent = {} as IpcMainInvokeEvent;
const captureMessage = (SentryMock as any).captureMessage as jest.Mock;
const batchSpy = (databaseServiceMock as any).createContactsBatch as jest.Mock;

async function call(channel: string, ...args: unknown[]): Promise<any> {
  return registeredHandlers.get(channel)(mockEvent, ...args);
}

/** Seed through the REAL macOS shadow writer (the shape `contactsService` hands `fullSync`). */
function seedMac(
  recordId: string,
  name: string,
  emails: string[],
  phones: string[] = [],
  company?: string,
): void {
  upsertFromMacOS(USER, [{ name, emails, phones, company, recordId, externalUuid: null }]);
  cancelPendingContactLinking(USER);
}

function seedOutlook(recordId: string, name: string | null, emails: string[]): void {
  upsertFromOutlook(USER, [
    { external_record_id: recordId, name, emails, phones: [], company: null },
  ]);
  cancelPendingContactLinking(USER);
}

/** The picker row exactly as `contacts:get-available` returns it. */
async function pickerRow(recordId: string): Promise<any> {
  const r = await call("contacts:get-available", USER);
  expect(r.success).toBe(true);
  const row = (r.contacts as any[]).find((c) => c.externalRecordId === recordId);
  expect(row).toBeDefined();
  return row;
}

function state() {
  const contacts = mockDb!
    .prepare("SELECT id, display_name, company, title FROM contacts WHERE user_id = ? ORDER BY rowid")
    .all(USER) as any[];
  const emails = mockDb!
    .prepare("SELECT email, is_primary, source FROM contact_emails ORDER BY rowid")
    .all() as any[];
  const phones = mockDb!
    .prepare("SELECT phone_display, is_primary, source FROM contact_phones ORDER BY rowid")
    .all() as any[];
  return {
    contacts: contacts.map((c) => ({
      display_name: c.display_name,
      company: c.company,
      title: c.title,
    })),
    emails: emails.map((e) => e.email),
    primaryEmail: emails.filter((e) => e.is_primary === 1).map((e) => e.email),
    emailSources: [...new Set(emails.map((e) => e.source))],
    phones: phones.map((p) => p.phone_display),
    primaryPhone: phones.filter((p) => p.is_primary === 1).map((p) => p.phone_display),
  };
}

/**
 * A relaunch: session state cleared, `contacts:get-all`, and its background
 * backfill awaited without polling.
 *
 * Resolves on the FIRST phone-backfill call, which the backfill makes once per
 * contact with a linked record. That is only a complete wait with exactly one
 * imported contact, so the precondition is asserted rather than assumed: with
 * more, this would read the state early.
 */
async function relaunchBackfill(): Promise<void> {
  expect(state().contacts).toHaveLength(1);
  resetContactSessionState();
  const done = new Promise<void>((resolve) => {
    mockSwitches.afterBackfillPhones = resolve;
  });
  const g = await call("contacts:get-all", USER);
  expect(g.success).toBe(true);
  await done;
  mockSwitches.afterBackfillPhones = null;
}

const importEvents = () =>
  captureMessage.mock.calls.filter((c) => /used to block it/.test(String(c[0])));

const emailOfLen = (len: number) =>
  "a".repeat(len - "@example.com".length) + "@example.com";

/** Arms a `contact_emails` insert failure the batch spy switches on. */
function installEmailInsertFailure(): void {
  mockDb!.exec(`CREATE TABLE IF NOT EXISTS fail_email_insert_arm (v INTEGER);
    CREATE TRIGGER IF NOT EXISTS fail_email_insert BEFORE INSERT ON contact_emails
    WHEN EXISTS (SELECT 1 FROM fail_email_insert_arm)
    BEGIN SELECT RAISE(ABORT, 'test: link write failed'); END;`);
}

beforeEach(() => {
  mockDb = openTestDb();
  mockDb.exec(CONTACT_IDENTITY_SCHEMA);
  // The recency sub-selects in the shadow reader's SQL need these tables to
  // EXIST (empty here). Column names from electron/database/schema.sql
  // (phone_last_message, email_participants, emails); unused columns omitted.
  mockDb.exec(`CREATE TABLE IF NOT EXISTS phone_last_message (phone_normalized TEXT NOT NULL, user_id TEXT NOT NULL, last_message_at DATETIME NOT NULL, PRIMARY KEY (phone_normalized, user_id));
    CREATE TABLE IF NOT EXISTS email_participants (email_id TEXT NOT NULL, email_address TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS emails (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, sent_at DATETIME, received_at DATETIME);`);
  // schema.sql carries `external_contacts.source_identity_json`; the identity
  // test schema predates it, and the shadow writer writes it.
  try {
    mockDb.exec("ALTER TABLE external_contacts ADD COLUMN source_identity_json TEXT");
  } catch {
    /* already present */
  }
  registeredHandlers.clear();
  __resetContactLinkingScheduler();
  resetContactSessionState();
  mockSwitches.batchThrows = false;
  mockSwitches.failNextEmailInsertAfterBatch = false;
  mockSwitches.afterBackfillPhones = null;
  captureMessage.mockClear();
  (SentryMock as any).captureException.mockClear();
  (SentryMock as any).addBreadcrumb.mockClear();
  batchSpy.mockClear();
  (logServiceMock.error as jest.Mock).mockClear();
  registerContactHandlers({ isDestroyed: () => false, webContents: { send: jest.fn() } } as any);
});

afterEach(() => {
  __resetContactLinkingScheduler();
  mockDb?.close();
  mockDb = null;
});

describe("P the picker row is built from the real shadow row and is unchanged", () => {
  it("P1 row email is the address book's first value; arrays verbatim", async () => {
    seedMac("AB-3358-P1", "Pat Riverton", ["name@localhost", "avery@example.com"]);
    const row = await pickerRow("AB-3358-P1");
    expect(row.email).toBe("name@localhost");
    expect(row.allEmails).toEqual(["name@localhost", "avery@example.com"]);
  });
});

describe("S stored state after import (linking pass awaited) and after a relaunch backfill", () => {
  it("S1 first email invalid, second valid: both stored, the valid one primary, stable after relaunch", async () => {
    seedMac("AB-3358-S1", "Pat Riverton", ["name@localhost", "avery@example.com"]);
    const r = await call("contacts:import", USER, [await pickerRow("AB-3358-S1")]);
    const afterImport = state();
    await relaunchBackfill();
    expect(r.success).toBe(true);
    expect(afterImport.emails).toEqual(["avery@example.com", "name@localhost"]);
    expect(afterImport.primaryEmail).toEqual(["avery@example.com"]);
    expect(state()).toEqual(afterImport);
    expect(importEvents()).toHaveLength(1);
  });

  it("S1b named card, ONLY an invalid email: imports with it as primary, stable after relaunch", async () => {
    seedMac("AB-3358-S1b", "Pat Riverton", ["test@localhost"]);
    const r = await call("contacts:import", USER, [await pickerRow("AB-3358-S1b")]);
    const afterImport = state();
    await relaunchBackfill();
    expect(r.success).toBe(true);
    expect(afterImport.contacts).toEqual([{ display_name: "Pat Riverton", company: null, title: null }]);
    expect(afterImport.emails).toEqual(["test@localhost"]);
    expect(afterImport.primaryEmail).toEqual(["test@localhost"]);
    expect(state()).toEqual(afterImport);
  });

  it("S1c overlong phone FIRST, valid second: both stored, valid primary, stable after relaunch", async () => {
    const LONG = "415-555-0143 office / 415-555-0144 mobile, after 6pm";
    expect(LONG.length).toBeGreaterThan(50);
    seedMac("AB-3358-S1c", "Pat Riverton", [], [LONG, "+14155550142"]);
    const r = await call("contacts:import", USER, [await pickerRow("AB-3358-S1c")]);
    const afterImport = state();
    await relaunchBackfill();
    expect(r.success).toBe(true);
    expect(afterImport.phones).toEqual(["+14155550142", LONG]);
    expect(afterImport.primaryPhone).toEqual(["+14155550142"]);
    expect(state()).toEqual(afterImport);
  });

  it("S1d nameless Outlook record, only an invalid email: importable, saved nameless with it", async () => {
    seedOutlook("OL-3358-S1d", null, ["name@localhost"]);
    const row = await pickerRow("OL-3358-S1d");
    expect(importRefusalReason(row)).toBeNull();
    const r = await call("contacts:import", USER, [row]);
    const afterImport = state();
    await relaunchBackfill();
    expect(r.success).toBe(true);
    expect(afterImport.contacts).toEqual([{ display_name: "", company: null, title: null }]);
    expect(afterImport.emails).toEqual(["name@localhost"]);
    expect(afterImport.primaryEmail).toEqual(["name@localhost"]);
    expect(state()).toEqual(afterImport);
  });

  it("S3 imported clean; the card later gains an invalid email; relaunch adds it as non-primary", async () => {
    seedMac("AB-3358-S3", "Pat Riverton", ["avery@example.com"]);
    const r = await call("contacts:import", USER, [await pickerRow("AB-3358-S3")]);
    expect(r.success).toBe(true);
    seedMac("AB-3358-S3", "Pat Riverton", ["avery@example.com", "name@localhost"]);
    await relaunchBackfill();
    const after = state();
    expect(after.emails).toEqual(["avery@example.com", "name@localhost"]);
    expect(after.primaryEmail).toEqual(["avery@example.com"]);
  });

  it("S3r imported with ONLY an invalid email; the card later gains a valid one; primary does not move (known limit)", async () => {
    seedMac("AB-3358-S3r", "Pat Riverton", ["test@localhost"]);
    const r = await call("contacts:import", USER, [await pickerRow("AB-3358-S3r")]);
    expect(r.success).toBe(true);
    seedMac("AB-3358-S3r", "Pat Riverton", ["test@localhost", "avery@example.com"]);
    await relaunchBackfill();
    const after = state();
    expect(after.emails).toEqual(["test@localhost", "avery@example.com"]);
    expect(after.primaryEmail).toEqual(["test@localhost"]);
  });

  it("S-P several values of each kind: usable email and phone primary; unchanged by a second picker load and a relaunch; the reader reports the usable email", async () => {
    const LONGP = "call 415 555 0101 or 415 555 0102 during business hours";
    expect(LONGP.length).toBeGreaterThan(50);
    seedMac(
      "AB-3358-SP",
      "Jordan Price",
      ["jordan@localhost", "jordan@example.com", "jordan@example.org"],
      [LONGP, "+1 415 555 0199"],
    );
    const row = await pickerRow("AB-3358-SP");
    expect(row.email).toBe("jordan@localhost");
    const r = await call("contacts:import", USER, [row]);
    expect(r.success).toBe(true);
    const afterImport = state();
    const again = await call("contacts:get-available", USER);
    expect(again.success).toBe(true);
    const afterGetAvailable = state();
    await relaunchBackfill();
    const realDb = jest.requireActual("../services/db/contactDbService");
    const { id } = mockDb!
      .prepare("SELECT id FROM contacts WHERE display_name = ?")
      .get("Jordan Price") as { id: string };
    const saved = await realDb.getContactById(id);
    expect(afterImport.emails).toEqual(["jordan@example.com", "jordan@example.org", "jordan@localhost"]);
    expect(afterImport.primaryEmail).toEqual(["jordan@example.com"]);
    expect(afterImport.phones).toEqual(["+1 415 555 0199", LONGP]);
    expect(afterImport.primaryPhone).toEqual(["+1 415 555 0199"]);
    expect(afterGetAvailable).toEqual(afterImport);
    expect(state()).toEqual(afterImport);
    expect(saved?.email).toBe("jordan@example.com");
    expect(importEvents()).toHaveLength(1);
  });
});

describe("H boundary sweep through the real picker row (stored value exact, event count exact)", () => {
  async function importMac(
    id: string,
    name: string,
    emails: string[],
    phones: string[] = [],
    company?: string,
  ) {
    seedMac(id, name, emails, phones, company);
    const r = await call("contacts:import", USER, [await pickerRow(id)]);
    return { r, s: state(), ev: importEvents().length };
  }
  type Outcome = Awaited<ReturnType<typeof importMac>>;
  const N200 = "N".repeat(200);
  const cases: Array<[string, () => Promise<Outcome>, (x: Outcome) => void]> = [
    ["name 200 kept", () => importMac("H-n200", N200, ["avery@example.com"]), (x) => {
      expect(x.s.contacts[0].display_name).toBe(N200);
      expect(x.ev).toBe(0);
    }],
    ["name 201 cut to 200", () => importMac("H-n201", N200 + "Z", ["avery@example.com"]), (x) => {
      expect(x.s.contacts[0].display_name).toBe(N200);
      expect(x.ev).toBe(1);
    }],
    ["name 199 + emoji cut before the surrogate pair", () => importMac("H-emoji", "N".repeat(199) + "\u{1F600}", ["avery@example.com"]), (x) => {
      expect(x.s.contacts[0].display_name).toBe("N".repeat(199));
      expect(x.ev).toBe(1);
    }],
    ["company 200 kept", () => importMac("H-c200", "Pat Riverton", ["avery@example.com"], [], "C".repeat(200)), (x) => {
      expect(x.s.contacts[0].company).toBe("C".repeat(200));
      expect(x.ev).toBe(0);
    }],
    ["company 201 cut to 200", () => importMac("H-c201", "Pat Riverton", ["avery@example.com"], [], "C".repeat(201)), (x) => {
      expect(x.s.contacts[0].company).toBe("C".repeat(200));
      expect(x.ev).toBe(1);
    }],
    ["email 254 only: primary, no event", () => importMac("H-e254", "Pat Riverton", [emailOfLen(254)]), (x) => {
      expect(x.s.primaryEmail).toEqual([emailOfLen(254)]);
      expect(x.ev).toBe(0);
    }],
    ["email 255 only: stored whole, primary, event", () => importMac("H-e255", "Pat Riverton", [emailOfLen(255)]), (x) => {
      expect(x.s.emails).toEqual([emailOfLen(255)]);
      expect(x.s.primaryEmail).toEqual([emailOfLen(255)]);
      expect(x.ev).toBe(1);
    }],
    ["email 255 then valid: valid primary, 255 stored whole", () => importMac("H-e255v", "Pat Riverton", [emailOfLen(255), "avery@example.com"]), (x) => {
      expect(x.s.emails).toEqual(["avery@example.com", emailOfLen(255)]);
      expect(x.s.primaryEmail).toEqual(["avery@example.com"]);
      expect(x.ev).toBe(1);
    }],
    ["phone 50 only: primary, no event", () => importMac("H-p50", "Pat Riverton", [], ["5".repeat(50)]), (x) => {
      expect(x.s.primaryPhone).toEqual(["5".repeat(50)]);
      expect(x.ev).toBe(0);
    }],
    ["phone 51 only: stored whole, primary, event", () => importMac("H-p51", "Pat Riverton", [], ["5".repeat(51)]), (x) => {
      expect(x.s.phones).toEqual(["5".repeat(51)]);
      expect(x.s.primaryPhone).toEqual(["5".repeat(51)]);
      expect(x.ev).toBe(1);
    }],
    ["dotless domain only: primary, event", () => importMac("H-loc", "Pat Riverton", ["name@localhost"]), (x) => {
      expect(x.s.primaryEmail).toEqual(["name@localhost"]);
      expect(x.ev).toBe(1);
    }],
    ["trailing dot after a dotted domain: usable, no event", () => importMac("H-dot", "Pat Riverton", ["avery@example.com."]), (x) => {
      expect(x.s.primaryEmail).toEqual(["avery@example.com."]);
      expect(x.ev).toBe(0);
    }],
    ["trailing dot after a dotless domain first: unusable, event", () => importMac("H-dotloc", "Pat Riverton", ["avery@localhost.", "avery@example.com"]), (x) => {
      expect(x.s.primaryEmail).toEqual(["avery@example.com"]);
      expect(x.ev).toBe(1);
    }],
    ["invalid in second position only: both stored, no event (it imported before this change)", () => importMac("H-second", "Pat Riverton", ["avery@example.com", "name@localhost"]), (x) => {
      expect(x.s.emails).toEqual(["avery@example.com", "name@localhost"]);
      expect(x.ev).toBe(0);
    }],
  ];
  for (const [label, run, check] of cases) {
    it(label, async () => {
      const x = await run();
      expect(x.r.success).toBe(true);
      check(x);
    });
  }

  it("whitespace-padded first email (direct record; toExternalContact trims): trimmed before the check, primary, no event", async () => {
    const r = await call("contacts:import", USER, [{
      id: "ext-direct-ws",
      name: "Pat Riverton",
      email: "  avery@example.com ",
      allEmails: ["  avery@example.com ", "name@localhost"],
      allPhones: [],
      source: "contacts_app",
      isFromDatabase: false,
    }]);
    const s = state();
    expect(r.success).toBe(true);
    expect(s.emails).toEqual(["avery@example.com", "name@localhost"]);
    expect(s.primaryEmail).toEqual(["avery@example.com"]);
    expect(importEvents()).toHaveLength(0);
  });

  it("title 101 (direct record; no picker producer carries a title): cut to 100", async () => {
    const r = await call("contacts:import", USER, [{
      id: "ext-direct-title",
      name: "Pat Riverton",
      title: "T".repeat(101),
      allEmails: ["avery@example.com"],
      allPhones: [],
      source: "contacts_app",
      isFromDatabase: false,
    }]);
    expect(r.success).toBe(true);
    expect(state().contacts[0].title).toBe("T".repeat(100));
    expect(importEvents()).toHaveLength(1);
  });

  it("message-derived row (transcribed from getMessageDerivedContacts' SELECT), 51-char sender: stored as the source has it, event", async () => {
    const FROM = "S".repeat(51);
    const r = await call("contacts:import", USER, [{
      id: `msg_${FROM.toLowerCase()}`,
      display_name: FROM,
      name: FROM,
      email: null,
      phone: FROM,
      company: null,
      source: "messages",
      isFromDatabase: false,
    }]);
    expect(r.success).toBe(true);
    expect(state().phones).toEqual([FROM]);
    expect(importEvents()).toHaveLength(1);
  });
});

describe("E the Sentry warning", () => {
  it("E1 two adjusted records in ONE call: exactly one event, exact payload, no input value anywhere in any Sentry call", async () => {
    seedMac("AB-3358-E1a", "Pat Riverton", ["name@localhost", "avery@example.com"], ["+14155550142"]);
    seedMac("AB-3358-E1b", "R".repeat(205), ["jordan@example.com"], ["5".repeat(51), "+14155550143"]);
    const rows = await call("contacts:get-available", USER);
    const picked = (rows.contacts as any[]).filter((c) => /AB-3358-E1/.test(c.externalRecordId));
    expect(picked).toHaveLength(2);
    const r = await call("contacts:import", USER, [...picked]);
    const ev = importEvents();
    expect(r.success).toBe(true);
    expect(ev).toHaveLength(1);
    expect(ev[0][1]).toEqual({
      level: "warning",
      tags: { area: "contacts", operation: "import-lenient" },
      extra: {
        recordsInCall: 2,
        recordsAdjusted: 2,
        namesCut: 1,
        companiesCut: 0,
        titlesCut: 0,
        emailsReordered: 1,
        phonesReordered: 1,
        noUsableEmail: 0,
        noUsablePhone: 0,
        fields: ["name", "email", "phone"],
      },
    });
    const everything =
      JSON.stringify(captureMessage.mock.calls) +
      JSON.stringify((SentryMock as any).captureException.mock.calls) +
      JSON.stringify((SentryMock as any).addBreadcrumb.mock.calls);
    for (const v of [
      "Riverton", "name@localhost", "avery@example.com", "jordan", "4155550142",
      "4155550143", "RRRR", "55555", "AB-3358", USER, ...picked.map((p) => p.id),
    ]) {
      expect(everything).not.toContain(v);
    }
  });

  it("E2 an adjusted import whose batch write throws: nothing saved, no event", async () => {
    seedMac("AB-3358-E2", "Pat Riverton", ["name@localhost"]);
    const row = await pickerRow("AB-3358-E2");
    mockSwitches.batchThrows = true;
    const r = await call("contacts:import", USER, [row]);
    expect(batchSpy).toHaveBeenCalledTimes(1);
    expect(r.success).toBe(false);
    expect(state().contacts).toHaveLength(0);
    expect(importEvents()).toHaveLength(0);
  });

  /**
   * The LAST write inside the transaction fails, after the batch has returned.
   *
   * E2 alone fails too early: an event sent inside the transaction callback,
   * right after `createContactsBatch`, passes E2 because the batch never
   * returns there. Here the shadow row gains an address after the picker row
   * is built, so the in-import link copy (`linkImportedContact` →
   * `applyLinkedSourceValuesOrThrow`) makes one real `contact_emails` insert
   * after the batch — and that insert is the one that fails.
   */
  it("E2b an adjusted import whose link copy fails after the batch: nothing saved, no event", async () => {
    seedMac("AB-3358-E2b", "Pat Riverton", ["name@localhost", "avery@example.com"]);
    const row = await pickerRow("AB-3358-E2b");
    seedMac("AB-3358-E2b", "Pat Riverton", ["name@localhost", "avery@example.com", "avery.extra@example.com"]);
    installEmailInsertFailure();
    mockSwitches.failNextEmailInsertAfterBatch = true;
    const r = await call("contacts:import", USER, [row]);
    const logged = (logServiceMock.error as jest.Mock).mock.calls.map((c: any[]) =>
      String(c[2]?.error?.message ?? c[2]?.error ?? ""),
    );
    expect(logged.some((m) => m.includes("test: link write failed"))).toBe(true);
    expect(batchSpy).toHaveBeenCalledTimes(1);
    expect(r.success).toBe(false);
    expect(state().contacts).toHaveLength(0);
    expect(importEvents()).toHaveLength(0);
  });

  it("E2b-control same fixture, failure installed but never armed: import succeeds and the link copy stores the extra address", async () => {
    seedMac("AB-3358-E2c", "Pat Riverton", ["name@localhost", "avery@example.com"]);
    const row = await pickerRow("AB-3358-E2c");
    seedMac("AB-3358-E2c", "Pat Riverton", ["name@localhost", "avery@example.com", "avery.extra@example.com"]);
    installEmailInsertFailure();
    const r = await call("contacts:import", USER, [row]);
    expect(r.success).toBe(true);
    expect(state().emails).toContain("avery.extra@example.com");
    expect(importEvents()).toHaveLength(1);
  });

  it("E3 nothing adjusted: no event", async () => {
    seedMac("AB-3358-E3", "Pat Riverton", ["avery@example.com"], ["+14155550142"]);
    const r = await call("contacts:import", USER, [await pickerRow("AB-3358-E3")]);
    expect(r.success).toBe(true);
    expect(importEvents()).toHaveLength(0);
  });
});

describe("C hand-typed input is still refused", () => {
  const bad: Array<[string, Record<string, unknown>, RegExp]> = [
    ["a dotless-domain email", { name: "Pat Riverton", email: "name@localhost" }, /Invalid email format/],
    ["a 255-character email", { name: "Pat Riverton", email: emailOfLen(255) }, /too long/],
    ["a 51-character phone", { name: "Pat Riverton", phone: "5".repeat(51) }, /phone must be at most 50/],
    ["a 201-character name", { name: "N".repeat(201) }, /name must be at most 200/],
    ["a 201-character company", { name: "Pat Riverton", company: "C".repeat(201) }, /company must be at most 200/],
    ["a 101-character title", { name: "Pat Riverton", title: "T".repeat(101) }, /title must be at most 100/],
  ];
  for (const [label, payload, msg] of bad) {
    it(`C1 contacts:create refuses ${label}`, async () => {
      const r = await call("contacts:create", USER, payload);
      expect(r.success).toBe(false);
      expect(String(r.error)).toMatch(msg);
      expect(state().contacts).toHaveLength(0);
    });
  }

  it("C2 contacts:update refuses a dotless-domain email and a 201-character name; stored contact unchanged", async () => {
    const c = await call("contacts:create", USER, { name: "Pat Riverton", email: "avery@example.com" });
    expect(c.success).toBe(true);
    const id = c.contact.id;
    const before = state();
    const u1 = await call("contacts:update", id, { email: "name@localhost" });
    const u2 = await call("contacts:update", id, { name: "N".repeat(201) });
    expect(u1.success).toBe(false);
    expect(String(u1.error)).toMatch(/Invalid email format/);
    expect(u2.success).toBe(false);
    expect(state()).toEqual(before);
  });

  it("C3 contacts:create with a typed invalid SECOND address: stored as before this change (both, manual) — pinned unchanged", async () => {
    const r = await call("contacts:create", USER, {
      name: "Pat Riverton",
      email: "avery@example.com",
      allEmails: ["avery@example.com", "name@localhost"],
    });
    const s = state();
    expect(r.success).toBe(true);
    expect(s.emails).toEqual(["avery@example.com", "name@localhost"]);
    expect(s.emailSources).toEqual(["manual"]);
  });
});
