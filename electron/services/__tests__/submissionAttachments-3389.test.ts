/**
 * @jest-environment node
 *
 * BACKLOG-3389 — a submission silently dropped an email attachment.
 *
 * ## The defect these controls exist for
 *
 * Before gathering attachments, a submission pre-downloads the email ones it is
 * missing. Its test for "missing" asked *does a ROW exist*, not *are there
 * BYTES*. Since BACKLOG-1870 a normal email sync writes attachment METADATA
 * with `storage_path` NULL, so that row satisfied the test, the download was
 * skipped — and the gather then discarded the row on `a.storage_path IS NOT
 * NULL`, because an upload needs bytes.
 *
 * Nothing was attempted, so nothing failed. The run logged
 * `attachmentsCount: 0, attachmentsFailed: 0` while dropping a real
 * attachment, and that silent zero is why it went unnoticed for a month.
 *
 * ## Why this suite runs a REAL database
 *
 * `submissionService.test.ts` does `jest.mock("../databaseService")` wholesale,
 * so no statement in it ever reaches a database — the BACKLOG-2848 shape, and
 * the reason both halves of this defect shipped green. Here the shipped SQL
 * runs against the whole of `electron/database/schema.sql` (executed, not
 * transcribed, so the CHECK constraints and defaults are production's), through
 * the real `submissionDbService` functions, with `PRAGMA foreign_keys = ON`
 * because production runs with them on.
 *
 * What is mocked is the OUTSIDE of the machine: the provider fetch, the storage
 * upload, the cloud. The provider mock backfills `storage_path` on the same row
 * the real `emailAttachmentService` would — which is what makes "the download
 * happened" observable as a row change rather than as a call count.
 *
 * ## The four properties, one test each
 *
 *  1. a metadata-only email attachment is downloaded and uploaded;
 *  2. a download that genuinely FAILS is counted and reported, never a silent
 *     zero;
 *  3. an attachment outside the audit window is still excluded;
 *  4. a text attachment that has bytes still uploads.
 *
 * Each mutation was run before the control was written down; the results are in
 * the PR body and on the backlog item.
 */

import fs from "fs";
import os from "os";
import path from "path";

import {
  createPostgrestEmulator,
  brokerageMembership,
  FIXTURE_USER_ID,
  type Emulator,
} from "./helpers/postgrestEmulator";

// Require the REAL native driver: jest's moduleNameMapper rewrites the bare
// specifier to a stub, and a stub cannot evaluate a WHERE clause.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

const SCHEMA = path.join(__dirname, "..", "..", "database", "schema.sql");

let db: DatabaseType;
let tmpRoot: string;
let emulator: Emulator;

// The real statement modules read their handle through `ensureDb()`; point it
// at the test database so the SHIPPED SQL text is what runs.
jest.mock("../db/core/dbConnection", () => ({
  ensureDb: () => db,
}));

const mockGetAuthSession = jest.fn();
jest.mock("../supabaseService", () => ({
  __esModule: true,
  default: {
    getClient: () => ({
      from: (table: string) => emulator.from(table),
      rpc: (fn: string, args?: unknown) => emulator.rpc(fn, args),
    }),
    getAuthSession: (...args: unknown[]) => mockGetAuthSession(...args),
  },
}));

/** Every attachment handed to storage, in the order the submission sent them. */
const uploaded: { id: string; localPath: string; filename: string }[] = [];
jest.mock("../supabaseStorageService", () => ({
  __esModule: true,
  default: {
    uploadAttachments: jest.fn(
      async (
        _orgId: string,
        _submissionId: string,
        localAttachments: { id: string; localPath: string; filename: string }[],
      ) => {
        uploaded.push(...localAttachments);
        return {
          results: localAttachments.map((a) => ({
            localId: a.id,
            success: true,
            remotePath: `remote/${a.id}`,
          })),
          failedCount: 0,
        };
      },
    ),
    deleteSubmissionAttachments: jest.fn(),
  },
}));

