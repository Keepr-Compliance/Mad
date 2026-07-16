/**
 * Preload Bridge Barrel Export
 * Re-exports all bridge modules for composition in preload.ts
 */

export { authBridge } from "./authBridge";
export { transactionBridge } from "./transactionBridge";
export type { ScanOptions, ExportEnhancedOptions, ExportFolderOptions } from "./transactionBridge";
export { contactBridge, addressBridge } from "./contactBridge";
export { feedbackBridge } from "./communicationBridge";
export { preferencesBridge, userBridge, shellBridge, notificationBridge, logBridge } from "./settingsBridge";
export { llmBridge } from "./llmBridge";
export { systemBridge } from "./systemBridge";
export { deviceBridge, backupBridge, driverBridge, syncBridge } from "./deviceBridge";
export { outlookBridge, updateBridge } from "./outlookBridge";
export { eventBridge } from "./eventBridge";
export { messageBridge } from "./messageBridge";
export { licenseBridge } from "./licenseBridge";
export { errorLoggingBridge } from "./errorLoggingBridge";
export { resetBridge } from "./resetBridge";
export { databaseBackupBridge } from "./databaseBackupBridge";
export { privacyBridge } from "./privacyBridge";
export { failureLogBridge } from "./failureLogBridge";
export { featureGateBridge } from "./featureGateBridge";
export { entitlementBridge } from "./entitlementBridge";
export { supportBridge } from "./supportBridge";
export { pairingBridge } from "./pairingBridge";
export { localSyncBridge } from "./localSyncBridge";
