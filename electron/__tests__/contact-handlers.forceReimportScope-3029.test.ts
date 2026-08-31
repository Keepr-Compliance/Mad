/**
 * @jest-environment node
 *
 * BACKLOG-3029 — FORCE RE-IMPORT MAY ONLY EMPTY WHAT IT IS ABOUT TO REFILL.
 *
 * ===========================================================================
 * WHAT ACTUALLY WENT WRONG, AS THE FOUNDER CORRECTED IT
 * ===========================================================================
 * Emptying `external_contacts` on a re-import is CORRECT. It is the shadow /
 * staging table the picker reads, not the user's contacts, and the founder said
 * so himself when the first filing of this item overstated it:
 *
 *   > "the force re-import didn't delete them... on force re-import we normally
 *   >  delete the shadow db table don't we?"
 *
 * The defect was the REFILL. `clearAllForUser` emptied every source, and the
 * refill only ever covers the three phases a contacts sync runs — and only when
 * they are switched on. From his machine, 2026-08-31:
 *
 *   21:42:56  [Main] Force re-import requested — wiping all sources
 *   21:42:56  [ExternalContactDbService] Cleared all external contacts
 *   21:42:57  [SyncOrchestrator] Contact source preferences:
 *               {"macosContacts":false,"outlookContacts":true,"googleContacts":true}
 *   21:42:57  [SyncOrchestrator] Skipping macOS Contacts (disabled by user preference)
 *   21:42:57  [ExternalContactDbService] Upserted 7 external contacts from outlook
 *   21:43:17  [Contacts] picker: 7 in (db 0 + external 7)
 *
 * 1,175 macOS rows and 28 `android_sync` rows emptied, 7 Outlook rows back. Not
 * data loss — nothing in the main `contacts` table is touched — but availability
 * loss: those records stop being offered for import, the source card reads 0,
 * and nothing says why. Android has no route back short of re-pairing the phone.
 *
 * ===========================================================================
 * WHY THIS SUITE RUNS THE REAL `externalContactDbService`
 * ===========================================================================
 * The question is "which rows are still on disk after the handler runs", so
 * anything that stubs the delete cannot answer it. Only `dbConnection` and the
 * outer I/O are mocked; the handler, the source filter and the DELETE are the
 * shipped code, running against a real in-memory SQLite.
 *
 * That also matters for the crosswalk assertions:
 * `deleteExternalContactsAndTheirLinks` reads `external_contacts` to decide
 * WHICH links to delete, so a suite that mocked the shadow table away would find
 * nothing to delete and pass no matter what the predicate said.
 *
 * ===========================================================================
 * ASSERTIONS ARE EXACT ID SETS, AND EVERY CASE CHECKS ITS OWN FIXTURE FIRST
 * ===========================================================================
 * A count cannot tell "the Android rows survived" from "the Android rows
 * survived and so did rows that should have gone". And "these rows survived"
 * passes vacuously if the fixture never held them, so each case asserts the
 * full seeded set BEFORE the handler runs. That check is not decoration: it is
 * the difference between a control and a green light.
 *
 * FIXTURES ARE INVENTED. Names are placeholders, numbers are inside the
 * reserved-for-fiction `+1 555 01xx` range, addresses use `example.test`.
 *
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --bail=0 \
 *     electron/__tests__/contact-handlers.forceReimportScope-3029.test.ts
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
  // A REAL transaction, not a passthrough (BACKLOG-2537): the delete and its
  // crosswalk cleanup are one unit, and a passthrough would make any atomicity
  // assertion here incapable of failing.
  dbTransaction: <T>(fn: () => T): T => mockDb!.transaction(fn)(),
  getDbPath: () => "/fake/path/mad.db",
  getEncryptionKey: () => "fake-key",
}));

jest.mock("../services/databaseService", () => ({
  __esModule: true,
  default: {
    getUserById: jest.fn((id: string) => Promise.resolve({ id })),
    isInitialized: jest.fn(() => true),
    getImportedContactsByUserIdAsync: jest.fn(() => Promise.resolve([])),
    getRemovedContactIdentifiers: jest.fn(() => Promise.resolve([])),
    getImportedContactsByUserId: jest.fn(() => Promise.resolve([])),
    getUnimportedContactsByUserId: jest.fn(() => Promise.resolve([])),
    backfillContactEmails: jest.fn(() => Promise.resolve(0)),
    backfillContactPhones: jest.fn(() => Promise.resolve(0)),
  },
}));

jest.mock("../services/supabaseService", () => ({
  __esModule: true,
  default: { getPreferences: jest.fn(() => Promise.resolve({})) },
}));

jest.mock("../services/logService", () => {
  const m = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { __esModule: true, default: m, logService: m };
});

jest.mock("../services/auditService", () => ({
  __esModule: true,
  default: { log: jest.fn(), logContactAction: jest.fn() },
}));

jest.mock("../services/contactsService", () => ({
  __esModule: true,
  getContactNames: jest.fn(() =>
    Promise.resolve({ phoneToContactInfo: {}, contacts: [], status: { loaded: true } }),
  ),
}));

jest.mock("../services/outlookFetchService", () => ({
  __esModule: true,
  default: { initialize: jest.fn(), fetchContacts: jest.fn() },
}));

jest.mock("../services/contactSyncService", () => ({
  __esModule: true,
  default: { registerProvider: jest.fn(), sync: jest.fn(), syncProvider: jest.fn() },
}));

// The linking pass is scheduling, not deletion. Stubbed so no timers are armed;
// `configureContactLinking` is called by `registerContactHandlers` itself, so a
// partial mock that omits it takes the whole suite down at registration.
jest.mock("../services/contactLinkingScheduler", () => ({
  configureContactLinking: jest.fn(),
  requestContactLinking: jest.fn(),
  holdContactLinking: jest.fn(),
  releaseContactLinking: jest.fn(),
  cancelPendingContactLinking: jest.fn(),
}));

jest.mock("../services/contactIngestionFunnel", () => ({ recordShadowSync: jest.fn() }));

jest.mock("../workers/contactWorkerPool", () => ({
  __esModule: true,
  isPoolReady: jest.fn(() => false),
  queryContacts: jest.fn(() => Promise.resolve([])),
}));

import { registerContactHandlers } from "../handlers/contactHandlers";
import { getContactSourceStats } from "../services/db/externalContactDbService";

const USER = "user-3029";
const mockEvent = {} as IpcMainInvokeEvent;

/**
 * One record per source, plus a record under a source name that does not exist
 * today. `future_push` stands in for the NEXT push-based integration: nobody has
 * classified it, and the fix must preserve it anyway — that is the difference
 * between a rule about a property and a rule about the name `android_sync`.
 */
