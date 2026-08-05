/**
 * @jest-environment node
 *
 * BACKLOG-2458 — the import must record the user's own answer, for EVERY record
 * the row it stands for.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SUITE PINS
 * ---------------------------------------------------------------------------
 * `linkImportedContact` opened with `if (!identity) return;` and
 * `toSourceIdentity` read a SINGLE `(externalRecordId, externalSourceType)`
 * pair. A picker row the dedup had collapsed carried one identity at best, so
 * importing it wrote at most one crosswalk row and usually none — silently,
 * because the `catch` below the early return only fires on a THROWN error.
 *
 * Founder, 2026-08-03: imported Paul Dorian from a collapsed row, then synced.
 *
 *     14:42:40.422  links: ... content-matched 2 ... unmatched 1124
 *
 * BOTH records were matched by CONTENT on the following sync. Had the import
 * written its crosswalk row, the first pass would have id-matched it. It did
 * not, so nothing was written for either record.
 *
 * ---------------------------------------------------------------------------
 * THIS DRIVES THE REAL ROUND TRIP, NOT A HAND-BUILT PAYLOAD
 * ---------------------------------------------------------------------------
 * Every test calls `contacts:get-available` and feeds THE ROWS IT RETURNED to
 * `contacts:import`. That is what the renderer does
 * (`ImportContactsModal.tsx:94` filters the array from `getAvailable` and hands
 * the same objects straight to `import`), and it is the only way to prove the
 * collapsed identities actually survive the picker rather than proving a
 * fixture agrees with itself.
 *
 * The crosswalk writes and reads are REAL SQL against a real in-memory SQLite —
 * they are the thing under test. Only the saved-contact list and the shadow
 * table are mocked, because they are the inputs, not the rule.
 *
 * NO SYNC RUNS IN ANY TEST. `runOpportunisticLinking` is never invoked on the
 * import path, and the shadow table is mocked `isStale: false`, so every link
 * asserted below was written BY THE IMPORT (catalogue I3).
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

// REAL SQL for the crosswalk.
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

let mockImportedContacts: any[] = [];
let mockShadowRows: any[] = [];
let mockUnimportedDbContacts: any[] = [];

/**
 * `createContactsBatch` writes REAL rows.
 *
 * The crosswalk has a foreign key onto `contacts`, so a stub returning invented
 * ids would let a link be written for a contact that does not exist — and the
 * assertions would pass against rows the database would have rejected in
 * production. Input order is preserved, which is the property the handler's
 * id-pairing depends on.
 */
const createdContactIds: string[] = [];

