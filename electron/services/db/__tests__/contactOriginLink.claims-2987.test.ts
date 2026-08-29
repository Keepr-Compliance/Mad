/**
 * @jest-environment node
 *
 * BACKLOG-2987 — `findClaimedSourceRecordIds`, against the REAL crosswalk table.
 *
 * ===========================================================================
 * WHY THIS RUNS REAL SQL AND NOT A MOCKED `dbAll`
 * ===========================================================================
 * The whole value of this helper is that it asks the database a question whose
 * answer is a fact rather than a guess. A suite that mocked `dbAll` and asserted
 * the SQL *string* would pass with a misspelled column, a missing `user_id`
 * scope, or a chunking bug that silently dropped the tail of a batch — every one
 * of which turns the probe into a permanent "nothing is claimed", i.e. exactly
 * today's behaviour, with a green test in front of it.
 *
 * `contact_source_links` here is the SAME DDL migration v59 execs — imported
 * from `db/contactIdentitySchemaSql.ts` via the shared schema helper, never
 * re-typed (see that helper's header for why re-typing it once went wrong).
 *
 * MUTATIONS THAT MUST GO RED (run, not asserted — results in the PR body):
 *   D1  drop `AND user_id = ?` (and its bind) from the query — the
 *       "scopes to the user" case fails.
 *   D2  drop `AND source_type = ?` (and its bind) — the "scopes to the source"
 *       case fails.
 *   D3  `break` out of the chunk loop after the first chunk — the large-batch
 *       case fails, because ids past id 400 come back unclaimed.
 *
 * A FOURTH MUTATION WAS RUN AND DID **NOT** GO RED, and that is recorded rather
 * than hidden: raising `CHUNK` to 10,000 changed nothing. The 999-parameter
 * figure everyone quotes is not this driver's — measured on
 * `better-sqlite3-multiple-ciphers` / SQLite 3.53.2, an `IN (...)` accepts
 * 32,766 bindings and fails at 32,767. So the chunking is insurance against an
 * older or differently-compiled SQLite, and the large-batch case below proves
 * CORRECTNESS ACROSS CHUNK BOUNDARIES (1,500 ids = four chunks), not that the
 * cap is enforced. Testing the cap itself would need a 32,767-row fixture.
 *
 * Every identifier below is invented.
 *
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --bail=0 \
 *     electron/services/db/__tests__/contactOriginLink.claims-2987.test.ts
 */

import { openTestDb, type TestDb } from "../../__tests__/helpers/syncSqliteDriver";
import { CONTACT_IDENTITY_SCHEMA } from "../../__tests__/helpers/contactIdentitySchema";

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
  dbTransaction: <T>(fn: () => T): T => mockDb!.transaction(fn)(),
  getDbPath: () => "/fake/path/mad.db",
  getEncryptionKey: () => "fake-key",
}));

jest.mock("../../logService", () => {
  const m = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { __esModule: true, default: m, logService: m };
});

import { findClaimedSourceRecordIds } from "../contactOriginLink";

const USER = "user-2987";
const OTHER_USER = "user-2987-other";

/**
 * Insert one crosswalk claim directly, the way a promote leaves one behind.
 *
 * The owning contact row is created too, because `contact_source_links` carries
 * a REAL foreign key to `contacts(id)` (it rejected the first version of this
 * helper). Left in the loop deliberately: a claim that cannot point at a contact
 * is not a state the code under test can ever see.
 */
function claim(userId: string, sourceType: string, recordId: string, contactId: string): void {
  mockDb!
    .prepare(
      "INSERT OR IGNORE INTO contacts (id, user_id, display_name, is_imported) VALUES (?, ?, ?, 1)",
    )
    .run(contactId, userId, `Contact ${contactId}`);
  mockDb!
    .prepare(
      `INSERT INTO contact_source_links
         (id, user_id, contact_id, source_type, source_record_id, match_method)
       VALUES (?, ?, ?, ?, ?, 'source_id')`,
    )
    .run(`link-${sourceType}-${recordId}-${userId}`, userId, contactId, sourceType, recordId);
}