const SEED: Array<{
  id: string;
  source: string;
  recordId: string;
  name: string;
  /** `contacts.source` for the promoted row — a DIFFERENT vocabulary. */
  contactSource: string;
  /** `contact_source_links.source_type` admits nine values and no others. */
  linkable: boolean;
}> = [
  {
    id: "ext-macos", source: "macos", recordId: "rec-macos", name: "Fixture Macos",
    // The one place the two vocabularies legitimately differ: the desktop
    // address book is `macos` in the shadow table and `contacts_app` in
    // `contacts` (see `toPersistedContactSource`). The CHECK enforces it.
    contactSource: "contacts_app", linkable: true,
  },
  {
    id: "ext-outlook", source: "outlook", recordId: "rec-outlook", name: "Fixture Outlook",
    contactSource: "outlook", linkable: true,
  },
  {
    id: "ext-google", source: "google_contacts", recordId: "rec-google", name: "Fixture Google",
    contactSource: "google_contacts", linkable: true,
  },
  {
    id: "ext-android", source: "android_sync", recordId: "rec-android", name: "Fixture Android",
    contactSource: "android_sync", linkable: true,
  },
  {
    id: "ext-iphone", source: "iphone", recordId: "rec-iphone", name: "Fixture Iphone",
    contactSource: "iphone", linkable: true,
  },
  {
    id: "ext-future", source: "future_push", recordId: "rec-future", name: "Fixture Future",
    // NO crosswalk row, and that is production's rule rather than a shortcut:
    // `contact_source_links.source_type` carries a CHECK listing nine spellings,
    // so a source nobody has added yet cannot have a link. It still has a shadow
    // row, which is the thing this suite is about.
    contactSource: "contacts_app", linkable: false,
  },
];

