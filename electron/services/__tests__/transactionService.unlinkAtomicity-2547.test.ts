/**
 * @jest-environment node
 *
 * BACKLOG-2547 — REMOVING MESSAGES FROM A TRANSACTION IS ONE ALL-OR-NOTHING WRITE.
 *
 * ===========================================================================
 * WHAT WAS WRONG
 * ===========================================================================
 * `unlinkMessages` (`transactionService.ts`) performs one logical action as
 * five unwrapped write groups:
 *
 *   (a) thread-level suppression   INSERT ignored_communications
 *   (b) per-message suppression    INSERT ignored_communications
 *   (c) per-message detach         UPDATE messages + DELETE communications
 *   (d) thread-level detach        DELETE communications
 *   (e) count fixup                UPDATE transactions
 *
 * A failure between (a/b) and (c) leaves the message SIMULTANEOUSLY LINKED —
 * the `communications` junction row survives — and SUPPRESSED — the
 * `ignored_communications` row exists. The next auto-link scan keeps it linked
 * while it also sits in the ignore set. That state is what the sweep below
 * proves unreachable, and what `REACHABILITY RECORD` names directly.
 *
 * ===========================================================================
 * WHY THIS SUITE HAS TO EXIST, AND WHY IT IS SHAPED LIKE THIS
 * ===========================================================================
 * `unlinkMessages` had NO test coverage of any kind before this file. The two
 * neighbouring suites — `transactionService.unlinkThread.test.ts` and
 * `transactionService.unlinkFallback.test.ts` — exercise `unlinkCommunication`,
 * a different method (BACKLOG-1718). So this is the first behavioural test the
 * function has ever had, written in the same change that restructures it, and
 * the happy-path case therefore has to carry more than anti-vacuity: it covers
 * BOTH predicate branches (see `PREDICATE ASYMMETRY` below).
 *
 * TWO CONTROLS COVER THIS CHANGE, AND THEY PROVE DIFFERENT THINGS.
 *
 * `writeAtomicity.guard.test.ts` is a STRUCTURAL control over `unlinkMessages`.
 * When this suite was first written it was not: the guard enumerated nothing
 * from a class-shaped service (BACKLOG-3232), and splitting a writer into
 * `<name>Sync` + a one-line wrapper dropped `<name>` from its writer set
 * (BACKLOG-3235). Both are fixed. The guard now enumerates `unlinkMessages`
 * (its own PRECONDITION names this unit), counts the db-layer writes it calls,
 * and reports the unit as an unwrapped multi-write when only the
 * `dbTransaction` wrap is removed. Its `KNOWN_UNWRAPPED` entry was deleted with
 * this fix for that reason.
 *
 * The guard can only see that a transaction is OPENED. It cannot see whether
 * every write actually lands inside it, or whether a failure rolls back. This
 * suite is the BEHAVIOURAL control for that, which is why the sweep is
 * exhaustive rather than sampled.
 *
 * ===========================================================================
 * HOW THE CRASH IS INJECTED
 * ===========================================================================
 * ONE instrumented handle sits under everything. `ensureDb()` and the mocked
 * `dbRun`/`dbGet`/`dbAll` all resolve to it, which is required rather than
 * tidy: group (c)'s `UPDATE messages` goes through `ensureDb().prepare()`
 * DIRECTLY (`messageDbService.unlinkMessageFromTransaction`), so a `dbRun`-level
 * injector would never see it and the sweep would silently skip that boundary.
 *
 * `crashAt = N` makes the Nth WRITE statement throw instead of executing, so
 * the observed state is "the first N-1 writes applied". N runs 1…EXPECTED_WRITES,
 * which is every boundary of the call, not a sample.
 *
 * WRITE-ONLY INJECTION IS COMPLETE FOR BOUNDARY COVERAGE. A crash at a read
 * lands between two writes, and both of those boundaries are already swept.
 * This is not a sampled sweep.
 *
 * THE COUNTER COUNTS JS-LEVEL `prepare().run()` CALLS, NOT SQL STATEMENTS.
 * `update_transactions_timestamp` (`schema.sql:1451`) is an AFTER UPDATE
 * trigger that issues its own `UPDATE transactions`; that write executes inside
 * SQLite and is invisible here. That is correct — a trigger is atomic with the
 * statement that fired it — and must not be read later as a miscount.
 *
 * `dbExec` is mocked to THROW. Nothing on this path uses it today (verified),
 * and it bypasses `prepare()` entirely, so it is the injector's one escape
 * route. Making it a red converts a future unaudited escape into a test
 * failure instead of a silently unswept write.
 *
 * ===========================================================================
 * PREDICATE ASYMMETRY — the thing most likely to break silently
 * ===========================================================================
 * Phase 1 decides with `passedTransactionId || message?.transaction_id`.
 * Group (c) decides with `message?.transaction_id` ALONE, and it iterates the
 * full `messageIds` INPUT LIST — not one of the phase-1 Maps — calling
 * `deleteCommunicationByMessageId` UNCONDITIONALLY. An implementation that
 * iterated a Map instead would silently stop deleting junction rows for every
 * input id that produced no `transactionId` in phase 1.
 *
 * `m-unlinked` is the discriminator: `transaction_id` NULL, but it HAS a
 * junction row. In the no-`passedTransactionId` call it lands in no Map at all,
 * so only an implementation that iterates `messageIds` deletes its junction
 * row. `m-missing` has no `messages` row at all and proves the null-message
 * path does not throw.
 *
 * ===========================================================================
 * FIXTURE
 * ===========================================================================
 * Real `schema.sql`, real engine, real production writers. Junction rows are
 * seeded by calling `createCommunication` — the actual producer — rather than
 * by hand-written INSERTs, so the fixture cannot describe a row shape the app
 * does not emit. Values are reserved-for-documentation only (`example.com`,
 * the `+1 555 01xx` reserved fictional range); names are invented.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { readFileSync } from "fs";
import path from "path";
import { openTestDb, currentEngine, type TestDb } from "./helpers/syncSqliteDriver";

// ---------------------------------------------------------------------------
// The instrumented handle
// ---------------------------------------------------------------------------

let realDb: TestDb | null = null;
/** Writes seen since the last `resetInjector`. */
let writeCount = 0;
/** The write index that throws. 0 = injection off. */
let crashAt = 0;

