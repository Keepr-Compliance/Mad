/**
 * @jest-environment node
 *
 * BACKLOG-2427 — a value the USER TYPED must survive rejecting a source.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SUITE EXISTS SEPARATELY FROM `contactSourceValues.test.ts`
 * ---------------------------------------------------------------------------
 * That suite seeds `contact_emails.source = 'manual'` directly and then proves
 * the removal rule respects it. That is a real proof of the RULE and no proof
 * at all of the PROVENANCE: it never runs the code that decides what `source`
 * a row gets, so it cannot notice that the deciding code was wrong.
 *
 * It was wrong. SR review of PR #2186 found that "the backfill only ever writes
 * 'import'" — the assumption the whole guarantee rested on — is false. TWO
 * production paths stamped hand-typed values `'import'`:
 *
 *   - `contactDbService.createContact` — the contact's primary email and phone
 *   - `backfillContactEmails/Phones`, called by `contacts:create` for the
 *     `allEmails` / `allPhones` arrays
 *
 * Both are reached by the manual Add Contact form
 * (`ContactFormModal.tsx` -> `window.api.contacts.create`, which sends no
 * `source`). And `resolveSourceRecord` will happily link such a contact to any
 * source record sharing an email or phone — `contactIdsByEmail` /
 * `contactIdsByPhone` filter on neither `is_imported` nor `source`.
 *
 * So "Not this person" deleted the client's typed phone number, and the panel
 * copy shipped in the same PR promised it would not ("unless another source has
 * them too or you added them yourself").
 *
 * These tests therefore go through the REAL create path — the IPC handler, the
 * real `createContact`, the real backfill — and assert on what actually lands
 * in the database. Nothing about provenance is seeded.
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

/**
 * `databaseService` is a THIN FACADE — `createContact` is one line delegating to
 * `contactDb.createContact`. It is redirected here rather than stubbed, so the
 * REAL value-inserting code runs against the REAL schema. Stubbing it would
 * mock away the exact lines under test.
 */
