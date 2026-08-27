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
import {
  checkDiskSpaceForOperation,
  DISK_SPACE_THRESHOLDS,
} from "./diagnostics/diskSpaceDiagnostics";
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
import type { BackupProgress, BackupResult } from "../types/backup";

/**
 * BACKLOG-2917: what we actually know about a previous backup before sizing this one.
 *
 * This replaces `let existingBackupSize = 0`, whose `0` meant both "there is no
 * previous backup" and "the check failed". Every consumer keyed off `> 0`, so an
 * unknown silently became a first sync — in the estimate, in the headroom branch and,
 * once BACKLOG-2898 added the mark, in the telemetry that was built to settle exactly
 * this question.
 *
 * `unknown` carries no `bytes` on purpose. A caller cannot accidentally size a disk
 * guard against a number it was never given.
 */
type PriorBackupBasis =
  /** A previous backup was found and its size measured. */
  | { kind: "measured"; bytes: number }
  /** `fs.stat` returned ENOENT: proven first sync. */
  | { kind: "none" }
  /** The check threw, or the size walk failed. Proven: nothing. */
  | { kind: "unknown"; reason: string };

/**
 * The `source` field of the `backup-estimate` mark.
 *
 * BACKLOG-2898 built `source` to name WHICH BRANCH RAN, so BACKLOG-2894 can aggregate
 * over it. Two branches sharing one label would defeat that, which is why the
 * device-storage-unavailable case below gets its own value rather than reusing
 * `"unknown"` — device storage being unreadable says nothing about whether a prior
 * backup exists, and the two unknowns are independent.
 */
type EstimateSource =
  | "existing-backup"
  | "device-storage"
  | "unknown"
  | "device-storage-unavailable";

function estimateSourceFor(basis: PriorBackupBasis): EstimateSource {
  switch (basis.kind) {
    case "measured":
      return "existing-backup";
    case "none":
      return "device-storage";
    case "unknown":
      return "unknown";
    default: {
      // Adding a basis without deciding what it reports fails to compile here.
      const exhaustive: never = basis;
      return exhaustive;
    }
  }
}

/**
 * BACKLOG-2899: how often free space is re-measured while the backup runs.
 *
 * The up-front check is not, on its own, a safety property. It multiplies
 * `storageInfo.estimatedBackupSize` — a figure the code's own comment calls
 * "less accurate", derived from the phone's used space — by a fixed headroom and
 * then, before this change, did not refuse on the result at all: it logged
 * "Proceeding anyway" and continued.
 *
 * A first sync is the exposed case. There is no prior backup to measure, so the
 * check runs on that derived figure, while a first full backup lands on the
 * order of tens of GB — ~59 GB on the founder's Windows machine. A single
 * up-front number cannot carry that alone, so the guard also measures as it goes.
 *
 * NOTE ON PROVENANCE: an earlier version of this comment claimed a 15.9x
 * underestimate on a specific run. That figure was derived from a
 * `bytesTransferred` progress value mistaken for an estimate; the real line was
 * `Using existing backup size for estimate: 55 GB` against a ~59 GB backup —
 * about 7% under, on the branch that HAS a prior backup to measure. Corrected
 * here rather than quietly deleted, because that number had already propagated
 * into four backlog items. Accuracy of the estimate itself is BACKLOG-2896.
 */
export const SYNC_DISK_POLL_INTERVAL_MS = 5000;

/**
 * BACKLOG-2899: free space the sync will not consume, in bytes.
 *
 * DERIVED, not picked:
 *
 *   DISK_SPACE_THRESHOLDS.sync   2048 MB   what the rest of the sync pipeline
 *                                          (decrypt, parse, store) already
 *                                          declares it needs to run at all
 *   one poll of drift             256 MB   a BOUND, not a measurement: local
 *                                          iPhone backups run at roughly
 *                                          30-40 MB/s, so a 5 s poll can miss
 *                                          ~200 MB at the top of that range;
 *                                          rounded up
 *   ------------------------------------
 *   reserve                      2304 MB
 *
 * The drift term is deliberately an upper bound rather than an observed rate —
 * it is only ever wrong in the safe direction, and no transfer-rate measurement
 * from this codebase is currently trustworthy enough to derive it from. (An
 * earlier version cited ~40 MB/s as measured, computed from a directory
 * footprint over a wall-clock duration; the footprint is not bytes transferred,
 * and run-to-run growth on that machine was ~150 MB.)
 *
 * This is a FLOOR the sync defends, not a prediction of backup size — the same
 * stance as `DISK_SPACE_THRESHOLDS.messagesImport`. It deliberately says nothing
 * about how large the backup will be, because nothing available up front does.
 */
