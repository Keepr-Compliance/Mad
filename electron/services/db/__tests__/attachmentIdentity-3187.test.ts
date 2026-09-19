/**
 * @jest-environment node
 *
 * BACKLOG-3187 — Gmail attachment IDENTITY, against the real driver.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS PROVES, AND WHY IT NEEDS A REAL DATABASE
 * ---------------------------------------------------------------------------
 * The claim under test is not "the code passes a value"; it is "two rows
 * collapse into one, or stay two, depending on which field is used as identity".
 * That is a statement about a UNIQUE INDEX and a four-step lookup order, so it is
 * asserted against real SQLite running the SHIPPED schema and the SHIPPED index —
 * `V71_CREATE_PROVIDER_INDEX_SQL` is IMPORTED, never transcribed. A transcribed
 * index would let this file stay green against an index the app does not have.
 *
 * `schema.sql` is what a FRESH INSTALL receives (it already carries
 * `provider_attachment_id`; v71 adds it only to an upgraded database). The
 * upgraded-install path is covered by databaseService.migration-v71.test.ts, and
 * that the two ends agree — column and index present either way — is covered by
 * databaseService.schema-parity.test.ts. This file does not restate either.
 *
 * ---------------------------------------------------------------------------
 * FIXTURES ARE SYNTHETIC AND CONTAIN NO MAILBOX DATA
 * ---------------------------------------------------------------------------
 * `partId` values are "1" / "2" — Google's own format, and the only two values
 * the shape actually takes. Fetch tokens are the literal strings
 * "fetch-token-run-1" / "fetch-token-run-2": they stand for the MEASURED fact
 * that the same attachment returned two different `attachmentId` values seconds
 * apart, and deliberately do not imitate a real token's shape.
 */

import path from "path";
// The default Jest moduleNameMapper rewrites this package to a stub; require the
// real one through an explicit node_modules path so the SQL actually runs.
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
import type { Database as DatabaseType } from "better-sqlite3";
import fs from "fs";
import { setDb, setDbPath, setEncryptionKey } from "../core/dbConnection";
import { V71_CREATE_PROVIDER_INDEX_SQL } from "../migrationV71Sql";
import {
  upsertEmailAttachmentMetadata,
  findEmailAttachmentRow,
} from "../attachmentDbService";

const EMAIL_ID = "email-row-1";
const USER_ID = "user-1";
const FILENAME = "agreement.pdf";

let db: DatabaseType;

/** Rows for one email, as (provider_attachment_id, filename) pairs. */
function rowsFor(emailId: string): Array<{ id: string; pid: string | null; filename: string }> {
  return db
    .prepare(
      `SELECT id, provider_attachment_id AS pid, filename
         FROM attachments WHERE email_id = ? ORDER BY rowid`,
    )
    .all(emailId) as Array<{ id: string; pid: string | null; filename: string }>;
}

function upsert(identity: string | null, filename = FILENAME): string {
  return upsertEmailAttachmentMetadata({
    emailId: EMAIL_ID,
    externalEmailId: "external-1",
    filename,
    mimeType: "application/pdf",
    fileSizeBytes: 1024,
    providerAttachmentId: identity,
  });
}

beforeEach(() => {
  db = new Database(":memory:");
  const schemaPath = path.join(__dirname, "..", "..", "..", "database", "schema.sql");
  db.exec(fs.readFileSync(schemaPath, "utf-8"));
  // The one piece of the shipped schema that lives in the migration, not in
  // schema.sql. Imported, so this test cannot pass against a different index.
  db.exec(V71_CREATE_PROVIDER_INDEX_SQL);

  setDb(db);
  setDbPath(":memory:");
  setEncryptionKey("test-key-not-a-real-key");

  // Synthetic, and deliberately not a plausible address: `users_local` requires
  // email / oauth_provider / oauth_id, and nothing in this file reads them.
  db.prepare(
    `INSERT INTO users_local (id, email, oauth_provider, oauth_id)
     VALUES (?, 'fixture@example.invalid', 'google', 'fixture-oauth-id')`,
  ).run(USER_ID);
  db.prepare(
    `INSERT INTO emails (id, user_id, external_id, source, has_attachments)
     VALUES (?, ?, ?, 'gmail', 1)`,
  ).run(EMAIL_ID, USER_ID, "external-1");
});

afterEach(() => {
  setDb(null as unknown as DatabaseType);
  setDbPath(null as unknown as string);
  db.close();
});

