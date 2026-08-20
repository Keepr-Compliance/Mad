/**
 * @file Export-capture fixture — BACKLOG-2612 characterization suite.
 *
 * Boots a REAL better-sqlite3-multiple-ciphers in-memory database on the
 * FRESH-INSTALL PATH EXECUTED, NOT IMITATED:
 *
 *   1. `exec(electron/database/schema.sql)`  — seeds schema_version = 32
 *   2. the real `databaseService._runVersionedMigrations()` — v33 → current
 *
 * Why not schema.sql alone: schema.sql stamps v32 and the chain then adds
 * columns the export path reads (`contacts.removed_at` arrives in v56,
 * `transaction_contacts.removed_at` likewise). A fixture built from
 * schema.sql alone describes a database production never has — the 2612
 * planning probe died on exactly that (`no such column: removed_at`).
 *
 * Why not import `migrationTestHarness.ts`: that helper carries an explicit
 * "DO NOT IMPORT FROM NON-MIGRATION TESTS" ban (it seeds a v29 SUBSET shape
 * for migration-runner tests). Only its three injection lines are replicated
 * here (`service.db`, `service.dbPath = null`, `setDb`), with this comment as
 * the required justification. Driver-require-by-path is the established
 * pattern from `contactSourceLinker.convergence-2620.test.ts`.
 *
 * SQL capture: `db.prepare` is wrapped AFTER migrations. While armed, every
 * prepared statement is recorded with its `/electron/` call frames, so
 * assertions can state "of every SQL statement the export EXECUTED, …" —
 * properties derived by execution, not by grep (a grep finds a token; the
 * capture finds what ran).
 *
 * All fixture identities are invented: names from `FICTIONAL_NAMES` in
 * scripts/ci/check-fixture-pii.mjs (the BACKLOG-2556 pairs are PAIRS BY
 * DESIGN for shared-identifier cases), `@example.com` addresses, reserved
 * 555-01xx phone numbers.
 *
 * RUNNER: real-driver suites run via
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --bail=0 <path>
 * — plain `npx jest` cannot load the native module at its resting Electron ABI.
 */

import path from "path";
import fs from "fs";
import os from "os";
import type { Database as DatabaseType } from "better-sqlite3";

import { setDb, setDbPath, setEncryptionKey } from "../../../db/core/dbConnection";
import { toE164, toLookupKey } from "../../../../utils/phoneNormalization";

// Bypass the Jest moduleNameMapper that rewrites better-sqlite3-multiple-ciphers
// to the auto-mock. Depth is 5: electron/services/folderExport/__tests__/helpers
// → repo root → node_modules.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  path.join(__dirname, "..", "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

const SCHEMA_SQL = fs.readFileSync(
  path.join(__dirname, "..", "..", "..", "..", "database", "schema.sql"),
  "utf8",
);

/** One captured statement: the SQL text plus the /electron/ frames that prepared it. */
export interface CapturedStatement {
  sql: string;
  frames: string[];
}

export interface SeedContactSpec {
  id: string;
  userId: string;
  displayName: string;
  /** First entry is written is_primary=1 unless `primary: false`. */
  emails?: Array<{ email: string; isPrimary?: boolean }>;
  phones?: Array<{ phone: string; isPrimary?: boolean }>;
}

export interface ExportFixture {
  db: DatabaseType;
  /** Statements recorded while armed, in execution-preparation order. */
  captured: CapturedStatement[];
  arm(): void;
  disarm(): void;
  /** Temp directory for export output; removed by cleanup(). */
  outputDir: string;
  seedUser(id: string, email: string, displayName: string): void;
  seedTransaction(spec: {
    id: string;
    userId: string;
    address: string;
    status?: string;
    startedAt?: string;
    closedAt?: string;
  }): void;
  seedContact(spec: SeedContactSpec): void;
  attachContact(spec: {
    transactionId: string;
    contactId: string;
    role?: string;
    isPrimary?: boolean;
    /** Explicit created_at so ORDER BY tc.created_at ASC is deterministic. */
    createdAt: string;
  }): void;
  seedLinkedEmail(spec: {
    id: string;
    userId: string;
    transactionId: string;
    sender: string;
    recipients: string;
    subject: string;
    sentAt: string;
    threadId?: string;
    bodyPlain?: string;
  }): void;
  seedLinkedText(spec: {
    id: string;
    userId: string;
    transactionId: string;
    /** Raw sender handle exactly as the messages table stores it. */
    sender: string;
    recipients: string;
    body: string;
    sentAt: string;
    threadId: string;
    direction?: "inbound" | "outbound";
    withAttachmentFilename?: string;
  }): void;
  cleanup(): Promise<void>;
}

