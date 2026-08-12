/**
 * @jest-environment node
 *
 * BACKLOG-2638 — A CONTACT MUST CLAIM THE RECORD IT WAS CREATED FROM.
 *
 * ===========================================================================
 * THE DEFECT IS NOT "IT CREATES INSTEAD OF IMPORTING"
 * ===========================================================================
 * The transaction wizard's "+ Add" created a contact and the person DID appear
 * in Clients & Contacts afterwards. From the user's side it imported. What it
 * never did was write a `(source_type, source_record_id)` crosswalk row for the
 * address-book record the user picked.
 *
 * The founder's clean database, gate 3, 2026-08-11:
 *
 *   | Contact       | Route                    | Crosswalk rows          |
 *   |---------------|--------------------------|-------------------------|
 *   | Priya Raman   | Clients & Contacts       | `origin` + `source_id`  |
 *   | Dana Whitlock | the transaction wizard   | `origin` ONLY           |
 *
 * And then the sentence this item is titled after: after a sweep, **Dana's own
 * address-book record was filed as a `pending` duplicate proposal against
 * Dana** — the app asked whether a person is the same as the card she was made
 * out of. CONTROL 7.
 *
 * ===========================================================================
 * THE RED IS THE SHIPPED CODE PATH, NOT AN APPROXIMATION OF IT
 * ===========================================================================
 * Every control below is paired with `addFromTheOldWizard()`, which drives the
 * REAL `contacts:create` handler with the REAL payload
 * `ContactAssignmentStep.handleImportContact` used to build — seven named
 * fields, transcribed from the deleted call. So the red in this file is the
 * behaviour the founder saw, produced by the code that produced it, and it is
 * in the suite permanently rather than reconstructed by a `git checkout`.
 *
 * `addFromTheWizard()` is the fixed path: `contacts:import` fed the payload the
 * renderer suite OBSERVES going across the boundary
 * (`src/components/audit/ContactAssignmentStep.wizardClaimsRecord-2638.test.tsx`,
 * "sends the address-book record itself"). Transcribed from that assertion, not
 * invented here — the two halves of this fix meet at that object, and if they
 * disagree the whole file proves nothing.
 *
 * ===========================================================================
 * REAL HANDLERS, REAL SQL, REAL TRANSACTIONS
 * ===========================================================================
 * Same harness as `contact-handlers.createDoesNotSubstitute-2617` and
 * `contact-handlers.typedValueProvenance`: `databaseService` is a thin facade
 * onto the REAL `contactDbService`, `dbTransaction` is a REAL transaction, and
 * every crosswalk read and write is a real statement against a real in-memory
 * SQLite built from the migration's own DDL.
 *
 * THE SWEEP IS OFF BY DEFAULT, and that is load-bearing. `contacts:import` ends
 * by awaiting `runContactLinkingNow`, and the linker writes crosswalk rows of
 * its own from content matches. With it running, "a `source_id` row exists"
 * could not distinguish "the import claimed the record the user picked" from
 * "the linker later guessed the same thing" — which is the exact confound this
 * item was warned about. Controls 1-5 therefore run with the sweep stubbed to a
 * no-op, so every row they assert was written by the import. CONTROL 7 turns
 * the REAL linker on, because the proposal is what it is about.
 *
 * ===========================================================================
 * EXACT ID SETS, NEVER COUNTS
 * ===========================================================================
 * "One crosswalk row" is equally satisfied by a row pointing at the wrong
 * record, and "two contacts" by two contacts for the wrong two people. Every
 * assertion below is a sorted set of identifiers.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { IpcMainInvokeEvent } from "electron";
import { CONTACT_IDENTITY_SCHEMA } from "../services/__tests__/helpers/contactIdentitySchema";
import { openTestDb, type TestDb } from "../services/__tests__/helpers/syncSqliteDriver";

let mockDb: TestDb | null = null;
const registeredHandlers = new Map<string, any>();

/**
 * Whether the post-import linking pass runs. See the docblock — this is the
 * difference between "the import claimed it" and "something later guessed it".
 */
let sweep: "off" | "real" = "off";

jest.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: any) => {
      registeredHandlers.set(channel, fn);
    },
  },
  BrowserWindow: jest.fn(),
  app: { isPackaged: false, getPath: jest.fn(() => "/tmp") },
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
  // A REAL transaction, not a `(fn) => fn()` passthrough — BACKLOG-2368 exists
  // to reject that, and BACKLOG-2496 put the origin write INSIDE this one.
  dbTransaction: <T>(fn: () => T): T => mockDb!.transaction(fn)(),
  getDbPath: () => "/fake/path/mad.db",
  getEncryptionKey: () => "fake-key",
}));

