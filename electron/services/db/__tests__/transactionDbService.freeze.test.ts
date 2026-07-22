/**
 * @jest-environment node
 */

/**
 * BACKLOG-2013 / BACKLOG-2150 — db-layer enforcement of the export freeze
 * inside transactionDbService.updateTransaction.
 *
 * The db layer is the real guarantee (UI disabling is a courtesy), so these
 * tests exercise the guard directly with a mocked connection.
 *
 * BACKLOG-2150: only the identity ANCHORS freeze (property block, transaction
 * type, started_at). The end date (closed_at) is now editable after export.
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
      mockDbGet.mockReturnValue({
        first_exported_at: "2026-07-18T00:00:00.000Z",
        property_address: "123 Original St",
      });

      await expect(
        updateTransaction("txn-1", { property_address: "swap" } as never),
      ).rejects.toBeInstanceOf(TransactionFrozenError);

      // No SQL UPDATE should have executed.
      expect(mockDbRun).not.toHaveBeenCalled();
    });

    it("reports the exact frozen fields attempted", async () => {
      mockDbGet.mockReturnValue({
        first_exported_at: "2026-07-18T00:00:00.000Z",
        property_address: "123 Original St",
        started_at: "2020-06-01",
      });

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

    it("surfaces a HUMAN message (no raw column names) — BACKLOG-2146", async () => {
      mockDbGet.mockReturnValue({
        first_exported_at: "2026-07-18T00:00:00.000Z",
        property_address: "123 Original St",
      });

      const err = await updateTransaction("txn-1", {
        property_address: "swap",
      } as never).catch((e) => e as Error);

      // The user-facing message must not dump snake_case columns.
      expect(err.message).not.toMatch(/property_address|started_at|_/);
      expect(err.message).toContain("This transaction has been exported");
      expect(err.message.toLowerCase()).toContain("contact support");
    });

    it("ALLOWS re-submitting an UNCHANGED frozen field (e.g. re-export) — BACKLOG-2181", async () => {
      // The value-aware guard must distinguish "key present" from "value
      // changed": a re-export resubmits the same started_at unchanged.
      mockDbGet.mockReturnValue({
        first_exported_at: "2026-07-18T00:00:00.000Z",
        property_address: "123 Original St",
        started_at: "2020-06-01",
      });

      await updateTransaction("txn-1", {
        property_address: "123 Original St",
        started_at: "2020-06-01",
        status: "closed",
      } as never);

      // No throw, and the UPDATE executed (including the unchanged frozen
      // fields riding along in the same payload).
      expect(mockDbRun).toHaveBeenCalledTimes(1);
    });

    it("STILL BLOCKS a genuine change to started_at on a frozen transaction — BACKLOG-2181", async () => {
      mockDbGet.mockReturnValue({
        first_exported_at: "2026-07-18T00:00:00.000Z",
        started_at: "2020-06-01",
      });

      await expect(
        updateTransaction("txn-1", { started_at: "2020-07-01" } as never),
      ).rejects.toBeInstanceOf(TransactionFrozenError);

      expect(mockDbRun).not.toHaveBeenCalled();
    });

    it("ALLOWS widening only the end date even though start_date rides along unchanged — BACKLOG-2181 / BACKLOG-2150", async () => {
      // Real-world save: the form submits the full payload, so an unchanged
      // start_date is present alongside the genuinely-changed closed_at.
      mockDbGet.mockReturnValue({
        first_exported_at: "2026-07-18T00:00:00.000Z",
        started_at: "2020-06-01",
      });

      await updateTransaction("txn-1", {
        started_at: "2020-06-01",
        closed_at: "2026-09-01",
      } as never);

      expect(mockDbRun).toHaveBeenCalledTimes(1);
      const [sql, values] = mockDbRun.mock.calls[0] as [string, unknown[]];
      expect(sql).toMatch(/started_at = \?/);
      expect(sql).toMatch(/closed_at = \?/);
      expect(values).toEqual(["2020-06-01", "2026-09-01", "txn-1"]);
    });

    it("ALLOWS editing closed_at (end date) after export — BACKLOG-2150", async () => {
      // A frozen row: guard reads the marker but closed_at is NOT an anchor, so
      // the update proceeds (no throw, SQL runs).
      mockDbGet.mockReturnValue({ first_exported_at: "2026-07-18T00:00:00.000Z" });

      await updateTransaction("txn-1", {
        closed_at: "2026-08-01",
      } as never);

      // closed_at is not a frozen field → guard is skipped, no marker read,
      // and the UPDATE executes.
      expect(mockDbGet).not.toHaveBeenCalled();
      expect(mockDbRun).toHaveBeenCalledTimes(1);
      const [sql, values] = mockDbRun.mock.calls[0] as [string, unknown[]];
      expect(sql).toMatch(/UPDATE transactions SET closed_at = \?/);
      expect(values).toEqual(["2026-08-01", "txn-1"]);
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
