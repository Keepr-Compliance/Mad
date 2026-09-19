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
  clearRefetchableSourcesForUser,
  deleteBySessionId,
} from "../externalContactDbService";
import {
  CONTACT_SOURCE_LINKS_TABLE_SQL,
  CONTACT_SOURCE_LINKS_INDEX_SQL,
  CONTACT_LINK_PROPOSALS_TABLE_SQL,
  CONTACT_LINK_PROPOSALS_INDEX_SQL,
} from "../contactIdentitySchemaSql";

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
  /**
   * contacts -- FK-RESOLUTION PARENT (BACKLOG-2614).
   *
   * The production DDL below carries real foreign keys:
   * contact_source_links.contact_id, and contact_link_proposals'
   * contact_id and target_contact_id, all REFERENCE contacts(id).
   *
   * This driver enables foreign_keys BY DEFAULT -- SQLite's own default is OFF,
   * which is the opposite. SQLite resolves a foreign key's parent TABLE on every
   * DML statement even when no row is touched, so the table is required here
   * whether or not rows are seeded.
   *
   * UNLIKE the funnelCounts and staleDeleteScope suites, this one DOES seed
   * rows: contact_source_links.contact_id is TEXT NOT NULL in production, with
   * no NULL escape hatch, so every seeded contact-<id> must exist as a parent.
   * seedRecord inserts them.
   *
   * "id TEXT PRIMARY KEY" is LOAD-BEARING: a parent key that is neither PRIMARY
   * KEY nor UNIQUE raises "foreign key mismatch". No test reads a contacts
   * column -- the survival assertions below read only the id set, to prove the
   * ON DELETE CASCADE did NOT fire.
   */
  CREATE TABLE contacts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL);

  /**
   * BACKLOG-2614 -- the crosswalk tables are the PRODUCTION DDL, not a
   * hand-written echo. They were five-column copies with no UNIQUE, no CHECK
   * vocabulary and no foreign keys, so a constraint could change in the
   * migration while this suite stayed green. contactIdentitySchemaSql.ts is the
   * ONE definition and its header forbids transcribing these statements.
   */
  ${CONTACT_SOURCE_LINKS_TABLE_SQL}
  ${CONTACT_SOURCE_LINKS_INDEX_SQL}
  ${CONTACT_LINK_PROPOSALS_TABLE_SQL}
  ${CONTACT_LINK_PROPOSALS_INDEX_SQL}
  CREATE TABLE phone_last_message (phone TEXT, last_message_at TEXT);