/**
 * `databaseService` is a THIN FACADE onto the real `contactDbService`.
 *
 * `createContactsBatch` in particular is NOT stubbed. It is the function that
 * writes the contact row, its emails, its phones AND its origin crosswalk row
 * inside one transaction (BACKLOG-2496) — so a stub would decide by hand the
 * very thing controls 1 and 7 measure.
 */
jest.mock("../services/databaseService", () => {
  const contactDb = jest.requireActual(
    "../services/db/contactDbService",
  ) as Record<string, unknown>;
  return {
    __esModule: true,
    default: {
      createContact: (data: any, origin: any) =>
        (contactDb.createContact as any)(data, origin),
      createContactsBatch: (rows: any[], onProgress?: any) =>
        (contactDb.createContactsBatch as any)(rows, onProgress),
      getContactById: (id: string) =>
        Promise.resolve(
          mockDb!.prepare("SELECT * FROM contacts WHERE id = ?").get(id) ?? null,
        ),
      markContactAsImported: (id: string, source: string) => {
        mockDb!
          .prepare("UPDATE contacts SET is_imported = 1, source = ? WHERE id = ?")
          .run(source, id);
        return Promise.resolve();
      },
      backfillContactEmails: (id: string, emails: string[], source?: any) =>
        (contactDb.backfillContactEmails as any)(id, emails, source),
      backfillContactPhones: (id: string, phones: string[], source?: any) =>
        (contactDb.backfillContactPhones as any)(id, phones, source),
      getUserById: (id: string) => Promise.resolve({ id }),
      isInitialized: () => true,
      getRemovedContactIdentifiers: () => Promise.resolve([]),
      getImportedContactsByUserIdAsync: () =>
        Promise.resolve(
          mockDb!
            .prepare("SELECT * FROM contacts WHERE user_id = ? AND is_imported = 1")
            .all("550e8400-e29b-41d4-a716-446655440000"),
        ),
      /**
       * BACKLOG-2638 (SR finding F4): this returned `[]`, so the legacy branch
       * of `contacts:get-available` was never exercised and CONTROL 8 could not
       * have gone red. Reads the real rows now — a legacy local contact is
       * simply one with `is_imported = 0`, which is what that query means.
       */
      getUnimportedContactsByUserId: () =>
        Promise.resolve(
          mockDb!
            .prepare("SELECT * FROM contacts WHERE user_id = ? AND is_imported = 0")
            .all("550e8400-e29b-41d4-a716-446655440000"),
        ),
      getRawDatabase: () => mockDb,
    },
  };
});

/**
 * The post-import sweep, under this suite's control. See the docblock.
 *
 * `runContactLinkingNow` is what `contacts:import` awaits. Delegating to the
 * REAL `linkExternalContactsForUser` rather than to the scheduler skips only
 * the coalescing timers, which have nothing to say about identity.
 */
