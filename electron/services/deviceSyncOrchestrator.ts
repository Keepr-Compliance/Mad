/**
 * Sync Orchestrator Service
 *
 * Orchestrates the complete iPhone sync flow on Windows:
 * 1. Device detection
 * 2. iPhone backup creation
 * 3. Backup decryption (if encrypted)
 * 4. Messages and contacts extraction
 * 5. Contact name resolution
 * 6. Cleanup
 *
 * This is the main integration point for all iPhone-related services.
 */

import { EventEmitter } from "events";
import crypto from "crypto";
import log from "electron-log";
import { syncTimeline } from "./syncTimeline";
import * as Sentry from "@sentry/electron/main";
import checkDiskSpace from "check-disk-space";
import { app } from "electron";
import path from "path";
import {
  DeviceDetectionService,
  deviceDetectionService,
} from "./deviceDetectionService";
import { BackupService } from "./backupService";
import { BackupDecryptionService } from "./backupDecryptionService";
import { iOSMessagesParser } from "./iosMessagesParser";
import { iOSContactsParser } from "./iosContactsParser";
import { checkDiskSpaceForOperation } from "./diagnostics/diskSpaceDiagnostics";
import {
  formatDiskSpaceError,
  formatMissingDriversError,
  formatDriverServiceStoppedError,
} from "./diagnostics/userFacingErrors";
import { checkAppleDrivers } from "./appleDriverService";
import { canUseLibimobiledevice } from "./libimobiledeviceService";
import type { iOSDevice } from "../types/device";
import type { iOSMessage, iOSConversation } from "../types/iosMessages";
import type { iOSContact } from "../types/iosContacts";
import type { BackupProgress } from "../types/backup";

/**
 * Metadata about the last successfully synced backup (TASK-908)
 */
interface LastBackupSync {
  /** Path to the backup directory */
  backupPath: string;
  /** SHA-256 hash of Manifest.db for change detection */
  manifestHash: string;
  /** When the sync was completed */
  syncedAt: Date;
}

/**
 * Sync phases for progress tracking
 */
export type SyncPhase =
  | "idle"
  | "backup"
  | "decrypting"
  | "parsing-contacts"
  | "parsing-messages"
  | "resolving"
  | "cleanup"
  | "complete"
  | "error";

/**
 * Result of a complete sync operation
 */
export interface SyncResult {
  success: boolean;
  messages: iOSMessage[];
  contacts: iOSContact[];
  conversations: iOSConversation[];
  error: string | null;
  duration: number;
  /** Whether the backup was skipped because it hasn't changed (TASK-908) */
  skipped?: boolean;
  /** Reason for skipping (TASK-908) */
  skipReason?: "unchanged" | "force-resync";
  /** Path to backup for attachment extraction (SPRINT-068) */
  backupPath?: string;
  /** Whether backup was encrypted (cleanup needed after persistence) */
  needsCleanup?: boolean;
  /** Unique session ID for ACID rollback on cancel (TASK-2110) */
  sessionId?: string;
}

/**
 * Options for starting a sync operation
 */
export interface SyncOptions {
  /** Device UDID to sync */
  udid: string;
  /** Password for encrypted backups */
  password?: string;
  /** Force full backup (no incremental) */
  forceFullBackup?: boolean;
}

/**
 * Sync progress information
 */
export interface SyncProgress {
  phase: SyncPhase;
  phaseProgress: number;
  overallProgress: number;
  message: string;
  backupProgress?: BackupProgress;
  /** Estimated total backup size in bytes (for progress calculation) */
  estimatedTotalBytes?: number;
}

/**
 * Options for processing an existing backup (TASK-908)
 */
export interface ProcessBackupOptions {
  /** Device UDID */
  udid: string;
  /** Password for encrypted backups */
  password?: string;
  /** Force re-processing even if backup hasn't changed (TASK-908) */
  forceResync?: boolean;
}

/**
 * DeviceSyncOrchestrator - Main integration service for iPhone sync on Windows
 *
 * Events:
 * - 'progress': SyncProgress - Progress updates during sync
 * - 'phase': SyncPhase - Phase changes
 * - 'device-connected': iOSDevice - Device connected
 * - 'device-disconnected': iOSDevice - Device disconnected
 * - 'password-required': void - Encrypted backup needs password
 * - 'error': Error - Error during sync
 * - 'complete': SyncResult - Sync completed
 *
 * @example
 * ```typescript
 * const orchestrator = new DeviceSyncOrchestrator();
 * orchestrator.on('progress', (progress) => console.log(progress));
 * const result = await orchestrator.sync({ udid: '...' });
 * ```
 */
export class DeviceSyncOrchestrator extends EventEmitter {
  private deviceService: DeviceDetectionService;
  private backupService: BackupService;
  private decryptionService: BackupDecryptionService;
  private messagesParser: iOSMessagesParser;
  private contactsParser: iOSContactsParser;

  private isRunning: boolean = false;
  private abortController: AbortController | null = null;
  private currentPhase: SyncPhase = "idle";
  private estimatedBackupSize: number = 0;
  private startTime: number = 0;

  /**
   * Tracks the last successfully synced backup for skip detection (TASK-908)
   * Note: This is in-memory only; cross-session persistence is a future enhancement
   */
  private lastBackupSync: LastBackupSync | null = null;

  constructor() {
    super();
    this.deviceService = deviceDetectionService;
    this.backupService = new BackupService();
    this.decryptionService = new BackupDecryptionService();
    this.messagesParser = new iOSMessagesParser();
    this.contactsParser = new iOSContactsParser();

    this.setupEventForwarding();
  }

