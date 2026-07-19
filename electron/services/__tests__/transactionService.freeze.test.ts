/**
 * @jest-environment node
 *
 * BACKLOG-2013 / BACKLOG-2150 — service-layer behavior around the export freeze:
 *   - BACKLOG-2150: detaching a linked communication is ALLOWED after export
 *   - BACKLOG-2150: removing a party is ALLOWED after export
 *     (the add-only guards were removed; only identity anchors freeze, and that
 *      is enforced at the db layer, not here)
 *   - adminUnfreezeTransaction clears the marker (via override) + audit-logs it
 */

const mockGetCommunicationById = jest.fn();
const mockDeleteCommunication = jest.fn();
const mockAddIgnored = jest.fn();
const mockUnlinkContact = jest.fn();
const mockUpdateTransaction = jest.fn();
const mockGetTransactionById = jest.fn();
const mockDbGet = jest.fn();
const mockDbAll = jest.fn();
const mockAuditLog = jest.fn();

jest.mock("../databaseService", () => ({
  __esModule: true,
  default: {
    getCommunicationById: (...a: unknown[]) => mockGetCommunicationById(...a),
    deleteCommunication: (...a: unknown[]) => mockDeleteCommunication(...a),
    addIgnoredCommunication: (...a: unknown[]) => mockAddIgnored(...a),
    unlinkContactFromTransaction: (...a: unknown[]) => mockUnlinkContact(...a),
    updateTransaction: (...a: unknown[]) => mockUpdateTransaction(...a),
    getTransactionById: (...a: unknown[]) => mockGetTransactionById(...a),
  },
}));

jest.mock("../gmailFetchService");
jest.mock("../outlookFetchService");
jest.mock("../transactionExtractorService");
jest.mock("../emailAttachmentService");
jest.mock("../supabaseService");

jest.mock("../db/core/dbConnection", () => ({
  dbAll: (...a: unknown[]) => mockDbAll(...a),
  dbGet: (...a: unknown[]) => mockDbGet(...a),
  dbRun: jest.fn(),
}));

jest.mock("../auditService", () => ({
  __esModule: true,
  default: { log: (...a: unknown[]) => mockAuditLog(...a) },
}));

jest.mock("../logService", () => ({
  __esModule: true,
  default: {
    info: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
  },
  logService: {
    info: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock("../../utils/preferenceHelper", () => ({
  isContactSourceEnabled: jest.fn().mockResolvedValue(true),
}));

import transactionService from "../transactionService";
import { UNFREEZE_OVERRIDE_KEY } from "../db/transactionDbService";

const TX_ID = "tx-frozen";
const FROZEN = { first_exported_at: "2026-07-18T00:00:00.000Z" };
const NOT_FROZEN = { first_exported_at: null };

describe("TransactionService — export freeze (BACKLOG-2013)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("unlinkCommunication (comms are add-AND-remove after export — BACKLOG-2150)", () => {
    it("ALLOWS detaching a communication from a FROZEN transaction", async () => {
      // A single SMS comm (message_id set → no thread expansion) on a frozen tx.
      mockGetCommunicationById.mockResolvedValue({
        id: "comm-1",
        transaction_id: TX_ID,
        communication_type: "sms",
        message_id: "m1",
        user_id: "user-9",
        subject: "s",
        sender: "x",
        sent_at: "2026-01-01",
      });
      mockDbGet.mockReturnValue(FROZEN); // frozen — but detach is no longer blocked
      mockAddIgnored.mockResolvedValue(undefined);
      mockDeleteCommunication.mockResolvedValue(undefined);

      const result = await transactionService.unlinkCommunication("comm-1");

      // The detach actually happens now (previously blocked).
      expect(result.unlinkedIds).toEqual(["comm-1"]);
      expect(mockDeleteCommunication).toHaveBeenCalledWith("comm-1");
    });

    it("ALLOWS detaching from a NOT-yet-exported transaction", async () => {
      mockGetCommunicationById.mockResolvedValue({
        id: "comm-1",
        transaction_id: TX_ID,
        communication_type: "sms",
        message_id: "m1",
        user_id: "user-9",
        subject: "s",
        sender: "x",
        sent_at: "2026-01-01",
      });
      mockDbGet.mockReturnValue(NOT_FROZEN);
      mockAddIgnored.mockResolvedValue(undefined);
      mockDeleteCommunication.mockResolvedValue(undefined);

      await expect(
        transactionService.unlinkCommunication("comm-1"),
      ).resolves.toBeDefined();
    });
  });

  describe("removeContactFromTransaction (parties are add-AND-remove after export — BACKLOG-2150)", () => {
    it("ALLOWS removing a party from a FROZEN transaction", async () => {
      mockDbGet.mockReturnValue(FROZEN); // frozen — but party removal is no longer blocked
      mockUnlinkContact.mockResolvedValue(undefined);

      await transactionService.removeContactFromTransaction(TX_ID, "contact-1");

      expect(mockUnlinkContact).toHaveBeenCalledWith(TX_ID, "contact-1");
    });

    it("ALLOWS removing a party before first export", async () => {
      mockDbGet.mockReturnValue(NOT_FROZEN);
      mockUnlinkContact.mockResolvedValue(undefined);

      await transactionService.removeContactFromTransaction(TX_ID, "contact-1");

      expect(mockUnlinkContact).toHaveBeenCalledWith(TX_ID, "contact-1");
    });
  });

  describe("adminUnfreezeTransaction", () => {
    it("clears the marker via the override path and writes an audit row", async () => {
      mockDbGet.mockReturnValue(FROZEN);
      mockGetTransactionById.mockResolvedValue({ id: TX_ID, user_id: "user-9" });
      mockUpdateTransaction.mockResolvedValue(undefined);
      mockAuditLog.mockResolvedValue(undefined);

      const result = await transactionService.adminUnfreezeTransaction(
        TX_ID,
        "typo in street name",
        "support-agent",
      );

      expect(result).toEqual({ success: true, wasFrozen: true });

      // The clearing write uses the override sentinel and nulls the marker.
      expect(mockUpdateTransaction).toHaveBeenCalledTimes(1);
      const [txnId, updates] = mockUpdateTransaction.mock.calls[0] as [
        string,
        Record<string, unknown>,
      ];
      expect(txnId).toBe(TX_ID);
      expect(updates.first_exported_at).toBeNull();
      expect(updates[UNFREEZE_OVERRIDE_KEY]).toBe(true);

      // Audit row identifies the unfreeze event + reason.
      expect(mockAuditLog).toHaveBeenCalledTimes(1);
      const auditArg = mockAuditLog.mock.calls[0][0] as Record<string, unknown>;
      expect(auditArg).toMatchObject({
        userId: "user-9",
        action: "TRANSACTION_UPDATE",
        resourceType: "TRANSACTION",
        resourceId: TX_ID,
        success: true,
      });
      expect(auditArg.metadata).toMatchObject({
        event: "export_freeze_unfrozen",
        reason: "typo in street name",
        actor: "support-agent",
      });
    });
  });
});
