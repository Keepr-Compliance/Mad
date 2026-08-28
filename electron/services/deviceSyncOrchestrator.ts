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
import type { PriorBackupState } from "../types/ipc/window-api-platform";
import { BackupDecryptionService } from "./backupDecryptionService";
import { iOSMessagesParser } from "./iosMessagesParser";
import { iOSContactsParser } from "./iosContactsParser";
import {
  checkDiskSpaceForOperation,
  DISK_SPACE_THRESHOLDS,
} from "./diagnostics/diskSpaceDiagnostics";
import {
  formatDiskSpaceError,
  formatUnknownBackupSizeError,
  formatMissingDriversError,
  formatDriverServiceStoppedError,
} from "./diagnostics/userFacingErrors";
import { checkAppleDrivers } from "./appleDriverService";
import { canUseLibimobiledevice } from "./libimobiledeviceService";
import type { iOSDevice, DeviceStorageInfo } from "../types/device";
import type { iOSMessage, iOSConversation } from "../types/iosMessages";
import type { iOSContact } from "../types/iosContacts";
import type {
  BackupProgress,
  BackupResult,
  BackupSnapshotState,
  BackupStatusReport,
} from "../types/backup";

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
  /** A COMPLETE, uninterrupted previous backup was found and its size measured. */
  | { kind: "measured"; bytes: number }
  /**
   * BACKLOG-2925: a previous backup is on disk and its size was measured, but the run
   * that produced it did not finish. The bytes are real; as an ESTIMATE they are a
   * lower bound BY CONSTRUCTION, because the run stopped early. Carried so telemetry
   * can report what was ignored — never used to size the estimate or the disk guard.
   */
  | { kind: "partial"; bytes: number }
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
  | "device-storage-unavailable"
  /**
   * BACKLOG-2925 (second pass): the device storage query ANSWERED and what it
   * answered cannot size anything — the founder's 2026-08-27 run returned
   * `{totalCapacity:0, availableSpace:0, usedSpace:0, estimatedBackupSize:0}`.
   * Distinct from `device-storage-unavailable` (the query returned nothing at all)
   * for the same reason that one exists: two different facts, and BACKLOG-2894 has
   * to be able to tell them apart when it asks how often the guard cannot size
   * itself.
   */
  | "device-storage-unusable";

/**
 * What the `backup-estimate` mark records for the snapshot dimension.
 *
 * BACKLOG-2926: this is a NAMED union, not `string`. The first version of this field
 * was `let snapshotStateForTelemetry: string = "no-backup"`, overwritten only on the
 * `present` arm — which reproduced the BACKLOG-2917 defect inside the very field added
 * to make that defect measurable: a run where the CHECK FAILED recorded
 * `snapshotState=no-backup`, identical to a proven ENOENT. The orchestrator logged
 * "NOT treating this as a first sync" ten lines above, and the telemetry then asserted
 * exactly that. `GROUP BY snapshotState` could not separate "we know there is none"
 * from "we could not find out".
 *
 * `"check-failed"` and `"no-backup"` are therefore distinct tokens, and the default is
 * gone: the value is derived from the report rather than initialised and overwritten.
 */
type MarkSnapshotState = BackupSnapshotState | "no-backup" | "check-failed";

/**
 * Exhaustive over the OUTER union. The `never` arm on the snapshot switch elsewhere
 * guards only the three snapshot states; this one guards the three report states, so a
 * fourth `BackupStatusReport` arm cannot silently inherit a neighbour's telemetry.
 */