export async function createExportFixture(): Promise<ExportFixture> {
  const db = new Database(":memory:") as DatabaseType;
  db.exec(SCHEMA_SQL); // seeds schema_version = 32 (schema.sql:1438)

  // Replicated (NOT imported) from migrationTestHarness — see file docblock.
  // dbPath = null skips the pre-migration backup-file requirement.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const service = require("../../../databaseService").default;
  service.db = db;
  service.dbPath = null;
  setDb(db);

  // The REAL versioned migration runner: v33 → current. This is what a fresh
  // install executes, so the fixture cannot drift from production shape
  // without CI noticing.
  await service._runVersionedMigrations();
  db.pragma("foreign_keys = ON");

  const captured: CapturedStatement[] = [];
  let armed = false;

  // Wrap prepare AFTER migrations so the capture holds export SQL only.
  const realPrepare = db.prepare.bind(db);
  (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
    if (armed) {
      const stack = new Error().stack ?? "";
      const frames = stack
        .split("\n")
        .filter((line) => line.includes(`${path.sep}electron${path.sep}`))
        .map((line) => line.trim());
      captured.push({ sql, frames });
    }
    return realPrepare(sql);
  };

  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "export-2612-"));

  const fixture: ExportFixture = {
    db,
    captured,
    arm: () => {
      armed = true;
    },
    disarm: () => {
      armed = false;
    },
    outputDir,

    seedUser(id, email, displayName) {
      db.prepare(
        `INSERT INTO users_local (id, email, display_name, oauth_provider, oauth_id)
         VALUES (?, ?, ?, 'google', ?)`,
      ).run(id, email, displayName, `oauth-${id}`);
    },

    seedTransaction({ id, userId, address, status = "active", startedAt, closedAt }) {
      db.prepare(
        `INSERT INTO transactions (id, user_id, property_address, status, started_at, closed_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, userId, address, status, startedAt ?? null, closedAt ?? null);
    },

    // Seeding is DIRECT INSERTs by design (SR §7): the expected value sets in
    // the controls must not move underneath us if a linking/backfill service
    // changes. The one production writer used deliberately is deleteContact()
    // for the tombstone — called from the tests, not from here.
    seedContact({ id, userId, displayName, emails = [], phones = [] }) {
      db.prepare(
        `INSERT INTO contacts (id, user_id, display_name, source, is_imported)
         VALUES (?, ?, ?, 'manual', 0)`,
      ).run(id, userId, displayName);
      emails.forEach(({ email, isPrimary }, i) => {
        db.prepare(
          `INSERT INTO contact_emails (id, contact_id, email, is_primary, source)
           VALUES (?, ?, ?, ?, 'manual')`,
        ).run(`ce-${id}-${i}`, id, email, isPrimary ?? i === 0 ? 1 : 0);
      });
      phones.forEach(({ phone, isPrimary }, i) => {
        // phone_normalized via the real production helper (toLookupKey) — the
        // digit-tail resolvers key on this column, so an invented normalization
        // here would test a shape production never writes.
        db.prepare(
          `INSERT INTO contact_phones (id, contact_id, phone_e164, phone_display, phone_normalized, is_primary, source)
           VALUES (?, ?, ?, ?, ?, ?, 'manual')`,
        ).run(`cp-${id}-${i}`, id, toE164(phone), phone, toLookupKey(phone), isPrimary ?? i === 0 ? 1 : 0);
      });
    },

    attachContact({ transactionId, contactId, role = "buyer", isPrimary = false, createdAt }) {
      db.prepare(
        `INSERT INTO transaction_contacts (id, transaction_id, contact_id, role, is_primary, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(`tc-${transactionId}-${contactId}`, transactionId, contactId, role, isPrimary ? 1 : 0, createdAt);
    },

    seedLinkedEmail({ id, userId, transactionId, sender, recipients, subject, sentAt, threadId, bodyPlain }) {
      db.prepare(
        `INSERT INTO emails (id, user_id, external_id, source, direction, subject, body_plain, sender, recipients, thread_id, sent_at, ingest_source)
         VALUES (?, ?, ?, 'gmail', 'inbound', ?, ?, ?, ?, ?, ?, 'manual')`,
      ).run(id, userId, `ext-${id}`, subject, bodyPlain ?? `Body of ${subject}`, sender, recipients, threadId ?? `thread-${id}`, sentAt);
      db.prepare(
        `INSERT INTO communications (id, user_id, transaction_id, email_id, thread_id, link_source, linked_at, created_at)
         VALUES (?, ?, ?, ?, ?, 'manual', ?, ?)`,
      ).run(`comm-${id}`, userId, transactionId, id, threadId ?? `thread-${id}`, sentAt, sentAt);
    },

    seedLinkedText({ id, userId, transactionId, sender, recipients, body, sentAt, threadId, direction = "inbound", withAttachmentFilename }) {
      db.prepare(
        `INSERT INTO messages (id, user_id, channel, direction, body_text, participants, participants_flat, thread_id, sent_at, has_attachments, external_id)
         VALUES (?, ?, 'imessage', ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        userId,
        direction,
        body,
        JSON.stringify({ from: sender, to: recipients.split(",").map((r) => r.trim()) }),
        `${sender}, ${recipients}`,
        threadId,
        sentAt,
        withAttachmentFilename ? 1 : 0,
        `guid-${id}`,
      );
      db.prepare(
        `INSERT INTO communications (id, user_id, transaction_id, message_id, thread_id, link_source, linked_at, created_at)
         VALUES (?, ?, ?, ?, ?, 'manual', ?, ?)`,
      ).run(`comm-${id}`, userId, transactionId, id, threadId, sentAt, sentAt);
      if (withAttachmentFilename) {
        db.prepare(
          `INSERT INTO attachments (id, message_id, external_message_id, filename, mime_type, file_size_bytes)
           VALUES (?, ?, ?, ?, 'image/png', 4)`,
        ).run(`att-${id}`, id, `guid-${id}`, withAttachmentFilename);
      }
    },

    async cleanup() {
      // Order per migrationTestHarness SR review: close handle FIRST, then
      // clear the shared connection, then the service fields.
      try {
        db.close();
      } catch {
        // already closed
      }
      setDb(null as unknown as DatabaseType);
      setDbPath(null as unknown as string);
      setEncryptionKey(null as unknown as string);
      service.db = null;
      service.dbPath = null;
      fs.rmSync(outputDir, { recursive: true, force: true });
    },
  };

  return fixture;
}
