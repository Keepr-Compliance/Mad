/**
 * @jest-environment node
 *
 * BACKLOG-2608 — THE APP MAY NOT ASK ABOUT A RECORD IT REFUSES TO SHOW.
 *
 * ===========================================================================
 * THE CONTRADICTION, IN THE FOUNDER'S WORDS (2026-08-09, clean DB `1590f890`)
 * ===========================================================================
 *   "If I only see them once in the clients list and all the rest are hiding
 *    before I clicked confirm, that's an issue."
 *
 * He imported ONE contact, Rosalind Vance. FOUR records were flagged as
 * candidates and filed to the review queue, whose card reads:
 *
 *   "Possible duplicates — these were not linked automatically because we could
 *    not tell. NOTHING CHANGES UNTIL YOU ANSWER."
 *
 * Clients & Contacts showed one Rosalind. All four candidates had already been
 * removed by `emailClaimedByImported` / `phoneClaimedByImported`.
 *
 * Two surfaces asserting opposite things about the same four rows: the queue
 * said it could not attribute them, the list had already concluded they were
 * the same person. And the card's promise was literally false — four rows
 * vanished before he answered anything.
 *
 * ===========================================================================
 * WHY THE NARROW FIX IS NOT WHAT IS TESTED HERE
 * ===========================================================================
 * "Do not suppress a record with a PENDING proposal" resolves the contradiction
 * and fails the case the founder went straight to: answer "not this person",
 * the proposal is resolved so nothing is pending, and the record disappears
 * anyway — because the hiding rule never looked at questions, it looked at
 * whether a saved contact held that email, which it still does.
 *
 *   "if I clicked not this person this contact shouldn't disappear."
 *
 * So the rule under test is the whole one: **`contact_source_links` decides
 * what is already imported.** Control 3 is the primary control, not a
 * nice-to-have, and control 4 is the case the narrow fix would have passed
 * while still being wrong.
 *
 * ===========================================================================
 * HOW THIS SUITE IS BUILT
 * ===========================================================================
 * Real SQL, real schema, a REAL `dbTransaction` (`mockDb.transaction(fn)()`,
 * not the `(fn) => fn()` passthrough BACKLOG-2368 exists to reject), and the
 * REAL writers — `createLink`, `proposeLink`, and `confirmProposal` /
 * `rejectProposal` from `contactLinkReview`, which are the functions the review
 * screen actually calls. Nothing here simulates an answer by writing the row it
 * expects to see.
 *
 * Every assertion is an EXACT ID SET. A count of 4 cannot tell "all four
 * candidates survived" from "three survived and something else appeared", and
 * the wrong row surviving is precisely the failure mode.
 *
 * Run under plain node (`node:sqlite`); the repo's better-sqlite3 binary is an
 * Electron build and cannot load under it.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { IpcMainInvokeEvent } from "electron";
import { CONTACT_IDENTITY_SCHEMA } from "../services/__tests__/helpers/contactIdentitySchema";
import { openTestDb, type TestDb } from "../services/__tests__/helpers/syncSqliteDriver";

let mockDb: TestDb | null = null;

const registeredHandlers = new Map<string, any>();

let mockImportedContacts: any[] = [];
let mockShadowRows: any[] = [];

jest.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: any) => registeredHandlers.set(channel, fn),
  },
  app: { getPath: jest.fn(() => "/tmp") },
  BrowserWindow: { getAllWindows: jest.fn(() => []) },
}));

jest.mock("../services/db/core/dbConnection", () => ({
  ensureDb: () => mockDb,
  dbAll: (sql: string, params: unknown[] = []) => mockDb!.prepare(sql).all(...params),
  dbGet: (sql: string, params: unknown[] = []) => mockDb!.prepare(sql).get(...params),
  dbRun: (sql: string, params: unknown[] = []) => {
    const r = mockDb!.prepare(sql).run(...params);
    return { lastInsertRowid: r.lastInsertRowid as number, changes: r.changes };
  },
  dbTransaction: <T>(fn: () => T): T => mockDb!.transaction(fn)(),
  getDbPath: () => "/fake/path/mad.db",
  getEncryptionKey: () => "fake-key",
}));

jest.mock("../services/databaseService", () => ({
  __esModule: true,
  default: {
    getImportedContactsByUserIdAsync: jest.fn(() => Promise.resolve(mockImportedContacts)),
    getRemovedContactIdentifiers: jest.fn(() => Promise.resolve([])),
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
  proposeLink,
  listPendingProposals,
  listVerdicts,
} from "../services/db/contactLinkReviewDbService";
import { confirmProposal, rejectProposal } from "../services/contactLinkReview";

const USER = "550e8400-e29b-41d4-a716-446655440000";
const CONTACT = "c-rosalind";
const mockEvent = {} as IpcMainInvokeEvent;

// ---------------------------------------------------------------------------
// The founder's corpus, transcribed from his 2026-08-09 run
// ---------------------------------------------------------------------------
// He imported ONE contact and four records were flagged. Every fixture value
// uses the reserved documentation forms: `example.com`, and 555 in the EXCHANGE
// slot of a +1 number.
const ROSALIND_EMAIL = "rosalind@example.com";
const ROSALIND_PHONE_E164 = "+16285550142";
const ROSALIND_PHONE_RAW = "(628) 555-0142";

/** The four candidate records, each resembling Rosalind on one identifier. */
const CANDIDATES = [
  { rec: "mac-rosalind-1", name: "Rosalind Vance", src: "macos", emails: [ROSALIND_EMAIL], phones: [] },
  { rec: "mac-rosalind-2", name: "Rosalind Vance", src: "macos", emails: [], phones: [ROSALIND_PHONE_RAW] },
  { rec: "out-rosalind-1", name: "R. Vance", src: "outlook", emails: [ROSALIND_EMAIL], phones: [] },
  { rec: "out-rosalind-2", name: "Rosalind Vance", src: "outlook", emails: [], phones: [ROSALIND_PHONE_RAW] },
] as const;