  /**
   * Set up event forwarding from child services
   */
  private setupEventForwarding(): void {
    // Forward backup progress events
    this.backupService.on("progress", (progress: BackupProgress) => {
      // Calculate progress based on bytes transferred if we have estimated size
      let calculatedProgress = progress.percentComplete;
      if (this.estimatedBackupSize > 0 && progress.bytesTransferred > 0) {
        // Calculate based on actual bytes vs estimated total
        calculatedProgress = Math.min(
          (progress.bytesTransferred / this.estimatedBackupSize) * 100,
          99 // Cap at 99% until we get completion signal
        );
      }

      this.emitProgress({
        phase: "backup",
        phaseProgress: calculatedProgress,
        overallProgress: this.calculateOverallProgress(
          "backup",
          calculatedProgress,
        ),
        message: this.getBackupProgressMessage(progress),
        backupProgress: progress,
        estimatedTotalBytes: this.estimatedBackupSize > 0 ? this.estimatedBackupSize : undefined,
      });
    });

    // Forward password required events
    this.backupService.on("password-required", () => {
      this.emit("password-required");
    });

    // Forward passcode waiting events (user needs to enter passcode on iPhone)
    this.backupService.on("waiting-for-passcode", () => {
      log.info("[DeviceSyncOrchestrator] Waiting for user to enter passcode on iPhone");
      this.emit("waiting-for-passcode");
    });

    this.backupService.on("passcode-entered", () => {
      log.info("[DeviceSyncOrchestrator] User entered passcode, backup starting");
      this.emit("passcode-entered");
    });

    // Forward device events
    this.deviceService.on("device-connected", (device: iOSDevice) => {
      this.emit("device-connected", device);
    });

    this.deviceService.on("device-disconnected", (device: iOSDevice) => {
      this.emit("device-disconnected", device);
    });
  }

