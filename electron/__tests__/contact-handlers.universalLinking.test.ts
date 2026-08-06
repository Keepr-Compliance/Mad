/**
 * @jest-environment node
 *
 * BACKLOG-2474 — contact matching must run for EVERY source, on the run that
 * wrote the records.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SUITE USES THE REAL SHADOW-TABLE SERVICE
 * ---------------------------------------------------------------------------
 * The defect was never in the matching engine — it has never had a source
 * filter and has always been able to match a macOS record against an Outlook
 * one. The defect was that nothing CALLED it unless the macOS sync ran.
 *
 * A suite that mocked `externalContactDbService` would therefore be testing the
 * wrong half: the trigger now lives on the INSERT itself (the three places a
 * record can enter `external_contacts`), so mocking the writer deletes the
 * thing under test. Every write below goes through the real service, into a
 * real in-memory SQLite, and the pass that follows is the real one — registered
 * by `registerContactHandlers`, not a stand-in.
 *
 * ---------------------------------------------------------------------------
 * THE CONTRACT BEING PINNED
 * ---------------------------------------------------------------------------
 * "At most one pass per quiet period, and every written record is seen by some
 * pass." NOT "exactly one pass per sync run" — see the scheduler suite for why
 * the stronger claim would be false on the sequential provider path.
 *
 * Assertions are exact identity SETS of `(contact_id, source_type,
 * source_record_id)`. Never counts: a count cannot tell a proposal about the
 * right pair from a proposal about the wrong one, and this whole feature is
 * about which pair gets asked.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

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

// REAL SQL everywhere — the crosswalk, the proposals AND the shadow table.
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
  dbTransaction: <T>(fn: () => T): T => fn(),
  getDbPath: () => "/fake/path/mad.db",
  getEncryptionKey: () => "fake-key",
}));

jest.mock("../services/databaseService", () => ({
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
    getContactById: jest.fn(() => Promise.resolve(null)),
    createContactsBatch: jest.fn(() => []),
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

/**
 * THE WINDOWS USER, expressed as the only thing that actually distinguishes
 * them: every macOS/iPhone contact source is OFF.
 *
 * This is the fixture that matters. Before BACKLOG-2474 the linking call sat
 * behind `macosEnabled || iphoneEnabled`, so this preference state meant the
 * pass never ran — not late, never — and the review queue was permanently empty
 * for every Outlook + Android user on Windows.
 */
let macosEnabled = true;
let iphoneEnabled = true;
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

jest.mock("../services/contactSyncService", () => ({
  __esModule: true,
  default: { registerProvider: jest.fn(), sync: jest.fn(), syncAll: jest.fn() },
}));

// Forces the main-thread path in the shadow service and the backfill, so every
// query below runs against the real in-memory database rather than a worker.
jest.mock("../workers/contactWorkerPool", () => ({
  __esModule: true,
  isPoolReady: jest.fn(() => false),
  queryContacts: jest.fn(() => Promise.resolve([])),
}));

import { registerContactHandlers } from "../handlers/contactHandlers";
import * as externalContactDb from "../services/db/externalContactDbService";
import { createLink } from "../services/db/contactSourceLinkDbService";
import {
  QUIET_PERIOD_MS,
  __resetContactLinkingScheduler,
  holdContactLinking,
  releaseContactLinking,
} from "../services/contactLinkingScheduler";

const USER = "550e8400-e29b-41d4-a716-446655440000";

// ---------------------------------------------------------------------------
// FIXTURES
// ---------------------------------------------------------------------------

/**
 * Columns the real writers use that the shared identity fixture does not
 * declare, because they belong to sync paths other suites do not exercise.
 * Added here rather than in the shared helper so no other suite's schema moves.
 */
const EXTRA_SHADOW_COLUMNS = `
  ALTER TABLE external_contacts ADD COLUMN sync_session_id TEXT;
  ALTER TABLE external_contacts ADD COLUMN source_identity_json TEXT;
`;