/**
 * The real `databaseService` opens an encrypted database at a real path. Its
 * submission readers are pure delegations to `db/submissionDbService`
 * (`databaseService.ts:2271-2281`), so this mock delegates to the SAME real
 * modules — the statements under test run, the singleton does not.
 */
jest.mock("../databaseService", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const submissionDb = require("../db/submissionDbService");
  return {
    __esModule: true,
    default: {
      getRawDatabase: () => db,
      getTransactionById: jest.fn(),
      getTransactionMessages: (...args: unknown[]) =>
        (submissionDb.getTransactionMessages as (...a: unknown[]) => unknown)(...args),
      getTransactionEmails: (...args: unknown[]) =>
        (submissionDb.getTransactionEmails as (...a: unknown[]) => unknown)(...args),
      getTransactionAttachments: (...args: unknown[]) =>
        (submissionDb.getTransactionAttachments as (...a: unknown[]) => unknown)(...args),
      updateTransaction: jest.fn(),
    },
  };
});

jest.mock("../logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock("../contactsService");
jest.mock("../contactResolutionService", () => ({
  resolveHandles: jest.fn().mockResolvedValue({ names: {}, matches: {} }),
  extractParticipantHandles: jest.fn().mockReturnValue([]),
  nameForHandle: jest.fn(),
}));

/**
 * The provider fetch. `getEmailById` answers with one attachment; the download
 * writes bytes onto the row a sync already created, exactly as
 * `emailAttachmentService.downloadEmailAttachment` does (`:397` backfills the
 * same row rather than inserting a second one).
 *
 * `downloadShouldFail` makes the provider throw the way a real fetch failure
 * throws — the service catches it and logs a warning, which is precisely the
 * path that used to end in `attachmentsFailed: 0`.
 */
let downloadShouldFail = false;
const downloadEmailAttachments = jest.fn(
  async (_userId: string, emailId: string) => {
    if (downloadShouldFail) throw new Error("provider refused the attachment");
    db.prepare(
      `UPDATE attachments SET storage_path = '/local/bytes/' || id
       WHERE email_id = ? AND storage_path IS NULL`,
    ).run(emailId);
  },
);
jest.mock("../emailAttachmentService", () => ({
  __esModule: true,
  default: {
    downloadEmailAttachments: (...args: unknown[]) =>
      (downloadEmailAttachments as (...a: unknown[]) => unknown)(...args),
  },
}));

jest.mock("../gmailFetchService", () => ({
  __esModule: true,
  default: {
    initialize: jest.fn().mockResolvedValue(true),
    getEmailById: jest.fn().mockResolvedValue({
      attachments: [
        {
          filename: "disclosure.pdf",
          mimeType: "application/pdf",
          size: 1024,
          partId: "2",
          attachmentId: "gmail-att-1",
        },
      ],
    }),
  },
}));
jest.mock("../outlookFetchService", () => ({
  __esModule: true,
  default: { initialize: jest.fn().mockResolvedValue(false), getAttachments: jest.fn() },
}));

jest.mock("electron", () => ({
  app: { getVersion: jest.fn().mockReturnValue("2.37.0") },
  net: { isOnline: jest.fn().mockReturnValue(true) },
}));

import { submissionService } from "../submissionService";
import databaseService from "../databaseService";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const TX = "txn-3389";

/**
 * The audit window. `submissionService` builds it from `started_at`/`closed_at`
 * and `auditWindowEnd` resolves the end to LOCAL midnight of the closing day,
 * so both in-window instants sit far from either bound and the out-of-window
 * one is months away — this suite is about attachment BYTES, and BACKLOG-2781's
 * suite already sweeps the boundary itself.
 */
const STARTED_AT = "2026-08-14";
const CLOSED_AT = "2026-09-14";
const IN_WINDOW = "2026-08-20T12:00:00.000Z";
const IN_WINDOW_TEXT = "2026-08-25T12:00:00.000Z";
const OUT_OF_WINDOW = "2026-05-01T12:00:00.000Z";

function insertEmail(id: string, sentAt: string, hasAttachments = 1): void {
  db.prepare(
    `INSERT INTO emails (id, user_id, external_id, source, has_attachments, subject, sent_at, direction)
     VALUES (?, ?, ?, 'gmail', ?, ?, ?, 'inbound')`,
  ).run(id, FIXTURE_USER_ID, `ext-${id}`, hasAttachments, `subject ${id}`, sentAt);
  db.prepare(
    `INSERT INTO communications (id, user_id, transaction_id, email_id, link_source)
     VALUES (?, ?, ?, ?, 'auto')`,
  ).run(`comm-${id}`, FIXTURE_USER_ID, TX, id);
}

function insertMessage(id: string, sentAt: string, hasAttachments = 1): void {
  db.prepare(
    `INSERT INTO messages (id, user_id, external_id, channel, direction, sent_at, has_attachments, thread_id, participants_flat)
     VALUES (?, ?, ?, 'imessage', 'inbound', ?, ?, ?, ?)`,
  ).run(id, FIXTURE_USER_ID, `ext-${id}`, sentAt, hasAttachments, `thread-${id}`, "+15550100");
  db.prepare(
    `INSERT INTO communications (id, user_id, transaction_id, message_id, link_source)
     VALUES (?, ?, ?, ?, 'auto')`,
  ).run(`comm-${id}`, FIXTURE_USER_ID, TX, id);
}

/** The shape a normal email sync writes: filename known, no bytes. */
function metadataOnlyEmailAttachment(id: string, emailId: string): void {
  db.prepare(
    `INSERT INTO attachments (id, email_id, filename, mime_type, storage_path)
     VALUES (?, ?, 'disclosure.pdf', 'application/pdf', NULL)`,
  ).run(id, emailId);
}

/** The shape a completed text import writes: bytes on disk. */
function storedTextAttachment(id: string, messageId: string): void {
  db.prepare(
    `INSERT INTO attachments (id, message_id, filename, mime_type, storage_path)
     VALUES (?, ?, 'photo.jpg', 'image/jpeg', ?)`,
  ).run(id, messageId, `/local/bytes/${id}`);
}

const submit = () => submissionService.submitTransaction(TX);

beforeEach(() => {
  jest.clearAllMocks();
  uploaded.length = 0;
  downloadShouldFail = false;

  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-3389-"));
  db = new RealDatabase(path.join(tmpRoot, "mad.db")) as unknown as DatabaseType;
  db.exec(fs.readFileSync(SCHEMA, "utf8"));
  db.pragma("foreign_keys = ON");

  db.prepare(
    `INSERT INTO users_local (id, email, oauth_provider, oauth_id)
     VALUES (?, 'fixture@example.test', 'google', 'oauth-3389')`,
  ).run(FIXTURE_USER_ID);
  db.prepare(
    `INSERT INTO transactions (id, user_id, property_address, started_at, closed_at)
     VALUES (?, ?, '1 Fixture Way', ?, ?)`,
  ).run(TX, FIXTURE_USER_ID, STARTED_AT, CLOSED_AT);

  emulator = createPostgrestEmulator({
    rows: { organization_members: [brokerageMembership()] },
  });
  mockGetAuthSession.mockResolvedValue({ userId: FIXTURE_USER_ID });
  (databaseService.getTransactionById as jest.Mock).mockResolvedValue({
    id: TX,
    user_id: FIXTURE_USER_ID,
    property_address: "1 Fixture Way",
    started_at: STARTED_AT,
    closed_at: CLOSED_AT,
  });
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("BACKLOG-3389 — an attachment that exists only as metadata", () => {
  /**
   * CONTROL 1. Reverting `submissionEmailSql.ts` to the bare
   * `NOT EXISTS (SELECT 1 FROM attachments a WHERE a.email_id = e.id)` turns
   * this red: the pre-download selects nothing, the row keeps its NULL
   * `storage_path`, and the gather drops it — which is the bug, reproduced.
   */
  it("downloads it before gathering, and submits it", async () => {
    insertEmail("e-meta", IN_WINDOW);
    metadataOnlyEmailAttachment("a-meta", "e-meta");

    const result = await submit();

    expect(result.success).toBe(true);
    // The row read back from the database — the download reached THIS row.
    const row = db
      .prepare(`SELECT storage_path FROM attachments WHERE id = 'a-meta'`)
      .get() as { storage_path: string | null };
    expect(row.storage_path).toBe("/local/bytes/a-meta");
    // And it reached the broker, which is the property the founder loses.
    expect(uploaded.map((u) => u.id)).toEqual(["a-meta"]);
    expect(result.attachmentsCount).toBe(1);
    expect(result.flaggedWithoutAttachments).toBe(0);
  });

  /**
   * CONTROL 2. The reported defect is not only the drop — it is the SILENCE.
   * Deleting the `countFlaggedWithoutAttachments` call and hardcoding 0 turns
   * this red; `attachmentsFailed` cannot be made to see it, because the
   * attachment never reached the upload stage that count measures.
   */
  it("counts an attachment whose download fails, instead of reporting nothing", async () => {
    insertEmail("e-fails", IN_WINDOW);
    metadataOnlyEmailAttachment("a-fails", "e-fails");
    downloadShouldFail = true;

    const result = await submit();

    expect(result.success).toBe(true);
    expect(result.attachmentsCount).toBe(0);
    // The old, uninformative pair — still reported, still zero, and still
    // structurally incapable of describing what happened.
    expect(result.attachmentsFailed).toBe(0);
    // The number that now says it.
    expect(result.flaggedWithoutAttachments).toBe(1);
    expect(uploaded).toEqual([]);
  });

  /**
   * CONTROL 3. The pre-download carries no audit window, so the fix makes it
   * fetch out-of-window emails too. The GATHER's window is what keeps them out
   * of the submission, and that must not have moved: the 26 text attachments
   * the founder's Attachments tab counted were excluded by this window alone,
   * correctly.
   */
  it("still excludes an attachment outside the audit window", async () => {
    insertEmail("e-in", IN_WINDOW);
    metadataOnlyEmailAttachment("a-in", "e-in");
    insertEmail("e-out", OUT_OF_WINDOW);
    metadataOnlyEmailAttachment("a-out", "e-out");

    const result = await submit();

    expect(uploaded.map((u) => u.id)).toEqual(["a-in"]);
    expect(result.attachmentsCount).toBe(1);
    // The out-of-window email is not "dropped" — it is not part of this audit,
    // so it must not inflate the number that means "we lost something".
    expect(result.flaggedWithoutAttachments).toBe(0);
  });

  /**
   * CONTROL 4. The text path was NOT changed by this item (the investigation's
   * proposed fallback arm was retracted in pm_comments 5ebbca1a as parity, not
   * defect). This is the control that says so — if a text attachment with bytes
   * stopped uploading, the change reached further than it was meant to.
   */
  it("still submits a text attachment that has its bytes", async () => {
    insertMessage("m-text", IN_WINDOW_TEXT);
    storedTextAttachment("a-text", "m-text");

    const result = await submit();

    expect(uploaded.map((u) => u.id)).toEqual(["a-text"]);
    expect(result.attachmentsCount).toBe(1);
    expect(result.flaggedWithoutAttachments).toBe(0);
  });

  /**
   * The shape that is NOT a code defect and must not be counted as one twice:
   * a message flagged `has_attachments` whose attachment row was never written
   * (the importer skips unsupported/oversized/missing media). There is nothing
   * to download and nothing to fix — but the submission must SAY so, which is
   * the whole point of the new number.
   */
  it("reports a flagged item whose attachment row does not exist at all", async () => {
    insertMessage("m-flagged-empty", IN_WINDOW_TEXT);

    const result = await submit();

    expect(result.attachmentsCount).toBe(0);
    expect(result.flaggedWithoutAttachments).toBe(1);
  });
});