`;

function seedRecord(
  id: string,
  source: string,
  recordId: string,
  opts: { syncedAt?: string; sessionId?: string; userId?: string } = {},
): void {
  // BACKLOG-2614 — the parent row first. Production
  // `contact_source_links.contact_id` is TEXT NOT NULL behind a real FK to
  // `contacts(id)`, so the child insert below fails without it. `OR IGNORE`
  // keeps the helper safe if two records ever share a contact.
  mockDb!
    .prepare(`INSERT OR IGNORE INTO contacts (id, user_id) VALUES (?, ?)`)
    .run(`contact-${id}`, opts.userId ?? USER);
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
  // BACKLOG-2614 — production adds four NOT NULLs with CHECK vocabularies:
  // `reason` (free text), `identity_assessment`, `relationship_assessment` and
  // `cluster_key`. The values below are inside those vocabularies. `pair_kind`
  // defaults to 'record_contact', whose shape CHECK requires exactly what this
  // seed supplies: contact + source columns set, every target_* column NULL.
  mockDb!
    .prepare(
      `INSERT INTO contact_link_proposals
         (id, user_id, contact_id, source_type, source_record_id,
          reason, identity_assessment, relationship_assessment, cluster_key)
       VALUES (?, ?, ?, ?, ?, 'seeded by BACKLOG-2480 suite', 'same_person', 'connected', ?)`,
    )
    .run(
      `prop-${id}`,
      opts.userId ?? USER,
      `contact-${id}`,
      source,
      recordId,
      `cluster-${id}`,
    );
}

const linkIds = (): string[] =>
  (mockDb!.prepare("SELECT id FROM contact_source_links ORDER BY id").all() as Array<{
    id: string;
  }>).map((r) => r.id);

const proposalIds = (): string[] =>
  (mockDb!.prepare("SELECT id FROM contact_link_proposals ORDER BY id").all() as Array<{
    id: string;
  }>).map((r) => r.id);

/**
 * BACKLOG-2614 — the contacts that the crosswalk rows point at.
 *
 * Reads the ID SET, never a contacts column, so it stays a statement about the
 * FK graph rather than about contact data. It exists because the production DDL
 * brought `ON DELETE CASCADE` into this suite: a cascade is a SECOND mechanism
 * that could remove exactly the link and proposal rows these tests are about,
 * and it is inert here only for as long as nothing deletes a contact. Asserting
 * the contacts survive is what keeps every green below attributable to the
 * service under test rather than to the cascade.
 */
const contactIds = (): string[] =>
  (mockDb!.prepare("SELECT id FROM contacts ORDER BY id").all() as Array<{
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
    // BACKLOG-2614 — the FK parent is part of the seeded shape now. This pins
    // WHAT SEEDING PRODUCES; it deletes nothing, so it cannot by itself catch a
    // cascade regression. The assertion that can is in the
    // `deleteStaleContactsBySource` case below, where a deletion actually runs.
    expect(contactIds()).toEqual(["contact-a"]);
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
    // BACKLOG-2614 — BOTH contacts survive a deletion that removed the stale
    // record's link and proposal. The production DDL brought
    // `ON DELETE CASCADE` into this suite, which could remove those same two
    // rows for a reason unrelated to the service. This is the assertion that
    // tells the two apart: if a future change ever deletes a contact, the
    // cascade takes the crosswalk with it and this goes red instead of the
    // suite passing for the wrong reason.
    expect(contactIds()).toEqual(["contact-fresh", "contact-stale"]);
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

  // BACKLOG-3029 replaced `clearAllForUser` with this. The suite's premise is
  // that EVERY deletion path is driven, so the replacement takes the slot rather
  // than the case being dropped — a path that stops being covered because it was
  // renamed is how the four unguarded siblings stayed unguarded.
  //
  // The seed is MIXED on both axes this path now discriminates on: another
  // user's row, and a row of a source that was NOT requested. `clearAllForUser`
  // would have taken all three.
  it("clearRefetchableSourcesForUser — the requested source goes; another user's and an unrequested source stay", () => {
    seedRecord("mine", "macos", "rec-mine");
    seedRecord("unrequested", "outlook", "rec-unrequested");
    seedRecord("theirs", "macos", "rec-theirs", { userId: OTHER_USER });

    // The fixture really does hold all three before the delete — otherwise
    // "it survived" would pass for a row that was never there.
    expect(recordIds()).toEqual(["mine", "theirs", "unrequested"]);

    const deleted = clearRefetchableSourcesForUser(USER, ["macos"]);

    expect(deleted).toBe(1);
    expect(recordIds()).toEqual(["theirs", "unrequested"]);
    // The survivor assertion is the one that catches a cleanup which deletes
    // too much — the failure mode a "the orphan is gone" test cannot see.
    expect(linkIds()).toEqual(["link-theirs", "link-unrequested"]);
    expect(proposalIds()).toEqual(["prop-theirs", "prop-unrequested"]);
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

/**
 * BACKLOG-2614 — THE GUARD IS BY EXECUTION, NOT BY IMPORT DISCIPLINE.
 *
 * Importing the production DDL fixes the drift once; these pins are what stop it
 * coming back. Paste a hand-written five-column `contact_link_proposals` over
 * the import and the UNIQUE count here goes 2 -> 0. The header on
 * `contactIdentitySchemaSql.ts` records the incident this comes from: dropping
 * the proposals UNIQUE from the REAL migration left a 27-test suite fully green,
 * because no suite was running the real DDL.
 *
 * `origin = 'u'` selects the auto-indexes SQLite creates for TABLE-LEVEL UNIQUE
 * constraints, so this counts constraints and ignores the plain `CREATE INDEX`
 * that ships beside each table.
 */
describe("the identity tables are the production DDL (BACKLOG-2614)", () => {
  const uniqueConstraintCount = (table: string): number =>
    (
      mockDb!.prepare(`PRAGMA index_list('${table}')`).all() as Array<{ origin: string }>
    ).filter((r) => r.origin === "u").length;

  it("contact_link_proposals carries BOTH table-level UNIQUEs", () => {
    // (user_id, contact_id, source_type, source_record_id) and (user_id, pair_key).
    expect(uniqueConstraintCount("contact_link_proposals")).toBe(2);
  });

  it("contact_source_links carries its table-level UNIQUE", () => {
    // (user_id, source_type, source_record_id).
    expect(uniqueConstraintCount("contact_source_links")).toBe(1);
  });

  it("contacts stays a bare FK parent: exactly id, user_id", () => {
    // NO ROW-COUNT PIN HERE, unlike the two sibling suites: this one seeds
    // contacts on purpose, because production `contact_source_links.contact_id`
    // is NOT NULL behind the FK. What must not drift is the SHAPE — the moment
    // `contacts` grows a column a test reads, it has stopped being an FK anchor
    // and become a second hand-written copy of a production table.
    expect(
      (mockDb!.prepare("PRAGMA table_info('contacts')").all() as Array<{ name: string }>).map(
        (c) => c.name,
      ),
    ).toEqual(["id", "user_id"]);
  });
});