const INJECTED = "INJECTED CRASH";
const IS_WRITE = /^\s*(INSERT|UPDATE|DELETE)\b/i;

function resetInjector(crashAtWrite = 0): void {
  writeCount = 0;
  crashAt = crashAtWrite;
}

/**
 * Every `prepare(...).run(...)` on this handle is a candidate crash point.
 * `get`/`all` are passed through untouched — reads are not boundaries.
 */
const instrumented: TestDb = {
  prepare(sql: string) {
    const stmt = realDb!.prepare(sql);
    return {
      run: (...params: unknown[]) => {
        if (IS_WRITE.test(sql)) {
          writeCount += 1;
          if (crashAt !== 0 && writeCount === crashAt) {
            throw new Error(`${INJECTED} at write ${writeCount}: ${sql.trim().slice(0, 60)}`);
          }
        }
        return stmt.run(...params);
      },
      get: (...params: unknown[]) => stmt.get(...params),
      all: (...params: unknown[]) => stmt.all(...params),
    };
  },
  exec: (sql: string) => realDb!.exec(sql),
  close: () => realDb!.close(),
  transaction: <T,>(fn: () => T) => realDb!.transaction(fn),
} as unknown as TestDb;

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock("../db/core/dbConnection", () => ({
  ensureDb: () => instrumented,
  dbAll: (sql: string, params: unknown[] = []) =>
    instrumented.prepare(sql).all(...(params as never[])),
  dbGet: (sql: string, params: unknown[] = []) =>
    instrumented.prepare(sql).get(...(params as never[])),
  dbRun: (sql: string, params: unknown[] = []) => {
    const r = instrumented.prepare(sql).run(...(params as never[]));
    return { lastInsertRowid: r.lastInsertRowid, changes: r.changes };
  },
  // A REAL transaction, never `(fn) => fn()`. A passthrough leaves every
  // assertion in this file green while proving nothing — the exact failure
  // `syncSqliteDriver.transaction.test.ts` exists to pin.
  dbTransaction: <T,>(fn: () => T): T => instrumented.transaction(fn)(),
  // B7: the injector wraps `prepare()`, so `dbExec` is its one escape route.
  dbExec: () => {
    throw new Error("unexpected dbExec on the unlink write path");
  },
  getDbPath: () => "/fake/path/mad.db",
  getEncryptionKey: () => "fake-key",
}));