  /**
   * Start the sync process
   */
  async sync(options: SyncOptions): Promise<SyncResult> {
    if (this.isRunning) {
      return this.errorResult("Sync already in progress");
    }

    this.isRunning = true;
    this.abortController = new AbortController();
    this.startTime = Date.now();
    this.estimatedBackupSize = 0;

    // BACKLOG-2898: open the phase timeline for this run.
    syncTimeline.beginSync({ platform: process.platform });

    // TASK-2110: Generate session ID for ACID rollback on cancel
    const sessionId = crypto.randomUUID();

    log.info("[DeviceSyncOrchestrator] Starting sync", { udid: options.udid, sessionId });

    try {
      // TASK-2276: Pre-sync checks with user-facing error messages
      // Check disk space using the diagnostic utility (enriched errors for UI)
      const diskCheck = await checkDiskSpaceForOperation("sync");
      if (!diskCheck.sufficient) {
        const userError = formatDiskSpaceError(diskCheck.availableMB, diskCheck.requiredMB);
        log.warn("[DeviceSyncOrchestrator] Pre-sync disk space check failed", {
          availableMB: diskCheck.availableMB,
          requiredMB: diskCheck.requiredMB,
        });
        this.isRunning = false;
        this.emit("error", { message: userError.description, userError });
        return this.errorResult(userError.description);
      }

      // TASK-2276: On Windows, check Apple drivers before attempting sync
      let driversInstalled = true;
      let serviceRunning = true;
      if (process.platform === "win32") {
        const driverStatus = await checkAppleDrivers();
        driversInstalled = driverStatus.isInstalled;
        serviceRunning = driverStatus.serviceRunning;
        if (!driverStatus.isInstalled) {
          const userError = formatMissingDriversError();
          log.warn("[DeviceSyncOrchestrator] Apple drivers not installed");
          // BACKLOG-1354: Breadcrumb + captureMessage when pre-sync fails
          Sentry.addBreadcrumb({
            category: "iphone.sync",
            message: "Pre-sync failed: Apple drivers not installed",
            level: "warning",
            data: { driversInstalled: false, serviceRunning: false },
          });
          Sentry.captureMessage("Pre-sync check failed: Apple drivers not installed", {
            level: "warning",
            tags: { component: "device_sync", platform: process.platform },
          });
          this.isRunning = false;
          this.emit("error", { message: userError.description, userError });
          return this.errorResult(userError.description);
        }
        if (!driverStatus.serviceRunning) {
          const userError = formatDriverServiceStoppedError();
          log.warn("[DeviceSyncOrchestrator] Apple Mobile Device Service not running");
          // BACKLOG-1354: Breadcrumb + captureMessage when pre-sync fails
          Sentry.addBreadcrumb({
            category: "iphone.sync",
            message: "Pre-sync failed: Apple Mobile Device Service not running",
            level: "warning",
            data: { driversInstalled: true, serviceRunning: false },
          });
          Sentry.captureMessage("Pre-sync check failed: Apple Mobile Device Service stopped", {
            level: "warning",
            tags: { component: "device_sync", platform: process.platform },
          });
          this.isRunning = false;
          this.emit("error", { message: userError.description, userError });
          return this.errorResult(userError.description);
        }
      }

      // BACKLOG-1354: Pre-sync summary breadcrumb with all check results
      const libimobiledeviceAvailable = canUseLibimobiledevice();
      const connectedDevices = this.deviceService.getConnectedDevices();
      Sentry.addBreadcrumb({
        category: "iphone.sync",
        message: "Pre-sync checks passed",
        level: "info",
        data: {
          driversInstalled,
          serviceRunning,
          libimobiledeviceAvailable,
          devicesDetectedCount: connectedDevices.length,
          diskSpaceSufficientMB: diskCheck.availableMB,
          platform: process.platform,
        },
      });

      // Step 0: Check for existing/interrupted backups
      this.emitProgress({
        phase: "backup",
        phaseProgress: 0,
        overallProgress: 0,
        message: "Initializing sync...",
      });

      // Check if there's an existing backup (could be complete or interrupted)
      const backupStatus = await this.backupService.checkBackupStatus(options.udid);
      let existingBackupSize = 0;

      if (backupStatus) {
        existingBackupSize = backupStatus.sizeBytes;
        const sizeGB = (backupStatus.sizeBytes / 1024 / 1024 / 1024).toFixed(1);

        if (backupStatus.isInterrupted) {
          // BACKLOG-2911: this branch used to say "Resuming..." and then issue a
          // byte-identical backup request. There is no resume to perform: the host
          // cannot ask for one. `idevicebackup2` never reads `Status.plist` on the
          // backup path, and `ForceFullBackup` is the only option the mobilebackup2
          // protocol accepts on a backup request — the device decides what to re-send.
          //
          // So the message says what actually happens. What is on disk is kept (the
          // partial directory is never deleted, and `--full` is never injected), but
          // no reuse is promised: the failed run never updated `Manifest.db`, and
          // whether the device credits its partially-transferred files cannot be
          // established from the host.
          log.warn(
            `[DeviceSyncOrchestrator] Previous backup did not finish (${sizeGB} GB on disk); starting a new backup. No host-side resume exists — see BACKLOG-2911.`,
          );
          this.emitProgress({
            phase: "backup",
            phaseProgress: 0,
            overallProgress: 0,
            message: `Previous sync didn't finish (${sizeGB} GB saved). Starting over...`,
          });
        } else if (backupStatus.isComplete) {
          const lastSync = backupStatus.lastModified;
          const timeSinceLastSync = lastSync ? Math.round((Date.now() - lastSync.getTime()) / 1000 / 60) : null;
          log.info(`[DeviceSyncOrchestrator] Previous backup exists (${sizeGB} GB), last modified ${timeSinceLastSync} minutes ago`);

          // Format time since last sync for user
          let timeAgoStr = "";
          if (timeSinceLastSync !== null) {
            if (timeSinceLastSync < 60) {
              timeAgoStr = `${timeSinceLastSync} minutes ago`;
            } else if (timeSinceLastSync < 1440) {
              timeAgoStr = `${Math.round(timeSinceLastSync / 60)} hours ago`;
            } else {
              timeAgoStr = `${Math.round(timeSinceLastSync / 1440)} days ago`;
            }
          }

          this.emitProgress({
            phase: "backup",
            phaseProgress: 0,
            overallProgress: 0,
            message: `Found previous backup (${sizeGB} GB, synced ${timeAgoStr})`,
          });

          // Brief pause to let user see this message
          await new Promise(resolve => setTimeout(resolve, 1500));

          this.emitProgress({
            phase: "backup",
            phaseProgress: 0,
            overallProgress: 0,
            message: "Comparing with iPhone to find new data...",
          });
        }
      } else {
        // No previous backup - first sync
        this.emitProgress({
          phase: "backup",
          phaseProgress: 0,
          overallProgress: 0,
          message: "Preparing first sync (this may take a while)...",
        });
      }

      // Step 1: Get device storage info to estimate backup size
      const storageInfo = await this.deviceService.getDeviceStorageInfo(options.udid);
      if (storageInfo) {
        // If we have an existing backup, use its size (most accurate)
        // Otherwise fall back to the storage-based estimate (less accurate)
        if (existingBackupSize > 0) {
          this.estimatedBackupSize = existingBackupSize;
          log.info(`[DeviceSyncOrchestrator] Using existing backup size for estimate: ${Math.round(this.estimatedBackupSize / 1024 / 1024 / 1024)} GB`);
        } else {
          this.estimatedBackupSize = storageInfo.estimatedBackupSize;
          log.info(`[DeviceSyncOrchestrator] Estimated backup size from storage: ${Math.round(this.estimatedBackupSize / 1024 / 1024)} MB (used space: ${Math.round(storageInfo.usedSpace / 1024 / 1024 / 1024)} GB)`);
        }

        // BACKLOG-2898/2896: the estimate BRANCH, on one greppable line. Which
        // branch ran is what says whether a previous backup was reused — the
        // question 2896 could not answer because both `log.info` lines above
        // had rotated out of main.log AND main.old.log before anyone looked.
        syncTimeline.mark("backup-estimate", {
          source: existingBackupSize > 0 ? "existing-backup" : "device-storage",
          bytes: this.estimatedBackupSize,
          reusedPreviousBackup: existingBackupSize > 0,
        });

        this.emitProgress({
          phase: "backup",
          phaseProgress: 0,
          overallProgress: 0,
          message: "Checking available disk space...",
          estimatedTotalBytes: this.estimatedBackupSize,
        });

        // Check if computer has enough disk space
        // For existing backups (accurate size), use 1.1x since the old backup is already on disk
        // For estimates (first-time), use 1.5x to account for estimation variance
        const headroom = existingBackupSize > 0 ? 1.1 : 1.5;
        const requiredSpace = this.estimatedBackupSize * headroom;
        const diskSpaceCheck = await this.checkAvailableDiskSpace(requiredSpace);

        if (!diskSpaceCheck.hasEnoughSpace) {
          const requiredGB = (requiredSpace / 1024 / 1024 / 1024).toFixed(1);
          const availableGB = (diskSpaceCheck.availableSpace / 1024 / 1024 / 1024).toFixed(1);
          log.warn(`[DeviceSyncOrchestrator] Low disk space warning: ~${requiredGB} GB recommended, ${availableGB} GB available. Proceeding anyway.`);
          this.emitProgress({
            phase: "backup",
            phaseProgress: 0,
            overallProgress: 0,
            message: `Low disk space (${availableGB} GB free). Backup may fail — consider freeing up space.`,
          });
          // Brief pause so user can see the warning
          await new Promise(resolve => setTimeout(resolve, 3000));
        } else {
          log.info(`[DeviceSyncOrchestrator] Disk space check passed: ${Math.round(diskSpaceCheck.availableSpace / 1024 / 1024 / 1024)} GB available`);
        }

        this.emitProgress({
          phase: "backup",
          phaseProgress: 0,
          overallProgress: 0,
          message: "Estimating backup size...",
          estimatedTotalBytes: this.estimatedBackupSize,
        });
      } else {
        log.warn("[DeviceSyncOrchestrator] Could not get storage info, progress will be estimated");

        // Even without device storage info, check we have at least 10GB free
        const minRequiredSpace = 10 * 1024 * 1024 * 1024; // 10 GB minimum
        const diskSpaceCheck = await this.checkAvailableDiskSpace(minRequiredSpace);

        if (!diskSpaceCheck.hasEnoughSpace) {
          const availableGB = (diskSpaceCheck.availableSpace / 1024 / 1024 / 1024).toFixed(1);
          log.warn(`[DeviceSyncOrchestrator] Very low disk space: ${availableGB} GB available (10 GB recommended). Proceeding anyway.`);
          this.emitProgress({
            phase: "backup",
            phaseProgress: 0,
            overallProgress: 0,
            message: `Very low disk space (${availableGB} GB free). Backup may fail — consider freeing up space.`,
          });
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
      }

      // Step 1: Create backup
      this.setPhase("backup");
      const backupResult = await this.backupService.startBackup({
        udid: options.udid,
        password: options.password,
        forceFullBackup: options.forceFullBackup,
        skipApps: true, // Always skip apps to reduce backup size
      });

      if (this.abortController?.signal.aborted) {
        this.isRunning = false;
        return this.errorResult("Sync cancelled by user");
      }

      if (!backupResult.success || !backupResult.backupPath) {
        const error = backupResult.error || "Backup failed";
        const isDiskSpaceError = /disk space|no space|ENOSPC|not enough space/i.test(error);
        if (isDiskSpaceError) {
          Sentry.captureMessage("Backup failed due to insufficient disk space", {
            level: "error",
            tags: { service: "sync-orchestrator", failure_reason: "disk_space" },
            extra: {
              estimatedBackupSize: this.estimatedBackupSize,
              error,
            },
          });
        }
        this.isRunning = false;
        return this.errorResult(error);
      }

      // BACKLOG-2898/2894: what the backup phase produced. `incremental` is
      // the fact BACKLOG-2896 could not settle — the lines that would have
      // answered it had already rotated out of the founder's log.
      syncTimeline.annotate("backup", {
        bytes: backupResult.backupSize,
        incremental: backupResult.isIncremental,
        encrypted: !!backupResult.isEncrypted,
      });

      let backupPath = backupResult.backupPath;

      // Step 2: Decrypt if needed
      if (backupResult.isEncrypted) {
        if (!options.password) {
          this.isRunning = false;
          this.emit("password-required");
          return this.errorResult("Password required for encrypted backup");
        }

        this.setPhase("decrypting");
        this.emitProgress({
          phase: "decrypting",
          phaseProgress: 0,
          overallProgress: this.calculateOverallProgress("decrypting", 0),
          message: "Decrypting backup...",
        });

        const decryptResult = await this.decryptionService.decryptBackup(
          backupPath,
          options.password,
        );

        if (this.abortController?.signal.aborted) {
          this.isRunning = false;
          return this.errorResult("Sync cancelled by user");
        }

        if (!decryptResult.success || !decryptResult.decryptedPath) {
          this.isRunning = false;
          return this.errorResult(decryptResult.error || "Decryption failed");
        }

        backupPath = decryptResult.decryptedPath;
      }

      // Step 3: Parse contacts
      this.setPhase("parsing-contacts");
      this.emitProgress({
        phase: "parsing-contacts",
        phaseProgress: 0,
        overallProgress: this.calculateOverallProgress("parsing-contacts", 0),
        message: "Reading contacts...",
      });

      this.contactsParser.open(backupPath);
      const contacts = this.contactsParser.getAllContacts();

      this.emitProgress({
        phase: "parsing-contacts",
        phaseProgress: 100,
        overallProgress: this.calculateOverallProgress("parsing-contacts", 100),
        message: `Found ${contacts.length} contacts`,
      });

      // BACKLOG-2898/2894: what this phase produced.
      syncTimeline.annotate("parsing-contacts", { contacts: contacts.length });

      if (this.abortController?.signal.aborted) {
        this.isRunning = false;
        this.contactsParser.close();
        return this.errorResult("Sync cancelled by user");
      }

      // Step 4: Parse messages (using async methods to prevent UI blocking)
      this.setPhase("parsing-messages");
      this.emitProgress({
        phase: "parsing-messages",
        phaseProgress: 0,
        overallProgress: this.calculateOverallProgress("parsing-messages", 0),
        message: "Reading messages...",
      });

      this.messagesParser.open(backupPath);

      // Use async method with progress callback
      const conversations = await this.messagesParser.getConversationsAsync(
        (current, total) => {
          const progress = (current / total) * 50; // First 50% is getting conversation list
          this.emitProgress({
            phase: "parsing-messages",
            phaseProgress: progress,
            overallProgress: this.calculateOverallProgress(
              "parsing-messages",
              progress,
            ),
            message: `Scanning chats: ${current}/${total}`,
          });
        },
      );

      // Load messages for each conversation using async method
      let loadedCount = 0;
      for (const conv of conversations) {
        if (this.abortController?.signal.aborted) {
          break;
        }

        conv.messages = await this.messagesParser.getMessagesAsync(conv.chatId);
        loadedCount++;

        // Report progress every 10 conversations (second 50%)
        if (loadedCount % 10 === 0 || loadedCount === conversations.length) {
          const progress = 50 + (loadedCount / conversations.length) * 50;
          this.emitProgress({
            phase: "parsing-messages",
            phaseProgress: progress,
            overallProgress: this.calculateOverallProgress(
              "parsing-messages",
              progress,
            ),
            message: `Loading conversations: ${loadedCount}/${conversations.length}`,
          });
        }
      }

      if (this.abortController?.signal.aborted) {
        this.isRunning = false;
        this.messagesParser.close();
        this.contactsParser.close();
        return this.errorResult("Sync cancelled by user");
      }

      // BACKLOG-2898/2894: what the parsing phase produced.
      syncTimeline.annotate("parsing-messages", {
        conversations: conversations.length,
        messages: conversations.reduce((sum, c) => sum + c.messages.length, 0),
      });

      // Step 5: Resolve contact names
      this.setPhase("resolving");
      this.emitProgress({
        phase: "resolving",
        phaseProgress: 0,
        overallProgress: this.calculateOverallProgress("resolving", 0),
        message: "Resolving contact names...",
      });

      const resolvedConversations = this.resolveContactNames(
        conversations,
        contacts,
      );

      // Step 6: Close parsers (but don't cleanup backup yet - needed for attachments)
      this.setPhase("cleanup");
      this.emitProgress({
        phase: "cleanup",
        phaseProgress: 0,
        overallProgress: this.calculateOverallProgress("cleanup", 0),
        message: "Finalizing...",
      });

      this.messagesParser.close();
      this.contactsParser.close();

      // SPRINT-068: Don't cleanup decrypted files here - needed for attachment extraction
      // Cleanup will be triggered by sync-handlers after persistence is complete
      const needsCleanup = backupResult.isEncrypted && backupPath !== backupResult.backupPath;

      // Calculate all messages from conversations
      const allMessages = resolvedConversations.flatMap((c) => c.messages);

      const duration = Date.now() - this.startTime;
      this.isRunning = false;
      this.setPhase("complete");

      log.info("[DeviceSyncOrchestrator] Sync complete", {
        conversations: resolvedConversations.length,
        messages: allMessages.length,
        contacts: contacts.length,
        duration,
        backupPath,
        needsCleanup,
      });

      const result: SyncResult = {
        success: true,
        messages: allMessages,
        contacts,
        conversations: resolvedConversations,
        error: null,
        duration,
        backupPath,  // SPRINT-068: Pass for attachment extraction
        needsCleanup, // SPRINT-068: Caller should cleanup after persistence
        sessionId,   // TASK-2110: For ACID rollback on cancel
      };

      this.emit("complete", result);
      return result;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      log.error("[DeviceSyncOrchestrator] Sync failed", { error: errorMessage });
      Sentry.captureException(error, {
        tags: { service: "sync-orchestrator", operation: "sync" },
      });

      // Cleanup on error
      try {
        this.messagesParser.close();
        this.contactsParser.close();
      } catch {
        // Ignore cleanup errors
      }

      this.isRunning = false;
      this.setPhase("error");
      this.emit("error", error);

      return this.errorResult(errorMessage);
    }
  }

  /**
   * Cancel the current sync operation
   */
  cancel(): void {
    log.info("[DeviceSyncOrchestrator] Cancelling sync");
    this.abortController?.abort();
    // Don't null the controller -- sync() checks signal.aborted at checkpoints
    // and the next sync()/processExistingBackup() call creates a fresh controller.
    this.isRunning = false;
    // Always cancel backup service — even if orchestrator thinks it's not running,
    // the backup process may still be alive (race condition on disconnect/error)
    this.backupService.cancelBackup();
    this.setPhase("idle");
  }

  /**
   * Get current sync status
   */
  getStatus(): { isRunning: boolean; phase: SyncPhase } {
    return {
      isRunning: this.isRunning,
      phase: this.currentPhase,
    };
  }

  /**
   * Cleanup decrypted backup files after persistence is complete (SPRINT-068)
   * @param backupPath Path to the decrypted backup directory
   */
  async cleanupBackup(backupPath: string): Promise<void> {
    if (!backupPath) return;

    try {
      log.info("[DeviceSyncOrchestrator] Cleaning up decrypted backup", { backupPath });
      await this.decryptionService.cleanup(backupPath);
      log.info("[DeviceSyncOrchestrator] Backup cleanup complete");
    } catch (error) {
      log.warn("[DeviceSyncOrchestrator] Backup cleanup failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      Sentry.captureException(error, {
        tags: { service: "sync-orchestrator", operation: "cleanupBackup" },
      });
    }
  }

