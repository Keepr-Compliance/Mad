/**
 * @jest-environment node
 *
 * BACKLOG-2759 — CLEARING A DATE OR A PRICE MUST REACH THE DATABASE.
 *
 * ===========================================================================
 * THE DEFECT
 * ===========================================================================
 * Six guards in `electron/utils/validation.ts` read
 * `!== undefined && !== null`. That shape collapses two OPPOSITE instructions
 * — "clear this column" (an explicit `null`) and "say nothing about this
 * column" (`undefined`) — into one, and drops the key before the writer can
 * tell them apart. `src/hooks/audit/useAuditSubmission.ts` sends
 * `closing_deadline` and `closed_at` as `|| null`, so this was live: blanking
 * a closing date left the OLD date on the row, and the handler returned
 * success. For a product whose audit window is computed from those dates, a
 * stale closing date is a wrong audit period.
 *
 * ===========================================================================
 * WHY THIS SUITE READS THE ROW BACK FROM THE DATABASE
 * ===========================================================================
 * `updateTransaction` returns nothing and logs success, and
 * `validateTransactionData` returns an object built in memory. A test that
 * asserts either can pass while the row is untouched — that is the whole trap
 * this defect class is made of. Every assertion below is a `SELECT` issued on
 * the test database. The validator-level tests live in
 * `electron/utils/__tests__/validation.test.ts`; they prove the KEY survives,
 * which is a different claim from the row being cleared.
 *
 * ===========================================================================
 * WHY THE FIXTURE IS A REAL MIGRATED DATABASE
 * ===========================================================================
 * The behaviour under test depends on column NULLability, on the writer's
 * `emptyToNull` handling and on the freeze policy reading `first_exported_at`.
 * A hand-written `CREATE TABLE` fixture would describe a schema the app does
 * not have, and the pre-fix control would then be proving a fiction. This
 * suite runs the app's own `runMigrations()` and asserts the chain reached its
 * head BEFORE any behavioural assertion, so a chain that stopped early cannot
 * make the suite vacuous. Same pattern as
 * `electron/services/db/__tests__/transactionWriter.detectionAndReview-2737-2558.test.ts`.
 *
 * ===========================================================================
 * WHY THE PRE-STATE IS SEEDED WITH RAW SQL
 * ===========================================================================
 * Every case needs a row that already HOLDS a value, so that "the clear did
 * nothing" and "the clear worked" are distinguishable. Producing that state
 * through the writer would make the assertion depend on the fix under test.
 *
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js \
 *     electron/__tests__/transactionNullClear-2759.test.ts
 *
 * Fixture values are invented and documentation-only.
 */

import { randomUUID } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import type { Database as DatabaseType } from "better-sqlite3";

jest.mock("electron", () => ({ app: { getPath: jest.fn(() => "/mock/user/data") } }));
jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  setUser: jest.fn(),
  addBreadcrumb: jest.fn(),
  flush: jest.fn().mockResolvedValue(true),
}));
jest.mock("../services/logService", () => {
  const m = {
    info: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
  };
  return { __esModule: true, default: m, logService: m };
});
jest.mock("../services/databaseEncryptionService", () => {
  const m = {
    initialize: jest.fn().mockResolvedValue(undefined),
    getEncryptionKey: jest.fn().mockResolvedValue("test-encryption-key-hex"),
    isDatabaseEncrypted: jest.fn().mockResolvedValue(false),
    getCachedKey: jest.fn(() => "test-encryption-key-hex"),
    getKeyMetadata: jest.fn().mockResolvedValue({}),
  };
  return { __esModule: true, default: m, databaseEncryptionService: m };
});
jest.mock("../services/contactsService", () => ({
  getContactNames: jest.fn(() => Promise.resolve([])),
}));
jest.mock("../workers/contactWorkerPool", () => ({
  queryContacts: jest.fn(),
  isPoolReady: jest.fn(() => false),
}));

