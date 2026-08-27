/**
 * @jest-environment node
 *
 * BACKLOG-2565 bullet 3 — `linkCommunicationToTransaction`, pinned NOT fixed.
 *
 * ===========================================================================
 * READ THIS FIRST: EVERY ASSERTION HERE IS GREEN ON THE CODE AS SHIPPED
 * ===========================================================================
 * This suite is a CHARACTERIZATION suite. It does not accompany a fix and it
 * has no red-then-green control, because nothing in this commit changes
 * behaviour. It exists so that two claims made on BACKLOG-2565 stop being
 * static traces and become executed facts, and so that whoever DOES fix them
 * has to change a test on purpose rather than discover the semantics again.
 *
 * Delete or invert these assertions when the fixes land. A test asserting a
 * defect is only honest while the defect is deliberate.
 *
 * ===========================================================================
 * FACT 1 (the filed bullet) — the thread-count companion is missing
 * ===========================================================================
 * `linkCommunicationToTransaction` (communicationDbService.ts:323-329) is a
 * bare `UPDATE communications SET transaction_id = ? WHERE id = ?`. Every
 * other mutator of that column calls `updateTransactionThreadCount` on the way
 * out (`:95`, `:100`, `:278`, `:287`, `:315`, `:692`, plus
 * `autoLinkService.ts:1764`). This one does not, so re-parenting a TEXT
 * communication leaves BOTH transactions' `text_thread_count` stale — the old
 * one over-counting, the new one under-counting.
 *
 * NOT FIXED HERE, and not by oversight. BACKLOG-2766 ("communications on the
 * standard, and `text_thread_count` gets ONE owner") owns this column's
 * writer set, and the 2738 epic's Phase-2 note records `text_thread_count` as
 * deliberately excluded from the transactions writer's update path "because
 * accepting it in two places would give one column two writers with no
 * arbiter". Adding an eighth caller of `updateTransactionThreadCount` from a
 * low-severity drift batch would pre-empt exactly the ownership decision that
 * item exists to make.
 *
 * ===========================================================================
 * FACT 2 (found while tracing fact 1, and larger) — the sole caller passes an
 * id from the wrong table, so the UPDATE matches nothing
 * ===========================================================================
 * The filing calls fact 1 "harmless until the function is reused for a text
 * communication" because the sole caller passes an email id. Tracing that
 * caller shows the function does not work for the caller it already has:
 *
 *   hybridExtractorService.ts:397   linkCommunicationToTransaction(emailId, transactionId)
 *   communicationDbService.ts:328   UPDATE communications SET transaction_id = ? WHERE id = ?
 *
 * `communications.id` is a fresh `crypto.randomUUID()` assigned at INSERT; an
 * email's id lives in `communications.email_id`. The values passed are
 * `Message.id` rows — `threadGroupingService.getEmailsToPropagate` returns
 * `thread.emails.filter(...).map((e) => e.id)` (`threadGroupingService.ts:150-158`)
 * — so the predicate compares an email id against a communication id and
 * matches zero rows. `hybridExtractorService` then logs "Linked email to
 * transaction" for each one, because a zero-row UPDATE is not an error.
 *
 * The guard immediately before it has the same defect in the other direction:
 * `filterAlreadyLinked` (`hybridExtractorService.ts:355-383`) calls
 * `getCommunicationById(emailId)`, gets null for the same reason, and reads
 * that null as "not linked yet — safe to propagate".
 *
 * This is the BACKLOG-1875 shape: a path that reports success while writing
 * nothing. `hybridExtractorService` is live — `transactionService.ts:106`
 * constructs it. Filed for triage on BACKLOG-2565 rather than fixed here:
 * whether propagation should match on `email_id`, or INSERT junction rows it
 * currently assumes exist, is a behaviour decision, not a tidy-up.
 *
 * Run under the real driver:
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --bail=0 \
 *     electron/services/db/__tests__/communicationDbService.relinkGaps-2565.test.ts
 */

import path from "path";
import type { Database as DatabaseType } from "better-sqlite3";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

let mockDb: DatabaseType | null = null;

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

jest.mock("../../logService", () => {
  const m = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { __esModule: true, default: m, logService: m };
});

import {
  createCommunication,
  getCommunicationById,
  linkCommunicationToTransaction,
  countTextThreadsForTransaction,
} from "../communicationDbService";
import type { NewCommunication } from "../../../types";

const USER = "user-2565";
const TX_OLD = "tx-old-2565";
const TX_NEW = "tx-new-2565";
const EMAIL = "email-2565";
const TEXT_MESSAGE = "message-2565";