  /**
   * Force reset sync state (use when sync gets stuck)
   */
  forceReset(): void {
    log.warn("[DeviceSyncOrchestrator] Force resetting sync state");
    this.abortController?.abort();
    this.abortController = null;
    this.isRunning = false;
    this.currentPhase = "idle";
    this.estimatedBackupSize = 0;
  }

  /**
   * Check if a backup should be processed or skipped (TASK-908)
   *
   * Compares the current backup's Manifest.db hash against the last
   * successfully synced backup. If unchanged, the backup can be skipped.
   *
   * @param backupPath Full path to the backup directory
   * @returns true if backup should be processed, false if it can be skipped
   */
  async shouldProcessBackup(backupPath: string): Promise<boolean> {
    try {
      const metadata = await this.backupService.getBackupMetadata(backupPath);

      // Can't determine state - process anyway to be safe
      if (!metadata) {
        log.info(
          "[DeviceSyncOrchestrator] No backup metadata available, will process backup"
        );
        return true;
      }

      // No previous sync recorded - first sync, must process
      if (!this.lastBackupSync) {
        log.info(
          "[DeviceSyncOrchestrator] No previous sync recorded, will process backup"
        );
        return true;
      }

      // Different backup path - process (could be different device)
      if (this.lastBackupSync.backupPath !== backupPath) {
        log.info(
          "[DeviceSyncOrchestrator] Different backup path, will process backup"
        );
        return true;
      }

      // Compare manifest hashes
      if (this.lastBackupSync.manifestHash === metadata.manifestHash) {
        const timeSinceLastSync = Math.round(
          (Date.now() - this.lastBackupSync.syncedAt.getTime()) / 1000 / 60
        );
        log.info(
          `[DeviceSyncOrchestrator] Backup unchanged since last sync (${timeSinceLastSync} min ago), skipping re-parse`
        );
        return false;
      }

      log.info(
        "[DeviceSyncOrchestrator] Backup manifest changed, will process backup"
      );
      return true;
    } catch (error) {
      log.error(
        "[DeviceSyncOrchestrator] Error checking if backup should be processed:",
        error
      );
      Sentry.captureException(error, {
        tags: { service: "sync-orchestrator", operation: "shouldProcessBackup" },
      });
      // On error, process anyway to be safe
      return true;
    }
  }