jest.mock("../services/databaseService", () => ({
  __esModule: true,
  default: {
    getImportedContactsByUserIdAsync: jest.fn(() => Promise.resolve(mockImportedContacts)),
    getRemovedContactIdentifiers: jest.fn(() => Promise.resolve([])),
    getImportedContactsByUserId: jest.fn(() => Promise.resolve(mockImportedContacts)),
    getUnimportedContactsByUserId: jest.fn(() => Promise.resolve(mockUnimportedDbContacts)),
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
    createContactsBatch: jest.fn((rows: any[]) => {
      const ids: string[] = [];
      rows.forEach((row, i) => {
        // Unique per call, exactly like the real UUID mint: importing the same
        // picker row twice creates a SECOND contact, and it is the crosswalk's
        // UNIQUE constraint — not id reuse — that must stop the source record
        // being claimed twice.
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

const logLines: { level: string; message: string }[] = [];
jest.mock("../services/logService", () => {
  const capture = (level: string) => (message: string) => {
    logLines.push({ level, message: String(message) });
  };
  const m = {
    info: jest.fn(capture("info")),
    debug: jest.fn(capture("debug")),
    warn: jest.fn(capture("warn")),
    error: jest.fn(capture("error")),
  };
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
  // Never stale — NO SYNC MAY RUN. Every link asserted below is the import's.
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

/**
 * The opportunistic linker is the mechanism this feature exists to PRE-EMPT.
 * Throwing from it makes "a link appeared because a sync ran" impossible to
 * mistake for "the import wrote it" — if any test path reached a sync, it fails
 * loudly instead of going green for the wrong reason.
 */
jest.mock("../services/contactSourceLinker", () => ({
  __esModule: true,
  linkExternalContactsForUser: jest.fn(() => {
    throw new Error("no sync may run in this suite (BACKLOG-2458 I3)");
  }),
}));

import { registerContactHandlers } from "../handlers/contactHandlers";
import { getLinksForContact } from "../services/db/contactSourceLinkDbService";

const USER = "550e8400-e29b-41d4-a716-446655440000";
const mockEvent = {} as IpcMainInvokeEvent;

// ---------------------------------------------------------------------------
// FIXTURES
// ---------------------------------------------------------------------------

function shadowRow(
  recordId: string,
  name: string,
  source: string,
  emails: string[],
  phones: string[],
  externalUuid: string | null = null,
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
    external_uuid: externalUuid,
    last_message_at: null,
    synced_at: "2026-08-03T00:00:00.000Z",
  };
}

/** The picker's rows, exactly as the renderer receives them. */
async function getAvailable(): Promise<any[]> {
  const handler = registeredHandlers.get("contacts:get-available");
  const result = await handler(mockEvent, USER);
  expect(result.success).toBe(true);
  return result.contacts as any[];
}

/**
 * Import the picker rows the renderer would have sent — the SAME objects
 * `getAvailable` returned, filtered, never rebuilt (ImportContactsModal:94).
 */
async function importRows(rows: any[]): Promise<any> {
  const handler = registeredHandlers.get("contacts:import");
  const result = await handler(mockEvent, USER, rows);
  // Surface the handler's own error rather than a bare `false` — a failed
  // import here is almost always a fixture problem and hiding the reason wastes
  // the run.
  if (!result.success) throw new Error(`import failed: ${result.error}`);
  return result;
}

/**
 * The crosswalk rows for a contact as `(source_type, source_record_id,
 * match_method)` triples, sorted. IDENTITY, never a count.
 */
function linkTriples(contactId: string): string[] {
  return getLinksForContact(contactId)
    .map((l) => `${l.source_type}/${l.source_record_id}/${l.match_method}`)
    .sort();
}

/** Every contact row that now exists, so a link can be attributed to a person. */
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
  mockUnimportedDbContacts = [];
  createdContactIds.length = 0;
  logLines.length = 0;
  registeredHandlers.clear();
  // A real-enough window: the import emits `contacts:import-progress` on the
  // existing-DB path and calls `isDestroyed()` before every send.
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
describe("BACKLOG-2458 I1 — a collapsed row links EVERY record it stands for", () => {
  /**
   * THE FOUNDER'S CASE. Paul Dorian is in the Mac address book and in Outlook
   * on the same number under the same name, so the picker collapses them to one
   * row. He imports that row.
   *
   * NEGATIVE CONTROL (executed, output in the PR): delete the
   * `absorbSourceIdentity` call at the duplicate `continue` and this drops to a
   * single macos link — the pre-fix behaviour, and the reason the next sync
   * content-matched both records.
   */
  beforeEach(() => {
    mockShadowRows = [
      shadowRow("mac-paul", "Paul Dorian", "macos", ["paul@pauljdorian.com"], [
        "(408) 210-4874",
      ]),
      shadowRow("out-paul", "Paul Dorian", "outlook", ["dorian@bluespaces.com"], [
        "4082104874",
      ]),
    ];
  });

  it("collapses the two records to one row and carries BOTH identities on it", async () => {
    const rows = await getAvailable();

    expect(rows.map((r) => r.name)).toEqual(["Paul Dorian"]);
    expect(
      rows[0].collapsedSources
        .map((s: any) => `${s.sourceType}/${s.sourceRecordId}`)
        .sort(),
    ).toEqual(["macos/mac-paul", "outlook/out-paul"]);
  });

  it("writes a source_id crosswalk row for BOTH records, before any sync", async () => {
    const rows = await getAvailable();
    await importRows(rows);

    const paul = contactIdByName("Paul Dorian");
    expect(linkTriples(paul)).toEqual([
      "macos/mac-paul/source_id",
      "outlook/out-paul/source_id",
    ]);
  });

  it("reports the carry in the picker funnel line", async () => {
    await getAvailable();

    const picker = logLines.find((l) => l.message.includes("[Contacts] picker:"));
    expect(picker?.message).toContain("dup-suppressed 1 (identity carried 1)");
  });

  it("captures the portable identifier of a COLLAPSED record, not just the winner", async () => {
    // ZEXTERNALUUID is the only candidate cross-device key and it cannot be
    // captured later. Dropping the collapsed record dropped its copy too.
    mockShadowRows = [
      shadowRow("mac-paul", "Paul Dorian", "macos", [], ["(408) 210-4874"], "uuid-mac"),
      shadowRow("out-paul", "Paul Dorian", "outlook", [], ["4082104874"], "uuid-out"),
    ];

    await importRows(await getAvailable());

    const paul = contactIdByName("Paul Dorian");
    expect(
      getLinksForContact(paul)
        .map((l) => `${l.source_record_id}=${l.external_uuid}`)
        .sort(),
    ).toEqual(["mac-paul=uuid-mac", "out-paul=uuid-out"]);
  });

  it("collapses THREE records onto one row and links all three", async () => {
    mockShadowRows.push(
      shadowRow("goo-paul", "Paul Dorian", "google_contacts", [], ["408-210-4874"]),
    );

    await importRows(await getAvailable());

    expect(linkTriples(contactIdByName("Paul Dorian"))).toEqual([
      "google_contacts/goo-paul/source_id",
      "macos/mac-paul/source_id",
      "outlook/out-paul/source_id",
    ]);
  });

  it("links only the row the user actually selected", async () => {
    // A second, unrelated person is offered but NOT imported. Selecting one row
    // must not claim source records the user never chose.
    mockShadowRows.push(
      shadowRow("mac-jane", "Jane Seller", "macos", ["jane@example.com"], []),
    );

    const rows = await getAvailable();
    const paulRow = rows.filter((r) => r.name === "Paul Dorian");
    expect(paulRow).toHaveLength(1);
    await importRows(paulRow);

    expect(linkTriples(contactIdByName("Paul Dorian"))).toEqual([
      "macos/mac-paul/source_id",
      "outlook/out-paul/source_id",
    ]);
    expect(
      mockDb!
        .prepare("SELECT COUNT(*) AS n FROM contact_source_links WHERE user_id = ?")
        .get(USER),
    ).toEqual({ n: 2 });
  });
});

// ===========================================================================
describe("BACKLOG-2458 I3 — the link is written AT IMPORT, not on the next sync", () => {
  it("has the crosswalk populated the moment the import call resolves", async () => {
    mockShadowRows = [
      shadowRow("mac-solo", "Solo Person", "macos", ["solo@example.com"], []),
    ];

    // Nothing has run but the import. The linker mock throws if a sync starts.
    await importRows(await getAvailable());

    expect(linkTriples(contactIdByName("Solo Person"))).toEqual([
      "macos/mac-solo/source_id",
    ]);
  });

  it("records the method as source_id — the user's choice, not a content guess", async () => {
    // BACKLOG-2419's symptom: the provenance panel read "Matched by an email
    // address you already had" for a record the founder picked by hand. With
    // the import writing first there is no weaker incumbent to lose to.
    mockShadowRows = [
      shadowRow("mac-solo", "Solo Person", "macos", ["solo@example.com"], []),
    ];

    await importRows(await getAvailable());

    const links = getLinksForContact(contactIdByName("Solo Person"));
    expect(links.map((l) => l.match_method)).toEqual(["source_id"]);
    expect(links.every((l) => l.confidence === null)).toBe(true);
  });
});

// ===========================================================================
describe("BACKLOG-2458 I2 — a missing identity is LOGGED, never silent", () => {
  it("reports at INFO, naming the contact id, when a row genuinely has no source", async () => {
    // A local `contacts` row (the iPhone-sync path): no external record behind
    // it, so there is genuinely nothing to link. The skip must be VISIBLE — but
    // not a warning, because nothing was lost and no later sync will recover
    // anything. Warning here would be false on the common path and would train
    // the reader to skip the line `unrecognised-source-type` needs them to read
    // (SR review, PR #2194).
    mockDb!
      .prepare(
        "INSERT INTO contacts (id, user_id, display_name, is_imported) VALUES (?, ?, ?, 0)",
      )
      .run("db-row-1", USER, "Local Only");
    mockUnimportedDbContacts = [
      {
        id: "db-row-1",
        user_id: USER,
        display_name: "Local Only",
        name: "Local Only",
        email: "local@example.com",
        phone: null,
        company: null,
        source: "contacts_app",
        last_communication_at: null,
      },
    ];

    await importRows(await getAvailable());

    const reported = logLines.find((l) =>
      l.message.includes("had no source record behind them"),
    );
    expect(reported).toBeDefined();
    expect(reported!.level).toBe("info");
    expect(reported!.message).toContain("db-row-1");

    // And it must NOT be dressed up as a defect.
    expect(
      logLines.filter((l) => l.message.includes("recorded NO source link")),
    ).toEqual([]);
  });

  it("says how many contacts DID carry an identity, so a total silence is readable", async () => {
    mockShadowRows = [
      shadowRow("mac-solo", "Solo Person", "macos", ["solo@example.com"], []),
    ];

    await importRows(await getAvailable());

    const summary = logLines.find((l) => l.message.includes("import linking:"));
    expect(summary?.message).toBe(
      "[Contacts] import linking: 1 of 1 contacts carried a source identity, " +
        "1 crosswalk row(s) written as source_id",
    );
  });

  it("emits NO skip line at all when every imported contact carried an identity", async () => {
    mockShadowRows = [
      shadowRow("mac-solo", "Solo Person", "macos", ["solo@example.com"], []),
    ];

    await importRows(await getAvailable());

    expect(
      logLines.filter(
        (l) =>
          l.message.includes("recorded NO source link") ||
          l.message.includes("had no source record behind them"),
      ),
    ).toEqual([]);
  });

  it("names an unrecognised source type distinguishably from an absent record", async () => {
    // A source string `contact_source_links`' CHECK would reject. Before, this
    // and "no record at all" were the same silent `return`.
    const rows = [
      {
        id: "x",
        name: "Odd Source",
        email: "odd@example.com",
        phone: null,
        isFromDatabase: false,
        externalRecordId: "rec-1",
        externalSourceType: "carrier_pigeon",
        collapsedSources: [
          { sourceType: "carrier_pigeon", sourceRecordId: "rec-1", externalUuid: null },
        ],
      },
    ];

    await importRows(rows);

    const warning = logLines.find(
      (l) => l.level === "warn" && l.message.includes("recorded NO source link"),
    );
    expect(warning?.message).toContain("unrecognised-source-type");
  });
});

// ===========================================================================
describe("BACKLOG-2458 — the crosswalk's own guarantees still hold", () => {
  it("claims a source record for ONE contact, never two", async () => {
    // Importing the same picker row twice must not produce a second claim, and
    // must not re-point the first.
    mockShadowRows = [
      shadowRow("mac-solo", "Solo Person", "macos", ["solo@example.com"], []),
    ];

    const rows = await getAvailable();
    await importRows(rows);
    await importRows(rows);

    expect(
      mockDb!
        .prepare("SELECT COUNT(*) AS n FROM contact_source_links WHERE user_id = ?")
        .get(USER),
    ).toEqual({ n: 1 });
  });

  it("does not write a duplicate row when the representative repeats in the set", async () => {
    // `collapsedSources` includes the representative by construction, so the
    // dedup inside `toSourceIdentities` is load-bearing, not defensive.
    const rows = [
      {
        id: "x",
        name: "Twice Listed",
        email: "twice@example.com",
        phone: null,
        isFromDatabase: false,
        externalRecordId: "rec-dup",
        externalSourceType: "macos",
        collapsedSources: [
          { sourceType: "macos", sourceRecordId: "rec-dup", externalUuid: null },
          { sourceType: "macos", sourceRecordId: "rec-dup", externalUuid: null },
        ],
      },
    ];

    await importRows(rows);

    expect(linkTriples(contactIdByName("Twice Listed"))).toEqual([
      "macos/rec-dup/source_id",
    ]);
  });

  it("keys identity on the PAIR, so two sources issuing the same id both link", async () => {
    mockShadowRows = [
      shadowRow("shared-id", "Twin Ids", "macos", ["twin@example.com"], []),
      shadowRow("shared-id", "Twin Ids", "outlook", ["twin@example.com"], []),
    ];

    await importRows(await getAvailable());

    expect(linkTriples(contactIdByName("Twin Ids"))).toEqual([
      "macos/shared-id/source_id",
      "outlook/shared-id/source_id",
    ]);
  });
});


// ===========================================================================
describe("BACKLOG-2462 L10 — the case the carry does NOT reach", () => {
  /**
   * ⚠️ OPEN QUESTION, RECORDED RATHER THAN GUESSED.
   *
   * The brief for this work states that two records sharing NO email and NO
   * phone — an Outlook record holding only an address, a phone-book record
   * holding only a name and a number — "are collapsed correctly by the picker
   * on the name", and that carrying the collapsed identities therefore rescues
   * them (catalogue L10).
   *
   * EXECUTED, AND THE PREMISE DOES NOT HOLD. The picker does not collapse them:
   * `findDuplicateOwner` matches on a shared email or a shared phone, and these
   * two share neither. They arrive as TWO rows, each standing for itself. There
   * is no collapse, so there is nothing for I1 to carry, and this test exists to
   * say so out loud rather than let a green suite imply the case is covered.
   *
   * Making the picker collapse them would mean matching on NAME ALONE for
   * records that each carry a strong identifier — which is the rule
   * BACKLOG-2316 deliberately REMOVED, because it hid distinct people who share
   * a name (the two Margarets, already pinned in
   * `contact-handlers.pickerIdentity.test.ts`). That is a matching-rule change
   * with a live counter-example, not an oversight, and BACKLOG-2462 does not
   * settle it. It needs a founder decision.
   *
   * When that decision is made this test goes red, which is the point.
   */
  it("does NOT collapse two records sharing only a name, so each links only itself", async () => {
    mockShadowRows = [
      shadowRow("out-jane", "Jane Seller", "outlook", ["jane@realty.com"], []),
      shadowRow("mac-jane", "Jane Seller", "macos", [], ["(415) 555-1234"]),
    ];

    const rows = await getAvailable();

    // Two rows, each carrying exactly its own identity.
    expect(
      rows.map((r) => r.collapsedSources.map((s: any) => `${s.sourceType}/${s.sourceRecordId}`)),
    ).toEqual([["outlook/out-jane"], ["macos/mac-jane"]]);

    await importRows(rows);

    // Both records ARE linked — but as two separate people, because that is
    // what the picker offered and what the user accepted.
    const links = mockDb!
      .prepare(
        "SELECT contact_id, source_type, source_record_id FROM contact_source_links WHERE user_id = ? ORDER BY source_type",
      )
      .all(USER) as Array<{ contact_id: string; source_type: string; source_record_id: string }>;
    expect(links.map((l) => `${l.source_type}/${l.source_record_id}`)).toEqual([
      "macos/mac-jane",
      "outlook/out-jane",
    ]);
    expect(new Set(links.map((l) => l.contact_id)).size).toBe(2);
  });

  it("records nothing as carried when nothing was collapsed", async () => {
    mockShadowRows = [
      shadowRow("out-jane", "Jane Seller", "outlook", ["jane@realty.com"], []),
      shadowRow("mac-jane", "Jane Seller", "macos", [], ["(415) 555-1234"]),
    ];

    await getAvailable();

    const picker = logLines.find((l) => l.message.includes("[Contacts] picker:"));
    expect(picker?.message).toContain("dup-suppressed 0 (identity carried 0)");
  });
});
