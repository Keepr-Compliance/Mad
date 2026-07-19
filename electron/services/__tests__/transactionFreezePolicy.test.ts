/**
 * @jest-environment node
 */

/**
 * BACKLOG-2013 / BACKLOG-2150 — unit tests for the export-freeze policy.
 *
 * BACKLOG-2150 narrowed the frozen set to the anti-reuse ANCHORS only:
 * the property address block, transaction type, and the audit-window START
 * (`started_at`). The end date, parties/contacts, and other key dates are NOT
 * frozen (editable after export).
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

  describe("FROZEN_IDENTITY_FIELDS coverage (BACKLOG-2150 anchors only)", () => {
    it("freezes EXACTLY the property block, transaction type, and started_at", () => {
      // Assert the EXACT set (identity, not count): the anti-reuse anchors only.
      const expected = new Set([
        "property_address",
        "property_street",
        "property_city",
        "property_state",
        "property_zip",
        "property_coordinates",
        "transaction_type",
        "started_at",
      ]);
      expect(new Set(FROZEN_IDENTITY_FIELDS)).toEqual(expected);
      for (const field of expected) {
        expect(isFrozenIdentityField(field)).toBe(true);
      }
    });

    it("does NOT freeze the end date, parties, or other key dates (BACKLOG-2150 relaxed)", () => {
      // These were frozen by the original 2013 shipment; 2150 makes them
      // editable after export (support burden ≫ ~zero abuse risk).
      const relaxed = [
        "closed_at",
        "buyer_agent_id",
        "seller_agent_id",
        "escrow_officer_id",
        "inspector_id",
        "other_contacts",
        "other_parties",
        "representation_start_date",
        "closing_deadline",
        "mutual_acceptance_date",
        "inspection_deadline",
        "financing_deadline",
        "earnest_money_delivered_date",
        "key_dates",
      ];
      for (const field of relaxed) {
        expect(isFrozenIdentityField(field)).toBe(false);
        expect(FROZEN_IDENTITY_FIELDS).not.toContain(field);
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
