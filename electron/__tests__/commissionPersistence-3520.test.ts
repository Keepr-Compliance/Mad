/**
 * @jest-environment node
 *
 * BACKLOG-3520 — THE FOUR COMMISSION FIGURES MUST BE STORED, NOT MERELY ACCEPTED.
 *
 * Two independent gates sit between the renderer and the `transactions` row:
 *   GATE 1  `TransactionField` / `validateTransactionData` (utils/validation.ts)
 *           — a key the validator does not forward never reaches the writer.
 *   GATE 2  `TRANSACTION_COLUMN_POLICY.update` (db/transactionDbService.ts)
 *           — a column whose policy is not "writable" is DROPPED WITHOUT AN
 *           ERROR while other columns in the same payload still succeed.
 * Gate 2 is the dangerous one: the save call reports success, the UI looks
 * fine, and the row is untouched. So every assertion here is a SELECT on the
 * test database, never the validator's return value and never a success flag.
 *
 * Each gate has its OWN control (see "GATE 1" / "GATE 2" blocks) and each was
 * proven by reverting only that gate.
 *
 * The write path reproduced is the handler's own (transactionCrudHandlers.ts,
 * "transactions:update"): sanitizeObject -> validateTransactionData(_, true)
 * -> updateTransaction. The handler itself is not invoked: it also needs the
 * audit and background-sync services, which are irrelevant to persistence.
 *
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js \
 *     electron/__tests__/commissionPersistence-3520.test.ts
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
import { validateTransactionData, sanitizeObject, ValidationError } from "../utils/validation";
import type { Transaction } from "../types";

// Bypass the jest moduleNameMapper that rewrites the driver to the auto-mock —
// the whole point of this file is a real file-backed database.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

const USER = "user-3520";
// Generated per run rather than written down — a literal UUID in a public repo
// is indistinguishable from a real record id (BACKLOG-2871).
const TX = randomUUID();

describe("commission figures persist through the IPC write path (BACKLOG-3520)", () => {
  jest.setTimeout(120000);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let service: any;
  let db: DatabaseType;
  let tmpDir: string;
  let dbFile: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-3520-commission-"));
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
    ).run(USER, "auditor@example.invalid", "google", "oauth-3520");
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
   * A row with NO commission figures yet, raw SQL so the pre-state does not
   * depend on the code under test.
   */
  function seed(): void {
    db.prepare("DELETE FROM transactions").run();
    db.prepare(
      `INSERT INTO transactions
         (id, user_id, property_address, status, started_at, closed_at, sale_price, closing_date_verified)
       VALUES (?, ?, ?, 'active', '2026-01-02', '2026-03-14', 412500, 0)`,
    ).run(TX, USER, "742 Invented Terrace, Springfield, IL 62704");
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
      validateTransactionData(sanitizeObject(payload), true) as unknown as Partial<Transaction>,
    );
  }

  it("migrated a real on-disk database to the head migration", () => {
    const head = service.constructor.MIGRATIONS[service.constructor.MIGRATIONS.length - 1].version;
    const version = (
      db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as { version: number }
    ).version;
    expect(version).toBe(head);
    const cols = (db.prepare("PRAGMA table_info(transactions)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining([
      "commission_offered_rate", "commission_actual_rate", "commission_gross_amount", "commission_adjustment_reason",
    ]));
  });

  const FIGURES = {
    commission_offered_rate: 2.5,
    commission_actual_rate: 2.375,
    commission_gross_amount: 9796.88,
    commission_adjustment_reason: "Reduced to close the deal",
  };

  // GATE 2 control (the policy). The validator forwards the keys; only the
  // writer's policy decides whether they land. Also GATE 1 control: with the
  // validator not admitting them they never reach the writer at all.
  describe("the four figures land in the row (GATE 1 + GATE 2)", () => {
    it("stores all four, exactly", async () => {
      seed();
      await submit({ ...FIGURES, closing_date_verified: 1 });
      const r = row();
      expect(r.commission_offered_rate).toBe(2.5);
      expect(r.commission_actual_rate).toBe(2.375);
      expect(r.commission_gross_amount).toBe(9796.88);
      expect(r.commission_adjustment_reason).toBe("Reduced to close the deal");
      // the rest of the payload landed too, so a partial drop is visible
      expect(r.closing_date_verified).toBe(1);
    });

    it.each(Object.keys(FIGURES))("%s alone is stored (a per-column drop cannot hide behind the others)", async (col) => {
      seed();
      await submit({ [col]: (FIGURES as Record<string, unknown>)[col], closing_date_verified: 1 });
      expect(row()[col]).toBe((FIGURES as Record<string, unknown>)[col]);
    });

    it("stores an exact-zero rate as 0, not as NULL (a legal referral rebate)", async () => {
      seed();
      await submit({ commission_offered_rate: 3, commission_actual_rate: 0, commission_gross_amount: 0 });
      const r = row();
      expect(r.commission_actual_rate).toBe(0);
      expect(r.commission_gross_amount).toBe(0);
    });

    it("an explicit null clears each figure (the agent blanked the field)", async () => {
      seed();
      await submit(FIGURES);
      await submit({
        commission_offered_rate: null, commission_actual_rate: null,
        commission_gross_amount: null, commission_adjustment_reason: null,
      });
      const r = row();
      expect(r.commission_offered_rate).toBeNull();
      expect(r.commission_actual_rate).toBeNull();
      expect(r.commission_gross_amount).toBeNull();
      expect(r.commission_adjustment_reason).toBeNull();
    });

    it("an omitted key leaves the stored figure alone", async () => {
      seed();
      await submit(FIGURES);
      await submit({ closing_date_verified: 1 });
      expect(row().commission_actual_rate).toBe(2.375);
    });
  });

  describe("value rules at the boundary (GATE 1's per-field branches)", () => {
    it.each([
      [-0.001], [100.001], [Number.NaN], ["abc"],
    ])("rejects an offered/actual rate of %p", async (bad) => {
      seed();
      await expect(submit({ commission_offered_rate: bad })).rejects.toBeInstanceOf(ValidationError);
      await expect(submit({ commission_actual_rate: bad })).rejects.toBeInstanceOf(ValidationError);
      expect(row().commission_offered_rate).toBeNull();
    });

    it.each([[0], [100], [0.001], [99.999]])("accepts a rate of %p", async (ok) => {
      seed();
      await submit({ commission_actual_rate: ok });
      expect(row().commission_actual_rate).toBe(ok);
    });

    it("rounds a rate to the column's 3 decimals (numeric(6,3) in the cloud)", async () => {
      seed();
      await submit({ commission_actual_rate: 2.3754 });
      expect(row().commission_actual_rate).toBe(2.375);
    });

    it.each([
      [10312.5, 10312.5],
      [10312.504, 10312.5],
      [10312.505, 10312.51],
      [1.005, 1.01],
      [0, 0],
    ])("rounds gross %p to cents -> %p", async (input, stored) => {
      seed();
      await submit({ commission_gross_amount: input });
      expect(row().commission_gross_amount).toBe(stored);
    });

    it.each([[-0.01], [Number.NaN], [1e10]])("rejects a gross amount of %p", async (bad) => {
      seed();
      await expect(submit({ commission_gross_amount: bad })).rejects.toBeInstanceOf(ValidationError);
    });

    it("trims the reason, stores whitespace-only as NULL, and bounds it at 2000", async () => {
      seed();
      await submit({ commission_adjustment_reason: "  Reduced  " });
      expect(row().commission_adjustment_reason).toBe("Reduced");
      await submit({ commission_adjustment_reason: "   " });
      expect(row().commission_adjustment_reason).toBeNull();
      await submit({ commission_adjustment_reason: "x".repeat(2000) });
      expect((row().commission_adjustment_reason as string).length).toBe(2000);
      await expect(submit({ commission_adjustment_reason: "x".repeat(2001) })).rejects.toBeInstanceOf(ValidationError);
    });

    it("rejects a non-string reason", async () => {
      seed();
      await expect(submit({ commission_adjustment_reason: 5 })).rejects.toBeInstanceOf(ValidationError);
    });
  });
});
