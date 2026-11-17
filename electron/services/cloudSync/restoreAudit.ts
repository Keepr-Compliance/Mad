/**
 * BACKLOG-4263 PR-4c (plan §14 F3): the audit entry of a deal restored from its archive. TRANSACTION_CREATE (a
 * TRANSACTION_RESTORE action is not in the audit_logs CHECK, and changing it means rebuilding that table), written
 * inside the restore's transaction: a failure throws and cancels the restore.
 */
import { auditService } from "../auditService";

export function recordDealRestoreAuditSync(e: { userId: string; transactionId: string; archivedAt: string; via: "computer" | "online" }): void {
  auditService.recordInTransaction({
    userId: e.userId,
    action: "TRANSACTION_CREATE",
    resourceType: "TRANSACTION",
    resourceId: e.transactionId,
    metadata: { restored_from_archive: true, archived_at: e.archivedAt, restored_from: e.via },
  });
}