describe("BACKLOG-3187: the index exists as shipped", () => {
  it("a fresh install carries the partial unique index the identity depends on", () => {
    const idx = db
      .prepare(
        `SELECT sql FROM sqlite_master
          WHERE type='index' AND name='idx_attachments_email_provider'`,
      )
      .get() as { sql: string } | undefined;
    // Without the WHERE clause every legacy NULL row would collide with every
    // other; without the index the collapse assertions below prove nothing.
    expect(idx?.sql).toContain("WHERE provider_attachment_id IS NOT NULL");
  });
});

describe("BACKLOG-3187 control 3a: identity must be the STABLE field", () => {
  it("re-syncing with the SAME identity leaves ONE row", () => {
    const first = upsert("1");
    const second = upsert("1");

    expect(second).toBe(first);
    expect(rowsFor(EMAIL_ID)).toEqual([
      { id: first, pid: "1", filename: FILENAME },
    ]);
  });

  it("the counterfactual: a ROTATING identity inserts a second row for the same attachment", () => {
    // This is what keying on Gmail's `attachmentId` would do. The measurement of
    // 2026-09-07 is that the two values below are what one attachment yields on
    // two fetches — so under that design every sync re-inserts, forever, while
    // the UNIQUE index asserts it cannot happen.
    const first = upsert("fetch-token-run-1");
    const second = upsert("fetch-token-run-2");

    expect(second).not.toBe(first);
    expect(rowsFor(EMAIL_ID).map((r) => r.pid)).toEqual([
      "fetch-token-run-1",
      "fetch-token-run-2",
    ]);
  });
});

describe("BACKLOG-3187 control 3b: one identity per PART, not per filename", () => {
  it("two same-named attachments in one message are two rows", () => {
    const a = upsert("1");
    const b = upsert("2");

    expect(b).not.toBe(a);
    // Asserted as an ID SET, not a count: a count of 2 is also produced by two
    // rows that both claim part "1", which would be a different bug.
    expect(new Set(rowsFor(EMAIL_ID).map((r) => r.pid))).toEqual(new Set(["1", "2"]));
  });

  it("the pre-3187 behaviour it replaces: with no identity, the second attachment is LOST", () => {
    // Not a regression being locked in — the record of what a NULL identity does,
    // which is what every Gmail row did before this item and what a row written
    // before it still does. The second call resolves to the FIRST row by filename.
    const a = upsert(null);
    const b = upsert(null);

    expect(b).toBe(a);
    expect(rowsFor(EMAIL_ID)).toHaveLength(1);
  });
});

describe("BACKLOG-3187 control 4: adopting a legacy row cannot collide", () => {
  it("stamps exactly one of two tolerated duplicate NULL rows, and does not throw", () => {
    // The state the brief warns about: duplicates that were legal while the column
    // was NULL, now inside the partial index's reach as soon as one is stamped.
    db.prepare(
      `INSERT INTO attachments (id, email_id, filename, created_at)
       VALUES ('legacy-a', ?, ?, CURRENT_TIMESTAMP)`,
    ).run(EMAIL_ID, FILENAME);
    db.prepare(
      `INSERT INTO attachments (id, email_id, filename, created_at)
       VALUES ('legacy-b', ?, ?, CURRENT_TIMESTAMP)`,
    ).run(EMAIL_ID, FILENAME);

    const adopted = upsert("1");

    const rows = rowsFor(EMAIL_ID);
    expect(rows).toHaveLength(2); // nothing inserted beside them, nothing deleted
    expect(rows.filter((r) => r.pid === "1").map((r) => r.id)).toEqual([adopted]);
    expect(rows.filter((r) => r.pid === null)).toHaveLength(1);
  });

  it("a second sync of the adopted attachment finds it by identity, not by filename", () => {
    db.prepare(
      `INSERT INTO attachments (id, email_id, filename, created_at)
       VALUES ('legacy-a', ?, ?, CURRENT_TIMESTAMP)`,
    ).run(EMAIL_ID, FILENAME);

    const adopted = upsert("1");
    expect(adopted).toBe("legacy-a");

    const again = findEmailAttachmentRow(EMAIL_ID, "a-different-name.pdf", "1");
    // Found despite the filename NOT matching — which is the whole point of an
    // identity: the provider renaming or our normalising the display name cannot
    // make the same part look like a new attachment.
    expect(again?.id).toBe("legacy-a");
  });
});

describe("BACKLOG-3187 control 2: an Outlook identity is unaffected", () => {
  it("a Graph id round-trips verbatim and keys the same way", () => {
    const graphId = "graph-attachment-id-1";
    const first = upsert(graphId);
    const second = upsert(graphId);

    expect(second).toBe(first);
    expect(rowsFor(EMAIL_ID)).toEqual([
      { id: first, pid: graphId, filename: FILENAME },
    ]);
  });
});
