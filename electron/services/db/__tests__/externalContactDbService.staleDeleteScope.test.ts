/**
 * @jest-environment node
 *
 * BACKLOG-2385 — a macOS contact sync deleted the user's Outlook, Google,
 * iPhone and Android contacts.
 *
 * `fullSync()` step 2 called an unscoped `deleteStaleContacts()`:
 *
 *     DELETE FROM external_contacts WHERE user_id = ? AND synced_at < ?
 *
 * with no `source` predicate. Every row from every OTHER source that had not
 * been re-synced in that same instant was destroyed. Observed live in a user's
 * log, repeating across days:
 *
 *     22:36:49.316  Upserted 716 external contacts from macOS
 *     22:36:49.321  Deleted 682 stale external contacts     <- her whole Outlook book
 *     22:36:54.052  Upserted 682 external contacts from outlook
 *
 * It fired on ordinary use — `contactHandlers.ts:586` (initial population),
 * `:622` (automatic >24h background re-sync, no user action) and `:1673`
 * (manual sync).
 *
 * These tests run the REAL `fullSync` against a REAL in-memory better-sqlite3
 * database: `./core/dbConnection` is mocked with thin delegates over a live
 * connection, so the service's actual SQL executes. `better-sqlite3-multiple-
 * ciphers` is remapped to a stub by jest.config.js `moduleNameMapper`, so the
 * driver is required by absolute path — the same escape hatch used by
 * `externalContactDbService.recency.test.ts` and `phoneNormalizedJoin.test.ts`.
 *
 * ASSERTION STYLE: exact ID SETS, never counts. A count assertion passes when
 * the WRONG rows survive (delete 3 outlook + keep 3 macos still "totals" right),
 * which is precisely the failure mode being guarded. Every row is seeded with a
 * fixed, readable id so the surviving set is compared by identity.
 */

import path from "path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  path.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers")
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

// Live connection shared with the dbConnection mock below.
// Must be named `mock*` to satisfy babel-plugin-jest-hoist's out-of-scope rule.
let mockDb: DatabaseType | null = null;

const mockLogInfo = jest.fn();