function seedContactRow(id: string, name: string): void {
  mockDb!
    .prepare("INSERT INTO contacts (id, user_id, display_name, is_imported) VALUES (?, ?, ?, 1)")
    .run(id, USER, name);
}

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

function shadowRow(
  recordId: string,
  name: string,
  source: string,
  emails: readonly string[],
  phones: readonly string[],
) {
  return {
    id: `ext-${recordId}`,
    user_id: USER,
    name,
    phones: [...phones],
    emails: [...emails],
    company: null,
    source,
    external_record_id: recordId,
    external_uuid: null,
    last_message_at: null,
    synced_at: "2026-08-09T00:00:00.000Z",
  };
}

/**
 * File the question the linker files when it cannot tell. The REAL writer, so
 * the queue this suite reads is the queue the review screen reads.
 */
function fileQuestion(sourceType: string, sourceRecordId: string): string {
  proposeLink({
    userId: USER,
    contactId: CONTACT,
    sourceType: sourceType as any,
    sourceRecordId,
    reason: "ambiguous_identifier",
    identityAssessment: "possibly_same_person",
    relationshipAssessment: "possibly_connected",
    clusterKey: "cluster-rosalind",
    evidence: {
      summary: "This record shares an identifier with Rosalind Vance.",
      details: ["We could not tell whether these are the same person."],
      contactLabel: "Rosalind Vance",
      sourceLabel: sourceType,
      sourceName: "Rosalind Vance",
    },
  });
  const filed = listPendingProposals(USER).find(
    (p) => p.source_record_id === sourceRecordId && p.source_type === sourceType,
  );
  if (!filed) throw new Error(`proposal for ${sourceRecordId} was not filed`);
  return filed.id;
}

/** The SOURCE RECORD IDs the picker offered, sorted. Identity, never a count. */
async function offeredRecordIds(): Promise<string[]> {
  const handler = registeredHandlers.get("contacts:get-available");
  const result = await handler(mockEvent, USER);
  expect(result.success).toBe(true);
  return (result.contacts as Array<{ externalRecordId?: string }>)
    .map((c) => c.externalRecordId as string)
    .sort();
}

/** Every (source_type, source_record_id) still waiting on a human. */
function queuedRecordKeys(): string[] {
  return listPendingProposals(USER)
    .map((p) => sourceKey(p.source_type, p.source_record_id))
    .sort();
}

