/**
 * @jest-environment node
 *
 * =============================================================================
 * BACKLOG-3376 — THE IMPORT SAYS WHAT IT SAVED THAT NO EMAIL CAN COME FROM
 * =============================================================================
 * BACKLOG-3358 stopped an address the app cannot validate from blocking an
 * import: the contact saves with the value as the address book has it. A real
 * user hit that on 2026-09-15 with an address carrying a space. Nothing told
 * them, so their mail would never link to the deal and nothing would explain
 * why.
 *
 * This suite covers the MAIN-PROCESS half: a new `unmatchableEmails` field on
 * the `contacts:import` response, carrying the addresses that call saved which
 * no email can be addressed from. The two renderer halves — one message per
 * import on the Clients & Contacts card and in the deal wizard — are covered by
 * `Contacts.importSkippedToast-3376.test.tsx` and
 * `ContactAssignmentStep.importSkippedToast-3376.test.tsx`.
 *
 * -----------------------------------------------------------------------------
 * WHY THE FIELD IS NARROW, AND WHY IT IS SUCCESS-ONLY
 * -----------------------------------------------------------------------------
 *   - NARROW because the message is definite. An address links iff some
 *     `email_participants.email_address` equals it; validity never enters that
 *     path. `pat@intranet` is refused by `validateEmail`, stored anyway, and
 *     links normally — so it is deliberately SILENT (U3). Founder decision,
 *     2026-09-16.
 *   - SUCCESS-ONLY because a rolled-back import saved nothing and so has
 *     nothing to warn about. That, plus `savedContactIds` being spread on the
 *     catch returns only, is what makes this message and BACKLOG-3354's failure
 *     message mutually exclusive by construction (U6).
 *
 * -----------------------------------------------------------------------------
 * THE HARNESS
 * -----------------------------------------------------------------------------
 * The mock block below is a VERBATIM copy of the BACKLOG-3358 suite's
 * (`contact-handlers.importBadValues-3358.test.ts`), minus three helpers this
 * file does not call. It is copied rather than shared for the reason that suite
 * gives: every address-book case is seeded through the REAL shadow writer, read
 * back through the REAL `contacts:get-available`, and the row that handler
 * returns is the row imported. A hand-built row misses the in-import link copy.
 * `mockSwitches.armOuterCommitFromBatch` is what produces U6's commit failure;
 * a trimmed copy of this block would give U6 a fixture that cannot fail.
 *
 * A sibling file rather than an edit to 3358's suite, so the two items' controls
 * stay separable.
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
  /** Resolved by the phone-backfill spy. Unused here; kept so this mock
   * block stays a verbatim copy of the BACKLOG-3358 suite's. */
  afterBackfillPhones: null as null | (() => void),
  /** Set by the batch spy; the OUTERMOST transaction throws after its callback returns. */
  failOuterCommit: false,
  armOuterCommitFromBatch: false,
};
let mockTxDepth = 0;
const mockSentryScope = { inScope: false, processors: [] as Array<(e: any) => any> };

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
  dbTransaction: <T>(fn: () => T): T => {
    const outer = mockTxDepth === 0;
    mockTxDepth++;
    try {
      return mockDb!.transaction(() => {
        const r = fn();
        if (outer && mockSwitches.failOuterCommit) {
          mockSwitches.failOuterCommit = false;
          throw new Error("test: commit failed");
        }
        return r;
      })();
    } finally {
      mockTxDepth--;
    }
  },
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
        if (mockSwitches.armOuterCommitFromBatch) {
          mockSwitches.armOuterCommitFromBatch = false;
          mockSwitches.failOuterCommit = true;
        }
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
  withScope: jest.fn((cb: (scope: any) => unknown) => {
    mockSentryScope.inScope = true;
    try {
      return cb({ addEventProcessor: (p: (e: any) => any) => mockSentryScope.processors.push(p) });
    } finally {
      mockSentryScope.inScope = false;
    }
  }),
  captureMessage: jest.fn((..._args: unknown[]) => ({ inScope: mockSentryScope.inScope })),
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
import { upsertFromMacOS } from "../services/db/externalContactDbService";
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

const importEvents = () =>
  captureMessage.mock.calls.filter((c) => /used to block it/.test(String(c[0])));

const emailOfLen = (len: number) =>
  "a".repeat(len - "@example.com".length) + "@example.com";

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
  mockSwitches.failOuterCommit = false;
  mockSwitches.armOuterCommitFromBatch = false;
  mockTxDepth = 0;
  mockSentryScope.processors = [];
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

