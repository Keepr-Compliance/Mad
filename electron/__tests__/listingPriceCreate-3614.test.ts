/**
 * @jest-environment node
 *
 * BACKLOG-3614 — AN OPTIONAL LISTING PRICE ENTERED WHEN CREATING A DEAL IS STORED.
 *
 * Three gates sit between step 1 of the create wizard and the `transactions` row:
 *   GATE 1  `validateTransactionData(_, false)` (utils/validation.ts) — the IPC
 *           accept-set for `transactions:create-audited`.
 *   GATE 2  `createAuditedTransaction` (transactionService.ts) — destructures the
 *           payload and passes named fields on; a key it does not name is lost.
 *   GATE 3  `TRANSACTION_COLUMN_POLICY.listing_price.insert`
 *           (db/transactionDbService.ts) — a column not "writable" on insert is
 *           dropped without an error.
 * Every assertion is a SELECT on a real migrated database, never a return value.
 *
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js \
 *     electron/__tests__/listingPriceCreate-3614.test.ts
 *
 * Fixture values are invented.
 */

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
import { validateTransactionData, sanitizeObject } from "../utils/validation";
import type { AuditedTransactionData } from "../services/transactionService/types";

// Bypass the jest moduleNameMapper that rewrites the driver to the auto-mock.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

const USER = "user-3614";

describe("listing price entered at create is stored (BACKLOG-3614)", () => {
  jest.setTimeout(120000);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let service: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let transactionService: any;
  let db: DatabaseType;
  let tmpDir: string;
  let dbFile: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-3614-listing-"));
    dbFile = path.join(tmpDir, "mad.db");

    db = new RealDatabase(dbFile) as DatabaseType;
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");

    // Deferred requires so the jest.mock factories above are applied first.
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

    db.prepare(
      "INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, ?, ?)",
    ).run(USER, "auditor@example.invalid", "google", "oauth-3614");

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("../services/transactionService");
    transactionService = mod.default ?? mod.transactionService ?? mod;
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
   * The handler's own create path (`transactions:create-audited`):
   * sanitizeObject -> validateTransactionData(_, false) -> createAuditedTransaction.
   * No contact assignments, so no auto-link runs.
   */
  async function create(extra: Record<string, unknown>): Promise<Record<string, unknown>> {
    const payload = {
      property_address: "742 Invented Terrace, Springfield, IL 62704",
      transaction_type: "purchase",
      started_at: "2026-06-29",
      ...extra,
    };
    const created = await transactionService.createAuditedTransaction(
      USER,
      validateTransactionData(sanitizeObject(payload), false) as unknown as AuditedTransactionData,
    );
    expect(created?.id).toEqual(expect.any(String));
    return db
      .prepare("SELECT * FROM transactions WHERE id = ?")
      .get(created.id) as Record<string, unknown>;
  }

  it("stores the listing price entered on step 1", async () => {
    const row = await create({ listing_price: 525000 });
    expect(row.listing_price).toBe(525000);
    // the rest of the payload landed too
    expect(row.property_address).toBe("742 Invented Terrace, Springfield, IL 62704");
    expect(row.closed_at).toBeNull();
  });

  it("stores cents exactly", async () => {
    const row = await create({ listing_price: 499999.5 });
    expect(row.listing_price).toBe(499999.5);
  });

  it("a blank listing price creates the deal with the column NULL", async () => {
    const row = await create({});
    expect(row.listing_price).toBeNull();
  });
});