  /**
   * Record a successful backup sync for future skip detection (TASK-908)
   *
   * @param backupPath Full path to the backup directory
   * @param manifestHash SHA-256 hash of the Manifest.db file
   */
  recordBackupSync(backupPath: string, manifestHash: string): void {
    this.lastBackupSync = {
      backupPath,
      manifestHash,
      syncedAt: new Date(),
    };
    log.info("[DeviceSyncOrchestrator] Recorded backup sync:", {
      backupPath,
      manifestHash: manifestHash.substring(0, 16) + "...",
      syncedAt: this.lastBackupSync.syncedAt.toISOString(),
    });
  }

  /**
   * Clear the last backup sync record (TASK-908)
   *
   * Use this to force a full re-sync on the next sync operation.
   */
  clearLastBackupSync(): void {
    this.lastBackupSync = null;
    log.info("[DeviceSyncOrchestrator] Cleared last backup sync record");
  }

  /**
   * Get connected devices
   */
  getConnectedDevices(): iOSDevice[] {
    return this.deviceService.getConnectedDevices();
  }

  /**
   * Start device detection polling
   */
  startDeviceDetection(intervalMs: number = 2000): void {
    this.deviceService.start(intervalMs);
  }

  /**
   * Stop device detection polling
   */
  stopDeviceDetection(): void {
    this.deviceService.stop();
  }

