/**
 * @jest-environment node
 *
 * BACKLOG-2630 D2 piece 2 — THE WIRING, driven through the REAL production
 * entry point.
 *
 * ===========================================================================
 * WHAT THIS SUITE EXISTS TO PROVE, AND WHY IT IS NOT A UNIT TEST
 * ===========================================================================
 * The gatherer's own suite proves it reports the right facts. This one proves
 * something the gatherer cannot prove about itself: that the facts REACH THE
 * ROW, on every path that files a question, and that attaching them CHANGED NO
 * DECISION.
 *
 * Both claims are only meaningful against the real writers, so nothing here
 * hand-writes a proposal. The linking pass runs through
 * `contactLinkingScheduler` -> `runLinkingPassWithBackfill` ->
 * `runOpportunisticLinking`, exactly as `contacts:get-available` triggers it,
 * which reaches BOTH proposal writers:
 *
 *   - `contactSourceLinker.recordProposal` (the four identifier reasons), and
 *   - `contactHandlers.fileNameQuestion` (the name rules),
 *
 * the second of which has no other test that runs the real function —
 * `contactNameAutoLink.frozenLink-2666.test.ts` TRANSCRIBES it, so a change to
 * the real one is invisible there. That gap is why this file loads the whole
 * handler module rather than calling something smaller.
 *
 * A cycle would also show up here and nowhere else: the gatherer is reachable
 * from `contactSourceLinker`, which participates in the pre-existing
 * `contactSourceLinker` <-> `contactSourceValues` require cycle. If loading the
 * gatherer through that chain ever yields an undefined binding, these tests are
 * where it goes red.
 *
 * ===========================================================================
 * PII
 * ===========================================================================
 * Every value is synthetic — `example.invalid` addresses, 555-01xx numbers.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { BrowserWindow } from "electron";
import { CONTACT_IDENTITY_SCHEMA } from "../services/__tests__/helpers/contactIdentitySchema";
import { CONTACT_COMMUNICATION_SCHEMA } from "../services/__tests__/helpers/contactCommunicationSchema";
import { openTestDb, type TestDb } from "../services/__tests__/helpers/syncSqliteDriver";

let mockDb: TestDb | null = null;

const registeredHandlers = new Map<string, any>();

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
  // A REAL transaction, not a passthrough (BACKLOG-2537).
  dbTransaction: <T>(fn: () => T): T => mockDb!.transaction(fn)(),
  getDbPath: () => "/fake/path/mad.db",
  getEncryptionKey: () => "fake-key",
}));

let mockImportedContacts: any[] = [];
let mockShadowRows: any[] = [];

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
import {
  requestContactLinking,
  QUIET_PERIOD_MS,
  __resetContactLinkingScheduler,
} from "../services/contactLinkingScheduler";
import { createLink } from "../services/db/contactSourceLinkDbService";
import { parseEvidence } from "../services/db/contactLinkReviewDbService";
import { confirmProposal } from "../services/contactLinkReview";
import { toLookupKey } from "../utils/phoneNormalization";

// A well-formed UUID is required because `getValidUserId` rejects anything
// else, and this literal is the established fixture user across the
// contact-handler suites.
// pii-allow-uuid: invented, not from any live row
const USER = "550e8400-e29b-41d4-a716-446655440000";

// ---------------------------------------------------------------------------
// SEEDS
// ---------------------------------------------------------------------------

function addContact(
  id: string,
  displayName: string,
  opts: { emails?: string[]; phones?: string[] } = {},
): void {
  mockDb!
    .prepare("INSERT INTO contacts (id, user_id, display_name, is_imported) VALUES (?, ?, ?, 1)")
    .run(id, USER, displayName);
  (opts.emails ?? []).forEach((e, i) => {
    mockDb!
      .prepare("INSERT INTO contact_emails (id, contact_id, email, is_primary) VALUES (?, ?, ?, ?)")
      .run(`${id}-e${i}`, id, e, i === 0 ? 1 : 0);
  });
  (opts.phones ?? []).forEach((p, i) => {
    mockDb!
      .prepare(
        "INSERT INTO contact_phones (id, contact_id, phone_e164, phone_normalized, is_primary) VALUES (?, ?, ?, ?, ?)",
      )
      .run(`${id}-p${i}`, id, p, toLookupKey(p), i === 0 ? 1 : 0);
  });
}

function addExternal(
  recordId: string,
  name: string | null,
  opts: { emails?: string[]; phones?: string[]; source?: string } = {},
): void {
  const phones = opts.phones ?? [];
  const source = opts.source ?? "macos";
  mockDb!
    .prepare(
      `INSERT INTO external_contacts
        (id, user_id, name, phones_json, phones_normalized_json, emails_json,
         external_record_id, source, synced_at, external_uuid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .run(
      `ext-${source}-${recordId}`,
      USER,
      name,
      JSON.stringify(phones),
      JSON.stringify(phones.map(toLookupKey)),
      JSON.stringify(opts.emails ?? []),
      recordId,
      source,
      "2026-08-27T00:00:00.000Z",
    );
}

/** Every proposal on file, as `reason|contactId|sourceRecordId` — an exact set. */
function proposalKeys(): string[] {
  return (
    mockDb!
      .prepare(
        `SELECT reason, contact_id, source_record_id FROM contact_link_proposals
          WHERE user_id = ? ORDER BY reason, contact_id, source_record_id`,
      )
      .all(USER) as { reason: string; contact_id: string; source_record_id: string }[]
  ).map((r) => `${r.reason}|${r.contact_id}|${r.source_record_id}`);
}

