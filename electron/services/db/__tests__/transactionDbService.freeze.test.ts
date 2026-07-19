/**
 * @jest-environment node
 */

/**
 * BACKLOG-2013 — db-layer enforcement of the export freeze inside
 * transactionDbService.updateTransaction.
 *
 * The db layer is the real guarantee (UI disabling is a courtesy), so these
 * tests exercise the guard directly with a mocked connection.
 */

import { jest } from "@jest/globals";
import { TransactionFrozenError } from "../../transactionFreezePolicy";

const mockDbGet = jest.fn();
const mockDbRun = jest.fn();
const mockDbAll = jest.fn();

jest.mock("../core/dbConnection", () => ({
  dbGet: (...args: unknown[]) => mockDbGet(...args),
  dbRun: (...args: unknown[]) => mockDbRun(...args),
  dbAll: (...args: unknown[]) => mockDbAll(...args),
}));

import {
  updateTransaction,
  stampFirstExportedAt,
  UNFREEZE_OVERRIDE_KEY,
} from "../transactionDbService";

describe("updateTransaction — export freeze (BACKLOG-2013)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDbRun.mockReturnValue({ changes: 1 });
  });

  describe("BEFORE first export (not frozen)", () => {
    it("allows editing identity fields when first_exported_at is null", async () => {
      mockDbGet.mockReturnValue({ first_exported_at: null });

      await updateTransaction("txn-1", {
        property_address: "123 New St",
      } as never);

      // The UPDATE ran and included the identity field.
      expect(mockDbRun).toHaveBeenCalledTimes(1);
      const [sql, values] = mockDbRun.mock.calls[0] as [string, unknown[]];
      expect(sql).toMatch(/UPDATE transactions SET property_address = \?/);
      expect(values).toEqual(["123 New St", "txn-1"]);
    });
  });

  describe("AFTER first export (frozen)", () => {
    it("BLOCKS editing a frozen identity field and does NOT write", async () => {
      mockDbGet.mockReturnValue({ first_exported_at: "2026-07-18T00:00:00.000Z" });

      await expect(
        updateTransaction("txn-1", { property_address: "swap" } as never),
      ).rejects.toBeInstanceOf(TransactionFrozenError);

      // No SQL UPDATE should have executed.
      expect(mockDbRun).not.toHaveBeenCalled();
    });

    it("reports the exact frozen fields attempted", async () => {
      mockDbGet.mockReturnValue({ first_exported_at: "2026-07-18T00:00:00.000Z" });

      await expect(
        updateTransaction("txn-1", {
          property_address: "swap",
          started_at: "2020-01-01",
        } as never),
      ).rejects.toMatchObject({
        code: "TRANSACTION_FROZEN",
        attemptedFields: expect.arrayContaining(["property_address", "started_at"]),
      });
    });

    it("ALLOWS non-identity (bookkeeping) edits without even reading the marker", async () => {
      // status / export_count are not identity fields → guard is skipped entirely,
      // so the freeze-marker SELECT is never issued.
      await updateTransaction("txn-1", {
        status: "closed",
        export_count: 2,
      } as never);

      expect(mockDbGet).not.toHaveBeenCalled();
      expect(mockDbRun).toHaveBeenCalledTimes(1);
    });

    it("ALLOWS a frozen-field write when the unfreeze override is present, and strips the sentinel from SQL", async () => {
      mockDbGet.mockReturnValue({ first_exported_at: "2026-07-18T00:00:00.000Z" });

      await updateTransaction("txn-1", {
        property_address: "corrected typo",
        [UNFREEZE_OVERRIDE_KEY]: true,
      } as never);

      expect(mockDbRun).toHaveBeenCalledTimes(1);
      const [sql, values] = mockDbRun.mock.calls[0] as [string, unknown[]];
      // Sentinel must never reach the SQL.
      expect(sql).not.toContain(UNFREEZE_OVERRIDE_KEY);
      expect(sql).toMatch(/property_address = \?/);
      expect(values).toEqual(["corrected typo", "txn-1"]);
    });
  });
});

describe("stampFirstExportedAt — write-once at the SQL layer (BACKLOG-2013)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("enforces write-once via `WHERE first_exported_at IS NULL` in the UPDATE", () => {
    mockDbRun.mockReturnValue({ changes: 1 });

    const stamped = stampFirstExportedAt("txn-1", "2026-07-18T00:00:00.000Z");

    expect(stamped).toBe(true);
    expect(mockDbRun).toHaveBeenCalledTimes(1);
    const [sql, values] = mockDbRun.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/UPDATE transactions SET first_exported_at = \?/);
    expect(sql).toMatch(/WHERE id = \? AND first_exported_at IS NULL/);
    expect(values).toEqual(["2026-07-18T00:00:00.000Z", "txn-1"]);
  });

  it("returns false when the row is already frozen (0 rows changed)", () => {
    // Already-frozen row: the guarded UPDATE matches nothing.
    mockDbRun.mockReturnValue({ changes: 0 });

    const stamped = stampFirstExportedAt("txn-1", "2026-07-18T00:00:00.000Z");

    expect(stamped).toBe(false);
    expect(mockDbRun).toHaveBeenCalledTimes(1);
  });
});
