// ============================================
// HANDLERS BARREL EXPORT
// Central export for all extracted IPC handlers
// ============================================

// Permission and system handlers
export { registerPermissionHandlers } from "./permissionHandlers";
export { registerConversationHandlers } from "./conversationHandlers";
export { registerMessageImportHandlers } from "./messageImportHandlers";
export { registerOutlookHandlers, getOutlookService } from "./outlookHandlers";
export { registerUpdaterHandlers } from "./updaterHandlers";

// Google OAuth handlers
export {
  registerGoogleAuthHandlers,
  handleGoogleLogin,
  handleGoogleCompleteLogin,
  handleGoogleConnectMailbox,
  handleGoogleConnectMailboxPending,
} from "./googleAuthHandlers";

// Microsoft OAuth handlers
export {
  registerMicrosoftAuthHandlers,
  handleMicrosoftLogin,
  handleMicrosoftConnectMailbox,
  handleMicrosoftConnectMailboxPending,
} from "./microsoftAuthHandlers";

// Session handlers
export { registerSessionHandlers } from "./sessionHandlers";

// Error logging handlers
export { registerErrorLoggingHandlers } from "./errorLoggingHandlers";

// Reset handlers (TASK-1802)
export { registerResetHandlers } from "./resetHandlers";

// Backup/Restore handlers (TASK-2052)
export { registerBackupRestoreHandlers } from "./backupRestoreHandlers";

// CCPA data export handlers (TASK-2053)
export { registerCcpaHandlers } from "./ccpaHandlers";

// Failure log handlers (TASK-2058)
export { registerFailureLogHandlers } from "./failureLogHandlers";

// Shared auth handlers
export {
  registerSharedAuthHandlers,
  handleCompletePendingLogin,
  handleSavePendingMailboxTokens,
  handleDisconnectMailbox,
} from "./sharedAuthHandlers";

// Auth handlers facade (TASK-2263: migrated from electron/ root)
export { registerAuthHandlers, initializeDatabase } from "./authHandlers";

// Contact handlers (TASK-2263: migrated from electron/ root)
export { registerContactHandlers } from "./contactHandlers";

// Address handlers (TASK-2263: migrated from electron/ root)
export { registerAddressHandlers } from "./addressHandlers";

// Feedback handlers (TASK-2263: migrated from electron/ root)
export { registerFeedbackHandlers } from "./feedbackHandlers";

// Backup handlers (TASK-2263: migrated from electron/ root)
export { registerBackupHandlers } from "./backupHandlers";

// Sync handlers (TASK-2263: migrated from electron/ root)
export { registerSyncHandlers, cleanupSyncHandlers, setSyncUserId } from "./syncHandlers";

// License handlers (TASK-2263: migrated from electron/ root)
export { registerLicenseHandlers } from "./licenseHandlers";

// Preference handlers (TASK-2263: migrated from electron/ root)
export { registerPreferenceHandlers } from "./preferenceHandlers";

// LLM handlers (TASK-2263: migrated from electron/ root)
export { registerLLMHandlers } from "./llmHandlers";

// Device handlers (TASK-2263: migrated from electron/ root)
export { registerDeviceHandlers, cleanupDeviceHandlers } from "./deviceHandlers";

// Driver handlers (TASK-2263: migrated from electron/ root)
export { registerDriverHandlers } from "./driverHandlers";

// Feature gate handlers (TASK-2263: migrated from electron/ root)
export { registerFeatureGateHandlers } from "./featureGateHandlers";
export { registerEntitlementHandlers } from "./entitlementHandlers";

// Transaction handlers compat (TASK-2263: migrated from electron/ root)
export { registerTransactionHandlers, cleanupTransactionHandlers } from "./transactionHandlers";

// System handlers compat (TASK-2263: migrated from electron/ root)
export { registerSystemHandlers as registerSystemHandlersCompat } from "./systemHandlersCompat";

// Local sync handlers (TASK-1429: Android Companion)
export { registerLocalSyncHandlers, cleanupLocalSyncHandlers } from "./localSyncHandlers";
