/**
 * @jest-environment node
 */

/**
 * BACKLOG-2013 — unit tests for the export-freeze policy (pure logic).
 */

import {
  FROZEN_IDENTITY_FIELDS,
  isTransactionFrozen,
  isFrozenIdentityField,
  frozenFieldsInUpdate,
  TransactionFrozenError,
} from "../transactionFreezePolicy";

describe("transactionFreezePolicy", () => {
  describe("isTransactionFrozen", () => {
    it("is NOT frozen before first export (null / undefined / empty marker)", () => {
      expect(isTransactionFrozen(null)).toBe(false);
      expect(isTransactionFrozen(undefined)).toBe(false);
      expect(isTransactionFrozen({})).toBe(false);
      expect(isTransactionFrozen({ first_exported_at: null })).toBe(false);
      expect(isTransactionFrozen({ first_exported_at: "" })).toBe(false);
      expect(isTransactionFrozen({ first_exported_at: "   " })).toBe(false);
    });

    it("IS frozen once first_exported_at holds a real timestamp", () => {
      expect(
        isTransactionFrozen({ first_exported_at: "2026-07-18T00:00:00.000Z" }),
      ).toBe(true);
    });
  });

  describe("FROZEN_IDENTITY_FIELDS coverage", () => {
    it("includes the address block, transaction type, party refs, and key dates", () => {
      const expected = [
        "property_address",
        "property_street",
        "property_city",
        "property_state",
        "property_zip",
        "transaction_type",
        "buyer_agent_id",
        "seller_agent_id",
        "escrow_officer_id",
        "inspector_id",
        "started_at",
        "closed_at",
        "closing_deadline",
        "mutual_acceptance_date",
      ];
      // Assert exact membership (identity, not just count) for each expected field.
      for (const field of expected) {
        expect(FROZEN_IDENTITY_FIELDS).toContain(field);
        expect(isFrozenIdentityField(field)).toBe(true);
      }
    });

    it("does NOT freeze operational / financial / bookkeeping fields", () => {
      const notFrozen = [
        "status",
        "stage",
        "message_count",
        "export_status",
        "export_count",
        "last_exported_at",
        "first_exported_at",
        "sale_price",
        "listing_price",
        "metadata",
        "skip_address_filter",
      ];
      for (const field of notFrozen) {
        expect(isFrozenIdentityField(field)).toBe(false);
        expect(FROZEN_IDENTITY_FIELDS).not.toContain(field);
      }
    });
  });

  describe("frozenFieldsInUpdate", () => {
    it("returns exactly the frozen keys present in the update", () => {
      const result = frozenFieldsInUpdate([
        "property_address",
        "sale_price",
        "started_at",
        "status",
      ]);
      expect(new Set(result)).toEqual(new Set(["property_address", "started_at"]));
    });

    it("returns empty when only non-identity fields are updated", () => {
      expect(frozenFieldsInUpdate(["status", "sale_price", "export_count"])).toEqual(
        [],
      );
    });
  });

  describe("TransactionFrozenError", () => {
    it("carries a stable code + transaction id + attempted fields", () => {
      const err = new TransactionFrozenError("txn-1", "frozen", ["property_address"]);
      expect(err.code).toBe("TRANSACTION_FROZEN");
      expect(err.transactionId).toBe("txn-1");
      expect(err.attemptedFields).toEqual(["property_address"]);
      expect(err).toBeInstanceOf(Error);
    });
  });
});
