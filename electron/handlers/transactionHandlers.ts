// ============================================
// TRANSACTION HANDLERS - Compatibility Re-export
// The monolith has been split into 4 domain handler files.
// This file provides backwards compatibility for existing tests.
// ============================================

import type { BrowserWindow } from "electron";
import { registerTransactionCrudHandlers } from "./transactionCrudHandlers";
import { registerTransactionExportHandlers, cleanupTransactionHandlers } from "./transactionExportHandlers";
import { registerEmailSyncHandlers } from "./emailSyncHandlers";
import { registerEmailLinkingHandlers } from "./emailLinkingHandlers";
import { registerEmailAutoLinkHandlers } from "./emailAutoLinkHandlers";
import { registerAttachmentHandlers } from "./attachmentHandlers";
import { registerTransactionSearchHandlers } from "./transactionSearchHandlers";

/**
 * Register all transaction-related IPC handlers (delegates to domain files).
 * @param mainWindow - Main window instance
 */
export function registerTransactionHandlers(
  mainWindow: BrowserWindow | null,
): void {
  registerTransactionCrudHandlers(mainWindow);
  registerTransactionExportHandlers(mainWindow);
  registerEmailSyncHandlers(mainWindow);
  registerEmailLinkingHandlers();
  registerEmailAutoLinkHandlers();
  registerAttachmentHandlers(mainWindow);
  registerTransactionSearchHandlers();
}

export { cleanupTransactionHandlers };
