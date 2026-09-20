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
 * @param _mainWindow - Main window instance (BACKLOG-3454: IGNORED — pushes resolve the live window via sendToMainWindow; kept so existing call sites and suites compile)
 */
export function registerTransactionHandlers(
  _mainWindow: BrowserWindow | null,
): void {
  registerTransactionCrudHandlers(_mainWindow);
  registerTransactionExportHandlers(_mainWindow);
  registerEmailSyncHandlers(_mainWindow);
  registerEmailLinkingHandlers();
  registerEmailAutoLinkHandlers();
  registerAttachmentHandlers(_mainWindow);
  registerTransactionSearchHandlers();
}

export { cleanupTransactionHandlers };