jest.mock("../services/contactLinkingScheduler", () => ({
  __esModule: true,
  configureContactLinking: jest.fn(),
  cancelPendingContactLinking: jest.fn(),
  requestContactLinking: jest.fn(),
  holdContactLinking: jest.fn(),
  releaseContactLinking: jest.fn(),
  runContactLinkingNow: jest.fn(async (userId: string) => {
    if (sweep === "off") return;
    const linker = jest.requireActual("../services/contactSourceLinker") as {
      linkExternalContactsForUser: (u: string) => Promise<unknown>;
    };
    await linker.linkExternalContactsForUser(userId);
  }),
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

/**
 * The shadow-table reader `contacts:get-available` uses.
 *
 * Projected FROM THE REAL `external_contacts` ROWS this suite seeds, rather
 * than from a parallel array of hand-written objects. The linker reads that
 * table directly with SQL, so a second in-memory list would let the picker and
 * the linker disagree about what records exist — and controls 2 and 7 would
 * then be measuring two different address books.
 */
jest.mock("../services/db/externalContactDbService", () => {
  const project = () =>
    (
      mockDb!
        .prepare("SELECT * FROM external_contacts WHERE user_id = ?")
        .all("550e8400-e29b-41d4-a716-446655440000") as any[]
    ).map((r) => ({
      id: r.id,
      user_id: r.user_id,
      name: r.name,
      phones: JSON.parse(r.phones_json ?? "[]"),
      emails: JSON.parse(r.emails_json ?? "[]"),
      company: r.company,
      source: r.source,
      external_record_id: r.external_record_id,
      external_uuid: r.external_uuid,
      last_message_at: null,
      synced_at: r.synced_at,
    }));
  return {
    __esModule: true,
    getCount: jest.fn(() => project().length),
    getAllForUser: jest.fn(() => project()),
    getAllForUserAsync: jest.fn(() => Promise.resolve(project())),
    isStale: jest.fn(() => false),
    fullSync: jest.fn(),
    getLastSyncTime: jest.fn(() => null),
    updateLastMessageAtFromLookupTable: jest.fn(() => 0),
    syncOutlookContacts: jest.fn(),
    getContactSourceStats: jest.fn(() => ({})),
    markSourceRecordsCurrent: jest.fn(),
  };
});

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
import { toLookupKey } from "../utils/phoneNormalization";
import { toPersistedContactSource } from "../utils/contactSourceVocabulary";

const USER = "550e8400-e29b-41d4-a716-446655440000";
const mockEvent = {} as IpcMainInvokeEvent;

// ---------------------------------------------------------------------------
// THE CORPUS — the founder's own gate-3 cases, fictional by construction:
// RFC 2606 `.test` domains, NANP 555-01xx numbers.
// ---------------------------------------------------------------------------

const DANA_RECORD = "AB-RECORD-7731";
/** Same name as Dana's record, different card. CONTROL 5 (BACKLOG-2617's guarantee). */
const OTHER_DANA_RECORD = "AB-RECORD-8802";
/** Nobody touches this one. Without it, "the record left the list" is satisfied by an empty list. */
const BYSTANDER_RECORD = "AB-RECORD-9902";

/**
 * Seed ONE address-book record into the real `external_contacts` table.
 *
 * `phones_normalized_json` is written the way the real importer writes it
 * (`toLookupKey` per phone) — the linker's phone fallback reads that column and
 * nothing else, so a fixture that left it empty would silently disarm every
 * phone-driven proposal, including the one CONTROL 7 is about.
 */
function seedRecord(opts: {
  recordId: string;
  name: string;
  emails?: string[];
  phones?: string[];
  company?: string | null;
  source?: string;
  uuid?: string | null;
}): void {
  const phones = opts.phones ?? [];
  mockDb!
    .prepare(
      `INSERT INTO external_contacts
         (id, user_id, name, phones_json, phones_normalized_json, emails_json,
          company, external_record_id, source, synced_at, external_uuid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `ext-${opts.source ?? "macos"}-${opts.recordId}`,
      USER,
      opts.name,
      JSON.stringify(phones),
      JSON.stringify(phones.map(toLookupKey).filter((k) => k.length > 0)),
      JSON.stringify(opts.emails ?? []),
      opts.company ?? null,
      opts.recordId,
      opts.source ?? "macos",
      "2026-08-11T00:00:00.000Z",
      opts.uuid ?? null,
    );
}

/** The picker's rows, exactly as the renderer receives them. */
async function getAvailable(): Promise<any[]> {
  const result = await registeredHandlers.get("contacts:get-available")(mockEvent, USER);
  expect(result.success).toBe(true);
  return result.contacts as any[];
}

/** Which address-book records the picker is still offering. Identity, never a count. */
async function offeredRecordIds(): Promise<string[]> {
  return (await getAvailable())
    .map((r) => r.externalRecordId as string)
    .sort();
}

/** The row the picker is offering for one record — the object the renderer hands back. */
async function pickerRowFor(recordId: string): Promise<any> {
  const row = (await getAvailable()).find((r) => r.externalRecordId === recordId);
  expect(row).toBeDefined();
  return row;
}

/**
 * THE FIXED PATH. The wizard's "+ Add" as of BACKLOG-2638.
 *
 * The payload is the picker's OWN ROW plus `display_name` — which is precisely
 * what the renderer suite observes crossing the boundary. Not rebuilt here:
 * rebuilding it is the defect, and a test that rebuilt it would be asserting
 * against its own idea of the payload rather than the app's.
 */
async function addFromTheWizard(recordId: string): Promise<string> {
  const row = await pickerRowFor(recordId);
  const result = await registeredHandlers.get("contacts:import")(mockEvent, USER, [
    { ...row, display_name: row.name },
  ]);
  if (!result.success) throw new Error(`import failed: ${result.error}`);
  expect(result.contacts).toHaveLength(1);
  return result.contacts[0].id as string;
}

/**
 * THE SHIPPED DEFECT. The wizard's "+ Add" before BACKLOG-2638.
 *
 * Transcribed from the deleted `contactService.create` call at
 * `ContactAssignmentStep.tsx:541-549` — these seven fields, in this order, and
 * nothing else. The three the crosswalk is written from — `externalRecordId`,
 * `externalSourceType`, `externalUuid` — are absent because they were absent,
 * which is the entire defect.
 */
async function addFromTheOldWizard(recordId: string): Promise<string> {
  const row = await pickerRowFor(recordId);
  const result = await registeredHandlers.get("contacts:create")(mockEvent, USER, {
    name: row.display_name || row.name || "",
    email: row.email,
    phone: row.phone,
    company: row.company,
    source: row.source || "contacts_app",
    allEmails: row.allEmails || [],
    allPhones: row.allPhones || [],
  });
  if (!result.success) throw new Error(`create failed: ${result.error}`);
  return (result.contact ?? result.contacts?.[0]).id as string;
}

// ---------------------------------------------------------------------------
// OBSERVATION HELPERS — read rows; never seed the property under test
// ---------------------------------------------------------------------------

/** Every crosswalk row for one contact: `${source_type}/${source_record_id}/${match_method}`. */
function linksFor(contactId: string): string[] {
  return (
    mockDb!
      .prepare(
        `SELECT source_type, source_record_id, match_method
           FROM contact_source_links WHERE contact_id = ?`,
      )
      .all(contactId) as Array<{
      source_type: string;
      source_record_id: string;
      match_method: string;
    }>
  )
    .map((l) => `${l.source_type}/${l.source_record_id}/${l.match_method}`)
    .sort();
}

/**
 * The crosswalk rows that point at a REAL address-book record, i.e. everything
 * except the synthetic `origin:<contactId>` row every contact gets.
 *
 * This is the distinction the founder's table is drawn on: Priya had one of
 * these and Dana had none.
 */
function recordClaimsBy(contactId: string): string[] {
  return linksFor(contactId).filter((l) => !l.includes("/origin:"));
}

/** Every contact in the database, as `${id}|${display_name}`. */
function allContacts(): string[] {
  return (
    mockDb!
      .prepare("SELECT id, display_name FROM contacts ORDER BY id")
      .all() as Array<{ id: string; display_name: string }>
  )
    .map((c) => `${c.id}|${c.display_name}`)
    .sort();
}

/** Every pending duplicate question, as `${source_record_id} -> ${contact_id}`. */
function pendingProposals(): string[] {
  return (
    mockDb!
      .prepare(
        `SELECT contact_id, source_record_id FROM contact_link_proposals
          WHERE user_id = ? AND status = 'pending'`,
      )
      .all(USER) as Array<{ contact_id: string; source_record_id: string }>
  )
    .map((p) => `${p.source_record_id} -> ${p.contact_id}`)
    .sort();
}

beforeEach(() => {
  mockDb = openTestDb();
  mockDb.exec(CONTACT_IDENTITY_SCHEMA);
  sweep = "off";
  registeredHandlers.clear();
  registerContactHandlers({
    isDestroyed: () => false,
    webContents: { send: jest.fn() },
  } as any);

  seedRecord({
    recordId: DANA_RECORD,
    name: "Dana Whitlock",
    emails: ["dana.whitlock@example.test"],
    phones: ["+15035550118"],
    company: "Whitlock Escrow",
    uuid: "9b1d4c7a-08e6-4f23-a5b9-7c2e6d0f8a14",
  });
  seedRecord({
    recordId: BYSTANDER_RECORD,
    name: "Marek Tull",
    emails: ["marek.tull@example.test"],
    phones: ["+15035550171"],
    company: "Tull Surveying",
  });
});

afterEach(() => {
  mockDb?.close();
  mockDb = null;
});

// ===========================================================================
describe("CONTROL 1 — the contact claims the record it was created from", () => {
  it("writes a source_id crosswalk row for the picked record", async () => {
    const contactId = await addFromTheWizard(DANA_RECORD);

    expect(recordClaimsBy(contactId)).toEqual([`macos/${DANA_RECORD}/source_id`]);
  });

  /**
   * THE RED, AND IT IS THE FOUNDER'S TABLE.
   *
   * The old path's contact holds its synthetic origin row and NOTHING pointing
   * at the card it was made from — "origin only", exactly as measured on his
   * database on 2026-08-11.
   */
  it("RED: the old create-from-the-card path claims nothing", async () => {
    const contactId = await addFromTheOldWizard(DANA_RECORD);

    expect(recordClaimsBy(contactId)).toEqual([]);
    // The origin row IS written, which is why the contact looked fine on the
    // card and why this survived: `origin:<id>` matches no address-book record.
    expect(linksFor(contactId)).toEqual([`macos/origin:${contactId}/origin`]);
  });
});

// ===========================================================================
describe("CONTROL 2 — the record leaves the available list", () => {
  it("stops offering the record the contact was made from", async () => {
    expect(await offeredRecordIds()).toEqual([DANA_RECORD, BYSTANDER_RECORD].sort());

    await addFromTheWizard(DANA_RECORD);

    // The record is gone AND the one nobody touched is still there. Without the
    // second half, a refresh that emptied the address book would pass.
    expect(await offeredRecordIds()).toEqual([BYSTANDER_RECORD]);
  });

  /**
   * THE RED, AND IT IS WHAT HE SAW ON SCREEN: searching afterwards showed the
   * contact AND the record he had just added from, side by side.
   */
  it("RED: the old path leaves the record on the list", async () => {
    await addFromTheOldWizard(DANA_RECORD);

    expect(await offeredRecordIds()).toEqual([DANA_RECORD, BYSTANDER_RECORD].sort());
  });
});

// ===========================================================================
describe("CONTROL 3 — pressing Add twice is one contact, and the crosswalk is why", () => {
  it("returns the same contact on the second press", async () => {
    const first = await addFromTheWizard(DANA_RECORD);

    // The record is no longer offered, so the second press is driven with the
    // row the picker gave the FIRST time — which is what a stale modal, or a
    // second window, actually holds.
    const result = await registeredHandlers.get("contacts:import")(mockEvent, USER, [
      { ...(await staleRowFor(DANA_RECORD)), display_name: "Dana Whitlock" },
    ]);
    expect(result.success).toBe(true);

    expect(result.contacts.map((c: any) => c.id)).toEqual([first]);
    expect(allContacts()).toEqual([`${first}|Dana Whitlock`]);
  });

  /**
   * THE MECHANISM, NOT THE OUTCOME.
   *
   * The second press carries the SAME `externalRecordId` under a DIFFERENT
   * NAME — the card was renamed in the address book between presses, which
   * macOS Contacts permits freely. It must still resolve to the first contact.
   *
   * A name comparison cannot pass this. That is the point: BACKLOG-2617 deleted
   * a name guard from `contacts:create` because it attached the WRONG
   * same-named person to a deal, and the fold that replaces it must be on the
   * record. This assertion is what separates the two.
   */
  it("folds on the RECORD, not the name — a renamed card still resolves to it", async () => {
    const first = await addFromTheWizard(DANA_RECORD);

    const stale = await staleRowFor(DANA_RECORD);
    const result = await registeredHandlers.get("contacts:import")(mockEvent, USER, [
      { ...stale, name: "Dana Whitlock-Reyes", display_name: "Dana Whitlock-Reyes" },
    ]);
    /**
     * ===================================================================
     * WHAT A NAME FOLD ACTUALLY DOES HERE. CORRECTED — THE FIRST VERSION
     * OF THIS COMMENT WAS WRONG, AND WRONG IN THE DANGEROUS DIRECTION.
     * ===================================================================
     * It said the mutation fails with `UNIQUE constraint failed:
     * contact_source_links…` and concluded *"the schema is the last line of
     * this defence"*. **There is no such backstop.** `createLink`
     * (`contactSourceLinkDbService.ts:341-384`) reads the existing pair and
     * returns `{ created: false }`. It never throws.
     *
     * OBSERVED, 2026-08-11, re-running with the re-entry guard changed to
     * `LOWER(display_name) = LOWER(?)`:
     *
     *     expect(received).toEqual(expected)
     *     -   "e654f6cd-89f8-44b8-b5d0-1a83f02c88a5"
     *     +   "75f01ed6-153c-48d4-9d99-134889f5f75c"
     *
     * The import SUCCEEDS and hands back a SECOND contact for a record the
     * first contact already claims. Nothing below the guard objects. The
     * guard is the only thing standing here, which is exactly why this test
     * exists.
     *
     * HOW THE FIRST VERSION GOT IT WRONG, because the mechanism matters more
     * than the correction: `staleRowFor` was emitting `source: "macos"`, and
     * the real `contacts:get-available` projection emits
     * `toPersistedContactSource("macos")` = `"contacts_app"`. `macos` is not
     * in the `contacts.source` CHECK vocabulary, so under the mutation the
     * second create died on a CHECK constraint before it could demonstrate
     * anything — and that fixture artifact was written up as a schema
     * guarantee. An untranscribed fixture did not merely weaken a control; it
     * invented a safety net a later reader would have relied on. Found by SR
     * review of PR #2292 (F1/F2); the fixture now goes through the real
     * projection.
     */
    expect(result.success ? true : result.error).toBe(true);

    expect(result.contacts.map((c: any) => c.id)).toEqual([first]);
    expect(allContacts()).toEqual([`${first}|Dana Whitlock`]);
  });

  /** THE RED: the old path mints a second contact for the card he already used. */
  it("RED: the old path makes a second contact on the second press", async () => {
    const first = await addFromTheOldWizard(DANA_RECORD);
    const second = await addFromTheOldWizard(DANA_RECORD);

    expect(second).not.toBe(first);
    expect(allContacts()).toEqual(
      [`${first}|Dana Whitlock`, `${second}|Dana Whitlock`].sort(),
    );
  });
});

// ===========================================================================
describe("CONTROL 5 — two same-named records are two people (BACKLOG-2617)", () => {
  /**
   * THE REGRESSION GUARD FOR THE FIX THAT EXPOSED THIS ONE.
   *
   * Two different clients called Dana Whitlock, two different cards, no shared
   * email or phone. They must become two contacts, each claiming its own
   * record. Any fold reintroduced on the NAME collapses this into one and
   * silently attaches the wrong person to a deal — the BACKLOG-2617 defect.
   */
  it("gives each record its own contact and its own crosswalk row", async () => {
    seedRecord({
      recordId: OTHER_DANA_RECORD,
      name: "Dana Whitlock",
      emails: ["d.whitlock@example.test"],
      phones: ["+15035550149"],
      company: "Cascade Property Group",
    });

    const first = await addFromTheWizard(DANA_RECORD);
    const second = await addFromTheWizard(OTHER_DANA_RECORD);

    expect(second).not.toBe(first);
    expect(allContacts()).toEqual(
      [`${first}|Dana Whitlock`, `${second}|Dana Whitlock`].sort(),
    );
    // Each claims ITS OWN card — not "two rows exist somewhere".
    expect(recordClaimsBy(first)).toEqual([`macos/${DANA_RECORD}/source_id`]);
    expect(recordClaimsBy(second)).toEqual([`macos/${OTHER_DANA_RECORD}/source_id`]);
  });
});

// ===========================================================================
describe("CONTROL 7 — the app does not ask whether she is her own source card", () => {
  /**
   * =========================================================================
   * THE FOUNDER-VISIBLE SYMPTOM, AND THE SENTENCE THIS ITEM IS TITLED AFTER
   * =========================================================================
   * *"After a sweep, Dana's own source record was filed as a `pending`
   * duplicate proposal against her. The app asked whether a person is the same
   * as the card she was made out of."*
   *
   * WHY THIS NEEDS THREE CARDS, AND WHY THAT IS NOT AN ARTIFICIAL CORPUS.
   * On a corpus of ONE card the sweep REPAIRS the defect: the record matches
   * the contact it created on email, nothing else competes, and
   * `linkExternalContactsForUser` writes the `source_id` row the import should
   * have written — with `match_method: 'email'` rather than `'source_id'`, a
   * guess recorded where a fact belonged, but the card does leave the list.
   * That is the "limited exposure" the item body describes, and it is why this
   * survived so long: on the easy case something else cleans up.
   *
   * It cannot clean up the founder's case. He had THREE cards named Dana
   * Whitlock carrying the same email address (his gate-3 note: *"two other
   * records carry Dana's exact email"*). An unclaimed contact gives the sweep
   * no way to know WHICH card the user picked, so it picks by content order —
   * links the first card it meets, and files every other card, INCLUDING THE
   * ONE THE USER ACTUALLY PICKED, as a duplicate question.
   *
   * So the corpus below is his: three cards, and the user picks the LAST one.
   * The seeding order is the address book's, and it is the whole mechanism —
   * the defect is that the app decides by content order rather than by what the
   * user chose.
   */
  const PICKED_CARD = "AB-RECORD-7733";

  function seedTheThreeDanaCards(): void {
    // AB-RECORD-7731 is already seeded by `beforeEach`, first in the book.
    seedRecord({
      recordId: "AB-RECORD-7732",
      name: "Dana Whitlock",
      emails: ["dana.whitlock@example.test"],
      phones: ["+15035550190"],
      company: "Whitlock Escrow",
    });
    seedRecord({
      recordId: PICKED_CARD,
      name: "Dana Whitlock",
      emails: ["dana.whitlock@example.test"],
      phones: [],
      company: null,
    });
  }

  /**
   * The card the user picked is claimed by the IMPORT, before the sweep runs,
   * so the sweep finds it already answered and never raises it.
   *
   * The other two cards ARE still questions, and that is correct rather than
   * tolerated: they are different address-book entries that share an email, and
   * whether they are the same person is a real question with a real answer. The
   * one question that has no meaningful answer is the one about her own card,
   * and that is the one that is gone.
   */
  it("files no duplicate question about the record the contact was made from", async () => {
    sweep = "real";
    seedTheThreeDanaCards();

    const contactId = await addFromTheWizard(PICKED_CARD);

    expect(recordClaimsBy(contactId)).toEqual([`macos/${PICKED_CARD}/source_id`]);
    // EXACT SET, not "does not contain": the picked card is absent AND the two
    // genuine questions are present. A sweep that raised nothing at all would
    // satisfy a `not.toContain` and would be a different bug.
    expect(pendingProposals()).toEqual([
      `AB-RECORD-7731 -> ${contactId}`,
      `AB-RECORD-7732 -> ${contactId}`,
    ]);
  });

  /**
   * THE RED: **"Is Dana Whitlock the same person as Dana Whitlock?"**
   *
   * The contact claims nothing, so the sweep links the FIRST card it meets —
   * one the user never picked — by content, and files the card she was actually
   * made out of as a pending question. Both halves are asserted: the wrong card
   * is claimed, and the right one has become a question.
   */
  it("RED: the old path lets the sweep claim the wrong card and question the right one", async () => {
    sweep = "real";
    seedTheThreeDanaCards();

    const contactId = await addFromTheOldWizard(PICKED_CARD);

    // `contacts:create` does not run the pass, so it is run explicitly — which
    // is what the founder did: he added the contact, and a sync swept later.
    const linker = jest.requireActual("../services/contactSourceLinker") as {
      linkExternalContactsForUser: (u: string) => Promise<unknown>;
    };
    await linker.linkExternalContactsForUser(USER);

    // The sweep claimed a card the user never chose, and recorded the guess as
    // an `email` match rather than as the `source_id` fact it was not.
    expect(recordClaimsBy(contactId)).toEqual(["macos/AB-RECORD-7731/email"]);
    // And her own card is now a question.
    expect(pendingProposals()).toContain(`${PICKED_CARD} -> ${contactId}`);
  });

  /**
   * THE DISCRIMINATING NEGATIVE — recorded so nobody "fixes" the wrong thing.
   *
   * On a single unambiguous card the sweep repairs the missing claim on its
   * own, so every assertion in the RED above would invert. If this test ever
   * goes red, the sweep's content fallback has changed, and the paragraphs in
   * this file about limited exposure need rewriting rather than the code.
   */
  it("the sweep repairs the SIMPLE case, which is why this survived", async () => {
    sweep = "real";

    const contactId = await addFromTheOldWizard(DANA_RECORD);
    const linker = jest.requireActual("../services/contactSourceLinker") as {
      linkExternalContactsForUser: (u: string) => Promise<unknown>;
    };
    await linker.linkExternalContactsForUser(USER);

    // Claimed after all — but by a GUESS (`email`), not by what the user chose.
    expect(recordClaimsBy(contactId)).toEqual([`macos/${DANA_RECORD}/email`]);
    expect(pendingProposals()).toEqual([]);
  });
});

// ===========================================================================
describe("CONTROL 8 — a legacy local row is claimed, not duplicated", () => {
  /**
   * =========================================================================
   * THE ONE THIS FIX GETS FOR FREE, NOW DRIVEN RATHER THAN REASONED ABOUT.
   * =========================================================================
   * `contacts:get-available` offers two kinds of row. Address-book records from
   * the shadow table carry `isFromDatabase: false`. LEGACY LOCAL CONTACTS —
   * rows in `contacts` with `is_imported = 0`, written by builds old enough
   * that nothing produces them any more — carry `isFromDatabase: true` and
   * their own REAL contact id.
   *
   * The wizard decides "is this external?" with
   * `contacts.some(c => c.id === contact.id)` against the SAVED list, which
   * holds imported contacts only. A legacy row is not in it, so it was treated
   * as external and handed to `contacts:create` — which created a SECOND
   * contact row for a person who was already in the table under the id the
   * picker had just handed over.
   *
   * `contacts:import` splits on `isFromDatabase` and marks the existing row
   * imported instead. The wizard gets that for nothing by using the same door.
   *
   * SR FINDING F4: this was asserted by READING the handler, and the suite
   * stubbed `getUnimportedContactsByUserId` to `[]` so no test could have
   * contradicted it. "Safe by inspection" is the claim this file exists to stop
   * anyone making. Driven now.
   */
  it("marks the existing contact imported instead of creating a second one", async () => {
    // A legacy local contact: real `contacts` row, `is_imported = 0`, no
    // address-book record behind it. Seeded directly because nothing in the
    // current app writes this state — which is the point of the case.
    const LEGACY_ID = "3f2a7c18-5b64-4e09-9d31-8a06f4c7b2e5";
    mockDb!
      .prepare(
        "INSERT INTO contacts (id, user_id, display_name, company, source, is_imported) VALUES (?, ?, ?, ?, ?, 0)",
      )
      .run(LEGACY_ID, USER, "Hal Bramwell", "Bramwell Title", "contacts_app");

    // The picker offers it, flagged as already being a database row.
    const legacyRow = (await getAvailable()).find((r) => r.id === LEGACY_ID);
    expect(legacyRow).toBeDefined();
    expect(legacyRow.isFromDatabase).toBe(true);

    const before = allContacts();
    const result = await registeredHandlers.get("contacts:import")(mockEvent, USER, [
      { ...legacyRow, display_name: legacyRow.name },
    ]);
    expect(result.success ? true : result.error).toBe(true);

    // The SAME contact came back — no second Hal Bramwell.
    expect(result.contacts.map((c: any) => c.id)).toEqual([LEGACY_ID]);
    expect(allContacts()).toEqual(before);
    expect(
      (mockDb!.prepare("SELECT is_imported FROM contacts WHERE id = ?").get(LEGACY_ID) as {
        is_imported: number;
      }).is_imported,
    ).toBe(1);
  });

  /**
   * THE RED: the shipped path made a second person.
   *
   * `contacts:create` cannot see `isFromDatabase` at all — it takes a name and
   * makes a contact. The legacy row stays unimported and a duplicate appears
   * beside it.
   */
  it("RED: the old create path makes a second contact for a row that already existed", async () => {
    const LEGACY_ID = "3f2a7c18-5b64-4e09-9d31-8a06f4c7b2e5";
    mockDb!
      .prepare(
        "INSERT INTO contacts (id, user_id, display_name, company, source, is_imported) VALUES (?, ?, ?, ?, ?, 0)",
      )
      .run(LEGACY_ID, USER, "Hal Bramwell", "Bramwell Title", "contacts_app");

    const legacyRow = (await getAvailable()).find((r) => r.id === LEGACY_ID);
    const result = await registeredHandlers.get("contacts:create")(mockEvent, USER, {
      name: legacyRow.name,
      email: legacyRow.email,
      phone: legacyRow.phone,
      company: legacyRow.company,
      source: legacyRow.source || "contacts_app",
      allEmails: legacyRow.allEmails || [],
      allPhones: legacyRow.allPhones || [],
    });
    expect(result.success).toBe(true);

    const created = (result.contact ?? result.contacts?.[0]).id as string;
    expect(created).not.toBe(LEGACY_ID);
    expect(allContacts()).toEqual(
      [`${LEGACY_ID}|Hal Bramwell`, `${created}|Hal Bramwell`].sort(),
    );
  });
});

/**
 * The picker row for a record the picker no longer offers.
 *
 * A second press does not re-read the list: the user is holding a modal opened
 * before the first press, or a second window. So the row is captured from the
 * shadow table in the same projection `contacts:get-available` uses, rather
 * than by asking a list that has correctly stopped mentioning it.
 */
async function staleRowFor(recordId: string): Promise<any> {
  const r = mockDb!
    .prepare("SELECT * FROM external_contacts WHERE user_id = ? AND external_record_id = ?")
    .get(USER, recordId) as any;
  expect(r).toBeDefined();
  return {
    id: r.id,
    name: r.name,
    phone: JSON.parse(r.phones_json ?? "[]")[0] ?? null,
    email: JSON.parse(r.emails_json ?? "[]")[0] ?? null,
    company: r.company,
    source: toPersistedContactSource(r.source),
    allPhones: JSON.parse(r.phones_json ?? "[]"),
    allEmails: JSON.parse(r.emails_json ?? "[]"),
    isFromDatabase: false,
    last_communication_at: null,
    externalRecordId: r.external_record_id,
    externalSourceType: r.source,
    externalUuid: r.external_uuid,
  };
}
