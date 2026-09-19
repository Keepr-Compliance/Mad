/**
 * @jest-environment node
 *
 * BACKLOG-2960 wave 1 lane B round 3 — unlockCacheDbService AGAINST A REAL DATABASE,
 * and the paywall decision that reads it.
 *
 * ===========================================================================
 * WHY THIS FILE EXISTS BEFORE THE CONVERSION
 * ===========================================================================
 * The export seam turns every `electron/services/db/**` export promise-returning.
 * The failure mode of that conversion is not a crash. It is a caller that forgets
 * to `await` and then tests the returned `Promise` for truthiness — and a
 * `Promise` is ALWAYS truthy.
 *
 * For this module that inverts a security decision. `entitlementService`
 * resolves the per-transaction paywall with
 *
 *     const cached = getCachedUnlock(localTransactionId, userId);
 *     if (cached) return { status: "unlocked", fromCache: true };
 *
 * A cache MISS must resolve LOCKED — that is the fail-closed contract stated at
 * the top of both this module and `entitlementService`. Un-awaited, a MISS
 * returns `Promise { null }`, `if (cached)` is TRUE, and the paywall opens on
 * exactly the input that must close it. Nothing throws and nothing logs.
 *
 * SR `6683f005` §4-B3 measured this module as a BLIND SPOT. Re-derived here by
 * execution at base `116601c1b`: eight test files reach the two production
 * files, and NOT ONE of them opens the real driver —
 * `entitlementService.test.ts:60` `jest.mock`s this module itself, `exportGate`
 * and `paymentService` mock `entitlementService`, and the remaining four mock
 * `dbConnection`/`databaseService`. The inversion above would have been
 * invisible to every one of them.
 *
 * So this file is committed FIRST, green against the UNCONVERTED synchronous
 * code, and the conversion lands on top of it.
 *
 * ===========================================================================
 * WHY THE `await`s ARE ALREADY HERE, IN THE PRE-CONVERSION COMMIT
 * ===========================================================================
 * `await` on a non-thenable is a no-op that yields the value unchanged, so every
 * `await` below is inert against the synchronous code and load-bearing against
 * the converted code. That is deliberate: **this file is byte-identical in the
 * test-first commit and in the conversion commit.** Nothing here was adjusted to
 * fit the new signatures, so "green before, green after" is a statement about the
 * conversion rather than about the test.
 *
 * ===========================================================================
 * WHAT IS ASSERTED, AND AGAINST WHAT
 * ===========================================================================
 * Block A reads the table with the RAW driver — never through the module under
 * test — and asserts the exact KEY SET of surviving rows, never a count.
 * Block B drives `entitlementService.getUnlockStatus` end to end over the same
 * real database, so each fail-closed branch is proved by the value the caller
 * actually returns.
 *
 * Fixtures are invented identities. No real contact data — this repository is
 * public. The schema comes through the app's own migration entry point and is
 * anchored before anything else is asserted, so a migration chain that stopped
 * early cannot let this file "prove" that real columns are phantoms.
 */

import fs from "fs";
import os from "os";
import path from "path";
import type { Database as DatabaseType } from "better-sqlite3";

jest.mock("electron", () => ({
  app: { getPath: jest.fn(() => "/mock/user/data") },
  net: { isOnline: jest.fn(() => true) },
}));
jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  setUser: jest.fn(),
  addBreadcrumb: jest.fn(),
  flush: jest.fn().mockResolvedValue(true),
}));
jest.mock("../../logService", () => {
  const m = {
    info: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
  };
  return { __esModule: true, default: m, logService: m };
});
jest.mock("../../databaseEncryptionService", () => {
  const m = {
    initialize: jest.fn().mockResolvedValue(undefined),
    getEncryptionKey: jest.fn().mockResolvedValue("test-encryption-key-hex"),
    isDatabaseEncrypted: jest.fn().mockResolvedValue(false),
    getCachedKey: jest.fn(() => "test-encryption-key-hex"),
    getKeyMetadata: jest.fn().mockResolvedValue({}),
  };
  return { __esModule: true, default: m, databaseEncryptionService: m };
});
jest.mock("../../contactsService", () => ({
  getContactNames: jest.fn(() => Promise.resolve([])),
}));
jest.mock("../../../workers/contactWorkerPool", () => ({
  queryContacts: jest.fn(),
  isPoolReady: jest.fn(() => false),
}));