describe("U the response field", () => {
  it("U1 an address with a space in it: imported, stored, and NAMED on the success response", async () => {
    // The founder's real case, in fictional form: an address book card whose
    // first address carries a space. Breaks caught: no field at all; counts
    // instead of values; the lowercased stored form instead of the source's.
    seedMac("AB-3376-U1", "Pat Riverton", ["Pat@ Example.com", "avery@example.com"]);
    const r = await call("contacts:import", USER, [await pickerRow("AB-3376-U1")]);
    expect(r.success).toBe(true);
    expect(r.unmatchableEmails).toEqual(["Pat@ Example.com"]);
    // The claim the message makes is about a value that IS saved. If this ever
    // stopped being stored, the message would be about nothing.
    expect(state().emails).toContain("pat@ example.com");
    expect(state().primaryEmail).toEqual(["avery@example.com"]);
  });

  it("U2 a clean card: the key is ABSENT, not an empty array", async () => {
    // Break caught: the field spread unconditionally, so every import carries
    // it and every renderer has to know an empty array means silence.
    seedMac("AB-3376-U2", "Pat Riverton", ["avery@example.com"], ["+14155550142"]);
    const r = await call("contacts:import", USER, [await pickerRow("AB-3376-U2")]);
    expect(r.success).toBe(true);
    expect("unmatchableEmails" in r).toBe(false);
  });

  it("U3 unusable but MATCHABLE addresses: imported, and SILENT", async () => {
    // The whole reason the predicate is narrower than `!isUsableImportEmail`.
    // Every address here is refused by `validateEmail` and every one of them
    // can equal a participant address, so a definite "won't be linked" about
    // any of them would be false. Break caught: the predicate widened to the
    // negation of `isUsableImportEmail` — `pat@intranet` would then be named.
    seedMac("AB-3376-U3", "Pat Riverton", [
      "pat@intranet",
      "pat@localhost",
      "two@@example.com",
      "pat@example.",
      "@example.com",
      "pat@",
      emailOfLen(256),
    ]);
    const r = await call("contacts:import", USER, [await pickerRow("AB-3376-U3")]);
    expect(r.success).toBe(true);
    expect("unmatchableEmails" in r).toBe(false);
    // Saved anyway, which is BACKLOG-3358's rule and the premise of the silence.
    expect(state().emails).toContain("pat@intranet");
  });

  it("U4 several on one record: every one named, address-book order, deduped case-insensitively", async () => {
    // Breaks caught: only the first reported; the list rebuilt from the stored
    // rows (which are lowercased and deduped differently); source order lost.
    seedMac("AB-3376-U4", "Pat Riverton", [
      "Pat@ Example.com",
      "avery@example.com",
      "PAT@ EXAMPLE.COM",
      "noatsign.example.com",
    ]);
    const r = await call("contacts:import", USER, [await pickerRow("AB-3376-U4")]);
    expect(r.success).toBe(true);
    expect(r.unmatchableEmails).toEqual(["Pat@ Example.com", "noatsign.example.com"]);
  });

  it("U5 two records in ONE call: flat across the call, in record order", async () => {
    // The contract stated on `ContactResponse.unmatchableEmails`: flat, with no
    // per-contact attribution. Pinned so a future batch caller finds the shape
    // asserted rather than inferred.
    //
    // The order is the order the CALLER sent the records in — NOT the order of
    // `contacts` on the same response, which is existing-DB rows, then created,
    // then claimed. Measured: `contacts:get-available` returns these two by its
    // own recency sort, so they are sorted by record id here to make "caller
    // order" the thing this test can actually observe.
    seedMac("AB-3376-U5a", "Pat Riverton", ["Pat@ Example.com"]);
    seedMac("AB-3376-U5b", "Avery Stone", ["noatsign.example.com"]);
    const rows = await call("contacts:get-available", USER);
    const picked = (rows.contacts as any[])
      .filter((c) => /AB-3376-U5/.test(c.externalRecordId))
      .sort((a, b) => String(a.externalRecordId).localeCompare(String(b.externalRecordId)));
    expect(picked).toHaveLength(2);
    expect(picked.map((c: any) => c.externalRecordId)).toEqual(["AB-3376-U5a", "AB-3376-U5b"]);
    const r = await call("contacts:import", USER, [...picked]);
    expect(r.success).toBe(true);
    expect(r.unmatchableEmails).toEqual(["Pat@ Example.com", "noatsign.example.com"]);
  });
});

