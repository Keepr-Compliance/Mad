/**
 * @jest-environment node
 *
 * BACKLOG-2538 — CREATING A DEAL AND ATTACHING ITS PARTIES ARE ONE ATOMIC WRITE.
 *
 * ===========================================================================
 * THE DEFECT
 * ===========================================================================
 * Creating a deal was one INSERT into `transactions`, followed by N awaited
 * calls to `assignContactToTransaction`, with nothing wrapping them.
 *
 * `better-sqlite3` is synchronous, so every statement outside a transaction
 * commits before the next line runs. A throw after the third of five parties
 * therefore left a deal that EXISTED, carried three of the five people entered,
 * and marked nothing. **It read as complete.** Ranked third by damage in the
 * write-path audit that produced BACKLOG-2496.
 *
 * ===========================================================================
 * WHY THE FIX NEEDED SYNC CORES, AND WHERE THAT IS ASSERTED
 * ===========================================================================
 * `dbTransaction` takes a SYNCHRONOUS callback, so the composition needs
 * callees that are synchronous all the way down: `createTransactionSync` and
 * `assignContactToTransactionSync`, exactly as BACKLOG-2496 needed
 * `updateContactSync`.
 *
 * The two `describe`s below carry the whole of that argument as assertions
 * rather than as prose — the first over the shipped composition, the second
 * over a callee shape deliberately made wrong. Nothing about callback shape is
 * claimed here that is not asserted there.
 *
 * ===========================================================================
 * WHAT THIS SUITE ASSERTS, AND WHY IT IS SHAPED THIS WAY
 * ===========================================================================
 * A test that creates a deal successfully and checks the result PASSES WHETHER
 * OR NOT A TRANSACTION EXISTS. It cannot separate the fixed code from the
 * broken code. The case that separates them is a FORCED FAILURE partway
 * through, which is what the "forced crash" describes do.
 *
 * The crash is forced with a SQLite trigger that aborts one party's INSERT —
 * a real failure of the real statement at the real point in the sequence, not
 * a mock standing in for one.
 *
 * The assertion is the STRONG one the item asked for: **not "the parties are
 * missing" but "no deal exists at all"**. Identity sets are asserted exactly —
 * the precise surviving ids, never a count. A count cannot tell a correct row
 * from a wrong one.
 *
 * Rejection is asserted with try/catch and an exact-message match rather than
 * `.rejects.toThrow()` / `.toThrow()`. See BACKLOG-2539: two `expect` packages
 * coexist in this tree and the one jest actually runs cannot reliably observe
 * an error raised inside the native driver on CI. This form asserts BOTH that
 * it threw AND what it said, so it is stricter than what it replaces.
 *
 * ===========================================================================
 * ENGINES
 * ===========================================================================
 * `openTestDb` prefers the SHIPPING driver (`better-sqlite3-multiple-ciphers`)
 * and falls back to `node:sqlite`. Every assertion here is engine-agnostic.
 *
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --bail=0 \
 *     electron/services/db/__tests__/transactionDbService.atomicDealCreate-2538.test.ts
 *
 * Fixture values are reserved-for-documentation only. Names invented.
 */

import { openTestDb, currentEngine, type TestDb } from "../../__tests__/helpers/syncSqliteDriver";

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
  /**
   * ROUTED TO A REAL TRANSACTION, AND THAT IS THE POINT OF THIS FILE.
   *
   * A passthrough `(fn) => fn()` runs every statement and satisfies every
   * caller while silently removing the atomicity — it would make every
   * assertion below unfailable. BACKLOG-2537 converted eleven sibling suites
   * off exactly that shape.
   */
  dbTransaction: <T>(fn: () => T): T => mockDb!.transaction(fn)(),
  getDbPath: () => "/fake/path/mad.db",
  getEncryptionKey: () => "fake-key",
}));

jest.mock("../../logService", () => {
  const m = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { __esModule: true, default: m, logService: m };
});

import {
  createTransactionWithContactsSync,
  createTransactionSync,
} from "../transactionDbService";
import {
  assignContactToTransaction,
  assignContactToTransactionSync,
} from "../transactionContactDbService";
import { dbTransaction } from "../core/dbConnection";
import type { NewTransaction } from "../../../types";

const USER = "user-2538";

