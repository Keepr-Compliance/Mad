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
 * Founder, 2026-08-03: imported Casey Lane from a collapsed row, then synced.
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
 * (the import surface filters the array from `getAvailable` and hands
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
 * `getAvailable` returned, filtered, never rebuilt.
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
 * The raw handler promise, NOT awaited (BACKLOG-2525).
 *
 * `importRows` awaits and throws on failure, which is right for a sequential
 * test and useless for a concurrent one: a re-entry defect only appears when the
 * second call STARTS before the first finishes. This returns the promise so
 * several presses can be in flight at once, exactly as the founder's three
 * clicks were.
 */
function handlerImport(rows: any[]): Promise<any> {
  return registeredHandlers.get("contacts:import")(mockEvent, USER, rows);
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
describe("BACKLOG-2556 — a picker row claims EXACTLY the record it stands for", () => {
  /**
   * =========================================================================
   * THIS BLOCK ASSERTED THE OPPOSITE UNTIL 2026-08-09. IT IS THE LAUNDERING.
   * =========================================================================
   * It was "BACKLOG-2458 I1 — a collapsed row links EVERY record it stands
   * for", and it was a faithful description of what the code did: the picker
   * folded two address-book records into one row on a shared number plus a
   * compatible name, `absorbSourceIdentity` put BOTH identities on the
   * survivor, and importing that row wrote TWO `contact_source_links` rows,
   * each with `match_method: 'source_id'` — the method that means "the source
   * itself says these are the same record".
   *
   * The founder reproduced it live with fictional data: he imported ONE Luis
   * Ferreira row and the contact came back carrying THREE sources, two of them
   * labelled *"Recognised by its own entry in your Mac address book"*. Nothing
   * in the database could then distinguish the picker's guess from a genuine
   * identifier match, and there is no undo.
   *
   * The fold is deleted, so a row stands for one record and claims one record.
   * These cases keep the SAME fixtures — the same two Casey Lane cards on the
   * same number — and assert the opposite outcome, because the fixtures are the
   * exact shape the old rule folded.
   *
   * WHY THE ID SET AND NEVER A COUNT: "two links" cannot tell "both records
   * claimed" from "one record claimed twice", and "one link" cannot tell "the
   * right record" from "the other one".
   *
   * The two addresses below deliberately sit on DIFFERENT domains: these cases
   * assert a record is matched ACROSS sources, not by a shared address, so
   * collapsing them onto one domain would quietly destroy what they check.
   *
   * Both addresses, the name and the `mac-` / `out-` record ids were scrubbed
   * under BACKLOG-2731. The guard's email rule covers consumer mailbox domains
   * only and reported none of it; closing that gap is that item's step 3 and is
   * not this PR's to fix.
   */
  beforeEach(() => {
    mockShadowRows = [
      shadowRow("mac-casey", "Casey Lane", "macos", ["casey@example.com"], [
        "(408) 555-0101",
      ]),
      shadowRow("out-casey", "Casey Lane", "outlook", ["c.lane@example.org"], [
        "4085550101",
      ]),
    ];
  });

  it("offers the two records as TWO rows, neither carrying the other's identity", async () => {
    const rows = await getAvailable();

    expect(rows.map((r) => r.name)).toEqual(["Casey Lane", "Casey Lane"]);
    expect(
      rows.map((r: any) => `${r.externalSourceType}/${r.externalRecordId}`).sort(),
    ).toEqual(["macos/mac-casey", "outlook/out-casey"]);
    // The channel the fold used to append the loser's identity to the winner is
    // deleted, not merely empty.
    for (const row of rows) {
      expect((row as any).collapsedSources).toBeUndefined();
    }
  });

  /**
   * CONTROL 3 — THE LAUNDERING CASE, AND THE MOST IMPORTANT ONE HERE.
   *
   * Import ONE row and assert the crosswalk row ID SET. Before the deletion
   * this returned both `macos/mac-casey/source_id` and `outlook/out-casey/source_id`
   * from a single click.
   *
   * OBSERVED RED: restore `findDuplicateOwner` + `absorbSourceIdentity` at the
   * external-loop `continue` and this reddens with the second, unchosen record
   * named in the received value.
   */
  it("importing ONE row writes ONE source_id crosswalk row — the one the user picked", async () => {
    const rows = await getAvailable();
    const macRow = rows.filter((r: any) => r.externalRecordId === "mac-casey");
    expect(macRow).toHaveLength(1);

    await importRows(macRow);

    const casey = contactIdByName("Casey Lane");
    expect(linkTriples(casey)).toEqual(["macos/mac-casey/source_id"]);
    // And nothing else in the table: the Outlook record is unclaimed and still
    // importable as its own contact.
    expect(
      mockDb!
        .prepare("SELECT COUNT(*) AS n FROM contact_source_links WHERE user_id = ?")
        .get(USER),
    ).toEqual({ n: 1 });
  });

  it("reports no duplicate suppression in the picker funnel line", async () => {
    await getAvailable();

    const picker = logLines.find((l) => l.message.includes("[Contacts] picker:"));
    // Was "dup-suppressed 1 (identity carried 1)". Nothing is suppressed as a
    // duplicate any more, and the optional carry counter is omitted entirely
    // rather than reported as zero.
    expect(picker?.message).toContain("dup-suppressed 0");
    expect(picker?.message).not.toContain("identity carried");
  });

  it("carries each record's OWN portable identifier, and only its own", async () => {
    // ZEXTERNALUUID is the only candidate cross-device key and it cannot be
    // captured later. Each row must carry the uuid of the record it IS.
    mockShadowRows = [
      shadowRow("mac-casey", "Casey Lane", "macos", [], ["(408) 555-0101"], "uuid-mac"),
      shadowRow("out-casey", "Casey Lane", "outlook", [], ["4085550101"], "uuid-out"),
    ];

    await importRows(await getAvailable());

    // Both rows were imported this time, so both are claimed — but as TWO
    // contacts, each owning its own record, not one contact owning both.
    const links = mockDb!
      .prepare(
        "SELECT contact_id, source_record_id, external_uuid FROM contact_source_links WHERE user_id = ?",
      )
      .all(USER) as Array<{
      contact_id: string;
      source_record_id: string;
      external_uuid: string | null;
    }>;
    expect(
      links.map((l) => `${l.source_record_id}=${l.external_uuid}`).sort(),
    ).toEqual(["mac-casey=uuid-mac", "out-casey=uuid-out"]);
    expect(new Set(links.map((l) => l.contact_id)).size).toBe(2);
  });

  it("three records that resemble each other are three rows and three separate claims", async () => {
    mockShadowRows.push(
      shadowRow("goo-casey", "Casey Lane", "google_contacts", [], ["408-555-0101"]),
    );

    const rows = await getAvailable();
    expect(rows).toHaveLength(3);

    // Import only the Google one. The other two stay unclaimed.
    await importRows(rows.filter((r: any) => r.externalRecordId === "goo-casey"));

    expect(linkTriples(contactIdByName("Casey Lane"))).toEqual([
      "google_contacts/goo-casey/source_id",
    ]);
  });

  it("links only the row the user actually selected", async () => {
    // A second, unrelated person is offered but NOT imported. Selecting one row
    // must not claim source records the user never chose.
    mockShadowRows.push(
      shadowRow("mac-jane", "Jane Seller", "macos", ["jane@example.com"], []),
    );

    const rows = await getAvailable();
    const outRow = rows.filter((r: any) => r.externalRecordId === "out-casey");
    expect(outRow).toHaveLength(1);
    await importRows(outRow);

    expect(linkTriples(contactIdByName("Casey Lane"))).toEqual([
      "outlook/out-casey/source_id",
    ]);
    expect(
      mockDb!
        .prepare("SELECT COUNT(*) AS n FROM contact_source_links WHERE user_id = ?")
        .get(USER),
    ).toEqual({ n: 1 });
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

  /**
   * DELETED BY BACKLOG-2556 — "does not write a duplicate row when the
   * representative repeats in the set".
   *
   * It fed `collapsedSources` a repeat of the representative and asserted that
   * `toSourceIdentities`'s pair-dedup caught it, calling that dedup
   * "load-bearing, not defensive". It WAS load-bearing, for exactly as long as
   * `collapsedSources` existed. With the field deleted the only input is the
   * row's own pair, so the `seen` set can no longer be handed a repeat and the
   * test would pass while exercising nothing — the vacuous-green shape. Removed
   * rather than re-pointed: there is no remaining input that can produce a
   * duplicate for it to catch.
   */

  /**
   * RE-POINTED BY BACKLOG-2556. The GUARANTEE is unchanged and is still the
   * point: identity is the `(source_type, source_record_id)` PAIR, so two
   * sources that happen to issue the same id string do not collide.
   *
   * What changed is how the two records reach the crosswalk. The fold used to
   * collapse them onto ONE row (same name, same address) and the import wrote
   * both links against one contact. Now they are two rows and the user imports
   * both, producing two contacts — and the pair-keying is still what stops the
   * second `createLink` being rejected as a repeat of the first.
   *
   * Asserted across the whole table rather than per contact, because "both
   * link" is now a statement about two contacts.
   */
  it("keys identity on the PAIR, so two sources issuing the same id both link", async () => {
    mockShadowRows = [
      shadowRow("shared-id", "Twin Ids", "macos", ["twin@example.com"], []),
      shadowRow("shared-id", "Twin Ids", "outlook", ["twin@example.com"], []),
    ];

    const rows = await getAvailable();
    expect(rows).toHaveLength(2);
    await importRows(rows);

    const links = mockDb!
      .prepare(
        "SELECT contact_id, source_type, source_record_id FROM contact_source_links WHERE user_id = ? ORDER BY source_type",
      )
      .all(USER) as Array<{ contact_id: string; source_type: string; source_record_id: string }>;
    expect(links.map((l) => `${l.source_type}/${l.source_record_id}`)).toEqual([
      "macos/shared-id",
      "outlook/shared-id",
    ]);
    expect(new Set(links.map((l) => l.contact_id)).size).toBe(2);
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
      shadowRow("mac-jane", "Jane Seller", "macos", [], ["(415) 555-0109"]),
    ];

    const rows = await getAvailable();

    // Two rows, each carrying exactly its own identity. BACKLOG-2556: read off
    // the row's own `externalSourceType`/`externalRecordId` — `collapsedSources`
    // was deleted with the fold, and it is now the ONLY identity a row has.
    expect(
      rows.map((r: any) => `${r.externalSourceType}/${r.externalRecordId}`),
    ).toEqual(["outlook/out-jane", "macos/mac-jane"]);

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

  it("records no duplicate suppression, and no carry counter at all", async () => {
    mockShadowRows = [
      shadowRow("out-jane", "Jane Seller", "outlook", ["jane@realty.com"], []),
      shadowRow("mac-jane", "Jane Seller", "macos", [], ["(415) 555-0109"]),
    ];

    await getAvailable();

    const picker = logLines.find((l) => l.message.includes("[Contacts] picker:"));
    // BACKLOG-2556: was "dup-suppressed 0 (identity carried 0)". The carry
    // counter is now omitted rather than reported as zero, so the line does not
    // imply a carry mechanism that no longer exists.
    expect(picker?.message).toContain("dup-suppressed 0");
    expect(picker?.message).not.toContain("identity carried");
  });
});


// ===========================================================================
describe("BACKLOG-2511 — an imported record is gone from the NEXT picker call", () => {
  /**
   * THE PRECONDITION THE RENDERER FIX RESTS ON.
   *
   * BACKLOG-2511 is a renderer defect: after importing from Clients & Contacts,
   * the screen re-fetched the saved contacts and never re-fetched the address
   * book, so the imported person stayed on screen twice. The fix is to re-fetch
   * both.
   *
   * That fix is only worth anything if a second `contacts:get-available` call
   * actually STOPS returning the record. Its body warned that it might not:
   * while BACKLOG-2510 was open the import wrote only the synthetic
   * `origin:<contactId>` crosswalk row, which matches no real address-book id,
   * so suppression fell through to the email and phone fallbacks and depended
   * on the name and number normalising identically.
   *
   * BACKLOG-2510 has since merged (PR #2223, `c1f3ade2` — the Clients & Contacts
   * import now goes through `contacts:import`). These tests establish BY
   * EXECUTION, rather than by assumption, that the precondition now holds, and
   * that it holds for the RIGHT REASON.
   *
   * `mockImportedContacts` is left EMPTY throughout. It is the saved-contact
   * list that feeds `importedEmails` and `phoneClaimedByImported` — the two
   * content fallbacks (`contactHandlers.ts:1719-1748`). Leaving it empty means
   * neither fallback can fire, so anything suppressed here was suppressed by
   * the crosswalk row the import wrote and by nothing else.
   */
  const TAM_EMAIL = "tam.wexford@example.test";
  const TAM_PHONE = "+15550187";

  beforeEach(() => {
    mockShadowRows = [
      shadowRow("mac-tam", "Tam Wexford", "macos", [TAM_EMAIL], [TAM_PHONE]),
    ];
  });

  /** The picker's offer, as record identity. IDENTITY, never a count. */
  async function offeredRecordIds(): Promise<string[]> {
    return (await getAvailable()).map((r) => r.externalRecordId).sort();
  }

  /** Every saved contact that now exists. Again identity, never a count. */
  function savedContactIds(): string[] {
    return (
      mockDb!
        .prepare("SELECT id FROM contacts WHERE user_id = ? ORDER BY id")
        .all(USER) as Array<{ id: string }>
    ).map((r) => r.id);
  }

  it("offers the record before the import and NOT after it", async () => {
    expect(await offeredRecordIds()).toEqual(["mac-tam"]);

    await importRows(await getAvailable());

    // The whole point. A second call to the same handler, same shadow table,
    // same empty saved-contact list — and the record is gone.
    expect(await offeredRecordIds()).toEqual([]);
  });

  it("is the crosswalk row that suppresses it — delete the row and it comes back", async () => {
    await importRows(await getAvailable());
    expect(await offeredRecordIds()).toEqual([]);

    // NEGATIVE CONTROL, RUN IN CI RATHER THAN ONLY IN A TERMINAL.
    //
    // Without this, the test above passes just as happily if the record
    // vanished for some reason nobody intended — a source gate, an exception
    // swallowed into an empty list, a fixture the handler cannot emit. Removing
    // the one row that is supposed to be doing the work, and watching the
    // record return, is what makes the green above mean what it says.
    const deleted = mockDb!
      .prepare("DELETE FROM contact_source_links WHERE user_id = ?")
      .run(USER);
    expect(deleted.changes).toBe(1);

    expect(await offeredRecordIds()).toEqual(["mac-tam"]);
  });

  it("counts the record as already-imported, not as a source-gated or duplicate drop", async () => {
    await importRows(await getAvailable());
    logLines.length = 0;

    await getAvailable();

    // The funnel line names WHICH branch consumed the record. "already-imported"
    // is the crosswalk branch (`contactHandlers.ts:1695-1701`); a record dropped
    // by a source gate or by the duplicate pass would be counted elsewhere and
    // would leave this suite green for a reason that has nothing to do with the
    // import having claimed it.
    const picker = logLines.find((l) => l.message.includes("[Contacts] picker:"));
    expect(picker?.message).toContain("already-imported 1");
    // BACKLOG-2556: the carry parenthetical is gone with the fold.
    expect(picker?.message).toContain("dup-suppressed 0");
    expect(picker?.message).not.toContain("identity carried");
  });

  it("returns the SAME contact if the same record is imported twice — the stale row is now harmless", async () => {
    /**
     * WHY THE STALE ROW WAS A P0 AND NOT A COSMETIC DEFECT — AND WHAT CHANGED.
     *
     * The duplicated row on screen carried a live Import button. This test used
     * to pin what pressing it did: it created a SECOND saved contact, and that
     * measured fact is what made BACKLOG-2511 a P0 rather than a cosmetic
     * defect. It was reported at the time as a note on the item body.
     *
     * The founder then pressed it three times and got three Roseys, which is
     * BACKLOG-2525. The note should have been a defect. The assertion is now
     * INVERTED — same record, same ids, no second contact — and the reasoning
     * that produced the old expectation is worth keeping straight:
     *
     *   - BACKLOG-2511's body said a second import would hit `contacts:create`'s
     *     duplicate-by-NAME early return, so only differing names could produce
     *     a real duplicate. BACKLOG-2510 moved this flow to `contacts:import`,
     *     which has no such branch — correctly, since name-only matching is what
     *     BACKLOG-2316 removed for hiding distinct people who share a name.
     *   - So for a while nothing guarded it at all, and the name was irrelevant
     *     in the WRONG direction: the same record imported twice under the same
     *     name yielded two saved contacts.
     *   - BACKLOG-2525 restores a guard on the SOURCE RECORD, not the name. Two
     *     different people called "Chris Nguyen" are still two contacts, because
     *     they are two address-book records. The same record is one.
     */
    const rows = await getAvailable();
    await importRows(rows);
    const afterFirst = savedContactIds();
    expect(afterFirst).toHaveLength(1);

    // MAKE THE FIXTURE FAITHFUL BEFORE TRUSTING THE RESULT.
    //
    // Every other test in this describe leaves `mockImportedContacts` empty on
    // purpose, to keep the content fallbacks out of the way. Here that would be
    // a fixture describing a state production never reaches: by the time a user
    // can press Import a second time, the contact they just created IS in the
    // saved-contact list. Seeding it removes the objection that the duplicate
    // below is an artefact of an empty list.
    //
    // It changes nothing, and that is the finding: `contacts:import` splits
    // rows on `isFromDatabase` alone (`contactHandlers.ts:1979-1983`) and a
    // shadow-table row carries `isFromDatabase: false`, so it goes to
    // `createContactsBatch` without the saved-contact list ever being consulted.
    mockImportedContacts = [
      {
        id: afterFirst[0],
        user_id: USER,
        name: "Tam Wexford",
        display_name: "Tam Wexford",
        email: TAM_EMAIL,
        phone: TAM_PHONE,
        is_imported: 1,
      },
    ];

    // The renderer had already handed these rows out; pressing Import on the
    // stale one re-sends the very same objects.
    const second = await importRows(rows);

    // THE EXACT ID SET, unchanged. Not a count — a count of 1 would also be
    // satisfied by the first contact being replaced by a new one, which would
    // silently orphan every transaction role pointing at it.
    expect(savedContactIds()).toEqual(afterFirst);

    // And the second press HANDED BACK the incumbent rather than failing. The
    // renderer reads `contacts[0]` and throws on absence (`Contacts.tsx:459`),
    // so returning nothing would turn a no-op into a visible error.
    expect(second.contacts.map((c: any) => c.id)).toEqual([afterFirst[0]]);

    // The crosswalk still shows exactly one claim on the source record, held by
    // the original contact.
    const links = mockDb!
      .prepare("SELECT contact_id FROM contact_source_links WHERE user_id = ?")
      .all(USER) as Array<{ contact_id: string }>;
    expect(links.map((l) => l.contact_id)).toEqual([afterFirst[0]]);
  });
});

// ===========================================================================
describe("BACKLOG-2525 — importing the same source record twice is ONE contact", () => {
  /**
   * =========================================================================
   * THE FOUNDER'S THREE ROSEYS
   * =========================================================================
   * 2026-08-05, on `5037fcfc`:
   *
   *   > "on contact that have lots of emails and data the import button seems
   *   >  like it's not working — you can click it a few times and nothing
   *   >  happens. i was able to click it three times and i went back to the
   *   >  list and i see rosey 3 times"
   *
   * Three real `contacts` rows. `contacts:import` split its input on
   * `isFromDatabase` alone, so an address-book row went straight to
   * `createContactsBatch` and nothing asked whether the source record behind it
   * was already claimed.
   *
   * =========================================================================
   * WHY THE CLICKS ARE FIRED CONCURRENTLY AND NOT ONE AFTER ANOTHER
   * =========================================================================
   * A sequential test — `await import(); await import();` — cannot catch a
   * re-entry defect. It only ever exercises the case where the first write has
   * fully landed before the second read happens, which is the EASY half, and it
   * would pass against a guard placed anywhere in the handler including on the
   * far side of an `await`.
   *
   * The founder's three clicks OVERLAPPED a slow operation: the import was
   * still running when he pressed again, which is why the button looked dead.
   * So the tests below start all three invocations before awaiting any of them.
   * Each one suspends at `getValidUserId`, and all three then resume into the
   * same handler with the same input — the real interleaving, not a re-telling
   * of it.
   *
   * That is also why the guard sits where it does. Between the crosswalk read
   * and `linkImportedContact` there is no `await`, so the second invocation
   * cannot resume inside that window. Move the check earlier, next to
   * `toSourceIdentities` where it reads more naturally, and the existing-DB
   * loop's `await`s fall between the read and the write — every invocation
   * reads "unclaimed" and all three insert. The concurrent tests fail; the
   * sequential ones do not notice.
   *
   * A contact with many emails and phones is the slow case, so the fixture is
   * one: four addresses and three numbers, all synthetic.
   */
  const ROSEY_EMAILS = [
    "rosey.calderbank@example.test",
    "rosey@example.com",
    "r.calderbank@example.test",
    "rosey.c@example.com",
  ];
  const ROSEY_PHONES = ["+15550118", "+15550119", "+15550120"];

  beforeEach(() => {
    mockShadowRows = [
      shadowRow("mac-rosey", "Rosey Calderbank", "macos", ROSEY_EMAILS, ROSEY_PHONES),
    ];
  });

  /** Every saved contact that exists. IDENTITY, never a count. */
  function savedContactIds(): string[] {
    return (
      mockDb!
        .prepare("SELECT id FROM contacts WHERE user_id = ? ORDER BY id")
        .all(USER) as Array<{ id: string }>
    ).map((r) => r.id);
  }

  it("holds the contact id set unchanged when the SAME rows are imported three times at once", async () => {
    const rows = await getAvailable();
    expect(rows.map((r) => r.externalRecordId)).toEqual(["mac-rosey"]);

    // ---- THE FOUNDER'S THREE CLICKS. No `await` between them. ----
    const handler = registeredHandlers.get("contacts:import");
    const [a, b, c] = await Promise.all([
      handler(mockEvent, USER, rows),
      handler(mockEvent, USER, rows),
      handler(mockEvent, USER, rows),
    ]);

    expect([a.success, b.success, c.success]).toEqual([true, true, true]);

    // ONE contact, and every call reported that same one. Asserting the SET
    // rather than a length is the point: three presses returning three
    // different single contacts would satisfy a count and be the same defect.
    const ids = savedContactIds();
    expect(ids).toHaveLength(1);
    const returned = [a, b, c].map((r: any) => r.contacts.map((x: any) => x.id));
    expect(returned).toEqual([[ids[0]], [ids[0]], [ids[0]]]);
  });

  it("adds nothing on the second and third press — the id set after equals the id set after the first", async () => {
    /**
     * The acceptance criterion stated as a before/after on the SET, which is
     * the assertion the control below is aimed at. A count would pass for a
     * build that deleted the original and inserted a replacement.
     */
    const rows = await getAvailable();
    const [first] = await Promise.all([handlerImport(rows)]);
    expect(first.success).toBe(true);

    const afterFirst = savedContactIds();
    expect(afterFirst).toHaveLength(1);

    // Two more presses, concurrent with each other, against a record that is
    // now genuinely claimed.
    await Promise.all([handlerImport(rows), handlerImport(rows)]);

    expect(savedContactIds()).toEqual(afterFirst);
  });

  it("claims the source record exactly once, and the survivor owns it", async () => {
    const rows = await getAvailable();
    await Promise.all([handlerImport(rows), handlerImport(rows), handlerImport(rows)]);

    const ids = savedContactIds();
    expect(ids).toHaveLength(1);

    // The crosswalk row is the guard's own key, so this is not a second opinion
    // — it is the state that makes every future press a no-op, and the state
    // `contacts:get-available` reads to stop offering the record at all.
    expect(linkTriples(ids[0])).toEqual(["macos/mac-rosey/source_id"]);
  });

  it("still offers no second chance: the record is gone from the picker afterwards", async () => {
    const rows = await getAvailable();
    await Promise.all([handlerImport(rows), handlerImport(rows), handlerImport(rows)]);

    // Ties this suite to the BACKLOG-2511 one above: the guard and the picker
    // suppression read the SAME `(source_type, source_record_id)` pair, so a
    // change that broke one would show up here as the other disagreeing.
    expect((await getAvailable()).map((r) => r.externalRecordId)).toEqual([]);
  });

  it("does NOT collapse two different people who happen to share a name", async () => {
    /**
     * THE GUARD MUST NOT BECOME THE THING IT REPLACED.
     *
     * The path this flow used before BACKLOG-2510 guarded on exact
     * `LOWER(display_name)` (`contactHandlers.ts:2166-2193` ->
     * `contactDbService.ts:465-475`) and returned the incumbent. Restoring that
     * would reintroduce BACKLOG-2416: two genuinely different clients with the
     * same name silently become one, and the second import is discarded.
     *
     * Two address-book records, same name, NOTHING else in common — no shared
     * email, no shared phone, so the picker does not collapse them
     * (BACKLOG-2462 L10, pinned above) and they arrive as two rows. They must
     * import as two contacts. If this ever goes red because "one contact" was
     * expected, the guard has been re-keyed onto the name.
     */
    mockShadowRows = [
      shadowRow("mac-jordan-1", "Jordan Ashby", "macos", ["jordan.ashby@example.test"], [
        "+15550131",
      ]),
      shadowRow("mac-jordan-2", "Jordan Ashby", "macos", ["j.ashby@example.com"], [
        "+15550172",
      ]),
    ];

    const rows = await getAvailable();
    expect(rows.map((r) => r.externalRecordId).sort()).toEqual([
      "mac-jordan-1",
      "mac-jordan-2",
    ]);

    await importRows(rows);

    const ids = savedContactIds();
    expect(ids).toHaveLength(2);

    // And each owns its OWN record — not one contact holding both, which is the
    // shape an over-eager guard would produce.
    expect(ids.flatMap((id) => linkTriples(id)).sort()).toEqual([
      "macos/mac-jordan-1/source_id",
      "macos/mac-jordan-2/source_id",
    ]);
  });

  it("imports a genuinely new record alongside an already-claimed one, keeping the pairing straight", async () => {
    /**
     * THE INDEX-PAIRING HAZARD. The handler pairs created contact ids back to
     * source identities BY INDEX (`contactHandlers.ts`, BACKLOG-2401). Filtering
     * claimed rows out of the create list means the surviving arrays must be
     * filtered together — pair the created ids against the PRE-guard identity
     * list and every link after the first claimed row is attributed to the wrong
     * person. That misattribution is silent: the counts still agree.
     *
     * So: claim the first record, then import BOTH. One is skipped, one is
     * created, and the created one must end up with its own record and not the
     * skipped one's.
     */
    mockShadowRows = [
      shadowRow("mac-rosey", "Rosey Calderbank", "macos", ROSEY_EMAILS, ROSEY_PHONES),
      shadowRow("mac-oleg", "Oleg Vantry", "macos", ["oleg.vantry@example.test"], [
        "+15550164",
      ]),
    ];

    const rowsBefore = await getAvailable();
    const roseyRow = rowsBefore.find((r) => r.externalRecordId === "mac-rosey");
    await importRows([roseyRow]);
    const roseyId = savedContactIds()[0];

    // Now import both — Rosey is claimed, Oleg is not. The picker no longer
    // offers Rosey, so re-send the row the renderer was already holding, which
    // is exactly what a stale screen does.
    const olegRow = (await getAvailable()).find((r) => r.externalRecordId === "mac-oleg");
    await importRows([roseyRow, olegRow]);

    const ids = savedContactIds();
    expect(ids).toHaveLength(2);

    const olegId = ids.find((id) => id !== roseyId)!;
    expect(linkTriples(roseyId)).toEqual(["macos/mac-rosey/source_id"]);
    expect(linkTriples(olegId)).toEqual(["macos/mac-oleg/source_id"]);
  });

  it("holds ONE record to one contact across three concurrent presses [BACKLOG-2556]", async () => {
    /**
     * RE-POINTED BY BACKLOG-2556 — was "holds a COLLAPSED row to one contact
     * across three concurrent presses, keeping both identities".
     *
     * The re-entry guard is what this test is FOR and it is unchanged: three
     * overlapping presses on one row must produce one contact, because the
     * `findContactIdBySourceRecord` read and the `createLink` write fall in one
     * synchronous stretch with no `await` between them.
     *
     * What changed is the fixture's premise. Two Nita Bramwell records sharing
     * an address and a number used to arrive as ONE collapsed row carrying both
     * identities, and this asserted that one contact ended up owning both. That
     * grouping was the fold's guess, written down as two `source_id` rows. They
     * are now two rows; pressing one of them three times claims exactly that
     * one record, and the OTHER record stays unclaimed and importable.
     *
     * The docblock this replaced recorded a fixture that had to be thrown away —
     * "one identity claimed, one not" describes a state the picker cannot emit,
     * because a claimed record is suppressed. That observation survives the
     * deletion and is worth keeping: it is why the second record here is checked
     * as ABSENT from the crosswalk rather than by re-reading the picker.
     */
    mockShadowRows = [
      shadowRow("mac-nita", "Nita Bramwell", "macos", ["nita.bramwell@example.test"], [
        "+15550153",
      ]),
      shadowRow("out-nita", "Nita Bramwell", "outlook", ["nita.bramwell@example.test"], [
        "+15550153",
      ]),
    ];

    // The picker's own output, not a hand-built payload. Two rows now.
    const offered = await getAvailable();
    expect(offered.map((r: any) => r.externalRecordId).sort()).toEqual([
      "mac-nita",
      "out-nita",
    ]);

    const macOnly = offered.filter((r: any) => r.externalRecordId === "mac-nita");
    expect(macOnly).toHaveLength(1);

    await Promise.all([
      handlerImport(macOnly),
      handlerImport(macOnly),
      handlerImport(macOnly),
    ]);

    const ids = savedContactIds();
    expect(ids).toHaveLength(1);
    // EXACTLY the record pressed. `out-nita` is untouched — three presses on
    // one card cannot claim a card the user never pressed.
    expect(linkTriples(ids[0])).toEqual(["macos/mac-nita/source_id"]);
    expect(
      mockDb!
        .prepare("SELECT COUNT(*) AS n FROM contact_source_links WHERE user_id = ?")
        .get(USER),
    ).toEqual({ n: 1 });
  });
});
