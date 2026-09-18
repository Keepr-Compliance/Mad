/**
 * @jest-environment node
 *
 * =============================================================================
 * BACKLOG-2481 — a person from a text thread can be saved at all
 * =============================================================================
 * `contactDbService` synthesises message-derived pseudo-contacts with
 * `'messages' as source` (`:273` and `:2594`). The `contacts.source` CHECK has
 * never admitted that value. So pressing Import on one of those rows did not
 * produce a mislabelled contact — the write threw on the CHECK and produced NO
 * CONTACT AT ALL, no origin link, nothing.
 *
 * Measured on the pre-fix tree, one record per call, both doors:
 *
 *   contacts:import  source "messages"      -> REFUSED, 0 rows
 *   contacts:create  source "messages"      -> REFUSED, 0 rows
 *   contacts:import  source "not_a_source"  -> REFUSED, 0 rows
 *   contacts:create  source "not_a_source"  -> accepted, stored "manual"
 *
 * That last asymmetry is the discriminator and it is pinned below: `create` had
 * a hand-copied allow-list that folded unknowns to `manual`; `import` had none.
 * `messages` was IN the create allow-list, which is exactly why create failed
 * where a bogus string succeeded.
 *
 * -----------------------------------------------------------------------------
 * WHY THE DESTINATION IS `manual` AND NOT `sms`
 * -----------------------------------------------------------------------------
 * `sms` is the truthful-looking answer and it is the wrong one. Every SAVED
 * contact reaches the source filter with `is_message_derived = 0`, hard-coded in
 * the projection (`services/db/contactProjectionSql.ts:117`), and the
 * Inferred>From Texts leaf requires that flag — so a stored `sms` contact matches
 * NO leaf and cannot be reached on Clients & Contacts by any means the UI offers.
 * The assertions below therefore name `manual` BY VALUE rather than saying
 * "the destination": two candidate destinations both survive a vaguer assertion,
 * and one of them (`contacts_app`) also renders fine while writing a false
 * provenance row. See `src/utils/__tests__/contactFilterModel.messagesSource-2481.test.ts`
 * for the filter half.
 *
 * -----------------------------------------------------------------------------
 * WHAT THIS FILE ASSERTS ABOUT ERRORS — AND WHAT IT DELIBERATELY DOES NOT
 * -----------------------------------------------------------------------------
 * Never the message text. `better-sqlite3` surfaces the raw CHECK string and the
 * `node:sqlite` fallback does not (its error fails `instanceof Error`, so the
 * handler's catch emits a generic literal). A string assertion would be green on
 * CI and red on a dev machine. Refused, and zero rows, is the assertion.
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

/**
 * THE WRITE PATHS ARE REAL, AND THAT IS THE POINT.
 *
 * The sibling BACKLOG-2684 suite mocks `createContactsBatch` with an insert
 * that writes `row.display_name` raw and omits `company`/`title` from its
 * column list. That mock structurally cannot go red on the writer's own
 * `|| "Unknown"` substitution — the defect half of this item. Delegating to the
 * real functions costs nothing here and removes a control that cannot fail.
 */
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
      backfillContactEmails: jest.fn(() => Promise.resolve(0)),
      backfillContactPhones: jest.fn(() => Promise.resolve(0)),
      markContactAsImported: jest.fn(() => Promise.resolve()),
      getContactById: jest.fn((id: string) =>
        Promise.resolve(
          mockDb!.prepare("SELECT * FROM contacts WHERE id = ?").get(id) ?? null,
        ),
      ),
      createContactsBatch: jest.fn((rows: any[]) => real.createContactsBatch(rows)),
      createContact: jest.fn((data: any, origin: any) => real.createContact(data, origin)),
      updateContactSync: jest.fn((id: string, updates: any) =>
        real.updateContactSync(id, updates),
      ),
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

// The RFC 4122 example UUID, copied verbatim from the sibling BACKLOG-2684 suite.
const USER = "550e8400-e29b-41d4-a716-446655440000"; // pii-allow-uuid: RFC 4122 example value, not from any live row
const mockEvent = {} as IpcMainInvokeEvent;