function snapshotStateForMark(status: BackupStatusReport): MarkSnapshotState {
  switch (status.state) {
    case "present":
      return status.snapshotState;
    case "absent":
      // Proven ENOENT. There genuinely is no backup.
      return "no-backup";
    case "unknown":
      // The check itself failed. We established nothing — and must not say otherwise.
      return "check-failed";
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

/**
 * BACKLOG-2938: THE definition of "the prior backup on disk is any good".
 *
 * There is exactly one, and every site that needs the answer calls this. Before this
 * item there were two derivations of `isComplete && !isInterrupted` — one inside the
 * BACKLOG-2925 estimate gate, one absent entirely from the UI-facing mapping, which
 * keyed on EXISTENCE instead. That is how the founder's install came to be told
 * "Previous backup can't be used. Starting a fresh backup..." and, in the same run,
 * NOT told that the replacement is a multi-hour full transfer. One fact, two answers.
 *
 * BACKLOG-2911 (second pass): `!isInterrupted` IS GONE, and this is the whole of
 * that fix. The predicate now asks one question — IS THE INDEX INTACT? — because that
 * is the only thing the next run depends on.
 *
 * PROVEN BY A DELIBERATE INTERRUPTION, founder's machine, 2026-08-28. A complete
 * 57.57 GB backup, an incremental sync underway, the cable pulled mid-transfer, and
 * the directory measured before and after:
 *
 *   | Manifest.db sha | `fa9c84e8768334d3…`  ->  `fa9c84e8768334d3…`  IDENTICAL |
 *   | folder size     | 57.57 GB             ->  58.47 GB, the delta KEPT       |
 *   | IsFullBackup    | 0                    ->  0, still incremental           |
 *   | SnapshotState   | `finished`           ->  `uploading`  <- the ONLY change |
 *
 * `isInterrupted` is `snapshotState === "unfinished"`, so the ONE bit that moved was
 * the bit this predicate refused on. Keepr logged `isComplete=true, isInterrupted=true`
 * and threw away 57.9 GB it had just measured; the device then transferred
 * incrementally against that unchanged manifest at ~482 MB/min, growing the folder
 * from 58 GB rather than restarting at zero. **Keepr was more pessimistic about the
 * device's data than the device was.**
 *
 * There is no host-side resume being added here. There is none to add — see the
 * `unfinished` arm below, and BACKLOG-2911's original finding that `idevicebackup2`
 * never reads `Status.plist` on the backup path. The device resumes itself by diffing
 * a manifest the interruption never touched. All this predicate had to stop doing was
 * discard the manifest.
 *
 * WHY `isComplete` AND NOT `IsFullBackup === 0`, which the item proposed: `isComplete`
 * is already `Manifest.db && Info.plist` present (`backupService.checkBackupStatus`),
 * which IS the "the index is intact" test the experiment validated. `IsFullBackup` is
 * NOT on `BackupStatusReport` at all, and adding it would be wrong: it describes the
 * LAST RUN, not the directory, so a completed first-ever backup carries
 * `IsFullBackup: 1` + `SnapshotState: finished` — the most usable state that exists on
 * disk — and a predicate demanding `0` would refuse it.
 *
 * Deliberately NOT also `snapshotState === "finished"` — see the note at the estimate
 * gate, which explains why demoting a manifest-present / Status.plist-absent backup
 * would trade a measured number for a discredited one. That reasoning now covers
 * `"unfinished"` as well.
 *
 * THE GUARD THAT KEEPS THIS FROM BECOMING "ALWAYS REUSE": `isComplete` is false when
 * `Manifest.db` is missing, which is the founder's OTHER real state (2026-08-27:
 * `BackupState: empty`, `SnapshotState: uploading`, no manifest, 6.3 MB of
 * `Info.plist`). That directory is still refused, and must stay refused —
 * `deviceSyncOrchestrator.interruptedIsUsable-2911.test.ts` fails if it is not.
 * Reintroducing "always reuse" reintroduces BACKLOG-2925, which shipped three days
 * before this change.
 *
 * `state !== "present"` is `false` rather than a thrown narrow: `absent` and `unknown`
 * have no usable prior backup to speak of, and each caller decides separately what
 * that means for the state it reports.
 */
function isUsablePriorBackup(status: BackupStatusReport): boolean {
  return status.state === "present" && status.isComplete;
}

/**
 * BACKLOG-2925 (second pass): HOW MANY BYTES THE BACKUP IS EXPECTED TO NEED — as a
 * three-state reading, because on 2026-08-27 the answer was "we could not find out"
 * and the code had no way to say that.
 *
 * THE DEFECT, IN ONE LINE: `this.estimatedBackupSize = storageInfo.estimatedBackupSize`
 * accepted `0`, and `0 x 1.5 = 0`, so `checkAvailableDiskSpace(0)` returned
 * `hasEnoughSpace: true` and the app logged "Disk space check passed: 15 GB
 * available" for a backup that had measured 58.8 GB. The guard did not fail — it
 * reported success, which is worse, because a failure is visible.
 *
 * THIS IS THE THIRD FORM OF ONE DEFECT and the shape of the type is the response to
 * that. BACKLOG-2899: the guard warned and proceeded. BACKLOG-2925 (first pass): the
 * guard sized itself from a partial, a lower bound by construction. Now: the guard
 * sized itself from nothing. Each fix moved the failure one step upstream while
 * leaving `number` as the currency, and `number` cannot represent "unknown" — so
 * every upstream fix had to invent a stand-in, and every stand-in was spendable.
 *
 * `unknown` therefore carries NO `bytes` field. The disk guard cannot multiply what
 * it was never given: `estimate.bytes` does not compile until the caller has
 * narrowed the union, and there is nothing to reach for when it has not.
 */
type BackupSizeEstimate =
  | { kind: "known"; bytes: number; source: EstimateSource }
  | { kind: "unknown"; source: EstimateSource; reason: string };

/**
 * The single place a byte count becomes an estimate, and the single place it can be
 * refused. Pure and total: every input state names its own outcome.
 *
 * Note the ORDER. A measured prior backup is consulted BEFORE device storage, so a
 * failed storage query no longer discards a size we already had — before this, the
 * whole estimate lived inside `if (storageInfo)`, and a device that would not report
 * its capacity threw away a measured 58.8 GB prior backup along with it.
 */
function resolveBackupSizeEstimate(
  priorBackup: PriorBackupBasis,
  storageInfo: DeviceStorageInfo | null,
): BackupSizeEstimate {
  if (priorBackup.kind === "measured") {
    // A measured prior backup of zero bytes is not a backup; it is a walk that
    // returned nothing. Same rule as everything else here: not a size.
    return priorBackup.bytes > 0
      ? { kind: "known", bytes: priorBackup.bytes, source: "existing-backup" }
      : {
          kind: "unknown",
          source: "existing-backup",
          reason: "prior-backup-measured-zero-bytes",
        };
  }

  if (storageInfo === null) {
    // Previously this branch checked a flat 10 GB floor and proceeded regardless of
    // the outcome. It is the same epistemic state as the zeros below — the size is
    // not known — so it now reaches the same refusal rather than a sibling hole.
    return {
      kind: "unknown",
      source: "device-storage-unavailable",
      reason: "device-storage-query-returned-nothing",
    };
  }

  if (!(storageInfo.estimatedBackupSize > 0)) {
    // The founder's case. `!(x > 0)` rather than `x <= 0` so a NaN arriving from any
    // producer lands here too, instead of sliding through a comparison that is false
    // in both directions.
    return {
      kind: "unknown",
      source: "device-storage-unusable",
      reason: `device-storage-reported-no-usable-size (used=${storageInfo.usedSpace} total=${storageInfo.totalCapacity})`,
    };
  }

  return {
    kind: "known",
    bytes: storageInfo.estimatedBackupSize,
    // Unchanged for every known case: a partial and a proven-absent backup both
    // estimate from device storage, and an unknown BASIS is still its own label.
    source: estimateSourceFor(priorBackup),
  };
}

function estimateSourceFor(basis: PriorBackupBasis): EstimateSource {
  switch (basis.kind) {
    case "measured":
      return "existing-backup";
    case "partial":
      // The estimate does NOT come from the partial — it comes from device storage,
      // exactly as on a first sync. Reporting `existing-backup` here would be the
      // instrument lying, the same class as BACKLOG-2917: it would claim a measured
      // prior backup drove a number that it did not.
      return "device-storage";
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
  /**
   * BACKLOG-2907: prior-backup state for this device, attached centrally by
   * `emitProgress`. Call sites do not set it.
   */
  priorBackup?: PriorBackupState;
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
  /**
   * BACKLOG-2907: what we know about a prior backup for the device being synced.
   * Set once per run from `checkBackupStatus`, attached to every progress event by
   * `emitProgress`. Defaults to `"unknown"` so a run that fails before the check
   * reports uncertainty rather than inheriting the previous run's answer.
   */
  private priorBackup: PriorBackupState = "unknown";
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

    // BACKLOG-2911 (FIX 3): the event name is historical. It means "the device has not
    // started sending files yet", and a passcode prompt is one of at least three
    // causes — see `PASSCODE_WAIT_DETECTION_MS` in backupService.
    this.backupService.on("waiting-for-passcode", () => {
      log.info("[DeviceSyncOrchestrator] Device has not started sending files yet");
      this.emit("waiting-for-passcode");
    });

    this.backupService.on("passcode-entered", () => {
      // BACKLOG-2911 (FIX 3): marks the END of the wait, not the entry of a passcode.
      log.info("[DeviceSyncOrchestrator] Device started sending files; the wait is over");
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
    // BACKLOG-2907: a new run must establish its own answer. Without this reset the
    // early progress events of run 2 would carry run 1's prior-backup state.
    this.priorBackup = "unknown";
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
      // BACKLOG-2907 + BACKLOG-2917: record what this check actually established.
      //
      // #2413 wrote `backupStatus?.exists === true ? "exists" : "unknown"` and
      // documented `"none"` as NOT PRODUCED YET, naming the reason: `checkBackupStatus`
      // returned `null` both for ENOENT and for a thrown check, so "there is no prior
      // backup" could not be established. The banner gates on `priorBackup === "none"`,
      // so it rendered in NO reachable state — it went from always-on (2907's original
      // defect) to never-on.
      //
      // BACKLOG-2917 is what makes `"none"` producible. `absent` is a proven ENOENT;
      // `unknown` is a check that failed and establishes nothing. That distinction is
      // the entire reason this branch exists, and `backupStatus?.exists` no longer
      // compiles against the union, so this mapping could not be skipped at merge time.
      //
      // BACKLOG-2938 — THIS MAPPING FOLLOWS USABILITY, NOT EXISTENCE.
      //
      // What it used to do, and the argument for it, kept here so the next reader
      // does not re-derive the old rule and revert this:
      //
      //   > `present` maps to `"exists"` for COMPLETE AND PARTIAL ALIKE. 2925 asks
      //   > "may this size a disk guard?" — a partial may not, because it is a lower
      //   > bound by construction. 2907 asks "is the user on their first sync?" — a
      //   > partial means no, because a prior transfer already happened. Both are
      //   > correct in their own domain, and deliberately NOT unified here.
      //
      // That reasoning is SOUND for a genuine partial — a torn multi-GB transfer
      // where data really moved. It is FALSE for the state MEASURED on the founder's
      // production install: a device directory holding a 6.3 MB `Info.plist` and no
      // manifest, where nothing usable was ever transferred and the next sync is a
      // full one. Both land in `kind: "partial"` below; only one of them means "a
      // prior transfer already happened".
      //
      // In that state the app told him two things about one fact: the switch below
      // emits "Previous backup can't be used. Starting a fresh backup..." while
      // `"exists"` withheld "First sync may take up to two hours...". Founder ruling,
      // 2026-08-27: "if the sync isn't useable show the this may take two hours msg."
      // The banner is not a description of what is on disk — it is a warning that a
      // full transfer is coming — so it must be driven by the SAME determination that
      // produces the "can't be used" message.
      //
      //   present AND usable      -> "exists"   incremental; no banner
      //   present AND NOT usable  -> "none"     full transfer; SHOW the banner
      //   absent                  -> "none"     full transfer; SHOW the banner
      //   unknown                 -> "unknown"  establishes nothing; claim neither
      //
      // `usableAsPriorBackup` is hoisted here and consumed TWICE — by this mapping and
      // by the BACKLOG-2925 estimate basis below — because the defect this item fixes
      // was two sites answering "is the prior backup any good?" separately. Deriving
      // the condition again at either site is how it returns in a new form;
      // `deviceSyncOrchestrator.usabilityParity-2938.test.ts` pins the two together
      // through their observable outputs rather than through the predicate itself.
      //
      // This changes nothing about which number sizes the disk guard. 2925's question
      // still gets 2925's answer — the two questions simply turn out to share one:
      // a directory that cannot be restored from neither sizes a guard nor spares the
      // user a full transfer.
      const usableAsPriorBackup = isUsablePriorBackup(backupStatus);

      this.priorBackup =
        backupStatus.state === "present"
          ? usableAsPriorBackup
            ? "exists"
            : "none"
          : backupStatus.state === "absent"
            ? "none"
            : "unknown";


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
        // BACKLOG-2925: `deviceSyncOrchestrator.ts:440` used to assign the prior
        // backup's size UNCONDITIONALLY. BACKLOG-2911 made `isInterrupted` available
        // three lines later and nothing downstream consulted it, so an interrupted run
        // fed the estimate (a lower bound by construction), took the TIGHTER 1.1x
        // headroom commented "for existing backups (accurate size)", and reported
        // `reusedPreviousBackup: true` on a run where reuse is impossible.
        //
        // BACKLOG-2899's own mid-transfer abort MANUFACTURES this state: it
        // deliberately leaves the partial on disk, so the next run dropped its headroom
        // against a number that abort guaranteed was too small. The guard made its own
        // next invocation weaker.
        //
        // The gate is `isComplete` — see `isUsablePriorBackup`. BACKLOG-2911's second
        // pass removed `!isInterrupted` from it, and THIS SITE IS THE 11.5 GB NUMBER
        // the founder saw: on 2026-08-28 an interrupted-but-complete 57.9 GB backup
        // took the `partial` arm here, so `resolveBackupSizeEstimate` fell through to
        // `0.25 x used space` and produced "Estimated backup size: 11547 MB" for a
        // directory that had just been measured at 57.9 GB. The measured size is a
        // lower bound only when the INDEX is torn; an intact manifest with a torn
        // snapshot is the size of the backup that is actually on disk.
        //
        // Still deliberately NOT also `snapshotState === "finished"` — that would
        // demote STATE D (a manifest present, Status.plist absent: a real backup
        // predating this device writing one) from a MEASURED size to the
        // `0.25 x used space` estimate that BACKLOG-2918 documents as untrustworthy
        // and BACKLOG-2910 removed the justification for. Trading a measured number
        // for a discredited one is a downgrade, not a tightening. Ruled on by SR
        // review, and the 2026-08-28 experiment extends it to `"unfinished"`.
        //
        // BACKLOG-2938: this gate used to derive `isComplete && !isInterrupted` here,
        // a second time, independently of the UI-facing mapping above. That is exactly
        // how the founder came to be told "previous backup can't be used" and NOT told
        // his sync would take hours: one fact, two derivations. The predicate is now
        // hoisted above the mapping and read here — one evaluation, two consumers.
        // Do not re-inline it.
        priorBackup = !backupStatus.size.measured
          ? { kind: "unknown", reason: `size-unmeasured: ${backupStatus.size.reason}` }
          : usableAsPriorBackup
            ? { kind: "measured", bytes: backupStatus.size.bytes }
            : { kind: "partial", bytes: backupStatus.size.bytes };

        if (priorBackup.kind === "partial") {
          // `isInterrupted` is still LOGGED here — it is a real fact about the last
          // run and it is what a support reader wants next — it simply no longer
          // decides anything. Reading this line as "interrupted, therefore refused"
          // is the misreading that produced BACKLOG-2911's second pass.
          log.warn(
            `[DeviceSyncOrchestrator] Previous backup is on disk (${priorBackup.bytes} bytes) but has no usable index (isComplete=${backupStatus.isComplete}, isInterrupted=${backupStatus.isInterrupted}); estimating from device storage instead. See BACKLOG-2925.`,
          );
        }

        if (!backupStatus.size.measured) {
          log.error(
            `[DeviceSyncOrchestrator] A previous backup exists but its size could not be measured (${backupStatus.size.reason}); estimating as if unknown, not as a first sync.`,
          );
        }

        const sizeGB = backupStatus.size.measured
          ? (backupStatus.size.bytes / 1024 / 1024 / 1024).toFixed(1)
          : null;

        // BACKLOG-2926: an EXHAUSTIVE switch over the device's own verdict, replacing
        // `if (isInterrupted) ... else if (isComplete)`. That pair had no third arm, so
        // a directory which is neither interrupted nor complete fired NOTHING and the
        // user was told nothing at all — the defect BACKLOG-2911 was filed to fix,
        // closed for `uploading` and still open for `absent`.
        //
        // Two on-disk states reached that silence, not one:
        //   snapshotState "absent"   + no Manifest.db  <- MEASURED on the founder's
        //                                                 production install
        //   snapshotState "finished" + no Manifest.db  <- a finished snapshot that
        //                                                 never produced a manifest
        // The item names only the first. Both are handled below.
        //
        // The `never` arm is the reintroduction guard: adding a fourth snapshot state,
        // or deleting a case, fails to compile rather than silently falling through to
        // the same silence this replaces.
        //
        // BACKLOG-2911 (second pass): the REUSE announcement is now a closure, because
        // TWO arms reach it. Before this change only `finished`/`absent` could announce
        // reuse and `unfinished` always announced a restart — which is how the founder,
        // whose 57.9 GB manifest was byte-identical after the interruption, was told
        // "Previous sync didn't finish. Starting over..." while the device went on to
        // transfer incrementally against that very manifest. The predicate and the
        // sentence have to move together or the fix is invisible to him.
        const announceUsablePriorBackup = async (interrupted: boolean): Promise<void> => {
          const lastSync = backupStatus.lastModified;
          const timeSinceLastSync = lastSync
            ? Math.round((Date.now() - lastSync.getTime()) / 1000 / 60)
            : null;
          log.info(
            `[DeviceSyncOrchestrator] Previous backup exists (${sizeGB === null ? "size unmeasured" : `${sizeGB} GB`}), last modified ${timeSinceLastSync} minutes ago, lastRunInterrupted=${interrupted}`,
          );

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

          // The size and "synced X ago" are unchanged. The interrupted variant adds
          // ONE clause, and it claims only what the experiment established: the data
          // already on disk is kept. It does NOT promise a host-side resume, and it
          // does NOT promise the device will credit every partially-transferred file —
          // neither is knowable from here. What was measured is that the index
          // survived and the next run continued from it.
          const found =
            sizeGB === null
              ? `Found previous backup (synced ${timeAgoStr})`
              : `Found previous backup (${sizeGB} GB, synced ${timeAgoStr})`;

          this.emitProgress({
            phase: "backup",
            phaseProgress: 0,
            overallProgress: 0,
            message: interrupted
              ? `${found} — last sync was interrupted, but nothing is lost`
              : found,
          });

          // Brief pause to let user see this message
          await new Promise(resolve => setTimeout(resolve, 1500));

          this.emitProgress({
            phase: "backup",
            phaseProgress: 0,
            overallProgress: 0,
            message: "Comparing with iPhone to find new data...",
          });
        };

        switch (backupStatus.snapshotState) {
          case "unfinished": {
          // BACKLOG-2911 (first pass): this branch used to say "Resuming..." and then
          // issue a byte-identical backup request. There is no HOST-SIDE resume to
          // perform: `idevicebackup2` never reads `Status.plist` on the backup path,
          // and `ForceFullBackup` is the only option the mobilebackup2 protocol accepts
          // on a backup request — the device decides what to re-send. That finding
          // stands, and nothing here asks for a resume.
          //
          // BACKLOG-2911 (second pass): what did NOT stand is the conclusion drawn from
          // it, that the directory was therefore worthless. The 2026-08-28 controlled
          // interruption showed the device resuming ITSELF against an unchanged
          // `Manifest.db` — so this arm splits on whether that index is still there.
          if (backupStatus.isComplete) {
            // The founder's measured case: complete, `SnapshotState: uploading`,
            // manifest byte-identical to before the cable was pulled. The next run is
            // an incremental one and the 57.9 GB on disk is its baseline. Announcing a
            // restart here is what sent him a two-hour first-sync warning and an
            // 11.5 GB estimate for a backup he already had.
            await announceUsablePriorBackup(true);
            break;
          }

          // No manifest. The index is what the device diffs against, so without it
          // there is nothing to continue from and the next run really does start over.
          // BACKLOG-2917: the size is reported only when it was measured. Printing
          // "null GB" or silently substituting "0.0 GB" would be the same class of
          // lie this item exists to remove, in the user-facing half of the app.
          log.warn(
            `[DeviceSyncOrchestrator] Previous backup did not finish and has no manifest (${sizeGB === null ? "size unmeasured" : `${sizeGB} GB on disk`}); starting a new backup. See BACKLOG-2911.`,
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
          break;
          }

          case "finished":
          case "absent": {
          // Nothing claims this snapshot tore. Whether it is USABLE is a separate
          // question, answered by `isComplete` (Manifest.db + Info.plist), and the two
          // must not be conflated: `absent` + a manifest is a real backup from before
          // this device wrote a Status.plist, while `absent` + no manifest is a
          // directory holding nothing anyone can restore from.
          if (!backupStatus.isComplete) {
            // THE 2926 STATE. Measured on the founder's production install: a device
            // directory holding a 6.3 MB `Info.plist` and nothing else — no
            // Status.plist, no Manifest.db, no blob directories. Today he is told
            // nothing whatsoever here and the sync simply appears to stall.
            //
            // The message deliberately does NOT say "didn't finish": there is no
            // evidence the transfer ever started, and claiming otherwise would be
            // inventing a cause. It says only what is established — this cannot be
            // used, and a fresh backup is starting.
            // The precise size belongs in the log, where it is diagnostic. It does NOT
            // belong in the message: this branch is by construction the sub-GB case
            // ("Info.plist and nothing else" is its canonical shape), so `toFixed(1)`
            // on GB renders the founder's real 6,343,173-byte directory as
            // "0.0 GB on disk" — which reads as a rendering bug and tells him nothing
            // he can act on. The size of a directory he cannot use is not decision
            // -relevant; that it cannot be used is.
            log.warn(
              `[DeviceSyncOrchestrator] Previous backup directory is not usable (snapshotState=${backupStatus.snapshotState}, isComplete=false, ${backupStatus.size.measured ? `${backupStatus.size.bytes} bytes on disk` : "size unmeasured"}); starting a fresh backup. See BACKLOG-2926.`,
            );
            this.emitProgress({
              phase: "backup",
              phaseProgress: 0,
              overallProgress: 0,
              message: "Previous backup can't be used. Starting a fresh backup...",
            });
            break;
          }

          // Nothing says the last run tore, and the index is intact. Ordinary reuse.
          await announceUsablePriorBackup(false);
          break;
          }

          default: {
            // Unreachable by construction. If a fourth snapshot state is ever added,
            // this line stops compiling — which is the point. The previous shape
            // absorbed a new state into silence with no signal at all.
            const exhaustive: never = backupStatus.snapshotState;
            log.error(
              `[DeviceSyncOrchestrator] Unhandled snapshot state: ${String(exhaustive)}`,
            );
            break;
          }
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

      // BACKLOG-2925 (second pass): ONE resolution, ONE mark, ONE decision. This used
      // to be `if (storageInfo) { ...estimate, mark, guard... } else { ...different
      // mark, a flat 10 GB floor, proceed anyway... }` — two branches, two ideas of
      // what an unreadable device means, and neither able to refuse. The estimate is
      // now resolved first and the branch below is on WHETHER IT IS KNOWN, not on
      // which query happened to answer.
      const estimate = resolveBackupSizeEstimate(priorBackup, storageInfo);

      // BACKLOG-2898/2896: the estimate BRANCH, on one greppable line. Which
      // branch ran is what says whether a previous backup was reused — the
      // question 2896 could not answer because both `log.info` lines below
      // had rotated out of main.log AND main.old.log before anyone looked.
      //
      // BACKLOG-2917: `source` has FIVE values because the underlying question has
      // five answers. The instrument built to settle "did incremental run?"
      // previously printed the reassuring answer in the one case where the true
      // answer would be alarming.
      //
      // BACKLOG-2925 (second pass): emitted BEFORE the refusal below, deliberately. A
      // refusal that emits no mark is the 2917 invisible-branch defect reborn — the
      // runs that most need counting would be the ones missing from the aggregate,
      // and their absence would read as "this never happens".
      syncTimeline.mark("backup-estimate", {
        source: estimate.source,
        // `bytes` is present only when there ARE bytes. Recording `bytes=0` for an
        // unknown estimate is the exact lie BACKLOG-2917 removed from `annotate`.
        ...(estimate.kind === "known"
          ? { bytes: estimate.bytes }
          : { estimateUnknownReason: estimate.reason, priorBackup: priorBackup.kind }),
        reusedPreviousBackup: estimate.kind === "known" && priorBackup.kind === "measured",
        snapshotState: snapshotStateForMark(backupStatus),
        // BACKLOG-2925: recorded, never used. The partial's size is real and worth
        // knowing when reading a timeline; it is not a number anything may size a
        // disk guard against.
        ...(priorBackup.kind === "partial" ? { ignoredPartialBytes: priorBackup.bytes } : {}),
        ...(priorBackup.kind === "unknown" ? { priorBackupUnknownReason: priorBackup.reason } : {}),
      });

      if (estimate.kind === "unknown") {
        // BACKLOG-2925 (second pass): REFUSE. The founder's run is the argument —
        // "Disk space check passed: 15 GB available" was printed for a backup that
        // had measured 58.8 GB, because the estimate was 0 and 0 clears every bar.
        //
        // WHY REFUSE RATHER THAN WARN. Warning and proceeding is precisely what
        // BACKLOG-2899 did ("Proceeding anyway"), and it has now failed the founder
        // three times in three different costumes. The cost of a wrong refusal is one
        // sync the user retries; the cost of a wrong pass is a 20-25 minute transfer
        // that fills the boot volume the app's own database lives on, and then aborts.
        // For an audit product those are not symmetric.
        //
        // The message names the remedy rather than a diagnosis, because the CAUSE of
        // the zeros is not established (see the item). If the leading candidate is
        // right — the device was locked when the query ran; it exited 0, answered
        // nothing, and the backup asked for a passcode five seconds later — then
        // unlocking and retrying clears it, and this refusal is self-curing rather
        // than a wall.
        const userError = formatUnknownBackupSizeError();
        log.warn(
          "[DeviceSyncOrchestrator] Sync refused: backup size could not be determined",
          {
            estimateSource: estimate.source,
            reason: estimate.reason,
            priorBackup: priorBackup.kind,
            storageInfoPresent: storageInfo !== null,
          },
        );
        Sentry.captureMessage("Sync refused: backup size unknown", {
          level: "warning",
          tags: {
            service: "sync-orchestrator",
            failure_reason: "backup_size_unknown",
            estimate_source: estimate.source,
          },
          extra: {
            reason: estimate.reason,
            priorBackup: priorBackup.kind,
            storageInfoPresent: storageInfo !== null,
          },
        });
        this.isRunning = false;
        this.emit("error", { message: userError.description, userError });
        return this.errorResult(userError.description);
      }

      // From here the estimate is KNOWN. `estimate.bytes` did not exist a line ago.
      this.estimatedBackupSize = estimate.bytes;
      if (estimate.source === "existing-backup") {
        log.info(`[DeviceSyncOrchestrator] Using existing backup size for estimate: ${Math.round(this.estimatedBackupSize / 1024 / 1024 / 1024)} GB`);
      } else {
        log.info(`[DeviceSyncOrchestrator] Estimated backup size from storage: ${Math.round(this.estimatedBackupSize / 1024 / 1024)} MB (used space: ${Math.round((storageInfo?.usedSpace ?? 0) / 1024 / 1024 / 1024)} GB)`);
      }

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
      const headroom = estimate.source === "existing-backup" ? 1.1 : 1.5;
      const requiredSpace = this.estimatedBackupSize * headroom;
      const diskSpaceCheck = await this.checkAvailableDiskSpace(requiredSpace);

      if (!diskSpaceCheck.hasEnoughSpace) {
        // THE RESIDUAL, NAMED. A KNOWN estimate that does not fit still only warns and
        // proceeds. That is BACKLOG-2899's deliberate decision — the first-sync
        // estimate is `0.25 x used space`, a figure BACKLOG-2896 has not validated and
        // BACKLOG-2910 removed the stated basis for, so refusing on it would block
        // real syncs on a number nobody can defend. Turning this into a refusal is
        // BACKLOG-2918 and needs the founder's ruling, not an engineer's.
        //
        // BACKLOG-2925 changes NOTHING here on purpose: this branch is reached only
        // when a size IS known, which is the case this item is not about. Pinned by
        // test so the distinction cannot rot into "the guard refuses sometimes".
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
    // BACKLOG-2907: attached here rather than at each of the ~18 call sites, so
    // no emit can forget it and silently report `undefined` (which the renderer
    // reads as "unknown" — safe, but it would hide the signal for a whole run).
    this.emit("progress", { ...progress, priorBackup: this.priorBackup });
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
    // BACKLOG-2907: a new run must establish its own answer. Without this reset the
    // early progress events of run 2 would carry run 1's prior-backup state.
    this.priorBackup = "unknown";
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

      // BACKLOG-2907: this path only proceeds on a backup that is on disk.
      // BACKLOG-2938: `PriorBackupState` now reports USABILITY, not existence, so this
      // asks the one predicate rather than assuming the directory's presence answers it.
      //
      // BACKLOG-2911 (second pass): this entry point and the guard three lines below
      // now agree BY CONSTRUCTION. `isUsablePriorBackup` is `isComplete` here, and the
      // guard is `!isComplete` — so a directory this path is willing to PARSE is
      // exactly the one it reports as `"exists"`. Before the predicate lost
      // `!isInterrupted` they disagreed on precisely one shape, `isComplete &&
      // isInterrupted`: `processExistingBackup` parsed the backup happily while
      // reporting `"none"`, i.e. telling the user a full transfer was coming while
      // reading the prior one. Do not re-add a condition to either side without adding
      // it to both.
      this.priorBackup = isUsablePriorBackup(backupStatus) ? "exists" : "none";

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