/** TRANSCRIBED from electron/database/schema.sql — see the linkSource-2565 suite. */
function createSchema(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE users_local (id TEXT PRIMARY KEY);

    CREATE TABLE transactions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      text_thread_count INTEGER DEFAULT 0
    );

    CREATE TABLE emails (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      thread_id TEXT
    );

    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      channel TEXT CHECK (channel IN ('email', 'sms', 'imessage')),
      participants TEXT,
      thread_id TEXT
    );

    CREATE TABLE communications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      transaction_id TEXT,
      message_id TEXT,
      email_id TEXT,
      thread_id TEXT,
      link_source TEXT CHECK (link_source IN ('auto', 'manual', 'scan')),
      link_confidence REAL,
      linked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      match_reason TEXT,
      FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE,
      FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE,
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
      FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE,
      CHECK (
        (message_id IS NOT NULL AND email_id IS NULL)
        OR (email_id IS NOT NULL AND message_id IS NULL)
        OR (message_id IS NULL AND email_id IS NULL AND thread_id IS NOT NULL)
      )
    );
  `);
}

function storedThreadCount(transactionId: string): number {
  const row = mockDb!
    .prepare("SELECT text_thread_count FROM transactions WHERE id = ?")
    .get(transactionId) as { text_thread_count: number };
  return row.text_thread_count;
}

beforeEach(() => {
  mockDb = new RealDatabase(":memory:");
  mockDb.pragma("foreign_keys = ON");
  createSchema(mockDb);

  mockDb.prepare("INSERT INTO users_local (id) VALUES (?)").run(USER);
  for (const tx of [TX_OLD, TX_NEW]) {
    mockDb.prepare("INSERT INTO transactions (id, user_id) VALUES (?, ?)").run(tx, USER);
  }
  mockDb
    .prepare("INSERT INTO emails (id, user_id, thread_id) VALUES (?, ?, ?)")
    .run(EMAIL, USER, "thread-email-2565");
  mockDb
    .prepare(
      "INSERT INTO messages (id, user_id, channel, thread_id) VALUES (?, ?, ?, ?)",
    )
    .run(TEXT_MESSAGE, USER, "sms", "thread-text-2565");
});

afterEach(() => {
  mockDb?.close();
  mockDb = null;
});

describe("linkCommunicationToTransaction — characterization (BACKLOG-2565)", () => {
  it("re-parents the row when given a communications.id", async () => {
    const comm = await createCommunication({
      user_id: USER,
      transaction_id: TX_OLD,
      email_id: EMAIL,
    } as NewCommunication);

    await linkCommunicationToTransaction(comm.id, TX_NEW);

    const after = await getCommunicationById(comm.id);
    expect(after?.transaction_id).toBe(TX_NEW);
  });

  /**
   * FACT 1 — the filed bullet, executed.
   *
   * A text communication moves from TX_OLD to TX_NEW. The row moves; neither
   * transaction's cached count does. The counts below are what the column
   * HOLDS, next to what a recount SAYS — so the assertion names the divergence
   * rather than just observing a number.
   */
  it("leaves text_thread_count stale on BOTH transactions", async () => {
    const comm = await createCommunication({
      user_id: USER,
      transaction_id: TX_OLD,
      message_id: TEXT_MESSAGE,
    } as NewCommunication);

    // createCommunication DOES call the companion, so the starting state is correct.
    expect(storedThreadCount(TX_OLD)).toBe(1);
    expect(storedThreadCount(TX_NEW)).toBe(0);

    await linkCommunicationToTransaction(comm.id, TX_NEW);

    // The junction row really moved...
    expect((await getCommunicationById(comm.id))?.transaction_id).toBe(TX_NEW);

    // ...and a fresh recount agrees it moved.
    expect(countTextThreadsForTransaction(TX_OLD)).toBe(0);
    expect(countTextThreadsForTransaction(TX_NEW)).toBe(1);

    // But the CACHED column on both rows still describes the world before the
    // move. This is the latent gap BACKLOG-2565 filed; BACKLOG-2766 owns the fix.
    expect(storedThreadCount(TX_OLD)).toBe(1);
    expect(storedThreadCount(TX_NEW)).toBe(0);
  });

  /**
   * FACT 2 — the sole caller's id domain, executed.
   *
   * `hybridExtractorService.linkEmailsToTransaction` passes an EMAIL id where
   * this function's predicate expects a `communications.id`. Nothing matches,
   * nothing throws, and the caller logs success.
   */
  it("matches ZERO rows when handed an email id, and does not report it", async () => {
    const comm = await createCommunication({
      user_id: USER,
      transaction_id: TX_OLD,
      email_id: EMAIL,
    } as NewCommunication);

    // The id the sole caller actually passes.
    await expect(
      linkCommunicationToTransaction(EMAIL, TX_NEW),
    ).resolves.toBeUndefined();

    // The row the caller believed it re-parented did not move.
    expect((await getCommunicationById(comm.id))?.transaction_id).toBe(TX_OLD);

    // And no row anywhere was re-parented — exact set, not a count.
    const linkedToNew = mockDb!
      .prepare("SELECT id FROM communications WHERE transaction_id = ?")
      .all(TX_NEW) as Array<{ id: string }>;
    expect(linkedToNew.map((r) => r.id)).toEqual([]);
  });

  /**
   * The other half of fact 2: the guard that runs immediately before the
   * UPDATE reads the same null and clears the email for propagation, so the
   * mismatch cannot be caught upstream either.
   */
  it("getCommunicationById returns null for an email id, which the caller's guard reads as 'safe to link'", async () => {
    await createCommunication({
      user_id: USER,
      transaction_id: TX_OLD,
      email_id: EMAIL,
    } as NewCommunication);

    // `filterAlreadyLinked` treats a null here as "not linked to anything yet".
    // The email IS linked — to TX_OLD — and the lookup cannot see it.
    expect(await getCommunicationById(EMAIL)).toBeNull();
  });
});