const SCHEMA = `
  CREATE TABLE contacts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    display_name TEXT,
    company TEXT,
    title TEXT,
    default_role TEXT,
    source TEXT,
    is_imported INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE transactions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    property_address TEXT,
    property_street TEXT,
    property_city TEXT,
    property_state TEXT,
    property_zip TEXT,
    property_coordinates TEXT,
    transaction_type TEXT,
    status TEXT,
    closing_deadline TEXT,
    started_at TEXT,
    closed_at TEXT,
    detection_status TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE transaction_contacts (
    id TEXT PRIMARY KEY,
    transaction_id TEXT NOT NULL,
    contact_id TEXT NOT NULL,
    role TEXT,
    role_category TEXT,
    specific_role TEXT,
    is_primary INTEGER DEFAULT 0,
    notes TEXT,
    removed_at DATETIME,
    removed_reason TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(transaction_id, contact_id)
  );
  CREATE TABLE communications (
    id TEXT PRIMARY KEY,
    transaction_id TEXT,
    email_id TEXT,
    -- BACKLOG-2865: the linked-email count reads this to decide which
    -- conversations the card counts.
    match_reason TEXT
  );
  -- BACKLOG-2865: getTransactionByIdSync (called by createTransactionSync to
  -- read the row back) now joins emails to scope the card's count to linked
  -- conversations. This table is present in every real database; leaving it out
  -- of this reduced schema described a state the app never has, and the read-back
  -- failed with "no such table: emails".
  CREATE TABLE emails (
    id TEXT PRIMARY KEY,
    thread_id TEXT,
    subject TEXT,
    sent_at TEXT
  );
`;

/** The five people entered on the deal, in the order the form sends them. */
const PARTIES = ["c-buyer", "c-seller", "c-lender", "c-escrow", "c-inspector"];

const DEAL: NewTransaction = {
  user_id: USER,
  property_address: "1 Example Way, Springfield",
  transaction_type: "purchase",
  status: "active",
} as NewTransaction;

function assignmentsFor(ids: string[]) {
  return ids.map((contact_id, i) => ({
    contact_id,
    role: `role-${i}`,
    role_category: "party",
    specific_role: `role-${i}`,
    is_primary: i === 0,
    notes: undefined,
  }));
}

/** Every deal id on disk, sorted. Exact set, never a count. */
function dealIds(): string[] {
  return (
    mockDb!.prepare("SELECT id FROM transactions ORDER BY id").all() as Array<{ id: string }>
  ).map((r) => r.id);
}

/** Every attached contact id on disk, sorted. Exact set, never a count. */
function attachedContactIds(): string[] {
  return (
    mockDb!
      .prepare("SELECT contact_id FROM transaction_contacts ORDER BY contact_id")
      .all() as Array<{ contact_id: string }>
  ).map((r) => r.contact_id);
}

/** Abort the INSERT for ONE party — a real statement failure, mid-sequence. */
function armCrashOn(contactId: string): void {
  mockDb!.exec(`
    CREATE TRIGGER crash_2538
    BEFORE INSERT ON transaction_contacts
    WHEN NEW.contact_id = '${contactId}'
    BEGIN
      SELECT RAISE(ABORT, 'forced crash attaching ${contactId}');
    END;
  `);
}

function disarmCrash(): void {
  mockDb!.exec("DROP TRIGGER IF EXISTS crash_2538;");
}

beforeEach(() => {
  mockDb = openTestDb();
  mockDb.exec(SCHEMA);
  for (const id of PARTIES) {
    mockDb
      .prepare("INSERT INTO contacts (id, user_id, display_name) VALUES (?, ?, ?)")
      .run(id, USER, `Party ${id}`);
  }
});

afterEach(() => {
  mockDb?.close();
  mockDb = null;
});

