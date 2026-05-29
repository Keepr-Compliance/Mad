/**
 * @file Migration Test Harness — reusable in-memory SQLite test fixture
 *
 * ============================================================================
 * WARNING — DO NOT IMPORT FROM NON-MIGRATION TESTS
 * ============================================================================
 * This harness bypasses ALL production invariants:
 *   - encryption (no SQLCipher key, no pragma cipher_compatibility)
 *   - key derivation (no databaseEncryptionService.initialize)
 *   - pre-migration backup requirement (dbPath set to null → check skipped)
 *   - WAL / synchronous / busy_timeout pragmas
 *
 * It is intended ONLY for migration runner tests (v40+) where the goal is
 * to exercise schema mutations + backfill against a real better-sqlite3
 * driver. Reusing it elsewhere will hide encryption/initialization bugs.
 *
 * Tracked: BACKLOG-1728 (this file), BACKLOG-1729 (broader write-path parity)
 * ============================================================================
 *
 * Usage:
 *
 *   const harness = createMigrationHarness({ seedV29Schema: true });
 *   try {
 *     harness.seedSchemaVersion(39);
 *     // ...seed test data via harness.db.prepare(...).run(...)...
 *     await harness.service._runVersionedMigrations();
 *     // ...assertions on harness.db...
 *   } finally {
 *     await harness.cleanup();
 *   }
 *
 * Bypassing the Jest auto-mock:
 * The default `better-sqlite3-multiple-ciphers` import resolves to the mock at
 * tests/__mocks__/better-sqlite3-multiple-ciphers.js. We escape that mapping
 * with an explicit node_modules require — same technique proven in
 * electron/services/db/__tests__/phoneNormalizedJoin.test.ts.
 *
 * This file lives at electron/services/__tests__/helpers/ — depth 4 from the
 * repo root, so the path is "..", "..", "..", "..", "node_modules", "...".
 */

import path from "path";
import type { Database as DatabaseType } from "better-sqlite3";
import {
  setDb,
  setDbPath,
  setEncryptionKey,
} from "../../db/core/dbConnection";

// Bypass the Jest moduleNameMapper that rewrites better-sqlite3-multiple-ciphers
// to the auto-mock. Depth is 4: __tests__/helpers/migrationTestHarness.ts →
// electron/services/__tests__/helpers → ../../../../ → repo root → node_modules.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  path.join(
    __dirname,
    "..",
    "..",
    "..",
    "..",
    "node_modules",
    "better-sqlite3-multiple-ciphers",
  ),
) as typeof import("better-sqlite3-multiple-ciphers");

/**
 * Minimal v29-shape schema subset.
 *
 * Includes ONLY the tables required by migration v40 (BACKLOG-1727) plus the
 * write-path functions tested in databaseService.migration-v40.test.ts.
 *
 * Tables included:
 *   - users_local             (FK target for contacts.user_id)
 *   - contacts                (parent for contact_phones)
 *   - contact_phones          (target of v40 ALTER + backfill — NO phone_normalized column)
 *   - contact_emails          (parent for createContact's email write path)
 *   - external_contacts       (target of v40 ALTER + backfill — NO phones_normalized_json column)
 *                             MUST include UNIQUE(user_id, source, external_record_id)
 *                             constraint — upsertFromMacOS/upsertFromiPhone rely on it
 *                             for ON CONFLICT.
 *   - schema_version          (where the runner reads current version + writes 40)
 *
 * Intentionally omitted: messages, communications, transactions, audit_logs,
 * email_*, sessions, oauth_tokens, etc. — none of these are touched by v40
 * or by the tested write functions, and including them would waste tokens.
 */
const V29_SCHEMA_SUBSET_SQL = `
  CREATE TABLE users_local (
    id TEXT PRIMARY KEY
  );

  CREATE TABLE contacts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    display_name TEXT,
    company TEXT,
    title TEXT,
    source TEXT,
    is_imported INTEGER DEFAULT 0,
    last_inbound_at DATETIME,
    last_outbound_at DATETIME,
    FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE
  );

  -- contact_phones at v29 shape: NO phone_normalized column, NO index.
  -- Migration v40 will ALTER + CREATE INDEX.
  CREATE TABLE contact_phones (
    id TEXT PRIMARY KEY,
    contact_id TEXT NOT NULL,
    phone_e164 TEXT NOT NULL,
    phone_display TEXT,
    is_primary INTEGER DEFAULT 0,
    source TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
  );

  CREATE TABLE contact_emails (
    id TEXT PRIMARY KEY,
    contact_id TEXT NOT NULL,
    email TEXT NOT NULL,
    is_primary INTEGER DEFAULT 0,
    source TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
  );

  -- external_contacts at v29 shape: NO phones_normalized_json column.
  -- Includes UNIQUE(user_id, source, external_record_id) — required for the
  -- ON CONFLICT clause in upsertFromMacOS / upsertFromiPhone.
  CREATE TABLE external_contacts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT,
    phones_json TEXT,
    emails_json TEXT,
    company TEXT,
    last_message_at DATETIME,
    external_record_id TEXT,
    source TEXT DEFAULT 'macos',
    synced_at DATETIME,
    sync_session_id TEXT,
    FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE,
    UNIQUE(user_id, source, external_record_id)
  );

  -- schema_version table: the runner's _ensureSchemaVersionTable will see this
  -- exists and ALTER in migrated_at if missing. We include migrated_at upfront
  -- to match the post-baseline shape.
  CREATE TABLE schema_version (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL DEFAULT 1,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    migrated_at TEXT DEFAULT (datetime('now'))
  );
`;