type Outcome = { refused: boolean; error: string | null };

async function drive(channel: string, ...args: unknown[]): Promise<Outcome> {
  try {
    const result = await registeredHandlers.get(channel)(mockEvent, ...args);
    return { refused: result.success !== true, error: result.error ?? null };
  } catch (e) {
    return { refused: true, error: e instanceof Error ? e.message : String(e) };
  }
}

const importRecords = (records: unknown[]) => drive("contacts:import", USER, records);
const createContact = (payload: unknown) => drive("contacts:create", USER, payload);

function rows(): Array<{ id: string; display_name: string; source: string }> {
  return mockDb!
    .prepare("SELECT id, display_name, source FROM contacts WHERE user_id = ? ORDER BY rowid")
    .all(USER) as any;
}

function originLinks(): Array<{ source_type: string; match_method: string }> {
  return mockDb!
    .prepare(
      "SELECT source_type, match_method FROM contact_source_links WHERE user_id = ? ORDER BY rowid",
    )
    .all(USER) as any;
}

beforeEach(() => {
  mockDb = openTestDb();
  mockDb.exec(CONTACT_IDENTITY_SCHEMA);
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


/**
 * The record BOTH live screens hand over, transcribed from the producer rather
 * than invented — `getMessageDerivedContacts` (`contactDbService.ts:169`, SQL at
 * `:257-294`) projects, per distinct `participants.$.from`:
 *
 *     id                 = 'msg_' || LOWER(from)
 *     display_name, name = from
 *     email              = NULL     (the CASE cannot fire; the WHERE excludes '%@%')
 *     phone              = from
 *     company            = NULL
 *     source             = 'messages'
 *     is_message_derived = 1
 *
 * `is_message_derived` is absent here on purpose: `Contacts.tsx:721` and
 * `ContactAssignmentStep.tsx:667` both destructure it off at the IPC boundary.
 * Captured from the rendered screen by driving the Import press, not assumed.
 */
const MESSAGE_DERIVED = {
  id: "msg_rosalind quill",
  display_name: "Rosalind Quill",
  name: "Rosalind Quill",
  email: null,
  phone: "Rosalind Quill",
  company: null,
  source: "messages",
  is_imported: 0,
  last_communication_at: "2026-02-04 13:00:00",
  communication_count: 3,
};

/* ==========================================================================
 * C1 — the defect. Both doors, by value, per door.
 * ========================================================================== */
describe("a message-derived person can be saved, and lands somewhere reachable (BACKLOG-2481)", () => {
  it("contacts:import stores 'manual' — NOT 'messages', 'sms' or 'contacts_app'", async () => {
    const outcome = await importRecords([MESSAGE_DERIVED]);

    expect(outcome).toEqual({ refused: false, error: null });
    // BY VALUE. "a row exists" passes on every candidate destination; "the
    // destination" is not a specification while two candidates both render.
    expect(rows()).toEqual([
      { id: expect.any(String), display_name: "Rosalind Quill", source: "manual" },
    ]);
    // And the crosswalk agrees, rather than claiming a macOS address book the
    // person has never been in — which is what the `contacts_app` fallback wrote.
    expect(originLinks()).toEqual([{ source_type: "manual", match_method: "origin" }]);
  });

  it("contacts:create stores 'manual' for the same value", async () => {
    const outcome = await createContact({ ...MESSAGE_DERIVED, id: undefined });

    expect(outcome).toEqual({ refused: false, error: null });
    expect(rows()).toEqual([
      { id: expect.any(String), display_name: "Rosalind Quill", source: "manual" },
    ]);
  });

  /**
   * The values that were never broken, swept rather than sampled — a fix that
   * folded everything to `manual` would pass the two tests above and destroy
   * every real provenance on the way through.
   *
   * `sms`, `email` and `inferred` used to be rows here, pinned as "stored
   * unchanged". Stored, each became a contact no filter leaf can find, so
   * BACKLOG-3193 refuses them on this door. Their rows moved to
   * `contact-handlers.unfilterableSource-3193.test.ts`, which asserts the
   * refusal for all three on both doors.
   */
  it.each([
    ["contacts_app", "contacts_app"],
    ["iphone", "iphone"],
    ["outlook", "outlook"],
    ["google_contacts", "google_contacts"],
    ["android_sync", "android_sync"],
    ["manual", "manual"],
  ])("contacts:import still stores %s unchanged", async (inbound, stored) => {
    const outcome = await importRecords([{ ...MESSAGE_DERIVED, source: inbound }]);

    expect(outcome).toEqual({ refused: false, error: null });
    expect(rows()).toEqual([
      { id: expect.any(String), display_name: "Rosalind Quill", source: stored },
    ]);
  });

  /**
   * An ABSENT source is a different case from an unrecognised one, and the two
   * doors answer it differently on purpose. Pinned so a later refactor cannot
   * merge them without going red.
   */
  it("contacts:import still defaults an ABSENT source to contacts_app", async () => {
    const outcome = await importRecords([{ ...MESSAGE_DERIVED, source: undefined }]);

    expect(outcome).toEqual({ refused: false, error: null });
    expect(rows()).toEqual([
      { id: expect.any(String), display_name: "Rosalind Quill", source: "contacts_app" },
    ]);
  });

  it("contacts:create still defaults an ABSENT source to manual", async () => {
    const outcome = await createContact({ ...MESSAGE_DERIVED, id: undefined, source: undefined });

    expect(outcome).toEqual({ refused: false, error: null });
    expect(rows()).toEqual([
      { id: expect.any(String), display_name: "Rosalind Quill", source: "manual" },
    ]);
  });

  /**
   * The THIRD write of `contacts.source` — an UPDATE, not an insert, and it
   * would have hit the same CHECK. Unreachable by a pseudo-contact today (it
   * needs `isFromDatabase`), so this drives the reachable shape of it.
   */
  it("markContactAsImported is handed the STORABLE value, never the synthetic one", async () => {
    mockDb!
      .prepare(
        "INSERT INTO contacts (id, user_id, display_name, source, is_imported) VALUES (?,?,?,?,0)",
      )
      .run("existing-1", USER, "Rosalind Quill", "manual");

    const outcome = await importRecords([
      { ...MESSAGE_DERIVED, id: "existing-1", isFromDatabase: true },
    ]);

    expect(outcome).toEqual({ refused: false, error: null });
    const dbService = jest.requireMock("../services/databaseService").default;
    expect(dbService.markContactAsImported).toHaveBeenCalledWith("existing-1", "manual");
  });
});

/* ==========================================================================
 * C7 — the unknown-string behaviour, decided rather than inherited
 * ========================================================================== */
describe("an unrecognised source string (BACKLOG-2481, SR required change 3)", () => {
  /**
   * `contacts:import` REFUSES it today — measured, and by accident: the value
   * reached the CHECK and took the batch down. The refusal is KEPT, because the
   * alternative is to start claiming every unknown record came out of the macOS
   * address book. What changes is only the message: a stated reason instead of a
   * raw SQLite constraint error.
   *
   * The error TEXT is not asserted (see the file header). Refused, zero rows.
   */
  it("is still refused by contacts:import, and lands nothing", async () => {
    const outcome = await importRecords([{ ...MESSAGE_DERIVED, source: "not_a_source" }]);

    expect(outcome.refused).toBe(true);
    expect(rows()).toEqual([]);
    expect(originLinks()).toEqual([]);
  });

  it("refuses the WHOLE batch, so a caller cannot half-succeed", async () => {
    const outcome = await importRecords([
      { ...MESSAGE_DERIVED, id: "msg_a", source: "contacts_app" },
      { ...MESSAGE_DERIVED, id: "msg_b", display_name: "Casey Ledger", name: "Casey Ledger", source: "not_a_source" },
    ]);

    expect(outcome.refused).toBe(true);
    expect(rows()).toEqual([]);
  });

  /**
   * `contacts:create` FOLDS it to `manual` today, and keeps doing so. The two
   * doors disagree, deliberately; this is the assertion that stops a later
   * refactor quietly making them agree in either direction.
   */
  it("is still folded to manual by contacts:create", async () => {
    const outcome = await createContact({
      ...MESSAGE_DERIVED,
      id: undefined,
      source: "not_a_source",
    });

    expect(outcome).toEqual({ refused: false, error: null });
    expect(rows()).toEqual([
      { id: expect.any(String), display_name: "Rosalind Quill", source: "manual" },
    ]);
  });
});

/* ==========================================================================
 * C6 — is the person still offered as UNSAVED after being saved?
 * ========================================================================== */
const MESSAGES_TABLE = `
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    channel TEXT,
    direction TEXT,
    participants TEXT,
    sent_at DATETIME,
    message_type TEXT,
    associated_message_type INTEGER
  );
`;

function seedThread(from: string) {
  mockDb!.exec(MESSAGES_TABLE);
  for (const [i, at] of ["2026-02-04 13:00:00", "2026-02-05 14:00:00"].entries()) {
    mockDb!
      .prepare(
        `INSERT INTO messages (id, user_id, channel, direction, participants, sent_at, message_type)
         VALUES (?,?,'sms','inbound',?,?, 'text')`,
      )
      .run(`m-${i}`, USER, JSON.stringify({ from }), at);
  }
}

describe("after the import, is the same person still offered as unsaved? (BACKLOG-2481 addendum A)", () => {
  it("MEASURED: the pseudo-contact survives its own import — the row is offered twice", async () => {
    seedThread("Rosalind Quill");
    const real = jest.requireActual("../services/db/contactDbService");

    // Before: one unsaved row, nothing saved.
    expect(real.getMessageDerivedContacts(USER).map((c: any) => c.display_name)).toEqual([
      "Rosalind Quill",
    ]);
    expect(rows()).toEqual([]);

    const outcome = await importRecords([MESSAGE_DERIVED]);
    expect(outcome).toEqual({ refused: false, error: null });

    /**
     * BY IDENTITY, NOT BY COUNT. The saved contact is there under `manual`, and
     * the pseudo-contact is STILL THERE beside it — so Clients & Contacts shows
     * two rows reading "Rosalind Quill", the BACKLOG-2511 shape.
     *
     * WHY, measured rather than reasoned: `namesThatAreTheirOwnIdentity`
     * (`contactDbService.ts:114-131`) only lets a saved contact suppress a
     * same-named sender when that contact has NO `contact_source_links` row. Its
     * own comment says a contact "created by importing this very message-derived
     * row" is meant to qualify — but since BACKLOG-2496 every create writes an
     * origin row, so `NOT EXISTS` is false and the suppression cannot fire. The
     * origin row is synthetic (`source_record_id = 'origin:<id>'`,
     * `match_method = 'origin'`), not an address-book record, so it is the wrong
     * thing for that rule to key on.
     *
     * NOT FIXED HERE. It is a rule in `contactDbService`, which this item does
     * not touch, and changing what suppresses a contact is an identity decision.
     * This test PINS the current behaviour so the follow-up has a starting point
     * and cannot land silently — and so this file states the defect rather than
     * leaving the next reader to find it on the screen.
     */
    expect(rows()).toEqual([
      { id: expect.any(String), display_name: "Rosalind Quill", source: "manual" },
    ]);
    expect(originLinks()).toEqual([{ source_type: "manual", match_method: "origin" }]);
    expect(real.getMessageDerivedContacts(USER).map((c: any) => c.display_name)).toEqual([
      "Rosalind Quill",
    ]);
  });

  /**
   * THE SAME FAILURE ON A PATH THIS ITEM DOES NOT TOUCH — so the defect is
   * PRE-EXISTING, not introduced here. Typing the person into Add Contact by
   * hand also writes an origin row, and also fails to suppress the sender.
   * BACKLOG-2481 adds one more population to a hole that is already open.
   */
  it("MEASURED: a hand-typed contact fails to suppress it too — the defect predates this item", async () => {
    seedThread("Rosalind Quill");
    const real = jest.requireActual("../services/db/contactDbService");

    const outcome = await createContact({
      name: "Rosalind Quill",
      phone: "+15550100",
      source: "manual",
    });

    expect(outcome).toEqual({ refused: false, error: null });
    expect(rows()).toEqual([
      { id: expect.any(String), display_name: "Rosalind Quill", source: "manual" },
    ]);
    expect(real.getMessageDerivedContacts(USER).map((c: any) => c.display_name)).toEqual([
      "Rosalind Quill",
    ]);
  });

  /**
   * The control that makes the results above mean something: with NO origin row,
   * the suppression does fire. So the rule works; it is the origin row that
   * defeats it, which is the finding.
   */
  it("CONTROL: with no crosswalk row, a saved contact DOES suppress the sender", async () => {
    seedThread("Rosalind Quill");
    const real = jest.requireActual("../services/db/contactDbService");

    mockDb!
      .prepare(
        "INSERT INTO contacts (id, user_id, display_name, source, is_imported) VALUES (?,?,?,?,1)",
      )
      .run("hand-typed-1", USER, "Rosalind Quill", "manual");

    expect(real.getMessageDerivedContacts(USER)).toEqual([]);
  });
});

/* ==========================================================================
 * C8 — the boundary compares EXACTLY. No trimming, no case folding.
 * ==========================================================================
 * This item's first draft normalised the inbound value with
 * `.trim().toLowerCase()`, and no test in this suite could tell whether it was
 * there or not — deleting it left all 32 green. It was a widening of the import
 * door arriving as a side effect of a refactor, which is the one thing the
 * `null`-not-fallback design exists to prevent.
 *
 * The row that mattered was `"SMS"`: under the normalisation `contacts:import`
 * stopped refusing it and stored `sms` — and a stored `sms` contact matches no
 * filter leaf, so a loud refusal became the silent failure this item's
 * destination decision was chosen to avoid.
 *
 * BACKLOG-3193 now refuses `sms` itself, so the `"SMS"` rows no longer tell a
 * normalising boundary from an exact one: both answer the same. They stay, as
 * refusals. The case-sensitivity is held by the other rows, and by the
 * `"Outlook"` row added beside the CONTROL's canonical `outlook`.
 *
 * These are the six probe rows that changed answer, pinned as assertions so the
 * normalisation cannot return unnoticed. Latent, not live: every contact-source
 * producer in the tree emits canonical lower-case today.
 */
describe("the write boundary compares exactly (BACKLOG-2481, SR required change A)", () => {
  it.each([
    ["SMS", "SMS"],
    ["Outlook — the CONTROL's value below, in the wrong case", "Outlook"],
    ["Contacts_App", "Contacts_App"],
    ["Messages — the synthetic value in the wrong case", "Messages"],
    ["' manual ' — untrimmed", " manual "],
    ["MANUAL", "MANUAL"],
  ])("contacts:import refuses %s, and lands nothing", async (_label, source) => {
    const outcome = await importRecords([{ ...MESSAGE_DERIVED, source }]);

    expect(outcome.refused).toBe(true);
    expect(rows()).toEqual([]);
    expect(originLinks()).toEqual([]);
  });

  it.each([
    ["SMS", "SMS"],
    ["Contacts_App", "Contacts_App"],
    ["' manual '", " manual "],
  ])("contacts:create folds %s to manual, as an unrecognised value", async (_label, source) => {
    const outcome = await createContact({ ...MESSAGE_DERIVED, id: undefined, source });

    expect(outcome).toEqual({ refused: false, error: null });
    expect(rows()).toEqual([
      { id: expect.any(String), display_name: "Rosalind Quill", source: "manual" },
    ]);
  });

  /**
   * The positive control. Without it, every assertion above is satisfied by a
   * boundary that refuses EVERYTHING, and the suite would be proving nothing
   * about case sensitivity.
   *
   * `outlook`, not `sms`: since BACKLOG-3193 `sms` is refused in any spelling,
   * so it can no longer show that the canonical spelling gets through. The
   * `"Outlook"` refusal row above is this control's pair.
   */
  it("CONTROL: the canonical lower-case spelling is still accepted on the import door", async () => {
    expect(await importRecords([{ ...MESSAGE_DERIVED, source: "outlook" }])).toEqual({
      refused: false,
      error: null,
    });
    expect(rows()).toEqual([
      { id: expect.any(String), display_name: "Rosalind Quill", source: "outlook" },
    ]);
  });
});