export const SYNC_DISK_RESERVE_BYTES =
  (DISK_SPACE_THRESHOLDS.sync + 256) * 1024 * 1024;

/**
 * BACKLOG-2899 x BACKLOG-2898: how far free space must move before a poll earns
 * a log line.
 *
 * The monitor measures every 5 s — across a 24.4-minute backup that is ~293
 * readings. Writing all of them reintroduces exactly what BACKLOG-2898 removed:
 * the founder's log went from 4,023 lines to ~100 for this workload, and 293
 * identical "64 GB free" lines would nearly triple it again. Free space that has
 * not moved is not news.
 *
 * 5 GB is sized against the largest backup footprint observed, ~59 GB: a 5 GB
 * step emits ~12 lines at that extreme and one line for an ordinary incremental
 * sync — a small fraction of 2898's ~100-line budget.
 *
 * The measurement interval is NOT the lever here. SYNC_DISK_RESERVE_BYTES bounds
 * its 256 MB drift term at one poll; polling less often widens the window in
 * which the disk can fill undetected. Change what is written, never how often it
 * is measured.
 */
export const SYNC_DISK_LOG_DELTA_BYTES = 5 * 1024 * 1024 * 1024;

/**
 * BACKLOG-2899: within this multiple of the reserve, the sync is approaching the
 * event the guard exists for, and every step gets louder rather than quieter.
 */
export const SYNC_DISK_NEAR_RESERVE_MULTIPLIER = 2;

/**
 * BACKLOG-2899: inside the near-reserve band, 5 GB is coarser than the reserve
 * itself (2304 MB) and would hide the entire run-up. Step down to the reserve's
 * own drift term so the approach is visible.
 */