  /**
   * Resolve contact names in conversations
   */
  private resolveContactNames(
    conversations: iOSConversation[],
    _contacts: iOSContact[],
  ): iOSConversation[] {
    return conversations.map((conv) => {
      // Resolve participants to display names
      const resolvedParticipants = conv.participants.map((handle) => {
        const lookup = this.contactsParser.lookupByHandle(handle);
        return lookup.contact?.displayName || handle;
      });

      // Update conversation with resolved names
      return {
        ...conv,
        participants: resolvedParticipants,
        // Optionally resolve sender names in messages
        messages: conv.messages.map((msg) => {
          if (!msg.isFromMe && msg.handle) {
            // Lookup performed for side effects; UI can use contacts for display
            this.contactsParser.lookupByHandle(msg.handle);
          }
          return msg;
        }),
      };
    });
  }

  /**
   * Set the current phase and emit event
   */
  private setPhase(phase: SyncPhase): void {
    this.currentPhase = phase;

    // BACKLOG-2898: one timeline record per back-end step, with its duration
    // and the counts it produced. Terminal states are not phases — "complete"
    // hands off to persistence in syncHandlers, which opens the storing:*
    // phases and ends the sync; the open phase is closed by that next enter().
    if (phase !== "idle" && phase !== "complete" && phase !== "error") {
      syncTimeline.enter(phase);
    }

    this.emit("phase", phase);
  }

  /**
   * Emit a progress event
   */
  private emitProgress(progress: SyncProgress): void {
    this.emit("progress", progress);
  }

