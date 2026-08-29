/**
 * @jest-environment node
 *
 * BACKLOG-2565 bullet 2 — `communications.link_source` had two defaults.
 *
 * ===========================================================================
 * THE DEFECT THIS SUITE PINS
 * ===========================================================================
 * Four sites INSERT into `communications.link_source`:
 *
 *   1. `communicationDbService.createCommunication`        `|| null`   <-- odd one out
 *   2. `communicationDbService.createCommunicationReference` `|| 'auto'`
 *   3. `messageMatchingService.createCommunicationReference` param default `'auto'`
 *   4. `autoLinkService.linkEmailToTransaction`             explicit `linkSource`
 *
 * Site 1 is the only one that can put NULL in the column, and it is the only
 * one reachable from a live caller with `link_source` omitted
 * (`transactionService.ts:683`, the extraction/analysis path — every other
 * caller passes `"manual"` explicitly). Sites 3 and 4 always bind a value.
 * Site 2 has ZERO importers anywhere in the repo — verified by grepping every
 * reference to the name; the only thing that reaches it is the blanket
 * `export *` in `electron/services/db/index.ts`, which no consumer names.
 *
 * NULL is not even in the column's declared domain. `NewCommunication.link_source`
 * is typed `'auto' | 'manual' | 'scan'` (`models.ts:1312`), and the schema
 * carries `CHECK (link_source IN ('auto','manual','scan'))` — which a NULL
 * passes only because SQLite treats a NULL CHECK result as satisfied.
 *
 * No reader distinguishes the two today: `getCommunications` exposes filters
 * for `user_id` and `transaction_id` only (`communicationDbService.ts:136-145`),
 * and the `link_source` entry at `:192` is `updateCommunication`'s WRITE
 * whitelist, not a query filter. So this is data-tidiness until the first
 * reader filters on the column — which is precisely the harm the item predicts.
 *
 * ===========================================================================
 * WHY THIS SUITE USES THE REAL SQLITE DRIVER
 * ===========================================================================
 * `createCommunication` does NOT read its row back — BACKLOG-1107 has it
 * return an object assembled in memory. A suite that mocked `dbRun` and
 * inspected the bound params would prove what the function INTENDED to store;
 * a suite that trusted the returned object would prove nothing at all, since
 * that object is built by the same `|| null` expression being tested. The
 * assertions below therefore go through the real driver and `SELECT` the
 * stored value back out, and separately assert that the in-memory return
 * MATCHES the row — the two `|| ...` expressions are independent code and a
 * fix to one is not a fix to the other.
 *
 * Run under the real driver:
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --bail=0 \
 *     electron/services/db/__tests__/communicationDbService.linkSource-2565.test.ts
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
  createCommunicationReference,
} from "../communicationDbService";
import type { NewCommunication } from "../../../types";

const USER = "user-2565";
const TX = "tx-2565";
const EMAIL = "email-2565";
const MESSAGE = "message-2565";

/**
 * TRANSCRIBED from `electron/database/schema.sql` — the `communications`,
 * `messages` and `emails` CREATE TABLE bodies, trimmed to the columns these
 * two writers bind plus every constraint that can reject a row.
 *
 * The constraints are kept deliberately, not trimmed away for convenience:
 *   - `CHECK (link_source IN ('auto','manual','scan'))` is the constraint the
 *     bug hides behind (SQLite passes a NULL CHECK), so dropping it would make
 *     the fixture unable to express the defect's setting.
 *   - the both-set/neither-set CHECK is what forces each case below to bind
 *     exactly one of `message_id` / `email_id`, matching the real callers.
 *   - `match_reason` stays LAST, as schema.sql requires (migration v55 appends
 *     it via ALTER TABLE; the parity guard BACKLOG-2298 depends on the order).
 *
 * `messages.participants` and `transactions.text_thread_count` are here because
 * `createCommunication` calls `updateTransactionThreadCount` on the way out,
 * which reads the first and writes the second. The first draft of this fixture
 * omitted `participants` and every test threw `no such column` instead of
 * asserting — a fixture that cannot run the real code path proves nothing.
 */
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

/** The stored value, read back out of the database by primary key. */
function storedLinkSource(id: string): string | null {
  const row = mockDb!
    .prepare("SELECT link_source FROM communications WHERE id = ?")
    .get(id) as { link_source: string | null } | undefined;
  expect(row).toBeDefined();
  return row!.link_source;
}

beforeEach(() => {
  mockDb = new RealDatabase(":memory:");
  mockDb.pragma("foreign_keys = ON");
  createSchema(mockDb);

  mockDb.prepare("INSERT INTO users_local (id) VALUES (?)").run(USER);
  mockDb
    .prepare("INSERT INTO transactions (id, user_id) VALUES (?, ?)")
    .run(TX, USER);
  mockDb
    .prepare("INSERT INTO emails (id, user_id, thread_id) VALUES (?, ?, ?)")
    .run(EMAIL, USER, "thread-2565");
  mockDb
    .prepare(
      "INSERT INTO messages (id, user_id, channel, thread_id) VALUES (?, ?, ?, ?)",
    )
    .run(MESSAGE, USER, "sms", "thread-2565");
});