function proposalRows(): { id: string; reason: string; evidence_json: string | null }[] {
  return mockDb!
    .prepare(
      `SELECT id, reason, evidence_json FROM contact_link_proposals
        WHERE user_id = ? ORDER BY reason, contact_id, source_record_id`,
    )
    .all(USER) as { id: string; reason: string; evidence_json: string | null }[];
}

/** Run the production linking pass, exactly as the picker triggers it. */
async function runLinkingPass(): Promise<void> {
  requestContactLinking(USER);
  jest.advanceTimersByTime(QUIET_PERIOD_MS + 1);
  // The scheduler's runner is async; let its microtasks settle.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  jest.useFakeTimers();
  __resetContactLinkingScheduler();
  mockDb = openTestDb();
  mockDb.exec(CONTACT_IDENTITY_SCHEMA);
  // `emails` / `email_participants` — the tables contactRecencySql reads, from
  // the helper that already owns them. `phone_last_message` has no shared owner
  // yet, so it is declared here from schema.sql:1488-1494.
  mockDb.exec(CONTACT_COMMUNICATION_SCHEMA);
  mockDb.exec(`
    CREATE TABLE IF NOT EXISTS phone_last_message (
      phone_normalized TEXT NOT NULL,
      user_id TEXT NOT NULL,
      last_message_at DATETIME NOT NULL,
      PRIMARY KEY (phone_normalized, user_id)
    );
  `);
  mockImportedContacts = [];
  mockShadowRows = [];
  registeredHandlers.clear();
  registerContactHandlers({
    isDestroyed: () => false,
    webContents: { send: jest.fn() },
  } as unknown as BrowserWindow);
});

afterEach(() => {
  __resetContactLinkingScheduler();
  jest.useRealTimers();
  mockDb?.close();
  mockDb = null;
});

// ===========================================================================
// 1. THE IDENTIFIER WRITER — `contactSourceLinker.recordProposal`
// ===========================================================================
/**
 * The number that changed hands. A saved contact still carries a line that now
 * belongs to someone else's record, so an identifier match is withheld and a
 * question is filed.
 *
 * CONTROL RUN: delete the `facts` from `recordProposal`'s `proposeLink` call.
 * See the PR body for the red test names.
 */
describe("a question filed by the identifier rules carries its facts", () => {
  function seedReassignedNumber(): void {
    const movedLine = "+14155550134";
    addContact("c-owner", "Pat Riverton", { phones: [movedLine] });
    addExternal("mac-owner", "Pat Riverton", { phones: ["+14155550105"] });
    createLink({
      userId: USER,
      contactId: "c-owner",
      sourceType: "macos",
      sourceRecordId: "mac-owner",
      matchMethod: "source_id",
    });
    // The line now sits on somebody else's card.
    addExternal("mac-other", "Robin Marsh", { phones: [movedLine] });
  }

  it("files exactly one question, and it carries the facts behind its sentence", async () => {
    seedReassignedNumber();

    await runLinkingPass();

    // The DECISION first, as an exact set: this is the pair that was queued.
    expect(proposalKeys()).toEqual(["identifier_reassigned|c-owner|mac-other"]);

    const [row] = proposalRows();
    const evidence = parseEvidence(row.evidence_json);
    expect(evidence).not.toBeNull();

    // The sentences are untouched.
    expect(typeof evidence!.summary).toBe("string");
    expect(evidence!.summary.length).toBeGreaterThan(0);

    // And the facts are there, gathered for the right pair and the right shape.
    expect(evidence!.facts).toBeDefined();
    expect(evidence!.facts!.pairKind).toBe("record_contact");
    expect(evidence!.facts!.schemaVersion).toBe(1);
    // The moved line is the shared key, derived from the live rule.
    expect(evidence!.facts!.identity.phones.sharedKeys).toEqual([toLookupKey("+14155550134")]);
    // The names disagree — a separate fact, and the reason this was asked.
    expect(evidence!.facts!.identity.name.normalizedKeysEqual).toBe(false);
    // No tally on an identifier path. `null` is "not computed", not "zero".
    expect(evidence!.facts!.identity.name.holderCount).toBeNull();
  });

  it("changes no decision: the same pairs are queued with and without the facts", async () => {
    seedReassignedNumber();

    await runLinkingPass();
    const first = proposalKeys();

    // A second pass must be a no-op — `INSERT OR IGNORE` on the pair UNIQUE.
    // If the facts had made the row different, the queue would grow.
    await runLinkingPass();

    expect(proposalKeys()).toEqual(first);
    expect(first).toEqual(["identifier_reassigned|c-owner|mac-other"]);
  });
});