const ALL_SEEDED_IDS = SEED.map((r) => r.id).sort();
const ALL_SEEDED_LINK_IDS = SEED.filter((r) => r.linkable).map((r) => `link-${r.id}`).sort();

function seed(): void {
  for (const row of SEED) {
    mockDb!
      .prepare(
        `INSERT INTO external_contacts
           (id, user_id, name, phones_json, emails_json, source, external_record_id, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        USER,
        row.name,
        JSON.stringify(["+1 555 0100"]),
        JSON.stringify([`${row.recordId}@example.test`]),
        row.source,
        row.recordId,
        "2026-08-31T00:00:00.000Z",
      );

    // The MAIN-table contact this record was imported or promoted into. Seeded
    // for every source because the crosswalk row below has a real FK to it, and
    // because "the main table is untouched" is one of the two things this item's
    // correction turned on.
    mockDb!
      .prepare(
        `INSERT INTO contacts (id, user_id, display_name, source, is_imported)
         VALUES (?, ?, ?, ?, 1)`,
      )
      .run(`contact-${row.id}`, USER, row.name, row.contactSource);

    if (!row.linkable) continue;

    // The crosswalk row. Emptying a record must take this with it
    // (BACKLOG-2480); PRESERVING a record must leave it alone, which is the half
    // this item adds — for `android_sync` it is the claim BACKLOG-2987's probe
    // reads to decide "already promoted".
    mockDb!
      .prepare(
        `INSERT INTO contact_source_links (id, user_id, contact_id, source_type, source_record_id, match_method)
         VALUES (?, ?, ?, ?, ?, 'source_id')`,
      )
      .run(`link-${row.id}`, USER, `contact-${row.id}`, row.source, row.recordId);
  }
}

/** Every main-table contact, as an exact set. The correction's central claim. */
function mainContacts(): Array<{ id: string; display_name: string; source: string }> {
  return mockDb!
    .prepare("SELECT id, display_name, source FROM contacts WHERE user_id = ? ORDER BY id")
    .all(USER) as Array<{ id: string; display_name: string; source: string }>;
}

/** Exact identity, never a count. */
function shadowIds(): string[] {
  return (
    mockDb!
      .prepare("SELECT id FROM external_contacts WHERE user_id = ? ORDER BY id")
      .all(USER) as Array<{ id: string }>
  ).map((r) => r.id);
}

function linkIds(): string[] {
  return (
    mockDb!
      .prepare("SELECT id FROM contact_source_links WHERE user_id = ? ORDER BY id")
      .all(USER) as Array<{ id: string }>
  ).map((r) => r.id);
}

async function forceReimport(sources: unknown): Promise<{ success: boolean; cleared: number; error?: string }> {
  const handler = registeredHandlers.get("contacts:forceReimport");
  expect(handler).toBeDefined();
  return handler(mockEvent, USER, sources);
}

beforeEach(() => {
  // Calls only, not implementations. Without this the log assertion in the
  // empty-list case could be satisfied by a LINE AN EARLIER TEST LOGGED, which
  // is the same vacuous green the `toContain` assertions guard against.
  jest.clearAllMocks();
  mockDb = openTestDb();
  mockDb.exec(CONTACT_IDENTITY_SCHEMA);
  registeredHandlers.clear();
  registerContactHandlers({} as any);
  seed();
});

afterEach(() => {
  mockDb?.close();
  mockDb = null;
});

describe("Force Re-import empties only the sources about to be refilled (BACKLOG-3029)", () => {
  it("PRECONDITION: the fixture really holds a row and a crosswalk link for every source", () => {
    // Without this, every "it survived" below could pass on a row that was never
    // seeded — the vacuous green this item's whole class of bug hides behind.
    expect(shadowIds()).toEqual(ALL_SEEDED_IDS);
    expect(linkIds()).toEqual(ALL_SEEDED_LINK_IDS);
    expect(mainContacts().map((c) => c.id)).toEqual(
      SEED.map((r) => `contact-${r.id}`).sort(),
    );
    expect(getContactSourceStats(USER)).toEqual({
      macos: 1,
      outlook: 1,
      google_contacts: 1,
      android_sync: 1,
      iphone: 1,
      future_push: 1,
    });
  });

  /**
   * THE FOUNDER'S RUN, AS A TEST. `macosContacts` was off, so the orchestrator
   * names only Outlook and Google.
   *
   * MUTATION THAT MUST GO RED (executed; counts in the PR body): put the
   * predicate back to `user_id = ?` in `clearRefetchableSourcesForUser`.
   */
  it("names outlook + google: those two go, macOS / Android / iPhone stay", async () => {
    const result = await forceReimport(["outlook", "google_contacts"]);

    expect(result).toEqual({ success: true, cleared: 2 });
    expect(shadowIds()).toEqual(["ext-android", "ext-future", "ext-iphone", "ext-macos"]);
    // The 1,175-row case: macOS was switched off, so its rows are still here for
    // the user to get back by switching the source on.
    expect(shadowIds()).toContain("ext-macos");
  });

  it("the crosswalk follows the rows in BOTH directions", async () => {
    await forceReimport(["outlook", "google_contacts"]);

    // Emptied records take their links (BACKLOG-2480), preserved records keep
    // theirs. A cleanup that deleted every link would pass a test that only
    // checked the first half.
    expect(linkIds()).toEqual([
      "link-ext-android",
      "link-ext-iphone",
      "link-ext-macos",
    ]);
  });

  it("names all three fetchable sources: exactly those three go", async () => {
    const result = await forceReimport(["macos", "outlook", "google_contacts"]);

    expect(result.cleared).toBe(3);
    expect(shadowIds()).toEqual(["ext-android", "ext-future", "ext-iphone"]);
    expect(linkIds()).toEqual(["link-ext-android", "link-ext-iphone"]);
  });

  /**
   * THE PROPERTY, NOT THE NAME. A caller that asks for a push-based source is
   * refused by the main process, so the guard does not depend on every caller
   * getting its list right.
   *
   * MUTATION THAT MUST GO RED: drop the `.filter(isDesktopRefetchableSource)`.
   */
  it("refuses to empty android_sync even when the caller explicitly names it", async () => {
    const result = await forceReimport(["outlook", "android_sync"]);

    expect(result.cleared).toBe(1);
    expect(shadowIds()).toContain("ext-android");
    expect(linkIds()).toContain("link-ext-android");
  });

  it("refuses to empty iphone even when the caller explicitly names it", async () => {
    const result = await forceReimport(["outlook", "iphone"]);

    expect(result.cleared).toBe(1);
    expect(shadowIds()).toContain("ext-iphone");
  });

  /**
   * The next push-based source, whatever it turns out to be. It is preserved
   * WITHOUT anyone editing the fix — which is the whole argument for classifying
   * by property instead of writing `!== 'android_sync'`. If this ever goes red,
   * someone has changed the DELETE from an `IN` to a `NOT IN`.
   */
  it("an unclassified source survives being named, with no change to the fix", async () => {
    const result = await forceReimport(["outlook", "future_push"]);

    expect(result.cleared).toBe(1);
    expect(shadowIds()).toContain("ext-future");
  });

  it("an empty list empties nothing, and says so in its own words", async () => {
    // Every contact source switched off — a real state, not a defensive branch.
    //
    // The first version of this test asserted only the two lines below, and a
    // mutation proved that worthless: DELETING the early return left it fully
    // green, because `source IN ()` is legal SQLite that evaluates false. The
    // early return's whole effect is the LOG, so the log is what pins it. Without
    // the third assertion the branch is untested and the mutation is invisible.
    const result = await forceReimport([]);

    expect(result).toEqual({ success: true, cleared: 0 });
    expect(shadowIds()).toEqual(ALL_SEEDED_IDS);

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { logService } = require("../services/logService");
    expect(
      (logService.info as jest.Mock).mock.calls.map((c: unknown[]) => String(c[0])),
    ).toContain("Force re-import emptied nothing: no re-fetchable source was named");
  });

  it("a missing list is a loud error, not a full wipe and not a silent no-op", async () => {
    const result = await forceReimport(undefined);

    expect(result.success).toBe(false);
    expect(result.cleared).toBe(0);
    expect(result.error).toMatch(/list of contact sources/i);
    // Both wrong readings are excluded by one assertion: nothing was emptied.
    expect(shadowIds()).toEqual(ALL_SEEDED_IDS);
  });

  it("a duplicated source name still deletes exactly its own rows", async () => {
    const result = await forceReimport(["outlook", "outlook", "outlook"]);

    expect(result.cleared).toBe(1);
    expect(shadowIds()).toEqual([
      "ext-android",
      "ext-future",
      "ext-google",
      "ext-iphone",
      "ext-macos",
    ]);
  });

  /**
   * =======================================================================
   * INVESTIGATION 1 — DOES THE EMPTYING STRAND A PROMOTED CONTACT?
   * =======================================================================
   * BACKLOG-2986 promotes Android contacts into the MAIN `contacts` table. The
   * original filing of this item claimed the emptying might strand them; the
   * founder said it does not. Asserted rather than believed, in the direction
   * that matters: after the fix, an Android contact keeps its main-table row
   * AND the crosswalk claim that stops BACKLOG-2987 re-creating it.
   */
  it("a promoted contact and its record claim are untouched by a Force Re-import", async () => {
    const before = mainContacts();
    expect(before).toHaveLength(SEED.length);

    await forceReimport(["macos", "outlook", "google_contacts"]);

    // EVERY main-table contact survives, including the ones whose shadow record
    // was just emptied. The shadow table is staging; the contacts are the user's.
    expect(mainContacts()).toEqual(before);

    // And the Android claim specifically. It is what `findClaimedSourceRecordIds`
    // reads to answer "already promoted"; lose it and the next full sync
    // re-creates every Android contact the phone probe cannot answer for —
    // BACKLOG-2987, re-opened by a button called re-import.
    expect(linkIds()).toContain("link-ext-android");
  });

  /**
   * =======================================================================
   * THE SOURCE CARD IS NOT THE BUG — DO NOT "FIX THE COUNT"
   * =======================================================================
   * `getContactSourceStats` is a `GROUP BY source` over a zero floor for the
   * five known sources. It was reporting the truth before this change and it is
   * NOT touched by it: the founder read "0 Android" and correctly concluded the
   * rows were gone. That floor is also WHY he saw a zero rather than a missing
   * row — the card names a source even when nothing is under it.
   *
   * Pinned here so a later attempt to make the card "look right" by editing the
   * query has to argue with a test instead of hiding a real emptying.
   */
  it("the source card counts what is actually on disk, floor included", async () => {
    await forceReimport(["outlook", "google_contacts"]);

    expect(getContactSourceStats(USER)).toEqual({
      macos: 1,
      android_sync: 1,
      iphone: 1,
      // Emptied and about to be refilled — genuinely 0 at this instant, and the
      // floor is what makes them visible as 0 rather than absent.
      outlook: 0,
      google_contacts: 0,
      // Not in the floor: an unclassified source only appears once it has rows.
      future_push: 1,
    });
  });
});