describe("creating a deal with its parties is ONE write (BACKLOG-2538)", () => {
  it(`runs on the ${currentEngine() ?? "detected"} engine`, () => {
    expect(["better-sqlite3", "node:sqlite"]).toContain(currentEngine());
  });

  it("attaches every party entered — the exact set, not a count", () => {
    const deal = createTransactionWithContactsSync(DEAL, assignmentsFor(PARTIES));

    expect(dealIds()).toEqual([deal.id]);
    expect(attachedContactIds()).toEqual([...PARTIES].sort());
  });

  describe("forced crash — the case that separates a transaction from no transaction", () => {
    it("attaching the THIRD of five fails, and NO DEAL SURVIVES", () => {
      armCrashOn("c-lender");

      let outcome = "NO THROW";
      try {
        createTransactionWithContactsSync(DEAL, assignmentsFor(PARTIES));
      } catch (e) {
        outcome = `THREW: ${(e as Error).message}`;
      }

      expect(outcome).toMatch(/^THREW: .*forced crash attaching c-lender/);

      // THE assertion this item is about. Not "the last two are missing" —
      // the deal itself must be gone, including the two parties that had
      // already been written before the abort.
      expect(dealIds()).toEqual([]);
      expect(attachedContactIds()).toEqual([]);
    });

    it("attaching the FIRST fails, and no deal survives either", () => {
      armCrashOn("c-buyer");

      let outcome = "NO THROW";
      try {
        createTransactionWithContactsSync(DEAL, assignmentsFor(PARTIES));
      } catch (e) {
        outcome = `THREW: ${(e as Error).message}`;
      }

      expect(outcome).toMatch(/^THREW: .*forced crash attaching c-buyer/);
      expect(dealIds()).toEqual([]);
      expect(attachedContactIds()).toEqual([]);
    });

    it("attaching the LAST fails, and the four already written are rolled back", () => {
      armCrashOn("c-inspector");

      let outcome = "NO THROW";
      try {
        createTransactionWithContactsSync(DEAL, assignmentsFor(PARTIES));
      } catch (e) {
        outcome = `THREW: ${(e as Error).message}`;
      }

      expect(outcome).toMatch(/^THREW: .*forced crash attaching c-inspector/);
      expect(dealIds()).toEqual([]);
      expect(attachedContactIds()).toEqual([]);
    });

    it("PRECONDITION: the trigger really does abort — without it the same call succeeds", () => {
      armCrashOn("c-lender");
      let threw = false;
      try {
        createTransactionWithContactsSync(DEAL, assignmentsFor(PARTIES));
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);

      // Same inputs, crash removed: the write lands in full. If this ever
      // fails, the describes above are proving something other than atomicity.
      disarmCrash();
      const deal = createTransactionWithContactsSync(DEAL, assignmentsFor(PARTIES));
      expect(dealIds()).toEqual([deal.id]);
      expect(attachedContactIds()).toEqual([...PARTIES].sort());
    });
  });

  describe("THE CALLEE'S SHAPE decides whether the transaction rolls back (BACKLOG-2960)", () => {
    /**
     * The two cases below are the same composition, the same forced crash and
     * the same assertion tuple. The ONLY difference is the shape of the callee
     * the transaction body reaches:
     *
     *   - `assignContactToTransaction`, the shipped seam facade — a PLAIN
     *     function that calls the sync core and wraps its VALUE;
     *   - `asyncShim`, a local `async` function over the IDENTICAL sync core,
     *     written here to be wrong on purpose. It is not production code and is
     *     not exported.
     *
     * Neither case reads production behaviour out of a docblock: each asserts
     * `{ threw, rejected, deals, attached }` in ONE `expect`, so a failure
     * prints all four facts together. Ids are asserted as sets, never counts —
     * except the deal's own uuid, which is generated.
     */
    async function outcomeOf(
      attach: (
        dealId: string,
        party: ReturnType<typeof assignmentsFor>[number],
      ) => unknown,
    ): Promise<{
      threw: string | null;
      rejected: string | null;
      deals: string[];
      attached: string[];
    }> {
      const parties = assignmentsFor(PARTIES);
      let deferred: Promise<unknown> | null = null;

      // The synchronous throw is captured by MESSAGE, not as a flag. A bare
      // boolean passes on ANY throw from the callee, including one that has
      // nothing to do with the armed crash — so it could not tell the rollback
      // it exists for from an unrelated failure on the same path. Read off the
      // value's own `.message` and asserted as a string, never handed to a
      // matcher as an Error (BACKLOG-3152).
      let threw: string | null = null;

      try {
        dbTransaction(() => {
          const deal = createTransactionSync(DEAL);
          deferred = Promise.all(parties.map((p) => attach(deal.id, p)));
          return deal;
        });
      } catch (e) {
        threw = (e as Error).message;
      }

      // Only the `async` arm reaches this with a pending rejection. Its message
      // is captured into the tuple rather than left pending, and read off the
      // value's own `.message` property rather than handed to a matcher
      // (BACKLOG-3152).
      let rejected: string | null = null;
      try {
        await deferred;
      } catch (e) {
        rejected = (e as Error).message;
      }

      return { threw, rejected, deals: dealIds(), attached: attachedContactIds() };
    }

    it("the PLAIN seam facade: its throw aborts the transaction — no deal, no parties", async () => {
      armCrashOn("c-lender");

      // Nothing is left pending: the throw happens before a promise exists, so
      // `rejected` is null rather than carrying the crash message.
      expect(await outcomeOf(assignContactToTransaction)).toEqual({
        threw: expect.stringMatching(/forced crash attaching c-lender/),
        rejected: null,
        deals: [],
        attached: [],
      });
    });

    it("an ASYNC callee over the same sync core: the transaction commits over the failure and the deal survives HALF-BUILT", async () => {
      armCrashOn("c-lender");

      const asyncShim = async (
        dealId: string,
        party: ReturnType<typeof assignmentsFor>[number],
      ) => assignContactToTransactionSync(dealId, party);

      // The transaction returned without seeing the failure; the crash message
      // arrives afterwards, and the four parties written before `c-lender`
      // survive on a deal that should not exist. The exact surviving set, not
      // a count.
      expect(await outcomeOf(asyncShim)).toEqual({
        threw: null,
        rejected: expect.stringMatching(/forced crash attaching c-lender/),
        deals: [expect.any(String)],
        attached: ["c-buyer", "c-escrow", "c-inspector", "c-seller"],
      });
    });
  });
});