function addContact(id: string, displayName: string, source: string): void {
  mockDb!
    .prepare(
      "INSERT INTO contacts (id, user_id, display_name, source, is_imported, removed_at) VALUES (?, ?, ?, ?, 1, NULL)",
    )
    .run(id, USER, displayName, source);
}

/** A source record as the real writer stores it. */
function record(recordId: string, name: string, emails: string[] = [], phones: string[] = []) {
  return { external_record_id: recordId, name, emails, phones, company: null };
}

/**
 * A saved contact that already owns its own source record — i.e. the user
 * imported it, and the import recorded the crosswalk row.
 *
 * THIS IS THE FOUNDER'S ACTUAL STATE and it is not cosmetic. With no crosswalk
 * rows the name group contains four unowned members and the rule correctly asks
 * about every pair, INCLUDING each contact against the record it came from —
 * which is a real question in that state, but not his. Pinning the wrong state
 * would make the interesting assertion (each contact against the OTHER
 * source's record) unfalsifiable, because the noisier set contains it.
 */
function addImportedContact(
  contactId: string,
  displayName: string,
  sourceType: string,
  sourceRecordId: string,
): void {
  addContact(contactId, displayName, sourceType === "macos" ? "contacts_app" : sourceType);
  createLink({
    userId: USER,
    contactId,
    sourceType: sourceType as any,
    sourceRecordId,
    matchMethod: "source_id",
  });
}

/**
 * The crosswalk rows a saved contact owns, as sorted
 * `source_type/source_record_id` pairs.
 */
function linkPairs(): string[] {
  return (
    mockDb!
      .prepare(
        "SELECT contact_id, source_type, source_record_id FROM contact_source_links WHERE user_id = ?",
      )
      .all(USER) as Array<{ contact_id: string; source_type: string; source_record_id: string }>
  )
    .map((l) => `${l.contact_id}/${l.source_type}/${l.source_record_id}`)
    .sort();
}

/**
 * Every pending question as a sorted `(contact_id, source_type,
 * source_record_id)` triple. THE identity assertion for this feature.
 */
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

/** Proposal row IDs — pins that a re-run REPLACED nothing and ADDED nothing. */
function proposalIds(): string[] {
  return (
    mockDb!
      .prepare("SELECT id FROM contact_link_proposals WHERE user_id = ? ORDER BY id")
      .all(USER) as Array<{ id: string }>
  ).map((p) => p.id);
}