/**
 * `databaseService` is REDIRECTED to the real db services, never stubbed. The
 * writers are the code under test; stubbing any of them makes every assertion
 * below vacuous.
 */
jest.mock("../databaseService", () => {
  const messageDb = jest.requireActual(
    "../db/messageDbService",
  ) as typeof import("../db/messageDbService");
  const communicationDb = jest.requireActual(
    "../db/communicationDbService",
  ) as typeof import("../db/communicationDbService");
  const transactionDb = jest.requireActual(
    "../db/transactionDbService",
  ) as typeof import("../db/transactionDbService");
  const transactionContactDb = jest.requireActual(
    "../db/transactionContactDbService",
  ) as typeof import("../db/transactionContactDbService");
  return {
    __esModule: true,
    default: {
      getMessageById: (id: string) => Promise.resolve(messageDb.getMessageById(id)),
      unlinkMessageFromTransaction: (id: string) =>
        Promise.resolve(messageDb.unlinkMessageFromTransaction(id)),
      addIgnoredCommunication: (data: any) => communicationDb.addIgnoredCommunication(data),
      deleteCommunicationByMessageId: (id: string) =>
        communicationDb.deleteCommunicationByMessageId(id),
      deleteCommunicationByThread: (threadId: string, txId: string) =>
        communicationDb.deleteCommunicationByThread(threadId, txId),
      // The facade takes (id, channelFilter, limit); the db-layer function takes
      // the id alone and the facade narrows in JS. `getTransactionDetails` passes
      // both extras as `undefined` on this path, and nothing here reads the
      // returned communications, so delegating the id alone is faithful.
      getCommunicationsByTransaction: (txId: string) =>
        communicationDb.getCommunicationsByTransaction(txId),
      updateTransaction: (txId: string, updates: any) =>
        transactionDb.updateTransaction(txId, updates),
      getTransactionById: (txId: string) => transactionDb.getTransactionById(txId),
      getTransactionContactsWithRoles: (txId: string) =>
        transactionContactDb.getTransactionContactsWithRoles(txId),
    },
  };
});

// Import-graph ballast. Verified not called by `unlinkMessages`.
jest.mock("../gmailFetchService");
jest.mock("../outlookFetchService");
jest.mock("../transactionExtractorService");
jest.mock("../emailAttachmentService");
jest.mock("../supabaseService");
jest.mock("../emailSyncService");
jest.mock("../messageMatchingService", () => ({
  __esModule: true,
  createCommunicationReference: jest.fn(),
}));
jest.mock("../autoLinkService", () => ({
  __esModule: true,
  autoLinkCommunicationsForContact: jest.fn(),
}));
jest.mock("../contactsService", () => ({
  __esModule: true,
  getContactNames: jest.fn(),
}));
jest.mock("../auditService", () => ({
  __esModule: true,
  default: { log: jest.fn(), logTransactionAction: jest.fn() },
}));
jest.mock("../../utils/preferenceHelper", () => ({
  isContactSourceEnabled: jest.fn().mockResolvedValue(true),
}));

