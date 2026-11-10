// ============================================
// TRANSACTION HANDLERS - Compatibility Re-export
// The monolith has been split into 4 domain handler files.
// This file provides backwards compatibility for existing tests.
// ============================================

import { registerTransactionCrudHandlers } from "./transactionCrudHandlers";
import {
  registerTransactionExportHandlers,
  cleanupTransactionHandlers,
  type TransactionExportHandlerOptions,
} from "./transactionExportHandlers";
import { registerEmailSyncHandlers } from "./emailSyncHandlers";
import { registerEmailLinkingHandlers } from "./emailLinkingHandlers";
import { registerEmailAutoLinkHandlers } from "./emailAutoLinkHandlers";
import { registerAttachmentHandlers } from "./attachmentHandlers";
import { registerTransactionSearchHandlers } from "./transactionSearchHandlers";

/**
 * Register all transaction-related IPC handlers (delegates to domain files).
 * @param options - forwarded to registerTransactionExportHandlers (BACKLOG-3456)
 */
export function registerTransactionHandlers(
  options: TransactionExportHandlerOptions,
): void {
  registerTransactionCrudHandlers(null);
  registerTransactionExportHandlers(options);
  registerEmailSyncHandlers(null);
  registerEmailLinkingHandlers();
  registerEmailAutoLinkHandlers();
  registerAttachmentHandlers(null);
  registerTransactionSearchHandlers();
}

export { cleanupTransactionHandlers };
