/**
 * @jest-environment node
 *
 * BACKLOG-2480 — DELETING A SOURCE RECORD REMOVES EVERYTHING THAT POINTED AT IT.
 *
 * ===========================================================================
 * THE DEFECT
 * ===========================================================================
 * Five paths delete from `external_contacts`. **Only ONE of them cleaned up the
 * crosswalk.** The other four left `contact_source_links` and
 * `contact_link_proposals` rows naming records that no longer existed.
 *
 * The one that mattered most is `deleteStaleContactsBySource`, which runs on
 * **every full Outlook, Google or Android sync** — and BACKLOG-2474 made the
 * linking pass run on every write path, so far more links get created while
 * those four paths removed none of them.
 *
 * ===========================================================================
 * WHAT AN ORPHAN COSTS THE USER
 * ===========================================================================
 * A review proposal about an address-book record they can no longer see, so the
 * question cannot be answered. BACKLOG-2410's own reasoning: **a queue of
 * unanswerable questions is worse than an empty one.** Plus a crosswalk row and
 * a provenance line both naming a record that is gone.
 *
 * ===========================================================================
 * WHY THIS SUITE IS SHAPED THIS WAY
 * ===========================================================================
 * Every path is driven, not one representative — **the defect WAS that four
 * siblings behaved differently from the fifth**, so a suite that sampled one
 * would reproduce the original mistake.
 *
 * Assertions are EXACT IDENTITY SETS. A count cannot tell "the orphan is gone"
 * from "the orphan is gone and so is a row that should have survived", and this
 * change deletes rows for a living.
 *
 * Each case also asserts the **survivor** — a link belonging to a record that
 * was NOT deleted must still be there. A cleanup that deletes everything passes
 * any test that only checks the orphan is gone.
 *
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --bail=0 \
 *     electron/services/db/__tests__/externalContactDbService.deletionCleanup-2480.test.ts
 */

import { openTestDb, type TestDb } from "../../__tests__/helpers/syncSqliteDriver";

let mockDb: TestDb | null = null;

jest.mock("../core/dbConnection", () => ({
  ensureDb: () => mockDb,
  dbAll: (sql: string, params: unknown[] = []) =>
    mockDb!.prepare(sql).all(...(params as never[])),
  dbGet: (sql: string, params: unknown[] = []) =>
    mockDb!.prepare(sql).get(...(params as never[])),
  dbRun: (sql: string, params: unknown[] = []) => {
    const r = mockDb!.prepare(sql).run(...(params as never[]));
    return { lastInsertRowid: r.lastInsertRowid, changes: r.changes };
  },
  // Real transaction, not a passthrough — see BACKLOG-2537.
  dbTransaction: <T>(fn: () => T): T => mockDb!.transaction(fn)(),
  getDbPath: () => "/fake/path/mad.db",
  getEncryptionKey: () => "fake-key",
}));

jest.mock("../../logService", () => {
  const m = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { __esModule: true, default: m, logService: m };
});
jest.mock("../../contactIngestionFunnel", () => ({ recordShadowSync: jest.fn() }));
jest.mock("../../contactLinkingScheduler", () => ({ requestContactLinking: jest.fn() }));
jest.mock("../../../workers/contactWorkerPool", () => ({
  queryContacts: jest.fn(),
  isPoolReady: () => false,
}));

import {
  deleteStaleContactsBySource,
  deleteByMacOSRecordId,
  deleteBySource,
  clearAllForUser,
  deleteBySessionId,
} from "../externalContactDbService";

const USER = "user-2480";
const OTHER_USER = "user-2480-other";

const SCHEMA = `
  CREATE TABLE external_contacts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT,
    phones_json TEXT,
    phones_normalized_json TEXT,
    emails_json TEXT,
    company TEXT,
    last_message_at TEXT,
    external_record_id TEXT,
    source TEXT NOT NULL,
    synced_at TEXT,
    sync_session_id TEXT,
    external_uuid TEXT,
    source_identity_json TEXT
  );
  CREATE TABLE contact_source_links (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    contact_id TEXT,
    source_type TEXT NOT NULL,
    source_record_id TEXT NOT NULL,
    match_method TEXT
  );
  CREATE TABLE contact_link_proposals (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    contact_id TEXT,
    source_type TEXT NOT NULL,
    source_record_id TEXT NOT NULL
  );
  CREATE TABLE phone_last_message (phone TEXT, last_message_at TEXT);
`;