/**
 * `logService` issues no SQL — it imports only `fs`, `path` and the logger
 * provider, and contains no `dbRun`/`dbGet`/`dbAll`/`ensureDb`/`.prepare(`.
 * So mocking it does not change the write count between test and production.
 */
jest.mock("../logService", () => {
  const m = {
    info: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
  };
  return { __esModule: true, default: m, logService: m };
});

import transactionService from "../transactionService";
import { createCommunication } from "../db/communicationDbService";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const SCHEMA_PATH = path.join(__dirname, "..", "..", "database", "schema.sql");

const USER = "6f1c2a90-3b7e-4d55-9a21-8c4f0e6b7d31"; // pii-allow-uuid: invented for this fixture, not from any live row
const TX = "b7d40e12-5c88-4a63-9f10-2e5a7c3b9d64"; // pii-allow-uuid: invented for this fixture, not from any live row
const THREAD = "thread-2547";

const M_THREAD_A = "m-thread-a";
const M_THREAD_B = "m-thread-b";
const M_NULL_THREAD = "m-null-thread";
const M_EMPTY_THREAD = "m-empty-thread";
/** transaction_id NULL, but HAS a junction row. The group-(c) discriminator. */
const M_UNLINKED = "m-unlinked";
/** No `messages` row at all — `getMessageById` returns null. */
const M_MISSING = "m-missing";

const SEEDED_MESSAGE_COUNT = 10;

/** The call the renderer actually makes: all three call sites pass a transactionId. */
const PRODUCTION_IDS = [M_THREAD_A, M_THREAD_B, M_NULL_THREAD, M_EMPTY_THREAD];

/**
 * The number of write statements `unlinkMessages(PRODUCTION_IDS, TX)` issues.
 *
 * A LITERAL ON PURPOSE. Jest evaluates a `describe` body before any hook runs,
 * so a bound measured in `beforeAll` is `undefined` at `it.each` time and
 * `[...Array(undefined).keys()]` is `[0]` — the sweep would collapse to ONE
 * case while reading as exhaustive. The measurement is pinned separately by
 * the PRECONDITION below, so a fixture that stops firing a group turns that
 * pin red AND leaves the sweep at full width.
 */
const EXPECTED_WRITES = 18;

function buildSchema(db: TestDb): void {
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  db.prepare(
    "INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)",
  ).run(USER, "owner@example.com", "oauth-2547");
}

function seedMessage(
  db: TestDb,
  id: string,
  threadId: string | null,
  transactionId: string | null,
): void {
  db.prepare(
    `INSERT INTO messages (id, user_id, channel, direction, body_text, participants_flat,
                           thread_id, sent_at, transaction_id)
     VALUES (?, ?, 'sms', 'inbound', ?, ?, ?, '2026-01-05T10:00:00Z', ?)`,
  ).run(id, USER, `body ${id}`, "+15550101", threadId, transactionId);
}

function seedFixture(db: TestDb): void {
  db.prepare(
    `INSERT INTO transactions (id, user_id, property_address, status, message_count, text_thread_count)
     VALUES (?, ?, ?, 'active', ?, 1)`,
  ).run(TX, USER, "1 Example Way, Springfield", SEEDED_MESSAGE_COUNT);

  seedMessage(db, M_THREAD_A, THREAD, TX);
  seedMessage(db, M_THREAD_B, THREAD, TX);
  seedMessage(db, M_NULL_THREAD, null, TX);
  seedMessage(db, M_EMPTY_THREAD, "", TX);
  seedMessage(db, M_UNLINKED, null, null);

  // Junction rows written by the REAL producer, not by hand.
  for (const id of [M_THREAD_A, M_THREAD_B, M_NULL_THREAD, M_EMPTY_THREAD, M_UNLINKED]) {
    void createCommunication({
      user_id: USER,
      transaction_id: TX,
      message_id: id,
      link_source: "manual",
      link_confidence: 1.0,
    } as any);
  }
  // The thread-shaped row auto-link's thread expansion writes: thread_id set,
  // message_id null. Without it group (d)'s DELETE matches nothing.
  void createCommunication({
    user_id: USER,
    transaction_id: TX,
    thread_id: THREAD,
    link_source: "auto",
    link_confidence: 0.9,
  } as any);
}