beforeEach(() => {
  mockDb = openTestDb();
  mockDb.exec(CONTACT_IDENTITY_SCHEMA);
  mockImportedContacts = [importedContact(CONTACT, "Rosalind Vance", ROSALIND_PHONE_E164, ROSALIND_EMAIL)];
  mockShadowRows = CANDIDATES.map((c) => shadowRow(c.rec, c.name, c.src, c.emails, c.phones));
  registeredHandlers.clear();
  registerContactHandlers({} as any);
  seedContactRow(CONTACT, "Rosalind Vance");
});

afterEach(() => {
  mockDb?.close();
  mockDb = null;
});

// ===========================================================================
describe("CONTROL 1 — every candidate stays visible while the question is open", () => {
  /**
   * THE FOUNDER'S EXACT CASE. One imported contact, four candidate records,
   * four questions filed, and all four records must still be listed.
   *
   * OBSERVED RED, 2026-08-09: restoring `emailClaimedByImported` /
   * `phoneClaimedByImported` and their two call sites in the external loop
   * gives `Expected [4 ids] / Received []` — all four candidates disappear,
   * which is the bug exactly as he described it.
   */
  it("all four candidate records are offered AND queued", async () => {
    for (const c of CANDIDATES) fileQuestion(c.src, c.rec);

    expect(await offeredRecordIds()).toEqual(
      ["mac-rosalind-1", "mac-rosalind-2", "out-rosalind-1", "out-rosalind-2"],
    );
    expect(queuedRecordKeys()).toEqual(
      [
        sourceKey("macos", "mac-rosalind-1"),
        sourceKey("macos", "mac-rosalind-2"),
        sourceKey("outlook", "out-rosalind-1"),
        sourceKey("outlook", "out-rosalind-2"),
      ].sort(),
    );
  });
});

// ===========================================================================
describe("CONTROL 2 — answering 'same person' removes the record", () => {
  /**
   * The record leaves the list because it now BELONGS to the contact, and the
   * belonging is a crosswalk row `confirmProposal` writes. This is the other
   * direction, and the one a careless deletion breaks: proving the fix hides
   * nothing is only half of it.
   *
   * OBSERVED RED, 2026-08-09: dropping the `linkedSourceKeys` check from the
   * external loop gives `Expected 3 ids / Received 4` — the confirmed record
   * stays listed.
   */
  it("the confirmed record leaves the list; the other three stay", async () => {
    const ids = CANDIDATES.map((c) => fileQuestion(c.src, c.rec));

    const outcome = confirmProposal(USER, ids[0]);
    expect(outcome.ok).toBe(true);

    expect(await offeredRecordIds()).toEqual(
      ["mac-rosalind-2", "out-rosalind-1", "out-rosalind-2"],
    );
  });
});