/** Let the coalesced pass fire and its async runner settle. */
async function settle(ms: number = QUIET_PERIOD_MS): Promise<void> {
  jest.advanceTimersByTime(ms);
  // The runner awaits the backfill, so drain the microtask queue.
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/**
 * How many passes have settled.
 *
 * The scheduler notifies on `contacts:link-review-updated` after every pass, so
 * counting that send is the only observable pass count available without
 * reaching inside the module. It is what makes "ONE pass" falsifiable: the
 * final proposal SET converges whether the pass runs once or once per source,
 * so a test asserting only the set cannot tell coalescing from per-source
 * firing. Verified — see the negative controls in the PR description.
 */
const send = jest.fn();
function passCount(): number {
  return send.mock.calls.filter((c) => c[0] === "contacts:link-review-updated").length;
}

beforeEach(() => {
  jest.useFakeTimers();
  mockDb = openTestDb();
  mockDb.exec(CONTACT_IDENTITY_SCHEMA);
  mockDb.exec(EXTRA_SHADOW_COLUMNS);
  macosEnabled = true;
  iphoneEnabled = true;
  send.mockClear();
  registeredHandlers.clear();
  __resetContactLinkingScheduler();
  // Registering the handlers is what injects the REAL pass into the scheduler.
  registerContactHandlers({
    isDestroyed: () => false,
    webContents: { send },
  } as any);
});

afterEach(() => {
  __resetContactLinkingScheduler();
  jest.useRealTimers();
  mockDb?.close();
  mockDb = null;
});

// ---------------------------------------------------------------------------
// 1. THE WINDOWS CASE — the reason this item is critical
// ---------------------------------------------------------------------------

describe("a user with NO macOS or iPhone source", () => {
  it("still gets cross-source matching, from Outlook + Android alone", async () => {
    // Every macOS/iPhone source off. On the old code this alone was enough to
    // guarantee the pass never ran.
    macosEnabled = false;
    iphoneEnabled = false;

    // One person, two saved contacts, one record per source, NO shared email or
    // phone — so only the name rule can connect them. The founder's exact shape.
    externalContactDb.upsertExternalContacts(USER, "outlook" as any, [
      record("out-juan", "Juan Villaherrera", ["juancavillaherrera@gmail.com"]),
    ]);
    externalContactDb.upsertExternalContacts(USER, "android_sync" as any, [
      record("and-juan", "Juan Villaherrera", [], ["+14088076253"]),
    ]);
    addImportedContact("c-out", "Juan Villaherrera", "outlook", "out-juan");
    addImportedContact("c-and", "Juan Villaherrera", "android_sync", "and-juan");

    await settle();

    // The pass ran, and it asked about the RIGHT pairs: each saved contact
    // against the other source's record. Exact set, not a count.
    expect(proposalTriples()).toEqual(
      ["c-and/outlook/out-juan", "c-out/android_sync/and-juan"].sort(),
    );
  });

  it("asks nothing when the two names are genuinely different people", async () => {
    // The discriminating half: the same wiring must NOT invent questions. If
    // this went green with the test above deleted, "the pass ran" would be
    // proving nothing about whether it ran CORRECTLY.
    macosEnabled = false;
    iphoneEnabled = false;

    externalContactDb.upsertExternalContacts(USER, "outlook" as any, [
      record("out-juan", "Juan Villaherrera", ["j@example.com"]),
    ]);
    externalContactDb.upsertExternalContacts(USER, "android_sync" as any, [
      record("and-maria", "Maria Restrepo", [], ["+14085550000"]),
    ]);
    addImportedContact("c-out", "Juan Villaherrera", "outlook", "out-juan");
    addImportedContact("c-and", "Maria Restrepo", "android_sync", "and-maria");

    await settle();

    expect(proposalTriples()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. SAME-RUN OUTLOOK — the 1.7s gap from the founder's log
// ---------------------------------------------------------------------------

describe("records written late in a sync run", () => {
  it("are matched by the SAME run's pass, not the next one", async () => {
    // From his log: macOS finished and the pass ran at 23:00:45.594; Outlook
    // inserted three records at 23:00:47.257. The pass had already judged a set
    // that did not contain them, so a second manual sync was required before
    // they were ever considered — and nothing told him that.
    externalContactDb.upsertFromMacOS(USER, [
      { recordId: "mac-juan", name: "Juan Villaherrera", phones: ["+14088076253"], emails: [] },
    ] as any);
    addImportedContact("c-mac", "Juan Villaherrera", "macos", "mac-juan");
    addImportedContact("c-out", "Juan Villaherrera", "outlook", "out-juan");

    // Outlook lands 1.7s later — inside the quiet window, so it restarts it.
    jest.advanceTimersByTime(1700);
    for (let i = 0; i < 5; i++) await Promise.resolve();

    // The macOS write has NOT fired its own pass. This is the coalescing
    // assertion, and it has to be made on the pass count rather than on the
    // proposal set: the set converges to the same value whether the pass runs
    // once or once per source, so asserting only the set cannot tell the two
    // apart. Confirmed by negative control — see the PR description.
    expect(passCount()).toBe(0);

    externalContactDb.upsertExternalContacts(USER, "outlook" as any, [
      record("out-juan", "Juan Villaherrera", ["juancavillaherrera@gmail.com"]),
    ]);

    await settle();

    // Exactly ONE pass for the whole run...
    expect(passCount()).toBe(1);
    // ...and it saw BOTH sources.
    expect(proposalTriples()).toEqual(
      ["c-mac/outlook/out-juan", "c-out/macos/mac-juan"].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// 3. IDEMPOTENCY
// ---------------------------------------------------------------------------

describe("repeated passes", () => {
  it("produce no duplicate proposals — same rows, same ids", async () => {
    externalContactDb.upsertFromMacOS(USER, [
      { recordId: "mac-juan", name: "Juan Villaherrera", phones: ["+14088076253"], emails: [] },
    ] as any);
    externalContactDb.upsertExternalContacts(USER, "outlook" as any, [
      record("out-juan", "Juan Villaherrera", ["juancavillaherrera@gmail.com"]),
    ]);
    addImportedContact("c-mac", "Juan Villaherrera", "macos", "mac-juan");
    addImportedContact("c-out", "Juan Villaherrera", "outlook", "out-juan");
    await settle();

    const firstIds = proposalIds();
    const firstTriples = proposalTriples();
    expect(firstTriples.length).toBeGreaterThan(0);

    // Two more full runs, driven the way production drives them: another write.
    for (let i = 0; i < 2; i++) {
      externalContactDb.upsertExternalContacts(USER, "outlook" as any, [
        record("out-juan", "Juan Villaherrera", ["juancavillaherrera@gmail.com"]),
      ]);
      await settle();
    }

    // ROW IDS, not counts. A count would stay equal if a proposal were deleted
    // and re-inserted; the ids prove the original rows are untouched, which is
    // what stops an answered-then-reasked loop.
    expect(proposalIds()).toEqual(firstIds);
    expect(proposalTriples()).toEqual(firstTriples);
  });
});

// ---------------------------------------------------------------------------
// 4. THE iPHONE ROLLBACK HAZARD (SR review)
// ---------------------------------------------------------------------------

describe("a rollback-eligible iPhone sync", () => {
  it("writes NO links or proposals for rows a rollback will delete", async () => {
    // TASK-2110 rollback deletes exactly the rows carrying this sessionId, and
    // it does not clean `contact_source_links` or `contact_link_proposals`.
    // `storeAttachments` runs after the contact write and can take minutes, so
    // a pass firing in between would leave the crosswalk pointing at records
    // that no longer exist. The review queue would hide the orphaned proposals
    // (its read INNER JOINs external_contacts) but the LINKS would be silently
    // wrong — the ACID guarantee breached, invisibly.
    const SESSION = "sync-session-1";

    externalContactDb.upsertExternalContacts(USER, "outlook" as any, [
      record("out-juan", "Juan Villaherrera", ["juancavillaherrera@gmail.com"]),
    ]);
    addImportedContact("c-out", "Juan Villaherrera", "outlook", "out-juan");

    // The iPhone sync takes the hold for the lifetime of its session, exactly
    // as `persistSyncResult` does.
    holdContactLinking(USER);
    externalContactDb.upsertFromiPhone(
      USER,
      [{ recordId: "iph-juan", name: "Juan Villaherrera", phones: ["+14088076253"], emails: [] }] as any,
      SESSION,
    );

    // A DIFFERENT source finishing mid-session. This is the case that
    // suppressing the iPhone path's own signal does NOT cover: this signal is
    // legitimate, and the pass it asks for would read the provisional rows too.
    externalContactDb.upsertExternalContacts(USER, "google_contacts" as any, [
      record("goo-juan", "Juan Villaherrera", ["juan@gmail.com"]),
    ]);

    await settle();

    // Nothing ran at all, because the hold is on the DATA, not on the signaller.
    expect(
      [...linkPairs(), ...proposalTriples()].filter((row) => row.includes("iph-juan")),
    ).toEqual([]);

    // The user cancels. Rollback removes the provisional rows...
    externalContactDb.deleteBySessionId(USER, SESSION);
    releaseContactLinking(USER);
    await settle();

    // ...and the pass that was owed from the hold window now runs — against a
    // table that no longer contains them.
    expect(
      [...linkPairs(), ...proposalTriples()].filter((row) => row.includes("iph-juan")),
    ).toEqual([]);

    // And the deferral cost nothing: the legitimate google record IS matched.
    expect(proposalTriples()).toEqual(["c-out/google_contacts/goo-juan"]);
  });

  it("cleans the crosswalk if a pass ever did link a rolled-back record", async () => {
    // Defence in depth for the hold above. If a future path writes session rows
    // without taking the hold — or the process is killed between the two — the
    // deleter must still not leave `contact_source_links` pointing at records
    // it removed. A link to a record that no longer exists is worse than no
    // link: it attributes a contact to a source the user cannot see, and the
    // review queue hides the matching proposals because its read INNER JOINs
    // `external_contacts`.
    const SESSION = "sync-session-2";

    externalContactDb.upsertFromiPhone(
      USER,
      [{ recordId: "iph-juan", name: "Juan Villaherrera", phones: ["+14088076253"], emails: [] }] as any,
      SESSION,
    );
    addContact("c-mac", "Juan Villaherrera", "contacts_app");
    // Simulate the link a pass would have written had it slipped through.
    createLink({
      userId: USER,
      contactId: "c-mac",
      sourceType: "iphone" as any,
      sourceRecordId: "iph-juan",
      matchMethod: "unique_name",
    });
    expect(linkPairs()).toEqual(["c-mac/iphone/iph-juan"]);

    externalContactDb.deleteBySessionId(USER, SESSION);

    expect(linkPairs()).toEqual([]);
    expect(proposalTriples()).toEqual([]);
  });

  it("DOES match a session-less iPhone write, which is not provisional", async () => {
    // The guard must be narrow: it keys on a session being OPEN, not on the
    // source being iPhone. A caller with no session has committed rows and must
    // not have its matching suppressed.
    //
    // Paired against Outlook rather than macOS deliberately: `macos` and
    // `iphone` are the same source family, and agreement WITHIN a family is a
    // duplicate rather than a cross-source identity question (BACKLOG-2370).
    // Pairing them would assert nothing about this guard.
    externalContactDb.upsertExternalContacts(USER, "outlook" as any, [
      record("out-juan", "Juan Villaherrera", ["juancavillaherrera@gmail.com"]),
    ]);
    externalContactDb.upsertFromiPhone(USER, [
      { recordId: "iph-juan", name: "Juan Villaherrera", phones: ["+14088076253"], emails: [] },
    ] as any);
    addImportedContact("c-out", "Juan Villaherrera", "outlook", "out-juan");
    addImportedContact("c-iph", "Juan Villaherrera", "iphone", "iph-juan");

    await settle();

    expect(proposalTriples()).toEqual(
      ["c-iph/outlook/out-juan", "c-out/iphone/iph-juan"].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// 6. THE HARNESS ITSELF — the transaction in this suite is REAL (BACKLOG-2537)
// ---------------------------------------------------------------------------

/**
 * ===========================================================================
 * WHY THIS BLOCK EXISTS, GIVEN NOTHING ABOVE IT IS ABOUT ATOMICITY
 * ===========================================================================
 * Until BACKLOG-2537 this suite stubbed `dbTransaction` as `(fn) => fn()`.
 * Every test above passed under that stub and passes without it, so NOTHING
 * ABOVE CAN TELL THE TWO APART. Replacing the stub therefore proves nothing on
 * its own — it is a change no existing assertion can see, which is the exact
 * shape of edit this repo treats as unverified.
 *
 * So the conversion gets its own test, and the test is chosen to be one the
 * OLD stub would have failed. Reinstate `(fn) => fn()` above and this goes red;
 * that control was run, and is recorded in the PR.
 *
 * `upsertExternalContacts` is a loop of INSERTs inside one `dbTransaction`.
 * That is the shape a crash mid-sync hits: the founder's address book is
 * written in batches, and half a batch is not a state the app can distinguish
 * afterwards from a sync that legitimately saw fewer records.
 *
 * The crash is a real SQLite `RAISE(ABORT)` on a real INSERT at a real point in
 * the batch — not a mock standing in for a failure.
 *
 * Fixtures are reserved-for-documentation values only (`example.com`, the
 * `+1 555 01xx` fictional range); the names are invented.
 */
describe("the transaction this suite runs on is a real one (BACKLOG-2537)", () => {
  /** Every shadow row on disk, as an exact `(source, record id)` set. */
  function shadowPairs(): string[] {
    return (
      mockDb!
        .prepare(
          "SELECT source, external_record_id FROM external_contacts WHERE user_id = ? ORDER BY source, external_record_id",
        )
        .all(USER) as Array<{ source: string; external_record_id: string }>
    ).map((r) => `${r.source}/${r.external_record_id}`);
  }

  it("rolls a whole batch back when one record in the middle fails to write", () => {
    // A record already on disk from an earlier, clean sync. Its survival is
    // half the assertion: a rollback must undo the failed batch and NOTHING
    // else.
    externalContactDb.upsertExternalContacts(USER, "outlook" as any, [
      record("out-existing", "Marisol Okafor", ["marisol.okafor@example.com"]),
    ]);
    expect(shadowPairs()).toEqual(["outlook/out-existing"]);

    mockDb!.exec(`
      CREATE TRIGGER crash_mid_batch_2537
      BEFORE INSERT ON external_contacts
      WHEN NEW.external_record_id = 'out-poison'
      BEGIN
        SELECT RAISE(ABORT, 'forced crash partway through the batch');
      END;
    `);

    /**
     * `.rejects.toThrow()` is NOT used here, and that is deliberate
     * (BACKLOG-2539): on CI it was measured failing to observe an error raised
     * inside the native driver, in this very repo, in the run that shipped
     * BACKLOG-2496. This form asserts BOTH that it threw AND the exact message,
     * so it is stricter than the assertion it replaces, not weaker.
     */
    let outcome = "NO THROW — the batch completed, so there was nothing to roll back";
    try {
      externalContactDb.upsertExternalContacts(USER, "outlook" as any, [
        record("out-first", "Devin Ashcroft", ["devin.ashcroft@example.com"]),
        record("out-poison", "Poison Record", ["poison@example.com"]),
        record("out-last", "Rhoda Yiu", ["rhoda.yiu@example.com"]),
      ]);
    } catch (error) {
      outcome = `REJECTED: ${(error as Error).message}`;
    }
    expect(outcome).toMatch(/^REJECTED: .*forced crash partway through the batch/);

    // THE ASSERTION. An exact set, never a count: a count of 1 cannot tell the
    // pre-existing record from a survivor of the failed batch, and those are
    // opposite verdicts.
    //
    // Under the old passthrough `out-first` is committed before the abort, so
    // this reads ["outlook/out-existing", "outlook/out-first"] and the test is
    // red. That is the control.
    expect(shadowPairs()).toEqual(["outlook/out-existing"]);
  });

  it("still commits a batch that does not fail", () => {
    // The other half. A test that only ever asserts "nothing was written" would
    // also pass against a transaction that never commits anything at all.
    externalContactDb.upsertExternalContacts(USER, "outlook" as any, [
      record("out-a", "Marisol Okafor", ["marisol.okafor@example.com"]),
      record("out-b", "Devin Ashcroft", ["devin.ashcroft@example.com"]),
    ]);

    expect(shadowPairs()).toEqual(["outlook/out-a", "outlook/out-b"]);
  });
});