jest.mock("../services/databaseService", () => {
  const contactDb = jest.requireActual(
    "../services/db/contactDbService",
  ) as typeof import("../services/db/contactDbService");
  return {
    __esModule: true,
    default: {
      createContact: (data: any) => contactDb.createContact(data),
      backfillContactEmails: (id: string, emails: string[], source?: any) =>
        contactDb.backfillContactEmails(id, emails, source),
      backfillContactPhones: (id: string, phones: string[], source?: any) =>
        contactDb.backfillContactPhones(id, phones, source),
      findContactByName: () => Promise.resolve(null),
      getUserById: (id: string) => Promise.resolve({ id }),
      isInitialized: () => true,
      getImportedContactsByUserIdAsync: () => Promise.resolve([]),
      getUnimportedContactsByUserId: () => Promise.resolve([]),
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
import { unlinkContactSource } from "../services/contactProvenance";
import { createLink } from "../services/db/contactSourceLinkDbService";
import { resolveSourceRecord } from "../services/contactSourceLinker";

const USER = "550e8400-e29b-41d4-a716-446655440000";
const mockEvent = {} as IpcMainInvokeEvent;

const TYPED_EMAIL = "typed@byhand.com";
const TYPED_SECOND_EMAIL = "typed.second@byhand.com";
const TYPED_PHONE = "(408) 210-4874";
const TYPED_PHONE_E164 = "+14082104874";

// ---------------------------------------------------------------------------
// HELPERS — observe rows, never provenance-seed them
// ---------------------------------------------------------------------------

function valueRows(contactId: string): {
  emails: Array<{ email: string; source: string | null }>;
  phones: Array<{ phone_e164: string; source: string | null }>;
} {
  return {
    emails: mockDb!
      .prepare("SELECT email, source FROM contact_emails WHERE contact_id = ? ORDER BY email")
      .all(contactId) as Array<{ email: string; source: string | null }>,
    phones: mockDb!
      .prepare(
        "SELECT phone_e164, source FROM contact_phones WHERE contact_id = ? ORDER BY phone_e164",
      )
      .all(contactId) as Array<{ phone_e164: string; source: string | null }>,
  };
}

function addExternal(
  recordId: string,
  name: string,
  source: string,
  emails: string[],
  phones: string[],
): void {
  mockDb!
    .prepare(
      `INSERT INTO external_contacts
        (id, user_id, name, phones_json, phones_normalized_json, emails_json,
         external_record_id, source, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `ext-${source}-${recordId}`,
      USER,
      name,
      JSON.stringify(phones),
      JSON.stringify(phones.map((p) => p.replace(/\D/g, "").slice(-10))),
      JSON.stringify(emails),
      recordId,
      source,
      "2026-08-03T00:00:00.000Z",
    );
}

/**
 * Exactly what the Add Contact form sends: name, primary email/phone, the
 * `allEmails` / `allPhones` arrays — and NO `source` field.
 */
async function createViaManualForm(): Promise<string> {
  const handler = registeredHandlers.get("contacts:create");
  const result = await handler(mockEvent, USER, {
    name: "Hand Typed Person",
    email: TYPED_EMAIL,
    phone: TYPED_PHONE,
    allEmails: [TYPED_EMAIL, TYPED_SECOND_EMAIL],
    allPhones: [TYPED_PHONE],
  });
  // Fail LOUDLY with the handler's own reason. A bare `expect(success)` here
  // reports "expected true, received false" and hides the SQL error behind it.
  if (!result.success) throw new Error(`contacts:create failed: ${result.error}`);
  return result.contact.id as string;
}

beforeEach(() => {
  mockDb = openTestDb();
  mockDb.exec(CONTACT_IDENTITY_SCHEMA);
  registeredHandlers.clear();
  registerContactHandlers({} as any);
});

afterEach(() => {
  mockDb?.close();
  mockDb = null;
});

// ===========================================================================
describe("the manual Add Contact form records its values as hand-typed", () => {
  /**
   * NEGATIVE CONTROL (executed, see PR): revert the source threading in
   * `createContact` / `backfillContact*Sync` and every case here goes red with
   * `"source": "import"`.
   */
  it("stamps the primary email and phone 'manual', not 'import'", async () => {
    const id = await createViaManualForm();
    const rows = valueRows(id);

    expect(rows.emails).toEqual([
      { email: TYPED_SECOND_EMAIL, source: "manual" },
      { email: TYPED_EMAIL, source: "manual" },
    ]);
    expect(rows.phones).toEqual([{ phone_e164: TYPED_PHONE_E164, source: "manual" }]);
  });

  it("still stamps an address-book import 'import'", async () => {
    // The picker sends the origin explicitly. Nothing about this path changes:
    // a value that genuinely came from a source must stay removable.
    const handler = registeredHandlers.get("contacts:create");
    const result = await handler(mockEvent, USER, {
      name: "Imported Person",
      email: "from@addressbook.com",
      phone: "(415) 555-0000",
      allEmails: ["from@addressbook.com", "second@addressbook.com"],
      allPhones: ["(415) 555-0000"],
      source: "contacts_app",
    });

    const rows = valueRows(result.contact.id);
    expect(rows.emails.map((e) => e.source)).toEqual(["import", "import"]);
    expect(rows.phones.map((p) => p.source)).toEqual(["import"]);
  });

  it("carries 'inferred' through rather than flattening it to 'import'", async () => {
    const handler = registeredHandlers.get("contacts:create");
    const result = await handler(mockEvent, USER, {
      name: "Inferred Person",
      email: "seen@inmessages.com",
      source: "inferred",
    });

    expect(valueRows(result.contact.id).emails).toEqual([
      { email: "seen@inmessages.com", source: "inferred" },
    ]);
  });
});

// ===========================================================================
describe("rejecting a source never deletes what the user typed", () => {
  /**
   * THE REGRESSION SR CAUGHT, end to end.
   *
   * A hand-typed contact, an address-book record that happens to share the
   * typed phone number, the linker connecting the two on that content match,
   * and then "Not this person". Before the fix this deleted the typed email AND
   * the typed phone — the client's own contact details, gone, because a
   * stranger's address book listed the same number.
   */
  it("keeps every typed value when the linked source is rejected", async () => {
    const contactId = await createViaManualForm();

    // An address book record that shares the typed phone. Nothing here is the
    // user's data — it is somebody else's card that lists the same line.
    addExternal("mac-someone", "Some Body", "macos", ["someone@else.com"], [TYPED_PHONE]);

    // The content fallback links them, exactly as it does in production: it
    // filters on neither `is_imported` nor `source`.
    const resolution = resolveSourceRecord(USER, {
      sourceType: "macos",
      sourceRecordId: "mac-someone",
      emails: ["someone@else.com"],
      phones: [TYPED_PHONE],
    });
    expect(resolution).toMatchObject({ outcome: "linked", contactId });

    const links = mockDb!
      .prepare("SELECT id FROM contact_source_links WHERE contact_id = ?")
      .all(contactId) as Array<{ id: string }>;
    expect(links).toHaveLength(1);

    const outcome = unlinkContactSource(USER, contactId, links[0].id);
    expect(outcome).toMatchObject({ ok: true });

    const rows = valueRows(contactId);
    // Every typed value survives. The address the SOURCE contributed does not
    // belong to this contact and was never copied onto it by this flow.
    expect(rows.emails.map((e) => e.email)).toEqual([TYPED_SECOND_EMAIL, TYPED_EMAIL]);
    expect(rows.phones.map((p) => p.phone_e164)).toEqual([TYPED_PHONE_E164]);
  });

  it("still removes what the source really did contribute to the same contact", async () => {
    // The guarantee must not become "never remove anything". A value that
    // arrived from the rejected source, on a hand-typed contact, still goes.
    const contactId = await createViaManualForm();

    addExternal("mac-someone", "Some Body", "macos", ["someone@else.com"], [TYPED_PHONE]);
    const link = createLink({
      userId: USER,
      contactId,
      sourceType: "macos",
      sourceRecordId: "mac-someone",
      matchMethod: "phone",
    });

    // The link copies the source's own address onto the contact (BACKLOG-2423).
    const { applyLinkedSourceValues } = await import("../services/contactSourceValues");
    applyLinkedSourceValues(USER, contactId);
    expect(valueRows(contactId).emails.map((e) => e.email)).toContain("someone@else.com");

    unlinkContactSource(USER, contactId, link.id!);

    const rows = valueRows(contactId);
    expect(rows.emails.map((e) => e.email)).toEqual([TYPED_SECOND_EMAIL, TYPED_EMAIL]);
    expect(rows.phones.map((p) => p.phone_e164)).toEqual([TYPED_PHONE_E164]);
  });
});