// ===========================================================================
describe("CONTROL 3 — 'not this person' keeps the record, permanently [PRIMARY]", () => {
  /**
   * THE CONTROL THE FOUNDER ASKED FOR BY NAME.
   *
   *   "if I clicked not this person this contact shouldn't disappear."
   *
   * This is what the NARROW fix ("do not suppress a record with a pending
   * proposal") gets wrong: a rejection RESOLVES the proposal, so after the
   * answer there is nothing pending, and a rule keyed on pending questions
   * would let the record vanish on the shared email it still carries.
   *
   * OBSERVED RED, 2026-08-09: restoring `emailClaimedByImported` and its
   * external-loop call site gives `Expected ["mac-rosalind-1", ...] / Received`
   * a set with `mac-rosalind-1` missing — the record he had just declared a
   * different person disappears, which is the founder's case verbatim.
   */
  it("the rejected record REMAINS visible after the question is closed", async () => {
    const ids = CANDIDATES.map((c) => fileQuestion(c.src, c.rec));

    const outcome = rejectProposal(USER, ids[0]);
    expect(outcome.ok).toBe(true);

    // The question is gone from the queue...
    expect(queuedRecordKeys()).not.toContain(sourceKey("macos", "mac-rosalind-1"));
    // ...and the record is still there. Both halves, because a fix that only
    // resolved the queue would pass the first assertion alone.
    expect(await offeredRecordIds()).toContain("mac-rosalind-1");
    expect(await offeredRecordIds()).toEqual(
      ["mac-rosalind-1", "mac-rosalind-2", "out-rosalind-1", "out-rosalind-2"],
    );
  });

  /**
   * PERMANENTLY, and never re-proposed. `proposeLink` is run again exactly as a
   * later sync would, and the `UNIQUE (user_id, contact_id, source_type,
   * source_record_id)` written with INSERT OR IGNORE is what keeps the answered
   * row answered.
   *
   * PIN, NOT A CONTROL — measured, and stated because an unstated control is an
   * unrun control. Reverting this PR leaves this case GREEN: the old code
   * exempted a rejected record from the content checks via
   * `getRejectedSourceKeys`, so it stayed visible by a different mechanism. The
   * "never re-proposed" half is BACKLOG-2410's UNIQUE lock and is not this PR's
   * to break either. Its sibling above is the discriminating case — it asserts
   * the whole set, and the other three records vanish on the revert.
   *
   * It is kept because the mechanism changed underneath it: the record now
   * stays visible because nothing hides it, rather than because something
   * exempts it. If a later change reintroduces a content rule, this goes red
   * alongside the rest.
   */
  it("stays visible across a later sync, and the question is not asked again", async () => {
    const ids = CANDIDATES.map((c) => fileQuestion(c.src, c.rec));
    rejectProposal(USER, ids[0]);

    // A later linking pass proposes the same pair again.
    fileQuestionExpectingNoOp("macos", "mac-rosalind-1");

    expect(queuedRecordKeys()).not.toContain(sourceKey("macos", "mac-rosalind-1"));
    expect(await offeredRecordIds()).toContain("mac-rosalind-1");
    // The verdict is kept, appended and never rewritten.
    expect(
      listVerdicts(USER)
        .filter((v) => v.source_record_id === "mac-rosalind-1")
        .map((v) => v.identity_verdict),
    ).toEqual(["different_people"]);
  });
});

/** The same call as `fileQuestion`, for the case where it must NOT create one. */
function fileQuestionExpectingNoOp(sourceType: string, sourceRecordId: string): void {
  const result = proposeLink({
    userId: USER,
    contactId: CONTACT,
    sourceType: sourceType as any,
    sourceRecordId,
    reason: "ambiguous_identifier",
    identityAssessment: "possibly_same_person",
    relationshipAssessment: "possibly_connected",
    clusterKey: "cluster-rosalind",
    evidence: {
      summary: "This record shares an identifier with Rosalind Vance.",
      details: ["We could not tell whether these are the same person."],
      contactLabel: "Rosalind Vance",
      sourceLabel: sourceType,
      sourceName: "Rosalind Vance",
    },
  });
  expect(result.created).toBe(false);
}

// ===========================================================================
describe("CONTROL 4 — a resemblance that was never asked about is not a claim", () => {
  /**
   * THE CASE THE NARROW FIX WOULD HAVE MISSED, and the reason judgement call 1
   * was decided as a deletion rather than a gate.
   *
   * No proposal was ever filed for this record — not pending, not answered. It
   * simply shares the saved contact's email under the same name, which is what
   * `emailClaimedByImported` decided was proof. A rule that only spared records
   * with an open question would still hide this one.
   *
   * It is also the tier rule stated as a test (BACKLOG-2556, "do nothing to
   * Dana"): on the basic tier the app does no consolidation at all, and this is
   * consolidation.
   */
  it("a record matching on email with NO crosswalk row and NO question stays visible", async () => {
    expect(listPendingProposals(USER)).toEqual([]);
    expect(await offeredRecordIds()).toEqual(
      ["mac-rosalind-1", "mac-rosalind-2", "out-rosalind-1", "out-rosalind-2"],
    );
  });

  /**
   * And the same on a phone. Split from the email case deliberately: they were
   * two separate predicates with two separate call sites, and a deletion that
   * removed one and left the other would pass a combined assertion for three of
   * the four records.
   */
  it("...and on a phone number", async () => {
    mockShadowRows = [shadowRow("mac-phone-only", "Rosalind Vance", "macos", [], [ROSALIND_PHONE_RAW])];
    expect(await offeredRecordIds()).toEqual(["mac-phone-only"]);
  });
});