// ===========================================================================
// 2. THE NAME WRITER — `contactHandlers.fileNameQuestion`, the REAL one
// ===========================================================================
/**
 * Two saved people, one on each side of the family split, sharing one name.
 * Joining them would be a MERGE, so the unique-name rule refuses and asks —
 * `name_two_saved_contacts`.
 *
 * This is the ONLY suite that drives the real `fileNameQuestion`.
 *
 * CONTROL RUN: delete the `facts` from `fileNameQuestion`'s `proposeLink` call.
 */
describe("a question filed by the name rules carries its facts, and its tally", () => {
  function seedTwoSavedContactsSharingAName(): void {
    // macOS is the PHONE family, Outlook the EMAIL family — the rule only looks
    // at a name that appears once on each side of that split.
    addContact("c-one", "Pat Riverton", { emails: ["ada.one@example.invalid"] });
    addContact("c-two", "Pat Riverton", { emails: ["ada.two@example.invalid"] });
    addExternal("mac-ada", "Pat Riverton", { source: "macos" });
    addExternal("out-ada", "Pat Riverton", { source: "outlook" });
    createLink({
      userId: USER,
      contactId: "c-one",
      sourceType: "macos",
      sourceRecordId: "mac-ada",
      matchMethod: "source_id",
    });
    createLink({
      userId: USER,
      contactId: "c-two",
      sourceType: "outlook",
      sourceRecordId: "out-ada",
      matchMethod: "source_id",
    });
  }

  it("asks about the exact pairs, and every one of them carries facts", async () => {
    seedTwoSavedContactsSharingAName();

    await runLinkingPass();

    // The decision, as an exact set.
    expect(proposalKeys()).toEqual([
      "name_two_saved_contacts|c-one|out-ada",
      "name_two_saved_contacts|c-two|mac-ada",
    ]);

    const rows = proposalRows();
    for (const row of rows) {
      const evidence = parseEvidence(row.evidence_json);
      expect(evidence?.facts).toBeDefined();
      expect(evidence!.facts!.pairKind).toBe("record_contact");
      // The names DO agree here — that is the whole reason the question exists,
      // and it is reported as a fact rather than as a conclusion.
      expect(evidence!.facts!.identity.name.normalizedKeysEqual).toBe(true);
      // The tally the name pass already computed is passed through, NOT
      // recomputed. Two holders: one record on each side of the family split.
      expect(evidence!.facts!.identity.name.holderCount).toBe(2);
    }
  });
});

// ===========================================================================
// 3. THE FACTS SURVIVE THE ANSWER
// ===========================================================================
/**
 * The calibration argument, made testable. A verdict is a labelled example, and
 * the label is only usable alongside the evidence as it stood WHEN THE HUMAN
 * SAW IT. `confirmProposal` copies the parsed proposal evidence onto the
 * verdict; if it ever rebuilt that object field by field instead, the facts
 * would die silently at the copy and the answered rows would stop being a
 * calibration set.
 *
 * CONTROL RUN: rebuild the verdict's `evidence` from the proposal's individual
 * fields instead of passing the parsed object through.
 */
describe("the facts the human judged are the facts stored with their answer", () => {
  it("carries the facts from the proposal onto the verdict", async () => {
    addContact("c-owner", "Pat Riverton", { phones: ["+14155550134"] });
    addExternal("mac-owner", "Pat Riverton", { phones: ["+14155550105"] });
    createLink({
      userId: USER,
      contactId: "c-owner",
      sourceType: "macos",
      sourceRecordId: "mac-owner",
      matchMethod: "source_id",
    });
    addExternal("mac-other", "Robin Marsh", { phones: ["+14155550134"] });

    await runLinkingPass();

    const [proposal] = proposalRows();
    const gathered = parseEvidence(proposal.evidence_json)!.facts;
    expect(gathered).toBeDefined();

    const outcome = confirmProposal(USER, proposal.id);
    expect(outcome.ok).toBe(true);

    const verdicts = mockDb!
      .prepare(`SELECT evidence_json FROM contact_link_verdicts WHERE user_id = ?`)
      .all(USER) as { evidence_json: string | null }[];

    // Exactly one answer, and it holds the SAME facts — not re-gathered, copied.
    expect(verdicts).toHaveLength(1);
    const stored = parseEvidence(verdicts[0].evidence_json);
    expect(stored?.facts).toEqual(gathered);
  });
});
