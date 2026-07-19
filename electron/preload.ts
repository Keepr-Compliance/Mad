/**
 * ============================================
 * PRELOAD SCRIPT - IPC BRIDGE
 * ============================================
 * This file safely exposes IPC methods to the renderer process via contextBridge.
 * It acts as a secure bridge between the main process and renderer process.
 *
 * Bridge modules are organized by domain in electron/preload/:
 * - authBridge: Authentication, OAuth, session management
 * - transactionBridge: Real estate transactions, scanning, export
 * - contactBridge: Contacts and address verification
 * - communicationBridge: Feedback for AI learning
 * - settingsBridge: User preferences, shell operations
 * - llmBridge: LLM configuration and usage
 * - systemBridge: Permissions, connections, health checks
 * - deviceBridge: iOS device detection, backup, sync, drivers
 * - outlookBridge: Legacy Outlook integration
 * - eventBridge: Event listeners from main process
 */

import { contextBridge } from "electron";
// Initialize Sentry IPC bridge so renderer can communicate with main process Sentry
// Note: hookupIpc may be undefined depending on @sentry/electron version/exports
try {
  const { hookupIpc: sentryHookupIpc } = require("@sentry/electron/preload");
  if (typeof sentryHookupIpc === "function") {
    sentryHookupIpc();
  }
} catch {
  // Sentry preload bridge not available — non-critical, continue without it
}

import {
  authBridge,
  transactionBridge,
  contactBridge,
  addressBridge,
  feedbackBridge,
  preferencesBridge,
  userBridge,
  shellBridge,
  notificationBridge,
  llmBridge,
  systemBridge,
  deviceBridge,
  backupBridge,
  driverBridge,
  syncBridge,
  eventBridge,
  outlookBridge,
  updateBridge,
  messageBridge,
  licenseBridge,
  errorLoggingBridge,
  resetBridge,
  appCleanupBridge,
  databaseBackupBridge,
  privacyBridge,
  failureLogBridge,
  featureGateBridge,
  entitlementBridge,
  paymentBridge,
  paymentEventBridge,
  supportBridge,
  pairingBridge,
  localSyncBridge,
  logBridge,
} from "./preload/index";

// Expose protected methods that allow the renderer process to use
// ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld("api", {
  // Authentication methods
  auth: authBridge,

  // Transaction methods
  transactions: transactionBridge,

  // Contact methods
  contacts: contactBridge,

  // Address verification methods
  address: addressBridge,

  // Feedback methods for AI learning
  feedback: feedbackBridge,

  // User preferences
  preferences: preferencesBridge,

  // LLM configuration
  llm: llmBridge,

  // System operations
  system: systemBridge,

  // User settings
  user: userBridge,

  // Event listeners (spread from eventBridge)
  ...eventBridge,

  // Payment deep-link callback listener (BACKLOG-2015)
  ...paymentEventBridge,

  // Backup operations
  backup: backupBridge,

  // Shell operations
  shell: shellBridge,

  // OS notifications
  notification: notificationBridge,

  // Device detection
  device: deviceBridge,

  // Driver management (Windows)
  drivers: driverBridge,

  // Sync operations (Windows iPhone sync)
  sync: syncBridge,

  // Outlook integration (Microsoft 365)
  outlook: outlookBridge,

  // Auto-update functionality
  update: updateBridge,

  // iMessage conversations (macOS)
  messages: messageBridge,

  // License management
  license: licenseBridge,

  // Error logging (production monitoring)
  errorLogging: errorLoggingBridge,

  // App reset (TASK-1802: self-healing feature)
  app: resetBridge,

  // App-data cleanup engine + detached uninstall (BACKLOG-2111)
  appCleanup: appCleanupBridge,

  // Database backup & restore (TASK-2052)
  databaseBackup: databaseBackupBridge,

  // Privacy / CCPA data export (TASK-2053)
  privacy: privacyBridge,

  // Failure log for offline diagnostics (TASK-2058)
  failureLog: failureLogBridge,

  // Feature gate enforcement (SPRINT-122)
  featureGate: featureGateBridge,

  // Per-transaction paywall entitlement (BACKLOG-2006a)
  entitlement: entitlementBridge,

  // PAYG card-purchase flow (BACKLOG-2015)
  payment: paymentBridge,

  // Support ticket diagnostics + screenshot (TASK-2180)
  support: supportBridge,

  // Android companion pairing (TASK-1428)
  pairing: pairingBridge,

  // Android companion local sync server (TASK-1431)
  localSync: localSyncBridge,

  // Renderer log relay — pipes to main process log file
  log: logBridge,
});