beforeEach(() => {
  mockDb = openTestDb(":memory:");
  mockDb.exec(CONTACT_IDENTITY_SCHEMA);
});

afterEach(() => {
  mockDb?.close();
  mockDb = null;
});

describe("findClaimedSourceRecordIds", () => {
  it("returns EXACTLY the claimed subset, not a count and not everything", () => {
    claim(USER, "android_sync", "android-dev-1-a", "contact-a");
    claim(USER, "android_sync", "android-dev-1-c", "contact-c");

    const result = findClaimedSourceRecordIds(USER, "android_sync", [
      "android-dev-1-a",
      "android-dev-1-b",
      "android-dev-1-c",
      "android-dev-1-d",
    ]);

    expect([...result].sort()).toEqual(["android-dev-1-a", "android-dev-1-c"]);
  });

  it("scopes to the user — another account's claim is not ours", () => {
    claim(OTHER_USER, "android_sync", "android-dev-1-a", "contact-other");

    expect([...findClaimedSourceRecordIds(USER, "android_sync", ["android-dev-1-a"])]).toEqual([]);
    // And the row really is there, so the empty answer above is a scope
    // decision rather than an empty table.
    expect([
      ...findClaimedSourceRecordIds(OTHER_USER, "android_sync", ["android-dev-1-a"]),
    ]).toEqual(["android-dev-1-a"]);
  });

  it("scopes to the source type — the same id claimed by another source is not ours", () => {
    claim(USER, "outlook", "android-dev-1-a", "contact-outlook");

    expect([...findClaimedSourceRecordIds(USER, "android_sync", ["android-dev-1-a"])]).toEqual([]);
    expect([...findClaimedSourceRecordIds(USER, "outlook", ["android-dev-1-a"])]).toEqual([
      "android-dev-1-a",
    ]);
  });

  it("A DIFFERENT deviceId is a DIFFERENT record — the key embeds it", () => {
    // This is why the claim probe alone does not fix the duplication: before the
    // companion re-presented its identity (the other half of BACKLOG-2987) every
    // re-pair re-keyed every record and no claim could ever match.
    claim(USER, "android_sync", "android-OLD-DEVICE-a", "contact-a");

    expect([
      ...findClaimedSourceRecordIds(USER, "android_sync", ["android-NEW-DEVICE-a"]),
    ]).toEqual([]);
  });

  it("answers correctly for a batch spanning several chunks", () => {
    // A real full Android sync is ~400 records. 1,500 spans FOUR chunks, which
    // is what this case is for: a chunking bug that dropped or mis-scoped
    // anything after the first chunk shows up here. It is NOT a parameter-cap
    // test — see the header for the measured cap and why.
    const ids = Array.from({ length: 1500 }, (_, i) => `android-dev-1-${i}`);
    // Claim every 7th, so the expected set is large, interleaved, and spans
    // every chunk boundary — a sweep rather than a sample.
    const expected = ids.filter((_, i) => i % 7 === 0);
    for (const id of expected) claim(USER, "android_sync", id, `contact-${id}`);

    const result = findClaimedSourceRecordIds(USER, "android_sync", ids);

    expect(result.size).toBe(expected.length);
    expect([...result].sort()).toEqual([...expected].sort());
  });

  it("returns an empty set for an empty batch, a missing user or a missing source", () => {
    claim(USER, "android_sync", "android-dev-1-a", "contact-a");

    expect(findClaimedSourceRecordIds(USER, "android_sync", []).size).toBe(0);
    expect(findClaimedSourceRecordIds("", "android_sync", ["android-dev-1-a"]).size).toBe(0);
    expect(findClaimedSourceRecordIds(USER, "", ["android-dev-1-a"]).size).toBe(0);
  });
});