describe("U-fail the field can never ride a failure response", () => {
  it("U6 the OUTER transaction fails after its callback returns: nothing saved, no field", async () => {
    // BACKLOG-3358's E2d fixture. This is the control for the pair of guards
    // that keep this message and BACKLOG-3354's failure message mutually
    // exclusive: the array is assigned only on the statement AFTER
    // `dbTransaction` returns, AND the spread is on the success return only.
    // THIS fixture cannot see the spread break on its own: it throws before the
    // assignment runs, so the field is `undefined` at catch time either way.
    // The mutation that reddens THIS test breaks BOTH guards (handoff, M5);
    // U6b below is the control for the spread on its own (SR, RC1).
    seedMac("AB-3376-U6", "Pat Riverton", ["Pat@ Example.com", "avery@example.com"]);
    const row = await pickerRow("AB-3376-U6");
    mockSwitches.armOuterCommitFromBatch = true;
    const r = await call("contacts:import", USER, [row]);
    expect(r.success).toBe(false);
    expect("unmatchableEmails" in r).toBe(false);
    expect(state().contacts).toHaveLength(0);
  });

  it("U6-control same fixture, the failure never armed: the import succeeds and IS named", async () => {
    // Without this, U6 passing would be indistinguishable from a fixture that
    // never produced an unmatchable address in the first place.
    seedMac("AB-3376-U6c", "Pat Riverton", ["Pat@ Example.com", "avery@example.com"]);
    const r = await call("contacts:import", USER, [await pickerRow("AB-3376-U6c")]);
    expect(r.success).toBe(true);
    expect(r.unmatchableEmails).toEqual(["Pat@ Example.com"]);
    expect(state().contacts).toHaveLength(1);
  });

  it("U6b a read AFTER the commit throws: savedContactIds present, unmatchableEmails ABSENT", async () => {
    // The commit SUCCEEDED, so `unmatchableEmails` is already assigned when the
    // catch runs. The success-only spread is the only thing keeping it off this
    // response — U6 above throws before that assignment and cannot see it.
    // Covers the spread ONLY: the post-commit assignment is redundant given the
    // spread, so this is not a control for the pair.
    seedMac("AB-3376-U6b", "Pat Riverton", ["Pat@ Example.com", "avery@example.com"]);
    const row = await pickerRow("AB-3376-U6b");
    const getById = (databaseServiceMock as any).getContactById as jest.Mock;
    getById.mockImplementationOnce(() =>
      Promise.reject(new Error("test: post-commit read failed")),
    );
    const r = await call("contacts:import", USER, [row]);
    expect(r.success).toBe(false);
    expect(Array.isArray(r.savedContactIds)).toBe(true); // the write DID commit
    expect("unmatchableEmails" in r).toBe(false); // the success-only spread
  });

  it("U7 a record refused outright: the whole call fails and carries no field", async () => {
    // `importRefusalReason` throws before anything is shaped, so a batch that
    // holds one empty record fails whole — and must still say nothing about the
    // addresses of the record beside it.
    seedMac("AB-3376-U7", "Pat Riverton", ["Pat@ Example.com"]);
    const good = await pickerRow("AB-3376-U7");
    const r = await call("contacts:import", USER, [good, { name: "", email: "", phone: "" }]);
    expect(r.success).toBe(false);
    expect("unmatchableEmails" in r).toBe(false);
  });
});

describe("U-sentry the warning stays counts-only", () => {
  it("U8 an unmatchable address reaches the response and NEVER the Sentry payload", async () => {
    // BACKLOG-3358's rule, which this item had to work around rather than
    // relax: the values live on `ShapedImportValues`, not on
    // `ImportAdjustmentCounts`, because the handler spreads that counts object
    // straight into `extra`. 3358's E1 already guards a NEW KEY in `extra`
    // (measured there); this guards the VALUE, on this item's own fixture.
    seedMac("AB-3376-U8", "Pat Riverton", ["Pat@ Example.com", "avery@example.com"]);
    const r = await call("contacts:import", USER, [await pickerRow("AB-3376-U8")]);
    expect(r.success).toBe(true);
    expect(r.unmatchableEmails).toEqual(["Pat@ Example.com"]);
    const ev = importEvents();
    expect(ev).toHaveLength(1);
    expect(ev[0][1]).toEqual({
      level: "warning",
      tags: { area: "contacts", operation: "import-lenient" },
      extra: {
        recordsInCall: 1,
        recordsAdjusted: 1,
        namesCut: 0,
        companiesCut: 0,
        titlesCut: 0,
        emailsReordered: 1,
        phonesReordered: 0,
        noUsableEmail: 0,
        noUsablePhone: 0,
        fields: ["email"],
      },
    });
    const everything =
      JSON.stringify(captureMessage.mock.calls) +
      JSON.stringify((SentryMock as any).captureException.mock.calls) +
      JSON.stringify((SentryMock as any).addBreadcrumb.mock.calls);
    for (const v of ["Pat@ Example.com", "pat@ example.com", "Example.com", "Riverton", "AB-3376"]) {
      expect(everything).not.toContain(v);
    }
  });
});
