/**
 * @jest-environment node
 *
 * BACKLOG-3226 — a link and the deal's text-thread count commit together.
 *
 * ===========================================================================
 * WHAT IS UNDER TEST
 * ===========================================================================
 * Two seams in `communicationDbService.ts` write a junction row and then
 * recount `transactions.text_thread_count`. Before this item each write was its
 * own autocommit, so a failure at the second left the link written and the
 * count stale. Both seams now run their `*Sync` twin inside `dbTransaction`.
 *
 *   - `createCommunication` — the live caller is the email scan,
 *     `transactionService.ts` `_saveCommunications` -> `createCommunication`.
 *     Its `commData` (email_id + the email's thread_id) is transcribed below.
 *   - `createThreadCommunicationReference` — the live caller is
 *     `autoLinkService.ts` `autoLinkCommunicationsForContact`, which passes
 *     `"auto", 0.9`.
 *
 * ===========================================================================
 * HOW — the real driver, a write injector, every write boundary
 * ===========================================================================
 * The shipped `schema.sql` on an in-memory better-sqlite3 handle. `prepare` is
 * wrapped so every INSERT/UPDATE/DELETE/REPLACE statement records
 * `db.inTransaction` and can throw at write k. For each path:
 *
 *   BASE    — the exact write count N, the per-write inTransaction list (length
 *             N, all true), the return value and the end state.
 *   CRASH@k — for k = 1..N, generated from N: `firedAt === k` (unconditional),
 *             the call threw, `communications` and `transactions` are unchanged
 *             row for row, and a retry with no crash succeeds.
 *   NESTED  — the seam inside an outer `dbTransaction`, crash at write N: the
 *             seam throws SYNCHRONOUSLY (the plain-seam rule, BACKLOG-2547),
 *             the outer body catches and continues, the outer commits, and
 *             nothing changed (better-sqlite3 ran the inner as a SAVEPOINT).
 *
 * Each catches a wrong fix the others miss (measured, BACKLOG-3226 PR): a
 * transaction around the INSERT only, or an empty transaction, is caught by
 * the inTransaction list; a swallowed count error is caught only by the crash
 * sweep; an `async` seam is caught only by the NESTED synchronous-throw check.
 *
 * ===========================================================================
 * NOT COVERED, deliberately
 * ===========================================================================
 *   - `createCommunication` with `message_id` (the text-message branch). NO LIVE
 *     PRODUCER passes `message_id` to this seam or its twin today. Its case is
 *     here because the branch exists; it is uncontrolled for production.
 *   - `createCommunicationReference` and the async seams `deleteCommunication`,
 *     `deleteCommunicationByMessageId`, `deleteCommunicationByThread`. They have
 *     no production caller and are NOT wrapped; what to do with them is an open
 *     decision on BACKLOG-3226.
 */
import type { Database as DatabaseType, Statement } from "better-sqlite3";
import crypto from "crypto";
import fs from "fs";
import path from "path";

jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  setUser: jest.fn(),
  addBreadcrumb: jest.fn(),
}));
jest.mock("../../logService", () => {
  const m = {
    info: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
  };
  return { __esModule: true, default: m, logService: m };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  path.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

import { setDb, dbTransaction } from "../core/dbConnection";
import {
  createCommunication,
  createThreadCommunicationReference,
} from "../communicationDbService";
import { batchInsertMessages } from "../syncDbService";
import type { NewCommunication } from "../../../types";

const SCHEMA = fs.readFileSync(
  path.join(__dirname, "..", "..", "..", "database", "schema.sql"),
  "utf8",
);

const USER = crypto.randomUUID();
const TXN = crypto.randomUUID();
const THREAD = "thread-" + crypto.randomUUID();
const MSG = crypto.randomUUID();
const EMAIL = crypto.randomUUID();
const ETHREAD = "ethread-" + crypto.randomUUID();

// ---------------------------------------------------------------------------
// Write injector
// ---------------------------------------------------------------------------
const IS_WRITE = /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i;
let armed = false;
let writeCount = 0;
let crashAt = 0;
let firedAt = 0;
/** `db.inTransaction` at each write, in order. */
let writeInTx: boolean[] = [];

function resetInjector(at = 0): void {
  writeCount = 0;
  crashAt = at;
  firedAt = 0;
  writeInTx = [];
}

function instrument(handle: DatabaseType): void {
  const realPrepare = handle.prepare.bind(handle);
  (handle as unknown as { prepare: (s: string) => Statement }).prepare = (source: string) => {
    const statement = realPrepare(source);
    if (IS_WRITE.test(source)) {
      const realRun = statement.run.bind(statement);
      (statement as unknown as { run: (...a: unknown[]) => unknown }).run = (...params: unknown[]) => {
        if (!armed) return realRun(...(params as never[]));
        writeCount += 1;
        writeInTx.push(handle.inTransaction);
        if (crashAt && writeCount === crashAt) {
          firedAt = writeCount;
          throw new Error(`INJECTED CRASH at write ${writeCount}`);
        }
        return realRun(...(params as never[]));
      };
    }
    return statement;
  };
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------
let db: DatabaseType;

const snapshot = (): string =>
  JSON.stringify({
    communications: db
      .prepare(
        "SELECT id, user_id, transaction_id, message_id, email_id, thread_id, link_source FROM communications ORDER BY rowid",
      )
      .all(),
    transactions: db
      .prepare("SELECT id, text_thread_count FROM transactions ORDER BY rowid")
      .all(),
  });

const linkCount = (): number =>
  (db.prepare("SELECT COUNT(*) AS n FROM communications").get() as { n: number }).n;
const threadCount = (): number | null =>
  (db.prepare("SELECT text_thread_count AS n FROM transactions WHERE id = ?").get(TXN) as {
    n: number | null;
  }).n;

beforeEach(() => {
  armed = false;
  resetInjector(0);
  db = new Database(":memory:") as unknown as DatabaseType;
  db.exec(SCHEMA);
  db.prepare(
    "INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'me@example.com', 'google', 'o-me')",
  ).run(USER);
  db.prepare(
    "INSERT INTO transactions (id, user_id, property_address, started_at, closed_at) VALUES (?, ?, ?, ?, ?)",
  ).run(TXN, USER, "1 Test St", "2026-01-01T00:00:00.000Z", "2026-12-31T00:00:00.000Z");
  instrument(db);
  setDb(db);
  // The text message comes from its real producer, the iPhone/macOS sync writer.
  batchInsertMessages(
    [
      {
        id: MSG,
        userId: USER,
        channel: "imessage",
        externalId: "ext-" + MSG,
        direction: "inbound",
        bodyText: "Are you free Thursday?",
        participants: JSON.stringify({ from: "+15555550100", to: ["me"] }),
        participantsFlat: "+15555550100",
        threadId: THREAD,
        sentAt: "2026-06-01T00:00:00.000Z",
        hasAttachments: 0,
        messageType: null,
        metadata: null,
      },
    ],
    50,
  );
  // An email row by the raw insert the 2845 suite uses (no exported single-row
  // writer is on the scan path; the scan's own createEmail precedes this seam).
  db.prepare(
    "INSERT INTO emails (id, user_id, subject, sender, body_plain, sent_at, created_at, thread_id) VALUES (?, ?, 'S', 'seller@example.com', 'x', '2026-06-01T00:00:00.000Z', CURRENT_TIMESTAMP, ?)",
  ).run(EMAIL, USER, ETHREAD);
});

afterEach(() => {
  setDb(null as unknown as DatabaseType);
  db.close();
});

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
interface SeamPath {
  name: string;
  /** Exact write count when nothing fails. */
  n: number;
  call: () => Promise<unknown>;
  checkResult: (value: unknown) => void;
  /** End state after a successful call. */
  checkEnd: () => void;
}

/** Transcribed from transactionService.ts `_saveCommunications` `commData`. */
const scanCommData = (): NewCommunication =>
  ({
    user_id: USER,
    transaction_id: TXN,
    email_id: EMAIL,
    thread_id: ETHREAD,
    communication_type: "email",
    attachment_metadata: undefined,
    keywords_detected: JSON.stringify(["closing"]),
    parties_involved: JSON.stringify(["seller@example.com"]),
    relevance_score: 0.8,
    flagged_for_review: false,
    is_compliance_related: true,
  }) as unknown as NewCommunication;

const PATHS: SeamPath[] = [
  {
    name: "createCommunication(email + thread_id) — the scan path",
    n: 2,
    call: () => createCommunication(scanCommData()),
    checkResult: (v) => {
      expect((v as { email_id: string }).email_id).toBe(EMAIL);
      expect((v as { thread_id: string }).thread_id).toBe(ETHREAD);
    },
    checkEnd: () => {
      expect(linkCount()).toBe(1);
      // The recount ran in the same transaction. Its VALUE for an email link is
      // a separate finding (an email thread counts as a text thread), filed on
      // its own; this suite asserts the count moved with the link, not its meaning.
      expect(threadCount()).toBe(1);
    },
  },
  {
    name: "createCommunication(message_id, text) — NO LIVE PRODUCER",
    n: 2,
    call: () =>
      createCommunication({
        user_id: USER,
        transaction_id: TXN,
        message_id: MSG,
        communication_type: "text",
      } as unknown as NewCommunication),
    checkResult: (v) => expect((v as { message_id: string }).message_id).toBe(MSG),
    checkEnd: () => {
      expect(linkCount()).toBe(1);
      expect(threadCount()).toBe(1);
    },
  },
  {
    name: 'createThreadCommunicationReference("auto", 0.9) — the auto-link path',
    n: 2,
    call: () => createThreadCommunicationReference(THREAD, TXN, USER, "auto", 0.9),
    checkResult: (v) => expect(typeof v).toBe("string"),
    checkEnd: () => {
      expect(linkCount()).toBe(1);
      expect(threadCount()).toBe(1);
    },
  },
  {
    name: 'createThreadCommunicationReference("manual", 1)',
    n: 2,
    call: () => createThreadCommunicationReference(THREAD, TXN, USER, "manual", 1),
    checkResult: (v) => expect(typeof v).toBe("string"),
    checkEnd: () => {
      expect(linkCount()).toBe(1);
      expect(threadCount()).toBe(1);
    },
  },
];

async function settle(call: () => Promise<unknown>): Promise<{ ok: boolean; value?: unknown; error?: string }> {
  try {
    const value = await call();
    return { ok: true, value };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

describe("BACKLOG-3226: a link and the deal's text-thread count commit together", () => {
  for (const P of PATHS) {
    describe(P.name, () => {
      it(`BASE: exactly ${P.n} writes, every one inside a transaction`, async () => {
        const before = snapshot();
        armed = true;
        resetInjector(0);
        const r = await settle(P.call);
        armed = false;

        expect(r).toEqual(expect.objectContaining({ ok: true }));
        P.checkResult(r.value);
        expect(writeCount).toBe(P.n);
        expect(writeInTx).toEqual(Array.from({ length: P.n }, () => true));
        expect(snapshot()).not.toBe(before);
        P.checkEnd();
      });

      const ks = Array.from({ length: P.n }, (_, i) => i + 1);
      it.each(ks)("CRASH@%i: the call throws and nothing changes; a retry succeeds", async (k) => {
        const before = snapshot();
        armed = true;
        resetInjector(k);
        const r = await settle(P.call);
        armed = false;

        expect(firedAt).toBe(k);
        expect(r.ok).toBe(false);
        expect(r.error).toBe(`INJECTED CRASH at write ${k}`);
        expect(snapshot()).toBe(before);

        armed = true;
        resetInjector(0);
        const retry = await settle(P.call);
        armed = false;
        expect(retry.ok).toBe(true);
        expect(writeCount).toBe(P.n);
        P.checkEnd();
      });

      it(`NESTED: inside an outer transaction, a crash at write ${P.n} throws synchronously and rolls back to the savepoint`, () => {
        const before = snapshot();
        armed = true;
        resetInjector(P.n);
        let caughtSync = false;
        let caughtMessage = "";
        dbTransaction(() => {
          try {
            void P.call().catch(() => undefined);
          } catch (e) {
            caughtSync = true;
            caughtMessage = e instanceof Error ? e.message : String(e);
          }
        });
        armed = false;

        expect(firedAt).toBe(P.n);
        expect(caughtSync).toBe(true);
        expect(caughtMessage).toBe(`INJECTED CRASH at write ${P.n}`);
        expect(db.inTransaction).toBe(false);
        expect(snapshot()).toBe(before);
      });
    });
  }

  it('locked deal: an "auto" thread link writes nothing and returns null (BACKLOG-3910)', async () => {
    db.prepare("UPDATE transactions SET submission_status = 'submitted' WHERE id = ?").run(TXN);
    const before = snapshot();
    armed = true;
    resetInjector(0);
    const r = await settle(() => createThreadCommunicationReference(THREAD, TXN, USER, "auto", 0.9));
    armed = false;

    expect(r).toEqual({ ok: true, value: null });
    expect(writeCount).toBe(0);
    expect(db.inTransaction).toBe(false);
    expect(snapshot()).toBe(before);
  });
});