// Chainable Supabase builder, same shape as `entitlementService.test.ts` uses:
// from().select().eq().eq().is().limit().maybeSingle(). Only the SERVER read is
// simulated — the cache side of every assertion below is the real SQLite table.
const mockMaybeSingle = jest.fn();
const mockGetSession = jest.fn();
const mockGetAuthSession = jest.fn();
const mockFrom = jest.fn(() => {
  const qb: Record<string, unknown> = {};
  for (const m of ["select", "eq", "is", "limit"]) qb[m] = jest.fn(() => qb);
  qb.maybeSingle = mockMaybeSingle;
  return qb;
});
jest.mock("../../supabaseService", () => ({
  __esModule: true,
  default: {
    getClient: () => ({
      from: mockFrom,
      rpc: jest.fn(),
      auth: { getSession: mockGetSession },
    }),
    getAuthSession: mockGetAuthSession,
  },
}));

import { net } from "electron";
import { setDb, setDbPath, setEncryptionKey } from "../core/dbConnection";
import {
  getCachedUnlock,
  upsertUnlock,
  removeCachedUnlock,
  clearUnlockCache,
} from "../unlockCacheDbService";
import entitlementService from "../../entitlementService";

// Bypass the Jest moduleNameMapper that rewrites the sqlite driver to the
// auto-mock — the whole point of this file is a real file-backed database.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

// Invented identities only. No real contact data in fixtures.
const TX_ALPHA = "2960-tx-alder-mill-road";
const TX_BRAVO = "2960-tx-brackenridge-lane";
const USER_ONE = "2960-user-imogen-fairweather";
const USER_TWO = "2960-user-tobias-lindqvist";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyService = any;