// ---------------------------------------------------------------------------
// Snapshots — read RAW, never through the code under test
// ---------------------------------------------------------------------------

const SNAPSHOT_TABLES = ["communications", "ignored_communications", "messages", "transactions"];

/**
 * `SELECT *` for the rollback comparison. A hand-picked column list cannot see
 * a write to a column it omits, which is the "the check's inputs cannot
 * separate pass from fail" shape. This is a before/after equality, so it needs
 * no expected literals and the width costs nothing.
 */
function fullSnapshot(db: TestDb): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const table of SNAPSHOT_TABLES) {
    out[table] = db.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
  }
  return out;
}

/** Identity sets for the happy-path assertions. Never counts. */
function communicationIdentity(db: TestDb): Array<Record<string, unknown>> {
  return db
    .prepare(
      "SELECT message_id, thread_id, transaction_id FROM communications ORDER BY message_id, thread_id",
    )
    .all() as Array<Record<string, unknown>>;
}

function suppressionIdentity(db: TestDb): Array<Record<string, unknown>> {
  return db
    .prepare(
      `SELECT transaction_id, thread_id, original_communication_id, reason
       FROM ignored_communications ORDER BY thread_id, original_communication_id`,
    )
    .all() as Array<Record<string, unknown>>;
}

function messageLinkIdentity(db: TestDb): Array<Record<string, unknown>> {
  return db
    .prepare("SELECT id, transaction_id FROM messages ORDER BY id")
    .all() as Array<Record<string, unknown>>;
}

function transactionCounts(db: TestDb): Record<string, unknown> {
  return db
    .prepare("SELECT message_count, text_thread_count FROM transactions WHERE id = ?")
    .get(TX) as Record<string, unknown>;
}

/** Run the unlink, swallowing whatever it does. State is the assertion. */
async function runUnlink(ids: string[], txId?: string): Promise<Error | null> {
  try {
    await transactionService.unlinkMessages(ids, txId);
    return null;
  } catch (error) {
    return error as Error;
  }
}

beforeEach(() => {
  realDb = openTestDb();
  resetInjector(0);
  buildSchema(realDb);
  seedFixture(realDb);
  resetInjector(0);
});

afterEach(() => {
  realDb?.close();
  realDb = null;
});