export const SYNC_DISK_NEAR_RESERVE_LOG_DELTA_BYTES = 256 * 1024 * 1024;

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

  /** BACKLOG-2899: mid-transfer free-space monitor */
  private diskSpaceMonitor: NodeJS.Timeout | null = null;
  private diskSpaceAborted: boolean = false;
  private diskSpaceAtAbort: number = 0;

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

      // BACKLOG-2917: `let existingBackupSize = 0` used to live here, and it was the
      // same defect wearing a second costume — `0` meant BOTH "no prior backup" and
      // "we could not find out". Every decision below then keyed off `> 0`, so an
      // unknown silently selected the first-sync path and the telemetry recorded it
      // as fact. The basis is now named, so "we do not know" is a value the estimate,
      // the headroom and the mark all have to handle explicitly.
      let priorBackup: PriorBackupBasis;

      if (backupStatus.state === "unknown") {
        // Proven: nothing. Do NOT say "first sync" — that is the 2917 defect, and
        // BACKLOG-2886's rule is that uncertainty must refuse, never substitute.
        priorBackup = { kind: "unknown", reason: backupStatus.reason };
        log.error(
          `[DeviceSyncOrchestrator] Could not establish whether a previous backup exists (${backupStatus.reason}); NOT treating this as a first sync.`,
        );
        this.emitProgress({
          phase: "backup",
          phaseProgress: 0,
          overallProgress: 0,
          message: "Checking your iPhone...",
        });
      } else if (backupStatus.state === "present") {
        // The directory is there. Its SIZE is a separate three-state reading: a walk
        // that threw must not be reported as a measured prior backup.
        priorBackup = backupStatus.size.measured
          ? { kind: "measured", bytes: backupStatus.size.bytes }
          : { kind: "unknown", reason: `size-unmeasured: ${backupStatus.size.reason}` };

        if (!backupStatus.size.measured) {
          log.error(
            `[DeviceSyncOrchestrator] A previous backup exists but its size could not be measured (${backupStatus.size.reason}); estimating as if unknown, not as a first sync.`,
          );
        }

        const sizeGB = backupStatus.size.measured
          ? (backupStatus.size.bytes / 1024 / 1024 / 1024).toFixed(1)
          : null;

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
          // BACKLOG-2917: the size is reported only when it was measured. Printing
          // "null GB" or silently substituting "0.0 GB" would be the same class of
          // lie this item exists to remove, in the user-facing half of the app.
          log.warn(
            `[DeviceSyncOrchestrator] Previous backup did not finish (${sizeGB === null ? "size unmeasured" : `${sizeGB} GB on disk`}); starting a new backup. No host-side resume exists — see BACKLOG-2911.`,
          );
          this.emitProgress({
            phase: "backup",
            phaseProgress: 0,
            overallProgress: 0,
            message:
              sizeGB === null
                ? "Previous sync didn't finish. Starting over..."
                : `Previous sync didn't finish (${sizeGB} GB saved). Starting over...`,
          });
        } else if (backupStatus.isComplete) {
          const lastSync = backupStatus.lastModified;
          const timeSinceLastSync = lastSync ? Math.round((Date.now() - lastSync.getTime()) / 1000 / 60) : null;
          log.info(`[DeviceSyncOrchestrator] Previous backup exists (${sizeGB === null ? "size unmeasured" : `${sizeGB} GB`}), last modified ${timeSinceLastSync} minutes ago`);

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
            message:
              sizeGB === null
                ? `Found previous backup (synced ${timeAgoStr})`
                : `Found previous backup (${sizeGB} GB, synced ${timeAgoStr})`,
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
        // BACKLOG-2917: reached ONLY on a proven ENOENT. Before this item the same
        // branch also absorbed every failed check, which is how a thrown check came
        // to announce a first sync to the user and to the telemetry.
        priorBackup = { kind: "none" };
        this.emitProgress({
          phase: "backup",
          phaseProgress: 0,
          overallProgress: 0,
          message: "Preparing first sync (this may take a while)...",
        });
      }

      // BACKLOG-2899: Refuse up front when free space is ALREADY below the
      // reserve the mid-transfer monitor defends. Same constant, same semantic:
      // if the first poll would abort the backup, do not start it.
      //
      // Deliberately NOT a refusal on `estimate x headroom`: the reserve is the
      // only number here that does not depend on the estimate at all, and a
      // refusal on the FIRST-sync branch would rest on `0.25 x used space`,
      // which no measurement in this codebase currently validates (BACKLOG-2896;
      // the ratio's stated basis is itself disputed by BACKLOG-2910).
      //
      // This is narrower than it should be. On the `existingBackupSize > 0`
      // branch the estimate is a PRIOR BACKUP'S MEASURED SIZE and was ~7% under
      // on the founder's run, so refusing up front there would cost a user
      // nothing while a mid-transfer abort costs a full 20-25 minute run. That
      // is filed separately; this change does not make it.
      const reserveCheck = await this.checkAvailableDiskSpace(
        SYNC_DISK_RESERVE_BYTES,
      );
      if (!reserveCheck.hasEnoughSpace) {
        const userError = formatDiskSpaceError(
          Math.round(reserveCheck.availableSpace / 1024 / 1024),
          Math.round(SYNC_DISK_RESERVE_BYTES / 1024 / 1024),
        );
        log.warn("[DeviceSyncOrchestrator] Sync refused: free space below reserve", {
          availableBytes: reserveCheck.availableSpace,
          reserveBytes: SYNC_DISK_RESERVE_BYTES,
        });
        Sentry.captureMessage("Sync refused: free space below reserve", {
          level: "warning",
          tags: { service: "sync-orchestrator", failure_reason: "disk_space" },
          extra: {
            availableBytes: reserveCheck.availableSpace,
            reserveBytes: SYNC_DISK_RESERVE_BYTES,
          },
        });
        this.isRunning = false;
        this.emit("error", { message: userError.description, userError });
        return this.errorResult(userError.description);
      }

      // Step 1: Get device storage info to estimate backup size
      const storageInfo = await this.deviceService.getDeviceStorageInfo(options.udid);
      if (storageInfo) {
        // BACKLOG-2917: the estimate now branches on the NAMED basis, not on
        // `existingBackupSize > 0`. The old predicate could not tell a measured
        // prior backup from an unknown one, so uncertainty took the first-sync path
        // and was recorded as a fact.
        if (priorBackup.kind === "measured") {
          this.estimatedBackupSize = priorBackup.bytes;
          log.info(`[DeviceSyncOrchestrator] Using existing backup size for estimate: ${Math.round(this.estimatedBackupSize / 1024 / 1024 / 1024)} GB`);
        } else {
          this.estimatedBackupSize = storageInfo.estimatedBackupSize;
          log.info(`[DeviceSyncOrchestrator] Estimated backup size from storage: ${Math.round(this.estimatedBackupSize / 1024 / 1024)} MB (used space: ${Math.round(storageInfo.usedSpace / 1024 / 1024 / 1024)} GB)`);
        }

        // BACKLOG-2898/2896: the estimate BRANCH, on one greppable line. Which
        // branch ran is what says whether a previous backup was reused — the
        // question 2896 could not answer because both `log.info` lines above
        // had rotated out of main.log AND main.old.log before anyone looked.
        //
        // BACKLOG-2917: `source` has THREE values because the underlying question
        // has three answers. The instrument built to settle "did incremental run?"
        // previously printed the reassuring answer in the one case where the true
        // answer would be alarming.
        syncTimeline.mark("backup-estimate", {
          source: estimateSourceFor(priorBackup),
          bytes: this.estimatedBackupSize,
          reusedPreviousBackup: priorBackup.kind === "measured",
          ...(priorBackup.kind === "unknown" ? { priorBackupUnknownReason: priorBackup.reason } : {}),
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
        //
        // BACKLOG-2917: an UNKNOWN basis takes the 1.5x branch, not the 1.1x one.
        // 1.1x is justified by "the number is a prior backup's measured size on
        // disk"; when that has not been established, the justification is absent and
        // the estimate is the device-storage figure that 1.5x was sized for. The
        // multiplier matches the first-sync case, but the BRANCH is distinct and the
        // mark above records which one ran — uncertainty is never recorded as a
        // first sync.
        const headroom = priorBackup.kind === "measured" ? 1.1 : 1.5;
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

        // BACKLOG-2917: this branch emitted NO mark at all, so every sync that took
        // it was invisible in the aggregate BACKLOG-2894 is being built on — an
        // absence that reads as "this never happens" rather than "this was not
        // recorded". `source` is its own value, not `"unknown"`: device storage being
        // unreadable is a different fact from the prior-backup basis being unknown,
        // and the prior-backup basis is carried alongside so the two stay separable.
        syncTimeline.mark("backup-estimate", {
          source: "device-storage-unavailable" satisfies EstimateSource,
          priorBackup: priorBackup.kind,
          reusedPreviousBackup: false,
        });

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

      // BACKLOG-2899: re-measure free space WHILE the transfer runs.
      let backupResult: BackupResult;
      this.startDiskSpaceMonitor();
      try {
        backupResult = await this.backupService.startBackup({
          udid: options.udid,
          password: options.password,
          forceFullBackup: options.forceFullBackup,
        });
      } finally {
        this.stopDiskSpaceMonitor();
      }

      // BACKLOG-2899: the monitor cancelled the backup to protect the volume.
      //
      // The partial backup is deliberately left on disk — nothing on this path
      // deletes `Backups/<udid>`, so the next run's checkBackupStatus still
      // finds it. It does NOT follow that the next run continues from it:
      // BACKLOG-2911 measured the next sync starting from zero. Do not promise
      // resume in the message below until 2911 lands.
      if (this.diskSpaceAborted) {
        const freeGB = (this.diskSpaceAtAbort / 1024 / 1024 / 1024).toFixed(1);
        const reserveGB = (SYNC_DISK_RESERVE_BYTES / 1024 / 1024 / 1024).toFixed(1);
        const message =
          `Sync stopped to protect your computer: free disk space fell to ${freeGB} GB ` +
          `(below the ${reserveGB} GB this sync keeps in reserve) while the iPhone backup was running. ` +
          `The partial backup was kept on disk. Free up space and sync again — the next sync currently starts over rather than continuing from it.`;
        log.warn("[DeviceSyncOrchestrator] Sync aborted mid-transfer: disk space", {
          availableBytes: this.diskSpaceAtAbort,
          reserveBytes: SYNC_DISK_RESERVE_BYTES,
          estimatedBackupSize: this.estimatedBackupSize,
        });
        Sentry.captureMessage("Sync aborted mid-transfer to protect disk space", {
          level: "error",
          tags: { service: "sync-orchestrator", failure_reason: "disk_space" },
          extra: {
            availableBytes: this.diskSpaceAtAbort,
            reserveBytes: SYNC_DISK_RESERVE_BYTES,
            estimatedBackupSize: this.estimatedBackupSize,
          },
        });
        this.isRunning = false;
        this.setPhase("error");
        this.emit("error", { message });
        return this.errorResult(message);
      }

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
      //
      // BACKLOG-2917: `bytes` is omitted rather than zeroed when the size could not
      // be measured. This is the same instrument, one function away from the defect
      // 2917 describes: a backup that COMPLETED and then failed its size walk used to
      // be annotated `bytes: 0`, which reads in the timeline — and in the aggregate
      // BACKLOG-2894 will build — as a run that transferred nothing.
      syncTimeline.annotate("backup", {
        ...(backupResult.backupSize === null
          ? { bytesUnmeasured: true }
          : { bytes: backupResult.backupSize }),
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
   * BACKLOG-2899: watch free space for as long as the backup runs.
   *
   * Cancels the backup when free space falls below SYNC_DISK_RESERVE_BYTES.
   * This is the guard's actual safety property — on a FIRST sync the up-front
   * check has no prior backup to measure and consults a derived figure instead
   * (BACKLOG-2896), and idevicebackup2 cannot be relied on to report the
   * resulting full disk: transcribed from
   * tools/idevicebackup2.c mb2_handle_receive_files(), the host-side write is
   * `fwrite(buf, 1, r, f);` with the return value never checked and `fclose(f)`
   * likewise unchecked, so a full volume is silently absorbed and the tool can
   * still print "Backup Successful." Prevention, not detection.
   *
   * Touches neither `lastProgress` nor the zombie-process watchdog
   * (BACKLOG-1582/1628) — it only reads the local filesystem and, on abort,
   * calls the existing cancel path.
   */
  private startDiskSpaceMonitor(): void {
    this.stopDiskSpaceMonitor();
    this.diskSpaceAborted = false;
    this.diskSpaceAtAbort = 0;

    let pollInFlight = false;
    let lastLoggedFree: number | null = null;

    // BACKLOG-2899 x BACKLOG-2898: a reading is written only when it has MOVED.
    // Unchanged free space is not news; the ~293 readings a 24.4-minute backup
    // produces would otherwise nearly triple the log 2898 just cut to ~100 lines.
    // Nothing here changes how often the disk is measured — only what is written.
    const logReadingIfMaterial = (freeBytes: number): void => {
      const nearReserve =
        freeBytes < SYNC_DISK_RESERVE_BYTES * SYNC_DISK_NEAR_RESERVE_MULTIPLIER;
      const threshold = nearReserve
        ? SYNC_DISK_NEAR_RESERVE_LOG_DELTA_BYTES
        : SYNC_DISK_LOG_DELTA_BYTES;

      if (
        lastLoggedFree !== null &&
        Math.abs(freeBytes - lastLoggedFree) < threshold
      ) {
        return;
      }
      lastLoggedFree = freeBytes;

      const freeGB = (freeBytes / 1024 / 1024 / 1024).toFixed(1);
      if (nearReserve) {
        const reserveGB = (SYNC_DISK_RESERVE_BYTES / 1024 / 1024 / 1024).toFixed(1);
        log.warn(
          `[DeviceSyncOrchestrator] Backup disk space: ${freeGB} GB free — approaching the ${reserveGB} GB reserve`,
        );
      } else {
        log.info(`[DeviceSyncOrchestrator] Backup disk space: ${freeGB} GB free`);
      }
    };

    this.diskSpaceMonitor = setInterval(() => {
      if (pollInFlight || this.diskSpaceAborted) return;
      pollInFlight = true;

      void this.checkAvailableDiskSpace(SYNC_DISK_RESERVE_BYTES, { quiet: true })
        .then((check) => {
          // A fail-open default is not a reading — do not log 0 GB free.
          if (!check.unavailable) {
            logReadingIfMaterial(check.availableSpace);
          }

          // Fail-open by construction: checkAvailableDiskSpace returns
          // hasEnoughSpace=true when the check itself throws, so one transient
          // stat failure never kills a 20-minute backup. Act on the boolean,
          // never on availableSpace (which is 0 on that error path).
          if (check.hasEnoughSpace) return;

          this.diskSpaceAborted = true;
          this.diskSpaceAtAbort = check.availableSpace;
          log.error(
            `[DeviceSyncOrchestrator] Free space fell below reserve (${Math.round(check.availableSpace / 1024 / 1024)} MB) — cancelling backup`,
          );
          this.stopDiskSpaceMonitor();
          this.backupService.cancelBackup();
        })
        .finally(() => {
          pollInFlight = false;
        });
    }, SYNC_DISK_POLL_INTERVAL_MS);
  }

  /** BACKLOG-2899: stop the mid-transfer free-space monitor. */
  private stopDiskSpaceMonitor(): void {
    if (this.diskSpaceMonitor) {
      clearInterval(this.diskSpaceMonitor);
      this.diskSpaceMonitor = null;
    }
  }

  /**
   * Check if computer has enough disk space for backup
   * @param requiredBytes Minimum bytes needed
   * @returns Object with hasEnoughSpace and availableSpace
   */
  private async checkAvailableDiskSpace(
    requiredBytes: number,
    options?: { quiet?: boolean },
  ): Promise<{
    hasEnoughSpace: boolean;
    availableSpace: number;
    /** BACKLOG-2899: true when the check itself failed and the result is a fail-open default. */
    unavailable?: boolean;
  }> {
    try {
      // Check disk space on the drive where app data is stored
      const appDataPath = app.getPath("userData");
      const diskInfo = await checkDiskSpace(path.parse(appDataPath).root);

      // BACKLOG-2899: the mid-transfer monitor calls this ~293 times per backup
      // and logs its own readings only when they move (see startDiskSpaceMonitor).
      if (!options?.quiet) {
        log.info(`[DeviceSyncOrchestrator] Disk space: ${Math.round(diskInfo.free / 1024 / 1024 / 1024)} GB free on ${diskInfo.diskPath}`);
      }

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
        unavailable: true,
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
      // BACKLOG-2917: "no backup found" and "we could not find out" are different
      // answers and now produce different errors. The old predicate reported a failed
      // check to the user as a confident "No existing backup found for this device",
      // which sends them looking for a backup that may well be sitting on disk.
      if (backupStatus.state === "unknown") {
        this.isRunning = false;
        return this.errorResult(
          `Could not read the backup for this device (${backupStatus.reason}). The backup may still be there — this check failed, which is not the same as finding nothing.`,
        );
      }

      if (backupStatus.state === "absent") {
        this.isRunning = false;
        return this.errorResult("No existing backup found for this device");
      }

      if (!backupStatus.isComplete) {
        this.isRunning = false;
        return this.errorResult("Backup is incomplete or corrupted");
      }

      log.info("[DeviceSyncOrchestrator] Backup status", {
        state: backupStatus.state,
        isComplete: backupStatus.isComplete,
        sizeBytes: backupStatus.size.measured ? backupStatus.size.bytes : "unmeasured",
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