export interface MigrationHarnessOptions {
  /**
   * If true (default), creates the v29-shape schema subset described above.
   * If false, returns an empty in-memory DB — caller is responsible for all
   * DDL. Useful for tests that need to verify _ensureSchemaVersionTable
   * creates the table from scratch.
   */
  seedV29Schema?: boolean;
}

export interface MigrationHarness {
  /** Raw better-sqlite3 in-memory database (real driver, not the Jest mock). */
  db: DatabaseType;

  /**
   * The singleton databaseService instance, with internal `db` set to the
   * in-memory DB above and `dbPath` set to null (so the backup-file check
   * in _runVersionedMigrations is bypassed — see databaseService.ts:1087).
   *
   * Type is `any` because we mutate private fields. The implementation casts
   * inside to avoid spreading the cast through every caller.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  service: any;

  /**
   * Seed an initial schema_version row. Call BEFORE _runVersionedMigrations
   * when you want to simulate a DB at a specific version (e.g. 39).
   */
  seedSchemaVersion(version: number): void;

  /**
   * Tear down in the order required by the SR Engineer review of BACKLOG-1728:
   *   1. close the in-memory DB
   *   2. setDb(null) on the shared connection module
   *   3. null out service.db / service.dbPath
   * Order matters — closing the handle FIRST guarantees no teardown hook can
   * reach it through ensureDb() after we've nulled the references.
   */
  cleanup(): Promise<void>;
}

/**
 * Create an in-memory migration test harness.
 *
 * The harness:
 *  - opens an in-memory SQLite DB via the REAL better-sqlite3-multiple-ciphers
 *    driver (Jest auto-mock bypassed via require(path.join(...)))
 *  - optionally seeds a minimal v29-shape schema subset
 *  - injects the DB into the databaseService singleton AND into the shared
 *    db/core/dbConnection module (via setDb) so production write functions
 *    that use dbRun / dbGet / dbAll target our in-memory DB
 *  - sets databaseService.dbPath = null so the backup-file requirement
 *    inside _runVersionedMigrations is skipped (line 1087 of databaseService.ts)
 *
 * Does NOT call databaseEncryptionService.initialize() — that service caches
 * encryption keys at module scope and leaks state across test files.
 */
export function createMigrationHarness(
  options: MigrationHarnessOptions = {},
): MigrationHarness {
  const { seedV29Schema = true } = options;

  const db = new Database(":memory:") as DatabaseType;
  db.pragma("foreign_keys = ON");

  if (seedV29Schema) {
    db.exec(V29_SCHEMA_SUBSET_SQL);
  }

  // Defer the databaseService import until inside the function so consumers
  // that mock modules with jest.mock() before calling createMigrationHarness()
  // get the mocked versions applied. The harness itself does not mock anything.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const service = require("../../databaseService").default;

  // Inject the in-memory DB into the singleton.
  // dbPath = null is INTENTIONAL: skips the backup-file existence check in
  // _runVersionedMigrations (databaseService.ts ~line 1087).
  // encryptionKey is left unset — the migration runner doesn't need it.
  service.db = db;
  service.dbPath = null;

  // Inject into the shared connection module so production write paths
  // (contactDbService.createContact, externalContactDbService.upsertFromMacOS,
  //  etc.) which use dbRun/dbGet/dbAll/dbTransaction hit the same in-memory DB.
  setDb(db);
  // Path + key remain unset — write functions only need ensureDb(), which
  // returns the db we just set.

  return {
    db,
    service,

    seedSchemaVersion(version: number): void {
      // The schema_version table is created by V29_SCHEMA_SUBSET_SQL with no
      // row. Insert id=1 with the requested version. Use INSERT OR REPLACE so
      // callers can re-seed if they want.
      db.prepare(
        "INSERT OR REPLACE INTO schema_version (id, version, updated_at, migrated_at) VALUES (1, ?, CURRENT_TIMESTAMP, datetime('now'))",
      ).run(version);
    },

    async cleanup(): Promise<void> {
      // ORDER (per SR Engineer Step-7 review):
      //   1. close DB handle FIRST
      //   2. setDb(null) on the shared connection module
      //   3. null service.db / service.dbPath
      // Reverse order would leave a closed handle reachable via ensureDb()
      // if any post-cleanup hook calls a service function.
      try {
        db.close();
      } catch {
        // already closed — ignore
      }

      // setDb is typed as `(database: DatabaseType) => void` but accepts null
      // in practice (it's just an assignment). Cast to bypass the type check.
      setDb(null as unknown as DatabaseType);
      setDbPath(null as unknown as string);
      setEncryptionKey(null as unknown as string);

      service.db = null;
      service.dbPath = null;
    },
  };
}