import { setDb, setDbPath, setEncryptionKey } from "../services/db/core/dbConnection";
import { updateTransaction } from "../services/db/transactionDbService";
import { validateTransactionData } from "../utils/validation";
import { TransactionFrozenError } from "../services/transactionFreezePolicy";
import type { Transaction } from "../types";

// Bypass the jest moduleNameMapper that rewrites the driver to the auto-mock —
// the whole point of this file is a real file-backed database.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

const USER = "user-2759";
// Generated per run rather than written down — a literal UUID in a public repo
// is indistinguishable from a real record id (BACKLOG-2871).
const TX = randomUUID();

describe("clearing a transaction date or price reaches the row (BACKLOG-2759)", () => {
  jest.setTimeout(120000);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let service: any;
  let db: DatabaseType;
  let tmpDir: string;
  let dbFile: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-2759-null-clear-"));
    dbFile = path.join(tmpDir, "mad.db");

    db = new RealDatabase(dbFile) as DatabaseType;
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");

    // Deferred require so the jest.mock factories above are applied first.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    service = require("../services/databaseService").default;
    service.db = db;
    service.dbPath = dbFile;
    service.encryptionKey = "test-encryption-key-hex";
    setDb(db);
    setDbPath(dbFile);
    setEncryptionKey("test-encryption-key-hex");

    await service.runMigrations();
    db = service.db as DatabaseType;
    setDb(db);

    // `transactions.user_id` is a real FOREIGN KEY and `foreign_keys = ON` is
    // deliberate, so the owning row has to exist or every INSERT below fails
    // for a reason unrelated to the defect.
    db.prepare(
      "INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, ?, ?)",
    ).run(USER, "auditor@example.invalid", "google", "oauth-2759");
  });

  afterAll(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    service.db = null;
    setDb(null as never);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  /**
   * A row that already HOLDS every value under test, written with raw SQL so
   * the pre-state does not depend on the fix. `first_exported_at` decides
   * whether the freeze policy applies.
   */
  function seed(firstExportedAt: string | null = null): void {
    db.prepare("DELETE FROM transactions").run();
    db.prepare(
      `INSERT INTO transactions
         (id, user_id, property_address, status,
          started_at, closed_at, closing_deadline,
          sale_price, listing_price, closing_date_verified, first_exported_at)
       VALUES (?, ?, ?, 'active', '2026-01-02', '2026-03-14', '2026-03-01', 500000, 525000, 1, ?)`,
    ).run(TX, USER, "742 Invented Terrace, Springfield, IL 62704", firstExportedAt);
  }

  /** The row as the DATABASE has it. Never the writer's return value. */
  function row(): Record<string, unknown> {
    return db
      .prepare("SELECT * FROM transactions WHERE id = ?")
      .get(TX) as Record<string, unknown>;
  }

  /**
   * The real IPC path: validate, then write.
   *
   * The cast mirrors `transactionCrudHandlers.ts`, which passes the validator's
   * output as `validatedUpdates as unknown as Partial<UpdateTransaction>`. It
   * is needed for the same reason there: `Transaction` in `types/models.ts`
   * declares `closed_at`, `started_at`, `closing_deadline`, `sale_price`,
   * `listing_price` and `closing_date_verified` as non-nullable, so the write
   * path's own parameter type cannot express "clear this column" even though
   * every one of those columns is nullable in the schema and `writable` in
   * `TRANSACTION_COLUMN_POLICY`. That gap predates this change — PR #2326 made
   * `reviewed_at` and `rejection_reason` forward null without widening them
   * either — and closing it means widening the app's core row type, which is
   * not this item's file. Reproduced here rather than hidden so the next reader
   * sees the same shape the handler has.
   */
  async function submit(payload: Record<string, unknown>): Promise<void> {
    await updateTransaction(
      TX,
      validateTransactionData(payload, true) as unknown as Partial<Transaction>,
    );
  }

  // -------------------------------------------------------------------------
  // ANCHOR — every assertion below is meaningless if the chain did not run.
  // -------------------------------------------------------------------------
  it("migrated a real on-disk database to the head migration", () => {
    const head = service.constructor.MIGRATIONS.length
      ? service.constructor.MIGRATIONS[service.constructor.MIGRATIONS.length - 1]
          .version
      : service.constructor.BASELINE_VERSION;
    const version = (
      db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as {
        version: number;
      }
    ).version;

    expect(version).toBe(head);

    // ...and the handle is bound to THAT file, not to an empty in-memory one.
    expect(
      (db.prepare("PRAGMA database_list").all() as Array<{ file: string }>)[0].file,
    ).toBe(fs.realpathSync(dbFile));
  });

  describe("an explicit null clears the column", () => {
    it.each([
      ["closed_at", "closed_at"],
      ["closing_deadline", "closing_deadline"],
      ["started_at", "started_at"],
      ["sale_price", "sale_price"],
      ["listing_price", "listing_price"],
      ["closing_date_verified", "closing_date_verified"],
    ])("%s", async (_label, column) => {
      seed();
      expect(row()[column]).not.toBeNull(); // the pre-state is real

      await submit({ [column]: null });

      expect(row()[column]).toBeNull();
    });
  });

  describe("an empty string — what a blanked form field sends — also clears", () => {
    // The writer declares `emptyToNull: true` for the three date columns, but
    // MEASURED against a real database that rule fires on the INSERT path
    // only: forwarding `""` to the update path stored a literal empty string
    // in a DATETIME column, which is not NULL and still reads as "a date is
    // set". So the clear is resolved in the validator instead.
    it.each(["closed_at", "closing_deadline", "started_at"])(
      "%s",
      async (column) => {
        seed();
        expect(row()[column]).not.toBeNull();

        await submit({ [column]: "" });

        expect(row()[column]).toBeNull();
      },
    );

    it.each(["sale_price", "listing_price"])(
      "%s clears rather than writing a real 0",
      async (column) => {
        // Latent before the fix — no renderer writes either price — but
        // `Number("") === 0` meant a cleared price landed as a genuine $0
        // rather than as no value at all.
        seed();

        await submit({ [column]: "" });

        expect(row()[column]).toBeNull();
      },
    );
  });

  it("leaves a column alone when the payload does not mention it", () => {
    // The other half of the distinction. If `undefined` stopped meaning "no
    // instruction", this fix would start nulling live data.
    seed();

    return submit({ status: "closed" }).then(() => {
      const after = row();
      expect(after.closed_at).toBe("2026-03-14");
      expect(after.closing_deadline).toBe("2026-03-01");
      expect(after.sale_price).toBe(500000);
      expect(after.status).toBe("closed");
    });
  });

  describe("started_at is a frozen identity field, so the refusal is the freeze policy's", () => {
    it("clears normally while the transaction has never been exported", async () => {
      seed(null);

      await submit({ started_at: null });

      expect(row().started_at).toBeNull();
    });

    it("refuses the clear once the transaction has been exported, and says so", async () => {
      // The right answer to "should a frozen field be clearable" is a
      // REFUSAL, not a silent strip that reports success. The refusal belongs
      // to the freeze layer, which already exists — the validator's job is
      // only to stop swallowing the instruction before it gets there.
      seed("2026-04-01T00:00:00.000Z");

      // The error TYPE is asserted, not merely that something threw. A bare
      // `rejects.toThrow()` passes on any rejection with the row untouched —
      // a SQL error, a binding error, a mock blowing up — so it could not tell
      // "the freeze policy refused" from "the write broke", which is the only
      // thing this case is about.
      await expect(submit({ started_at: null })).rejects.toBeInstanceOf(
        TransactionFrozenError,
      );

      expect(row().started_at).toBe("2026-01-02");
    });
  });
});