  /**
   * Calculate overall progress based on phase weights
   */
  private calculateOverallProgress(
    phase: SyncPhase,
    phaseProgress: number,
  ): number {
    const phaseWeights: Record<SyncPhase, { start: number; weight: number }> = {
      idle: { start: 0, weight: 0 },
      backup: { start: 0, weight: 60 }, // Backup is the longest phase
      decrypting: { start: 60, weight: 10 },
      "parsing-contacts": { start: 70, weight: 5 },
      "parsing-messages": { start: 75, weight: 15 },
      resolving: { start: 90, weight: 5 },
      cleanup: { start: 95, weight: 5 },
      complete: { start: 100, weight: 0 },
      error: { start: 0, weight: 0 },
    };

    const config = phaseWeights[phase];
    return config.start + (phaseProgress / 100) * config.weight;
  }

  /**
   * Get a human-readable backup progress message
   * Note: We avoid showing per-file percentages as they can be confusing
   * (each file goes 0-100%, not overall progress)
   */
  private getBackupProgressMessage(progress: BackupProgress): string {
    // BACKLOG-1628: If the backup service provides a specific message
    // (e.g., from stderr debug parsing), use it directly.
    if (progress.message) {
      return progress.message;
    }

    switch (progress.phase) {
      case "preparing":
        // This phase can take several minutes while device:
        // 1. Verifies backup password (if encrypted)
        // 2. Compares existing backup with current device state
        // 3. Builds list of files that need to be transferred
        return "iPhone is preparing backup... This may take several minutes.";
      case "transferring":
        // Show descriptive message based on progress
        if (progress.filesTransferred && progress.filesTransferred > 0) {
          return "Receiving files from iPhone...";
        }
        return "Starting file transfer...";
      case "finishing":
        return "Finalizing backup...";
      case "extracting":
        return "Extracting messages and contacts...";
      case "decrypting":
        return "Decrypting backup data...";
      default:
        return "Processing...";
    }
  }

  /**
   * Check if computer has enough disk space for backup
   * @param requiredBytes Minimum bytes needed
   * @returns Object with hasEnoughSpace and availableSpace
   */
  private async checkAvailableDiskSpace(requiredBytes: number): Promise<{
    hasEnoughSpace: boolean;
    availableSpace: number;
  }> {
    try {
      // Check disk space on the drive where app data is stored
      const appDataPath = app.getPath("userData");
      const diskInfo = await checkDiskSpace(path.parse(appDataPath).root);

      log.info(`[DeviceSyncOrchestrator] Disk space: ${Math.round(diskInfo.free / 1024 / 1024 / 1024)} GB free on ${diskInfo.diskPath}`);

      return {
        hasEnoughSpace: diskInfo.free >= requiredBytes,
        availableSpace: diskInfo.free,
      };
    } catch (err) {
      log.error("[DeviceSyncOrchestrator] Failed to check disk space:", err);
      Sentry.captureException(err, {
        tags: { service: "sync-orchestrator", operation: "checkAvailableDiskSpace" },
      });
      // If we can't check, assume we have enough space and let backup fail naturally if not
      return {
        hasEnoughSpace: true,
        availableSpace: 0,
      };
    }
  }