jest.mock("../core/dbConnection", () => ({
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

// The service imports the worker pool at module load; not exercised by fullSync.
jest.mock("../../../workers/contactWorkerPool", () => ({
  queryContacts: jest.fn(),
  isPoolReady: jest.fn().mockReturnValue(false),
}));

jest.mock("../../logService", () => ({
  __esModule: true,
  default: {
    info: (...args: unknown[]) => mockLogInfo(...args),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import { fullSync, type MacOSContact } from "../externalContactDbService";
import {
  CONTACT_SOURCE_LINKS_TABLE_SQL,
  CONTACT_SOURCE_LINKS_INDEX_SQL,
  CONTACT_LINK_PROPOSALS_TABLE_SQL,
  CONTACT_LINK_PROPOSALS_INDEX_SQL,
} from "../contactIdentitySchemaSql";

const USER_ID = "user-2385";
const OTHER_USER = "user-other";

/** Long before any sync in these tests, so every seeded row is "stale". */
const STALE = "2020-01-01T00:00:00.000Z";

interface SeedRow {
  id: string;
  source: string;
  recordId: string;
  name: string;
  userId?: string;
}

/**
 * Production DDL for external_contacts (electron/database/schema.sql), including
 * the UNIQUE(user_id, source, external_record_id) constraint that
 * upsertFromMacOS's ON CONFLICT clause targets, plus the tables the step-3
 * recency recompute reads.
 */
function createSchema(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE users_local (id TEXT PRIMARY KEY);

    CREATE TABLE external_contacts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT,
      phones_json TEXT,
      phones_normalized_json TEXT,
      emails_json TEXT,
      company TEXT,
      last_message_at DATETIME,
      external_record_id TEXT,
      source TEXT DEFAULT 'macos',
      synced_at DATETIME,
      sync_session_id TEXT,
      -- BACKLOG-2401: ZEXTERNALUUID capture. Added by migration v57; declared
      -- here because these fixtures hand-roll the table rather than run the
      -- chain, and the macOS upsert now writes this column.
      external_uuid TEXT,
      UNIQUE(user_id, source, external_record_id)
    );

    /**
     * contacts -- FK-RESOLUTION STUB, NOT A FIXTURE (BACKLOG-2614).
     *
     * The production DDL below carries real foreign keys:
     * contact_source_links.contact_id, and contact_link_proposals'
     * contact_id and target_contact_id, all REFERENCE contacts(id).
     *
     * This driver enables foreign_keys BY DEFAULT -- SQLite's own default is
     * OFF, which is the opposite, and is why this table looked unnecessary.
     * SQLite resolves a foreign key's parent TABLE on every DML statement even
     * when no row is touched, so without this the suite dies on the crosswalk
     * DELETE with "no such table: main.contacts". Measured, not assumed: the
     * DDL swap alone reds 6 of the 17 tests across this file and
     * staleDeleteScope, and adding this one line restores all 17.
     *
     * ZERO ROWS, and no test reads a contacts column -- it exists only so the
     * constraint can resolve. "id TEXT PRIMARY KEY" is LOAD-BEARING: a parent
     * key that is neither PRIMARY KEY nor UNIQUE raises "foreign key mismatch".
     * user_id is inert here, kept for shape parity with the 2480 suite.
     *
     * Deliberately a stub rather than production's contacts: there is no
     * exported constant for that table, so "use the real shape" would mean
     * hand-writing a copy of a production table inside the very change that
     * deletes hand-written copies. The table_info and row-count pins at the end
     * of this file are what keep the stub from becoming a fixture.
     */
    CREATE TABLE contacts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL);

    /**
     * BACKLOG-2480 — every deletion path now removes the crosswalk rows that
     * pointed at the records it deleted, so the tables must exist here. A
     * fixture that omits a table the production path writes is a fixture that
     * describes a state the code cannot be in.
     *
     * BACKLOG-2614 — and they are now the PRODUCTION DDL rather than a
     * hand-written echo of it. These were five-column copies with no UNIQUE, no
     * CHECK vocabulary and no foreign keys, so a constraint could change in the
     * migration while this suite stayed green. contactIdentitySchemaSql.ts is
     * the ONE definition -- its header forbids transcribing these statements --
     * and the pins at the end of this file hold that by execution rather than
     * by import discipline.
     */
    ${CONTACT_SOURCE_LINKS_TABLE_SQL}
    ${CONTACT_SOURCE_LINKS_INDEX_SQL}
    ${CONTACT_LINK_PROPOSALS_TABLE_SQL}
    ${CONTACT_LINK_PROPOSALS_INDEX_SQL}
    CREATE TABLE phone_last_message (
      phone_normalized TEXT NOT NULL,
      user_id TEXT NOT NULL,
      last_message_at DATETIME NOT NULL,
      PRIMARY KEY (phone_normalized, user_id)
    );

    CREATE TABLE emails (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      sent_at DATETIME,
      received_at DATETIME
    );

    CREATE TABLE email_participants (
      email_id TEXT NOT NULL,
      role TEXT NOT NULL,
      position INTEGER NOT NULL,
      email_address TEXT NOT NULL,
      PRIMARY KEY (email_id, role, position)
    );
    CREATE INDEX idx_email_participants_email_address ON email_participants(email_address);
  `);
}

function seed(rows: SeedRow[]): void {
  const stmt = mockDb!.prepare(`
    INSERT INTO external_contacts
      (id, user_id, name, phones_json, phones_normalized_json, emails_json,
       company, external_record_id, source, synced_at)
    VALUES (?, ?, ?, '[]', '[]', '[]', NULL, ?, ?, ?)
  `);
  for (const r of rows) {
    stmt.run(r.id, r.userId ?? USER_ID, r.name, r.recordId, r.source, STALE);
  }
}

/** Exact surviving ids for a source, sorted — identity, not count. */
function idsOfSource(source: string, userId: string = USER_ID): string[] {
  return (
    mockDb!
      .prepare(
        "SELECT id FROM external_contacts WHERE user_id = ? AND source = ? ORDER BY id"
      )
      .all(userId, source) as Array<{ id: string }>
  ).map((r) => r.id);
}

/** Exact surviving `id|source` pairs for every non-macOS row, sorted. */
function survivingNonMacOs(): string[] {
  return (
    mockDb!
      .prepare(
        `SELECT id, source FROM external_contacts
         WHERE user_id = ? AND source <> 'macos' ORDER BY id`
      )
      .all(USER_ID) as Array<{ id: string; source: string }>
  ).map((r) => `${r.id}|${r.source}`);
}

/**
 * The user's real situation: a Mac address book PLUS Outlook, Google, an iPhone
 * and an Android companion, all previously synced (so all "stale" relative to
 * the macOS sync about to run).
 */
const OUTLOOK_IDS = ["ext-outlook-1", "ext-outlook-2", "ext-outlook-3"];
const GOOGLE_IDS = ["ext-google-1", "ext-google-2"];
const IPHONE_IDS = ["ext-iphone-1"];
const ANDROID_IDS = ["ext-android-1"];

function seedAllSources(): void {
  seed([
    // macOS: mac-1 will be re-synced, mac-2 is genuinely gone from the Mac
    { id: "ext-macos-1", source: "macos", recordId: "mac-rec-1", name: "Kept Mac Contact" },
    { id: "ext-macos-2", source: "macos", recordId: "mac-rec-2", name: "Deleted Mac Contact" },
    ...OUTLOOK_IDS.map((id, i) => ({
      id,
      source: "outlook",
      recordId: `out-rec-${i + 1}`,
      name: `Outlook Contact ${i + 1}`,
    })),
    ...GOOGLE_IDS.map((id, i) => ({
      id,
      source: "google_contacts",
      recordId: `goog-rec-${i + 1}`,
      name: `Google Contact ${i + 1}`,
    })),
    { id: IPHONE_IDS[0], source: "iphone", recordId: "iphone-rec-1", name: "iPhone Contact" },
    { id: ANDROID_IDS[0], source: "android_sync", recordId: "android-rec-1", name: "Android Contact" },
  ]);
}

/** The macOS read that fullSync receives: mac-rec-1 survives, mac-rec-2 is gone. */
const MACOS_SYNC_PAYLOAD: MacOSContact[] = [
  { name: "Kept Mac Contact", recordId: "mac-rec-1", phones: ["+15555550112"], emails: [] },
  { name: "Brand New Mac Contact", recordId: "mac-rec-3", phones: [], emails: [] },
];

describe("BACKLOG-2385: macOS fullSync stale deletion is scoped to source='macos'", () => {
  beforeEach(() => {
    mockDb = new Database(":memory:") as DatabaseType;
    createSchema(mockDb);
    mockDb.prepare("INSERT INTO users_local (id) VALUES (?)").run(USER_ID);
    mockDb.prepare("INSERT INTO users_local (id) VALUES (?)").run(OTHER_USER);
    mockLogInfo.mockClear();
  });

  afterEach(() => {
    mockDb?.close();
    mockDb = null;
  });

  /**
   * BACKLOG-2614 — THE GUARD IS BY EXECUTION, NOT BY IMPORT DISCIPLINE.
   *
   * Importing the production DDL fixes the drift once; these pins are what stop
   * it coming back. Paste a hand-written five-column `contact_link_proposals`
   * over the import and the UNIQUE count here goes 2 -> 0 — which is exactly
   * the failure this item exists to close. The header on
   * `contactIdentitySchemaSql.ts` records the incident it comes from: dropping
   * the proposals UNIQUE from the REAL migration left a 27-test suite fully
   * green, because no suite was running the real DDL.
   *
   * `origin = 'u'` selects the auto-indexes SQLite creates for TABLE-LEVEL
   * UNIQUE constraints, so this counts constraints and ignores the plain
   * `CREATE INDEX` that ships beside each table.
   */
  describe("the identity tables are the production DDL (BACKLOG-2614)", () => {
    const uniqueConstraintCount = (table: string): number =>
      (
        mockDb!.prepare(`PRAGMA index_list('${table}')`).all() as Array<{ origin: string }>
      ).filter((r) => r.origin === "u").length;

    const columnNames = (table: string): string[] =>
      (mockDb!.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>).map(
        (c) => c.name,
      );

    it("contact_link_proposals carries BOTH table-level UNIQUEs", () => {
      // (user_id, contact_id, source_type, source_record_id) and (user_id, pair_key).
      expect(uniqueConstraintCount("contact_link_proposals")).toBe(2);
    });

    it("contact_source_links carries its table-level UNIQUE", () => {
      // (user_id, source_type, source_record_id).
      expect(uniqueConstraintCount("contact_source_links")).toBe(1);
    });

    it("contacts is a bare FK-resolution stub, not a fixture", () => {
      expect(columnNames("contacts")).toEqual(["id", "user_id"]);
    });

    it("...and the stub holds no rows", () => {
      // SCOPE LIMIT: this runs after `beforeEach`, so it pins the FIXTURE
      // contract. It cannot see an `INSERT INTO contacts` inside some future
      // `it()`. A task that needs contacts rows here must revisit BACKLOG-2614.
      expect(
        (mockDb!.prepare("SELECT COUNT(*) AS n FROM contacts").get() as { n: number }).n,
      ).toBe(0);
    });
  });

  it("leaves the EXACT id set of every other source untouched", () => {
    seedAllSources();

    fullSync(USER_ID, MACOS_SYNC_PAYLOAD);

    // Identity, per source. Under the unscoped DELETE every one of these is [].
    expect(idsOfSource("outlook")).toEqual(OUTLOOK_IDS);
    expect(idsOfSource("google_contacts")).toEqual(GOOGLE_IDS);
    expect(idsOfSource("iphone")).toEqual(IPHONE_IDS);
    expect(idsOfSource("android_sync")).toEqual(ANDROID_IDS);

    // And as one whole-set comparison, so a row silently changing source is caught.
    expect(survivingNonMacOs()).toEqual([
      "ext-android-1|android_sync",
      "ext-google-1|google_contacts",
      "ext-google-2|google_contacts",
      "ext-iphone-1|iphone",
      "ext-outlook-1|outlook",
      "ext-outlook-2|outlook",
      "ext-outlook-3|outlook",
    ]);
  });

  it("still removes macOS rows genuinely absent from the sync, and keeps the ones present", () => {
    seedAllSources();

    fullSync(USER_ID, MACOS_SYNC_PAYLOAD);

    const macIds = idsOfSource("macos");

    // ext-macos-1 is re-synced by record id, so ON CONFLICT UPDATEs it in place
    // and its identity is preserved.
    expect(macIds).toContain("ext-macos-1");

    // ext-macos-2 is no longer in the macOS address book -> genuinely deleted.
    // (Guards against over-correcting the fix into deleting nothing at all.)
    expect(macIds).not.toContain("ext-macos-2");

    // The new mac-rec-3 row was inserted with a generated uuid.
    expect(macIds).toHaveLength(2);
    const newRow = mockDb!
      .prepare(
        "SELECT id, name FROM external_contacts WHERE user_id = ? AND source = 'macos' AND external_record_id = ?"
      )
      .get(USER_ID, "mac-rec-3") as { id: string; name: string } | undefined;
    expect(newRow?.name).toBe("Brand New Mac Contact");
    expect(macIds).toContain(newRow!.id);

    // The re-synced row got a fresh synced_at (it was NOT left stale).
    const kept = mockDb!
      .prepare("SELECT synced_at FROM external_contacts WHERE id = ?")
      .get("ext-macos-1") as { synced_at: string };
    expect(kept.synced_at > STALE).toBe(true);
  });

  it("reports a macOS-scoped `deleted` count in SyncResult", () => {
    seedAllSources();

    const result = fullSync(USER_ID, MACOS_SYNC_PAYLOAD);

    // Exactly one macOS row (ext-macos-2) went stale. The 7 rows belonging to
    // other sources must NOT be counted — under the unscoped delete this was 8.
    expect(result.deleted).toBe(1);

    // total = 2 macos + 7 other sources
    expect(result.total).toBe(9);
  });

  it("logs the source-scoped deletion line, not the unscoped one", () => {
    seedAllSources();

    fullSync(USER_ID, MACOS_SYNC_PAYLOAD);

    const messages = mockLogInfo.mock.calls.map((c) => String(c[0]));

    // The user's log showed the unscoped line `Deleted 682 stale external
    // contacts`. The scoped path names the source.
    expect(messages).toContain("Deleted 1 stale macos external contacts");
    expect(messages.some((m) => /^Deleted \d+ stale external contacts$/.test(m))).toBe(false);
  });

  it("deletes nothing when every macOS contact is still present", () => {
    seedAllSources();

    const result = fullSync(USER_ID, [
      { name: "Kept Mac Contact", recordId: "mac-rec-1", phones: [], emails: [] },
      { name: "Deleted Mac Contact", recordId: "mac-rec-2", phones: [], emails: [] },
    ]);

    expect(result.deleted).toBe(0);
    expect(idsOfSource("macos")).toEqual(["ext-macos-1", "ext-macos-2"]);
    expect(survivingNonMacOs()).toHaveLength(7);
  });

  it("does not touch another user's macOS rows", () => {
    seedAllSources();
    seed([
      { id: "ext-other-macos-1", source: "macos", recordId: "mac-rec-99", name: "Other User Mac", userId: OTHER_USER },
    ]);

    fullSync(USER_ID, MACOS_SYNC_PAYLOAD);

    expect(idsOfSource("macos", OTHER_USER)).toEqual(["ext-other-macos-1"]);
  });
});