// ===========================================================================
describe("BACKLOG-2547 PRECONDITIONS — the instrument itself", () => {
  it("runs on the real driver whenever the real driver is loadable", () => {
    let realDriverLoadable = true;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Real = require(
        path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
      ) as new (file: string) => { close(): void };
      new Real(":memory:").close();
    } catch {
      realDriverLoadable = false;
    }
    // eslint-disable-next-line no-console
    console.log(`[BACKLOG-2547] SQLite engine under test: ${currentEngine()}`);
    expect(currentEngine()).toBe(realDriverLoadable ? "better-sqlite3" : "node:sqlite");
  });

  it("the fixture fires exactly EXPECTED_WRITES write statements", async () => {
    resetInjector(0);
    const before = writeCount;
    await runUnlink(PRODUCTION_IDS, TX);
    expect(writeCount - before).toBe(EXPECTED_WRITES);
  });

  /**
   * THE MEASUREMENT BEHIND RULING (a).
   *
   * A caught constraint violation inside a live transaction is a STATEMENT-level
   * abort in SQLite: the transaction stays alive and later writes COMMIT. That
   * is why the two `try/catch` blocks that used to sit around the suppression
   * INSERTs had to go — with them, a failed suppression reproduces 2547's filed
   * inconsistent state with no crash at all, inside the transaction added to
   * prevent it.
   *
   * The probe asserts the violation ACTUALLY HAPPENED and names the constraint.
   * Without that it is self-confirming: a probe whose "violating" row is in fact
   * valid reports "the later write committed" for the wrong reason, and the two
   * readings are indistinguishable.
   */
  it("a CAUGHT constraint violation inside a transaction aborts the STATEMENT, not the transaction", () => {
    // The pragma must be established and read OUTSIDE the transaction — a
    // `PRAGMA foreign_keys` issued inside one is a no-op.
    const pragma = realDb!.prepare("PRAGMA foreign_keys").get() as Record<string, unknown>;
    expect(Object.values(pragma)[0]).toBe(1);

    let thrown: Error | null = null;
    realDb!.transaction(() => {
      try {
        // `transaction_id` FK -> transactions(id). This id does not exist.
        realDb!
          .prepare(
            "INSERT INTO ignored_communications (id, user_id, transaction_id, reason) VALUES (?, ?, ?, ?)",
          )
          .run("ig-probe", USER, "no-such-transaction", "probe");
      } catch (error) {
        thrown = error as Error;
      }
      // A later, VALID write in the same transaction.
      realDb!
        .prepare("UPDATE transactions SET property_address = ? WHERE id = ?")
        .run("probe marker", TX);
    })();

    // The violation actually occurred, and it is the constraint we think it is.
    expect(thrown).not.toBeNull();
    expect((thrown as unknown as Error).message).toContain("FOREIGN KEY constraint failed");

    const suppression = realDb!
      .prepare("SELECT id FROM ignored_communications WHERE id = ?")
      .all("ig-probe");
    const marker = realDb!
      .prepare("SELECT property_address FROM transactions WHERE id = ?")
      .get(TX) as Record<string, unknown>;

    // Statement rolled back; transaction stayed live and COMMITTED the later write.
    expect(suppression).toEqual([]);
    expect(marker.property_address).toBe("probe marker");
  });
});

// ===========================================================================
describe("BACKLOG-2547 — the unlink succeeds, and does exactly what it says", () => {
  /**
   * ANTI-VACUITY. "Byte-identical at every crash boundary" is also satisfied by
   * an `unlinkMessages` that throws immediately, so the end state has to be
   * asserted as identity sets on its own.
   */
  it("with a passed transactionId: detaches, suppresses, and fixes the counts", async () => {
    const error = await runUnlink(PRODUCTION_IDS, TX);
    expect(error).toBeNull();

    // Every junction row for the four unlinked messages is gone, and so is the
    // thread-shaped row. `m-unlinked` was not in the input list, so it stays.
    expect(communicationIdentity(realDb!)).toEqual([
      { message_id: M_UNLINKED, thread_id: null, transaction_id: TX },
    ]);

    expect(suppressionIdentity(realDb!)).toEqual([
      {
        transaction_id: TX,
        thread_id: null,
        original_communication_id: M_EMPTY_THREAD,
        reason: "Manually unlinked by user (no thread_id)",
      },
      {
        transaction_id: TX,
        thread_id: null,
        original_communication_id: M_NULL_THREAD,
        reason: "Manually unlinked by user (no thread_id)",
      },
      {
        transaction_id: TX,
        thread_id: THREAD,
        original_communication_id: null,
        reason: "Manually unlinked by user",
      },
    ]);

    expect(messageLinkIdentity(realDb!)).toEqual([
      { id: M_EMPTY_THREAD, transaction_id: null },
      { id: M_NULL_THREAD, transaction_id: null },
      { id: M_THREAD_A, transaction_id: null },
      { id: M_THREAD_B, transaction_id: null },
      { id: M_UNLINKED, transaction_id: null },
    ]);

    expect(transactionCounts(realDb!)).toEqual({
      message_count: SEEDED_MESSAGE_COUNT - PRODUCTION_IDS.length,
      text_thread_count: 1,
    });
  });

  /**
   * THE PREDICATE ASYMMETRY, and the group-(c) iteration source.
   *
   * No `passedTransactionId`, so `m-unlinked` (transaction_id NULL) lands in NO
   * phase-1 Map — it is neither counted nor suppressed. Its junction row must
   * STILL be deleted, because group (c) iterates the INPUT LIST and calls
   * `deleteCommunicationByMessageId` unconditionally. An implementation that
   * iterated a Map instead leaves that row behind and this goes red.
   *
   * `m-missing` has no `messages` row at all: the null-message path must not throw.
   */
  it("without a passed transactionId: falls back to the message's own link, and still deletes every input's junction row", async () => {
    const error = await runUnlink([...PRODUCTION_IDS, M_UNLINKED, M_MISSING]);
    expect(error).toBeNull();

    // Nothing survives — including m-unlinked's row, which no Map knew about.
    expect(communicationIdentity(realDb!)).toEqual([]);

    // m-unlinked contributed no suppression row: it was never counted.
    expect(
      suppressionIdentity(realDb!).map((r) => r.original_communication_id),
    ).toEqual([M_EMPTY_THREAD, M_NULL_THREAD, null]);

    // …and it was never counted against message_count either.
    expect(transactionCounts(realDb!)).toEqual({
      message_count: SEEDED_MESSAGE_COUNT - PRODUCTION_IDS.length,
      text_thread_count: 0,
    });
  });
});