// ===========================================================================
describe("CONTROL 5 — THE INVARIANT: the queue and the list cannot disagree", () => {
  /**
   * No record may be in the review queue and absent from the list at the same
   * time. Stated as a property over whatever the fixture happens to contain,
   * rather than as a list of ids, so it keeps holding when the corpus changes.
   *
   * WHY IT CANNOT BREAK ANY MORE, and why that is worth asserting rather than
   * arguing: both surfaces now read `contact_source_links`. The queue proposes
   * a pair precisely because no link exists for it, and the picker suppresses a
   * pair precisely because one does. The two answers come from one table, so a
   * pending question about a hidden record is not a bug that was fixed — it is
   * a state the code can no longer represent. A future change that gives the
   * picker a second suppression rule reintroduces it, and this goes red.
   */
  async function assertInvariant(): Promise<void> {
    const offered = new Set(
      (await offeredRecordIds()).map((id) => id),
    );
    const offeredKeys = new Set(
      mockShadowRows
        .filter((r) => offered.has(r.external_record_id))
        .map((r) => sourceKey(r.source, r.external_record_id)),
    );
    for (const queued of queuedRecordKeys()) {
      expect([queued, [...offeredKeys]]).toEqual([queued, expect.arrayContaining([queued])]);
    }
  }

  it("holds with every question open", async () => {
    for (const c of CANDIDATES) fileQuestion(c.src, c.rec);
    await assertInvariant();
  });

  it("holds after one is confirmed and one is rejected", async () => {
    const ids = CANDIDATES.map((c) => fileQuestion(c.src, c.rec));
    confirmProposal(USER, ids[0]);
    rejectProposal(USER, ids[1]);

    await assertInvariant();

    // And the answered pairs really did leave the queue, so the invariant above
    // is not holding vacuously over an empty set.
    expect(queuedRecordKeys()).toEqual(
      [sourceKey("outlook", "out-rosalind-1"), sourceKey("outlook", "out-rosalind-2")].sort(),
    );
  });
});

// ===========================================================================
describe("CONTROL 6 — removal still cannot undo itself (BACKLOG-2365)", () => {
  /**
   * The picker used to add `getRemovedContactIdentifiers` back into its
   * already-imported sets, because `getImportedContactsByUserIdAsync` hides
   * tombstoned contacts and without that read the picker would offer a removed
   * person as though she were new — re-importing her resurrecting the contact
   * the user deleted.
   *
   * Both content sets are deleted, so that read is deleted with them. The
   * protection survives through the crosswalk instead: `getLinkedSourceKeys`
   * does not filter removed contacts, so a tombstoned contact KEEPS its claims
   * and its source records stay suppressed.
   *
   * ASSERTED RATHER THAN ASSUMED, because it is the one place where deleting
   * the removed-identifier read could plausibly have broken something, and
   * "the crosswalk covers it" is exactly the kind of claim that is true right
   * up until someone adds an `ACTIVE_CONTACTS_CLAUSE` to `getLinkedSourceKeys`.
   *
   * OBSERVED RED, 2026-08-09: adding `AND c.removed_at IS NULL` to
   * `getLinkedSourceKeys` gives `Expected [] / Received ["mac-removed"]` — the
   * removed contact's record is offered again.
   */
  it("a REMOVED contact's linked record is still suppressed", async () => {
    mockDb!
      .prepare(
        "INSERT INTO contacts (id, user_id, display_name, is_imported, removed_at) VALUES (?, ?, ?, 1, ?)",
      )
      .run("c-dana", USER, "Dana Example", "2026-08-09T10:00:00.000Z");
    createLink({
      userId: USER,
      contactId: "c-dana",
      sourceType: "macos",
      sourceRecordId: "mac-removed",
      matchMethod: "source_id",
    });

    // She is gone from the saved list, as a tombstone requires.
    mockImportedContacts = [];
    mockShadowRows = [shadowRow("mac-removed", "Dana Example", "macos", ["dana@example.com"], [])];

    expect(await offeredRecordIds()).toEqual([]);
  });
});