function seedRecord(
  id: string,
  source: string,
  recordId: string,
  opts: { syncedAt?: string; sessionId?: string; userId?: string } = {},
): void {
  mockDb!
    .prepare(
      `INSERT INTO external_contacts (id, user_id, name, source, external_record_id, synced_at, sync_session_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      opts.userId ?? USER,
      `Record ${id}`,
      source,
      recordId,
      opts.syncedAt ?? "2026-08-06T00:00:00Z",
      opts.sessionId ?? null,
    );
  mockDb!
    .prepare(
      `INSERT INTO contact_source_links (id, user_id, contact_id, source_type, source_record_id, match_method)
       VALUES (?, ?, ?, ?, ?, 'source_id')`,
    )
    .run(`link-${id}`, opts.userId ?? USER, `contact-${id}`, source, recordId);
  mockDb!
    .prepare(
      `INSERT INTO contact_link_proposals (id, user_id, contact_id, source_type, source_record_id)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(`prop-${id}`, opts.userId ?? USER, `contact-${id}`, source, recordId);
}

const linkIds = (): string[] =>
  (mockDb!.prepare("SELECT id FROM contact_source_links ORDER BY id").all() as Array<{
    id: string;
  }>).map((r) => r.id);

const proposalIds = (): string[] =>
  (mockDb!.prepare("SELECT id FROM contact_link_proposals ORDER BY id").all() as Array<{
    id: string;
  }>).map((r) => r.id);

const recordIds = (): string[] =>
  (mockDb!.prepare("SELECT id FROM external_contacts ORDER BY id").all() as Array<{
    id: string;
  }>).map((r) => r.id);

beforeEach(() => {
  mockDb = openTestDb();
  mockDb.exec(SCHEMA);
});

afterEach(() => {
  mockDb?.close();
  mockDb = null;
});

describe("every deletion path removes the crosswalk rows it orphans (BACKLOG-2480)", () => {
  it("PRECONDITION: seeding really does create a link and a proposal per record", () => {
    seedRecord("a", "outlook", "rec-a");
    expect(recordIds()).toEqual(["a"]);
    expect(linkIds()).toEqual(["link-a"]);
    expect(proposalIds()).toEqual(["prop-a"]);
  });

  /**
   * THE ONE THAT MATTERS MOST — it runs on every full Outlook, Google and
   * Android sync.
   *
   * NEGATIVE CONTROL (executed): point `deleteStaleContactsBySource` back at a
   * bare `DELETE FROM external_contacts` and this goes red with
   *   Expected: ["link-fresh"]   Received: ["link-fresh", "link-stale"]
   */
  it("deleteStaleContactsBySource — the stale record's link and proposal go, the fresh one's stay", () => {
    seedRecord("stale", "outlook", "rec-stale", { syncedAt: "2026-08-01T00:00:00Z" });
    seedRecord("fresh", "outlook", "rec-fresh", { syncedAt: "2026-08-06T00:00:00Z" });

    const deleted = deleteStaleContactsBySource(USER, "outlook", "2026-08-05T00:00:00Z");

    expect(deleted).toBe(1);
    expect(recordIds()).toEqual(["fresh"]);
    expect(linkIds()).toEqual(["link-fresh"]);
    expect(proposalIds()).toEqual(["prop-fresh"]);
  });

  it("deleteByMacOSRecordId — only that record's rows go", () => {
    seedRecord("gone", "macos", "rec-gone");
    seedRecord("kept", "macos", "rec-kept");

    deleteByMacOSRecordId(USER, "rec-gone");

    expect(recordIds()).toEqual(["kept"]);
    expect(linkIds()).toEqual(["link-kept"]);
    expect(proposalIds()).toEqual(["prop-kept"]);
  });

  it("deleteBySource — the whole source goes, other sources survive intact", () => {
    seedRecord("android", "android_sync", "rec-android");
    seedRecord("outlook", "outlook", "rec-outlook");

    const deleted = deleteBySource(USER, "android_sync");

    expect(deleted).toBe(1);
    expect(recordIds()).toEqual(["outlook"]);
    expect(linkIds()).toEqual(["link-outlook"]);
    expect(proposalIds()).toEqual(["prop-outlook"]);
  });

  it("clearAllForUser — this user's rows go, ANOTHER user's are untouched", () => {
    seedRecord("mine", "macos", "rec-mine");
    seedRecord("theirs", "macos", "rec-theirs", { userId: OTHER_USER });

    clearAllForUser(USER);

    expect(recordIds()).toEqual(["theirs"]);
    // The survivor assertion is the one that catches a cleanup which deletes
    // too much — the failure mode a "the orphan is gone" test cannot see.
    expect(linkIds()).toEqual(["link-theirs"]);
    expect(proposalIds()).toEqual(["prop-theirs"]);
  });

  it("deleteBySessionId — still cleans up, now through the shared helper", () => {
    seedRecord("insession", "iphone", "rec-insession", { sessionId: "sess-1" });
    seedRecord("outside", "iphone", "rec-outside", { sessionId: "sess-2" });

    const deleted = deleteBySessionId(USER, "sess-1");

    expect(deleted).toBe(1);
    expect(recordIds()).toEqual(["outside"]);
    expect(linkIds()).toEqual(["link-outside"]);
    expect(proposalIds()).toEqual(["prop-outside"]);
  });

  it("a record with no external_record_id deletes without taking anything else", () => {
    // `external_record_id IS NULL` rows cannot own a crosswalk row. The helper
    // filters them out of the identity read; this pins that it does not then
    // delete links belonging to somebody else.
    mockDb!
      .prepare(
        `INSERT INTO external_contacts (id, user_id, name, source, external_record_id, synced_at)
         VALUES ('nullrec', ?, 'No record id', 'outlook', NULL, '2026-08-01T00:00:00Z')`,
      )
      .run(USER);
    seedRecord("kept", "outlook", "rec-kept", { syncedAt: "2026-08-06T00:00:00Z" });

    deleteStaleContactsBySource(USER, "outlook", "2026-08-05T00:00:00Z");

    expect(recordIds()).toEqual(["kept"]);
    expect(linkIds()).toEqual(["link-kept"]);
    expect(proposalIds()).toEqual(["prop-kept"]);
  });
});