// ===========================================================================
describe("BACKLOG-2547 — a crash anywhere in the write phase changes nothing", () => {
  /**
   * THE FILED DEFECT, NAMED. A crash at the first delete (the a/b -> c boundary)
   * is the state the item was filed for: the junction row still present AND the
   * suppression row present, for the same message.
   *
   * Kept as its own case, separate from the sweep, so the pre-fix red names the
   * defect instead of reporting "boundary 4 differs".
   */
  it("REACHABILITY RECORD: a crash at the first delete must not leave a message both linked and suppressed", async () => {
    const before = fullSnapshot(realDb!);

    // The first three writes are the suppression INSERTs (a, b); write 4 is the
    // first `UPDATE messages` of group (c).
    resetInjector(4);
    const error = await runUnlink(PRODUCTION_IDS, TX);
    resetInjector(0);

    expect(error).not.toBeNull();

    const stillLinked = realDb!
      .prepare("SELECT message_id FROM communications WHERE message_id = ?")
      .all(M_THREAD_A);
    const suppressed = realDb!
      .prepare("SELECT thread_id FROM ignored_communications WHERE thread_id = ?")
      .all(THREAD);

    // THE PAIR IS THE DEFECT — linked AND suppressed at the same time.
    //
    // `stillLinked` is NON-EMPTY here and that is correct: the rollback puts
    // the junction row back, so the message is linked and NOT suppressed —
    // exactly the coherent state it was in before the call. Asserting an empty
    // `stillLinked` would describe a state neither the old code nor the new one
    // produces (it was the first draft of this case, and execution caught it).
    // Pre-fix this goes red on `suppressed`, which is the filed defect.
    expect({ stillLinked, suppressed }).toEqual({
      stillLinked: [{ message_id: M_THREAD_A }],
      suppressed: [],
    });
    expect(fullSnapshot(realDb!)).toEqual(before);
  });

  /**
   * THE SWEEP. Every write boundary of the production-shaped call, not a
   * sample. The comparison is `SELECT *` on all four tables, so a write to any
   * column — including ones no assertion names — is visible.
   */
  it.each(Array.from({ length: EXPECTED_WRITES }, (_, i) => i + 1))(
    "crash at write %i leaves the database exactly as it was",
    async (n) => {
      const before = fullSnapshot(realDb!);

      resetInjector(n);
      const error = await runUnlink(PRODUCTION_IDS, TX);
      resetInjector(0);

      expect(fullSnapshot(realDb!)).toEqual(before);
      expect(error).not.toBeNull();
    },
  );
});