  /**
   * Process an existing backup without running a new backup
   * Useful for testing and debugging the extraction/storage pipeline
   *
   * @param udidOrOptions Either UDID string (legacy) or ProcessBackupOptions object
   * @param password Optional password (only used with legacy UDID string param)
   */
  async processExistingBackup(
    udidOrOptions: string | ProcessBackupOptions,
    password?: string
  ): Promise<SyncResult> {
    // Handle both legacy (string, string) and new options-based signatures
    const options =
      typeof udidOrOptions === "string"
        ? { udid: udidOrOptions, password, forceResync: false }
        : udidOrOptions;

    if (this.isRunning) {
      return this.errorResult("Sync already in progress");
    }

    this.isRunning = true;
    this.abortController = new AbortController();
    this.startTime = Date.now();

    // TASK-2110: Generate session ID for ACID rollback on cancel
    const sessionId = crypto.randomUUID();

    try {
      // Get backup path - construct from app's userData folder
      const { app } = await import("electron");
      const pathModule = await import("path");
      const backupPath = pathModule.join(
        app.getPath("userData"),
        "Backups",
        options.udid
      );
      log.info("[DeviceSyncOrchestrator] Processing existing backup", {
        udid: options.udid,
        backupPath,
        forceResync: options.forceResync ?? false,
      });

      // Check if backup exists
      const backupStatus = await this.backupService.checkBackupStatus(
        options.udid
      );
      if (!backupStatus || !backupStatus.exists) {
        this.isRunning = false;
        return this.errorResult("No existing backup found for this device");
      }

      if (!backupStatus.isComplete) {
        this.isRunning = false;
        return this.errorResult("Backup is incomplete or corrupted");
      }

      log.info("[DeviceSyncOrchestrator] Backup status", {
        exists: backupStatus.exists,
        isComplete: backupStatus.isComplete,
        sizeBytes: backupStatus.sizeBytes,
      });

      // TASK-908: Check if backup should be processed or skipped
      if (!options.forceResync) {
        const shouldProcess = await this.shouldProcessBackup(backupPath);
        if (!shouldProcess) {
          this.isRunning = false;
          this.setPhase("complete");

          const result: SyncResult = {
            success: true,
            messages: [],
            contacts: [],
            conversations: [],
            error: null,
            duration: Date.now() - this.startTime,
            skipped: true,
            skipReason: "unchanged",
          };

          log.info("[DeviceSyncOrchestrator] Skipped unchanged backup", {
            duration: result.duration,
          });
          this.emit("complete", result);
          return result;
        }
      } else {
        log.info(
          "[DeviceSyncOrchestrator] Force resync requested, skipping change detection"
        );
      }

      // Check if backup is encrypted and decrypt if needed
      let extractionPath = backupPath;
      const isEncrypted =
        await this.decryptionService.isBackupEncrypted(backupPath);

      if (isEncrypted) {
        if (!options.password) {
          this.isRunning = false;
          this.emit("password-required", {});
          return this.errorResult("Password required for encrypted backup");
        }

        this.setPhase("decrypting");
        this.emitProgress({
          phase: "decrypting",
          phaseProgress: 0,
          overallProgress: 10,
          message: "Decrypting backup...",
        });

        const decryptResult = await this.decryptionService.decryptBackup(
          backupPath,
          options.password
        );

        if (!decryptResult.success || !decryptResult.decryptedPath) {
          this.isRunning = false;
          return this.errorResult(decryptResult.error || "Decryption failed");
        }

        extractionPath = decryptResult.decryptedPath;
      }

      // Parse contacts
      this.setPhase("parsing-contacts");
      this.emitProgress({
        phase: "parsing-contacts",
        phaseProgress: 0,
        overallProgress: 30,
        message: "Reading contacts...",
      });

      this.contactsParser.open(extractionPath);
      const contacts = this.contactsParser.getAllContacts();

      this.emitProgress({
        phase: "parsing-contacts",
        phaseProgress: 100,
        overallProgress: 40,
        message: `Found ${contacts.length} contacts`,
      });

      // Parse messages (using async methods to prevent UI blocking)
      this.setPhase("parsing-messages");
      this.emitProgress({
        phase: "parsing-messages",
        phaseProgress: 0,
        overallProgress: 40,
        message: "Reading messages...",
      });

      this.messagesParser.open(extractionPath);

      // Use async method with progress callback
      const conversations = await this.messagesParser.getConversationsAsync(
        (current, total) => {
          const progress = (current / total) * 50; // First 50% is getting conversation list
          this.emitProgress({
            phase: "parsing-messages",
            phaseProgress: progress,
            overallProgress: 40 + progress * 0.25,
            message: `Scanning chats: ${current}/${total}`,
          });
        },
      );

      // Load messages for each conversation using async method
      let loadedCount = 0;
      for (const conv of conversations) {
        if (this.abortController?.signal.aborted) {
          break;
        }

        conv.messages = await this.messagesParser.getMessagesAsync(conv.chatId);
        loadedCount++;

        // Report progress every 10 conversations (second 50%)
        if (loadedCount % 10 === 0 || loadedCount === conversations.length) {
          const progress = 50 + (loadedCount / conversations.length) * 50;
          this.emitProgress({
            phase: "parsing-messages",
            phaseProgress: progress,
            overallProgress: 40 + progress * 0.5,
            message: `Loading conversations: ${loadedCount}/${conversations.length}`,
          });
        }
      }

      if (this.abortController?.signal.aborted) {
        this.messagesParser.close();
        this.contactsParser.close();
        return this.errorResult("Processing cancelled by user");
      }

      // Resolve contact names
      this.setPhase("resolving");
      this.emitProgress({
        phase: "resolving",
        phaseProgress: 0,
        overallProgress: 90,
        message: "Resolving contact names...",
      });

      const resolvedConversations = this.resolveContactNames(conversations, contacts);

      // Cleanup
      this.setPhase("cleanup");
      this.messagesParser.close();
      this.contactsParser.close();

      // Cleanup decrypted files if we decrypted
      if (isEncrypted && extractionPath !== backupPath) {
        await this.decryptionService.cleanup(extractionPath);
      }

      // Calculate all messages from conversations
      const allMessages = resolvedConversations.flatMap((c) => c.messages);

      const duration = Date.now() - this.startTime;
      this.isRunning = false;
      this.setPhase("complete");

      log.info("[DeviceSyncOrchestrator] Processing complete", {
        conversations: resolvedConversations.length,
        messages: allMessages.length,
        contacts: contacts.length,
        duration,
      });

      // TASK-908: Record successful sync for future skip detection
      const metadata = await this.backupService.getBackupMetadata(backupPath);
      if (metadata) {
        this.recordBackupSync(backupPath, metadata.manifestHash);
      }

      const result: SyncResult = {
        success: true,
        messages: allMessages,
        contacts,
        conversations: resolvedConversations,
        error: null,
        duration,
        sessionId,   // TASK-2110: For ACID rollback on cancel
      };

      this.emit("complete", result);
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error("[DeviceSyncOrchestrator] Processing failed", { error: errorMessage });
      Sentry.captureException(error, {
        tags: { service: "sync-orchestrator", operation: "processExistingBackup" },
      });

      try {
        this.messagesParser.close();
        this.contactsParser.close();
      } catch {
        // Ignore cleanup errors
      }

      this.isRunning = false;
      this.setPhase("error");
      this.emit("error", error);

      return this.errorResult(errorMessage);
    }
  }

  /**
   * Create an error result
   */
  private errorResult(error: string): SyncResult {
    // BACKLOG-2898: close the timeline on every failure and cancel path.
    // The guard distinguishes the ONE reentrant caller ("Sync already in
    // progress", reached while isRunning is still true for the OTHER sync)
    // from genuine terminations, which all clear isRunning first.
    if (!this.isRunning) {
      syncTimeline.endSync(/cancelled/i.test(error) ? "cancelled" : "error");
    }

    return {
      success: false,
      messages: [],
      contacts: [],
      conversations: [],
      error,
      duration: Date.now() - this.startTime,
    };
  }
}

// Export singleton instance
export const deviceSyncOrchestrator = new DeviceSyncOrchestrator();
export default deviceSyncOrchestrator;