describe("BACKLOG-2960 — unlockCacheDbService and the paywall it decides, against real rows", () => {
  jest.setTimeout(120000);

  let service: AnyService;
  let db: DatabaseType;
  let tmpDir: string;
  let dbFile: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-2960-unlock-"));
    dbFile = path.join(tmpDir, "mad.db");

    db = new RealDatabase(dbFile) as DatabaseType;
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    service = require("../../databaseService").default;
    service.db = db;
    service.dbPath = dbFile;
    service.encryptionKey = "test-encryption-key-hex";
    setDb(db);
    setDbPath(dbFile);
    setEncryptionKey("test-encryption-key-hex");

    await service.runMigrations();
    db = service.db as DatabaseType;
    setDb(db);
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

  beforeEach(() => {
    jest.clearAllMocks();
    db.prepare("DELETE FROM transaction_unlocks_cache").run();
    (net.isOnline as jest.Mock).mockReturnValue(true);
    mockGetAuthSession.mockResolvedValue({ userId: USER_ONE });
    mockGetSession.mockResolvedValue({
      data: { session: { user: { id: USER_ONE } } },
    });
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });
  });

  /**
   * The surviving rows' KEY SET, read with the raw driver. A set, never a count:
   * a count cannot tell "deleted the right row" from "deleted a different one".
   */
  const cacheKeys = (): string[] =>
    (
      db
        .prepare(
          "SELECT local_transaction_id, user_id FROM transaction_unlocks_cache",
        )
        .all() as { local_transaction_id: string; user_id: string }[]
    )
      .map((r) => `${r.local_transaction_id}::${r.user_id}`)
      .sort();

  /** One stored row, read with the raw driver — never through the module under test. */
  const storedRow = (
    tx: string,
    user: string,
  ): Record<string, unknown> | undefined =>
    db
      .prepare(
        "SELECT * FROM transaction_unlocks_cache WHERE local_transaction_id = ? AND user_id = ?",
      )
      .get(tx, user) as Record<string, unknown> | undefined;

  // ───────────────────────────────────────────────────────────────────────
  // SCHEMA ANCHOR
  // ───────────────────────────────────────────────────────────────────────
  describe("schema anchor — the migration chain actually built this table", () => {
    it("transaction_unlocks_cache exists with the five columns the module reads and writes", () => {
      const cols = (
        db.prepare("PRAGMA table_info(transaction_unlocks_cache)").all() as {
          name: string;
        }[]
      )
        .map((c) => c.name)
        .sort();
      expect(cols).toEqual([
        "cached_at",
        "funding_source",
        "local_transaction_id",
        "unlocked_at",
        "user_id",
      ]);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // BLOCK A — the four exports against the real table
  // ───────────────────────────────────────────────────────────────────────
  describe("A · the four exports, against what SQLite actually holds", () => {
    it("getCachedUnlock on an empty table resolves NULL — the value the paywall reads as LOCKED", async () => {
      const row = await getCachedUnlock(TX_ALPHA, USER_ONE);
      // `toBeNull` and not `toBeFalsy`: an un-awaited Promise is truthy AND
      // non-null, so a weaker matcher here would pass on the defect.
      expect(row).toBeNull();
      expect(cacheKeys()).toEqual([]);
    });

    it("upsertUnlock writes the exact values the raw driver reads back", async () => {
      await upsertUnlock({
        localTransactionId: TX_ALPHA,
        userId: USER_ONE,
        unlockedAt: "2026-03-04T09:15:00Z",
        fundingSource: "credit",
      });

      const raw = storedRow(TX_ALPHA, USER_ONE);
      expect(raw).toBeDefined();
      expect(raw?.local_transaction_id).toBe(TX_ALPHA);
      expect(raw?.user_id).toBe(USER_ONE);
      expect(raw?.unlocked_at).toBe("2026-03-04T09:15:00Z");
      expect(raw?.funding_source).toBe("credit");
      expect(typeof raw?.cached_at).toBe("string");
      expect(String(raw?.cached_at).length).toBeGreaterThan(0);

      const readBack = await getCachedUnlock(TX_ALPHA, USER_ONE);
      expect(readBack).toEqual({
        local_transaction_id: TX_ALPHA,
        user_id: USER_ONE,
        unlocked_at: "2026-03-04T09:15:00Z",
        funding_source: "credit",
        cached_at: raw?.cached_at,
      });
    });

    it("upsertUnlock with no fundingSource stores SQL NULL, not the string 'undefined'", async () => {
      await upsertUnlock({
        localTransactionId: TX_ALPHA,
        userId: USER_ONE,
        unlockedAt: "2026-03-04T09:15:00Z",
      });
      expect(storedRow(TX_ALPHA, USER_ONE)?.funding_source).toBeNull();
      expect((await getCachedUnlock(TX_ALPHA, USER_ONE))?.funding_source).toBeNull();
    });

    it("a second upsert on the same (transaction, user) UPDATES in place — the key set does not grow", async () => {
      await upsertUnlock({
        localTransactionId: TX_ALPHA,
        userId: USER_ONE,
        unlockedAt: "2026-03-04T09:15:00Z",
        fundingSource: "credit",
      });
      await upsertUnlock({
        localTransactionId: TX_ALPHA,
        userId: USER_ONE,
        unlockedAt: "2026-05-19T17:40:00Z",
        fundingSource: "grant",
      });

      expect(cacheKeys()).toEqual([`${TX_ALPHA}::${USER_ONE}`]);
      const raw = storedRow(TX_ALPHA, USER_ONE);
      expect(raw?.unlocked_at).toBe("2026-05-19T17:40:00Z");
      expect(raw?.funding_source).toBe("grant");
    });

    it("rows are keyed by (transaction, user) — one account's unlock never reads as another's", async () => {
      await upsertUnlock({
        localTransactionId: TX_ALPHA,
        userId: USER_ONE,
        unlockedAt: "2026-03-04T09:15:00Z",
        fundingSource: "credit",
      });

      // Same transaction, a DIFFERENT user on a shared device.
      expect(await getCachedUnlock(TX_ALPHA, USER_TWO)).toBeNull();
      // Same user, a DIFFERENT transaction.
      expect(await getCachedUnlock(TX_BRAVO, USER_ONE)).toBeNull();
      // The owner still reads their own row.
      expect((await getCachedUnlock(TX_ALPHA, USER_ONE))?.user_id).toBe(USER_ONE);
    });

    it("removeCachedUnlock deletes exactly the one pair — the surviving key SET is named in full", async () => {
      for (const [tx, user] of [
        [TX_ALPHA, USER_ONE],
        [TX_ALPHA, USER_TWO],
        [TX_BRAVO, USER_ONE],
      ] as const) {
        await upsertUnlock({
          localTransactionId: tx,
          userId: user,
          unlockedAt: "2026-03-04T09:15:00Z",
          fundingSource: null,
        });
      }
      expect(cacheKeys()).toEqual(
        [
          `${TX_ALPHA}::${USER_ONE}`,
          `${TX_ALPHA}::${USER_TWO}`,
          `${TX_BRAVO}::${USER_ONE}`,
        ].sort(),
      );

      await removeCachedUnlock(TX_ALPHA, USER_ONE);

      expect(cacheKeys()).toEqual(
        [`${TX_ALPHA}::${USER_TWO}`, `${TX_BRAVO}::${USER_ONE}`].sort(),
      );
      expect(await getCachedUnlock(TX_ALPHA, USER_ONE)).toBeNull();
      expect(await getCachedUnlock(TX_ALPHA, USER_TWO)).not.toBeNull();
    });

    it("clearUnlockCache empties the table for EVERY user (the logout path)", async () => {
      await upsertUnlock({
        localTransactionId: TX_ALPHA,
        userId: USER_ONE,
        unlockedAt: "2026-03-04T09:15:00Z",
        fundingSource: null,
      });
      await upsertUnlock({
        localTransactionId: TX_BRAVO,
        userId: USER_TWO,
        unlockedAt: "2026-03-04T09:15:00Z",
        fundingSource: null,
      });
      expect(cacheKeys()).toHaveLength(2);

      await clearUnlockCache();

      expect(cacheKeys()).toEqual([]);
      expect(await getCachedUnlock(TX_ALPHA, USER_ONE)).toBeNull();
      expect(await getCachedUnlock(TX_BRAVO, USER_TWO)).toBeNull();
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // BLOCK B — the fail-closed contract, end to end, over the same real table
  // ───────────────────────────────────────────────────────────────────────
  describe("B · entitlementService.getUnlockStatus over the REAL cache — fail-closed", () => {
    it("OFFLINE + empty cache ⇒ LOCKED (offline_uncached). A cache MISS NEVER unlocks", async () => {
      (net.isOnline as jest.Mock).mockReturnValue(false);

      const r = await entitlementService.getUnlockStatus(TX_ALPHA);

      expect(r.status).toBe("locked");
      expect(r.lockReason).toBe("offline_uncached");
      expect(r.fromCache).toBe(false);
      // The server must not be consulted at all while offline.
      expect(mockFrom).not.toHaveBeenCalled();
    });

    it("OFFLINE + a real cached row ⇒ UNLOCKED from the cache", async () => {
      await upsertUnlock({
        localTransactionId: TX_ALPHA,
        userId: USER_ONE,
        unlockedAt: "2026-03-04T09:15:00Z",
        fundingSource: "credit",
      });
      (net.isOnline as jest.Mock).mockReturnValue(false);

      const r = await entitlementService.getUnlockStatus(TX_ALPHA);

      expect(r.status).toBe("unlocked");
      expect(r.fromCache).toBe(true);
    });

    it("OFFLINE + a cached row belonging to ANOTHER user ⇒ still LOCKED", async () => {
      await upsertUnlock({
        localTransactionId: TX_ALPHA,
        userId: USER_TWO,
        unlockedAt: "2026-03-04T09:15:00Z",
        fundingSource: "credit",
      });
      (net.isOnline as jest.Mock).mockReturnValue(false);

      const r = await entitlementService.getUnlockStatus(TX_ALPHA);

      expect(r.status).toBe("locked");
      expect(r.lockReason).toBe("offline_uncached");
    });

    it("ONLINE + the server read FAILS + empty cache ⇒ LOCKED (error), never unlocked", async () => {
      mockMaybeSingle.mockResolvedValue({
        data: null,
        error: { message: "network down", code: "PGRST000" },
      });

      const r = await entitlementService.getUnlockStatus(TX_ALPHA);

      expect(r.status).toBe("locked");
      expect(r.lockReason).toBe("error");
      expect(r.fromCache).toBe(false);
    });

    it("ONLINE + the server read FAILS + a real prior cached row ⇒ UNLOCKED from the cache", async () => {
      await upsertUnlock({
        localTransactionId: TX_ALPHA,
        userId: USER_ONE,
        unlockedAt: "2026-03-04T09:15:00Z",
        fundingSource: "credit",
      });
      mockMaybeSingle.mockResolvedValue({
        data: null,
        error: { message: "network down", code: "PGRST000" },
      });

      const r = await entitlementService.getUnlockStatus(TX_ALPHA);

      expect(r.status).toBe("unlocked");
      expect(r.fromCache).toBe(true);
    });

    it("ONLINE + the server CONFIRMS an unlock ⇒ UNLOCKED, and the row is mirrored into the real table", async () => {
      mockMaybeSingle.mockResolvedValue({
        data: {
          unlocked_at: "2026-06-21T11:02:00Z",
          funding_source: "grant",
          refunded_at: null,
        },
        error: null,
      });

      const r = await entitlementService.getUnlockStatus(TX_ALPHA);

      expect(r.status).toBe("unlocked");
      expect(r.fromCache).toBe(false);
      // The mirror is asserted in SQLite, not on a mock call.
      expect(cacheKeys()).toEqual([`${TX_ALPHA}::${USER_ONE}`]);
      const raw = storedRow(TX_ALPHA, USER_ONE);
      expect(raw?.unlocked_at).toBe("2026-06-21T11:02:00Z");
      expect(raw?.funding_source).toBe("grant");
    });

    it("ONLINE + the server says NO unlock ⇒ LOCKED, and the stale mirror is purged from the real table", async () => {
      await upsertUnlock({
        localTransactionId: TX_ALPHA,
        userId: USER_ONE,
        unlockedAt: "2026-03-04T09:15:00Z",
        fundingSource: "credit",
      });
      // A second user's row must SURVIVE the purge.
      await upsertUnlock({
        localTransactionId: TX_ALPHA,
        userId: USER_TWO,
        unlockedAt: "2026-03-04T09:15:00Z",
        fundingSource: "credit",
      });
      mockMaybeSingle.mockResolvedValue({ data: null, error: null });

      const r = await entitlementService.getUnlockStatus(TX_ALPHA);

      expect(r.status).toBe("locked");
      expect(r.lockReason).toBe("no_unlock");
      expect(cacheKeys()).toEqual([`${TX_ALPHA}::${USER_TWO}`]);
    });

    it("no auth session ⇒ LOCKED (not_authenticated), and the cache is never consulted", async () => {
      await upsertUnlock({
        localTransactionId: TX_ALPHA,
        userId: USER_ONE,
        unlockedAt: "2026-03-04T09:15:00Z",
        fundingSource: "credit",
      });
      mockGetAuthSession.mockResolvedValue(null);

      const r = await entitlementService.getUnlockStatus(TX_ALPHA);

      expect(r.status).toBe("locked");
      expect(r.lockReason).toBe("not_authenticated");
      // The cached row is still there — it was never read, and never grants.
      expect(cacheKeys()).toEqual([`${TX_ALPHA}::${USER_ONE}`]);
    });
  });
});