afterEach(() => {
  mockDb?.close();
  mockDb = null;
});

describe("communications.link_source has ONE default (BACKLOG-2565)", () => {
  /**
   * THE RED CASE. Before the fix this stored NULL.
   *
   * The fixture is the live omitting caller's shape: `transactionService.ts:683`
   * builds a `Partial<NewCommunication>` for the extraction path with
   * `user_id`, `transaction_id`, `email_id` and `thread_id` set and
   * `link_source` never mentioned, then casts and calls through
   * `databaseService.createCommunication`. Every other caller of this writer
   * (`emailLinkingHandlers.ts:257/314/378`, `transactionService.ts:1823`)
   * passes `link_source: "manual"` explicitly and cannot reach the default.
   */
  it("createCommunication stores 'auto' when link_source is omitted", async () => {
    const created = await createCommunication({
      user_id: USER,
      transaction_id: TX,
      email_id: EMAIL,
      thread_id: "thread-2565",
    } as NewCommunication);

    // Read back what the WRITER actually put in the column — not what it
    // returned, and not what it bound.
    expect(storedLinkSource(created.id)).toBe("auto");
  });

  /**
   * BACKLOG-1107 has `createCommunication` return an object built in memory
   * rather than re-SELECTing the row. That object's `link_source` is a SECOND,
   * independent `|| ...` expression (`communicationDbService.ts:78`), so fixing
   * only the bound param would leave the returned object saying NULL about a
   * row that says 'auto'. Two answers for one row is the shape BACKLOG-2632
   * pinned for `ignored_at`; this asserts identity between them.
   */
  it("the object createCommunication returns MATCHES the stored row", async () => {
    const created = await createCommunication({
      user_id: USER,
      transaction_id: TX,
      email_id: EMAIL,
      thread_id: "thread-2565",
    } as NewCommunication);

    expect(created.link_source).toBe(storedLinkSource(created.id));
  });

  /**
   * The default must not swallow a caller's explicit choice. Exact values, and
   * every member of the declared domain — `'auto' | 'manual' | 'scan'` — not a
   * sample, so a future `|| 'auto'` placed on the wrong side of the expression
   * shows up here instead of silently rewriting `'scan'` rows.
   */
  it.each(["auto", "manual", "scan"] as const)(
    "createCommunication preserves an explicit link_source of '%s'",
    async (linkSource) => {
      const created = await createCommunication({
        user_id: USER,
        transaction_id: TX,
        email_id: EMAIL,
        thread_id: "thread-2565",
        link_source: linkSource,
      } as NewCommunication);

      expect(storedLinkSource(created.id)).toBe(linkSource);
      expect(created.link_source).toBe(linkSource);
    },
  );

  /**
   * THE ITEM'S ACTUAL CLAIM: the two writers in this module disagreed about
   * the same column. So the assertion is over BOTH writers at once, as an
   * exact SET — `['auto']`, not "two rows" and not "neither is null".
   *
   * `createCommunicationReference` has no live importer (see file header) and
   * is exercised here only because it is the other half of the inconsistency
   * the item names. It is left in place rather than deleted: removing an
   * exported function is a separate decision from making two defaults agree.
   */
  it("both writers in this module agree on the default", async () => {
    const viaCreate = await createCommunication({
      user_id: USER,
      transaction_id: TX,
      email_id: EMAIL,
      thread_id: "thread-2565",
    } as NewCommunication);

    const viaReference = await createCommunicationReference({
      user_id: USER,
      message_id: MESSAGE,
      transaction_id: TX,
    });

    const stored = mockDb!
      .prepare(
        "SELECT DISTINCT link_source FROM communications WHERE id IN (?, ?) ORDER BY link_source",
      )
      .all(viaCreate.id, viaReference.id) as Array<{ link_source: string | null }>;

    expect(stored.map((r) => r.link_source)).toEqual(["auto"]);
  });

  /**
   * The whole point of picking `'auto'` over `null` is that `'auto'` is inside
   * the column's declared domain. Proves the fixture's CHECK constraint is
   * live and would reject a value outside it — without which the assertions
   * above would pass against a column that accepts anything.
   */
  it("the fixture's CHECK constraint is live", () => {
    expect(() =>
      mockDb!
        .prepare(
          "INSERT INTO communications (id, user_id, email_id, link_source) VALUES (?, ?, ?, ?)",
        )
        .run("comm-bad", USER, EMAIL, "invented"),
    ).toThrow(/CHECK constraint failed/);
  });
});
