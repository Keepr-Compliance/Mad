/**
 * Types for the iPhone backup service
 * Used for extracting messages and contacts from iPhone via idevicebackup2
 * Includes encryption support types for encrypted backups (TASK-007)
 */

// ============================================
// BACKUP PROGRESS & STATUS TYPES (TASK-006)
// ============================================

/**
 * Progress information during backup operations
 */
export interface BackupProgress {
  /** Current phase of the backup operation */
  phase:
    | "preparing"
    | "transferring"
    | "finishing"
    | "extracting"
    | "decrypting";
  /** Overall percentage complete (0-100) */
  percentComplete: number;
  /** Current file being processed, if available */
  currentFile: string | null;
  /** Number of files transferred so far */
  filesTransferred: number;
  /** Total number of files to transfer, if known */
  totalFiles: number | null;
  /** Bytes transferred so far */
  bytesTransferred: number;
  /** Total bytes to transfer, if known */
  totalBytes: number | null;
  /** Estimated time remaining in seconds, if calculable */
  estimatedTimeRemaining: number | null;
  /**
   * BACKLOG-1628: Optional user-facing message for sub-phase detail.
   * During the preparing phase, this carries context about what the process
   * is doing (e.g., "Uploading backup index (563 MB)...").
   */
  message?: string;
}

/**
 * Result of a backup operation
 */
export interface BackupResult {
  /** Whether the backup completed successfully */
  success: boolean;
  /** Path to the backup directory, null if failed */
  backupPath: string | null;
  /** Error message if backup failed */
  error: string | null;
  /** Duration of the backup in milliseconds */
  duration: number;
  /** UDID of the device that was backed up */
  deviceUdid: string;
  /** Whether this was an incremental backup (vs full) */
  isIncremental: boolean;
  /**
   * BACKLOG-2914: what the DEVICE said, or `null` when it never said.
   *
   * `isIncremental` used to be derived purely from whether a backup directory
   * existed, and on the founder's 2026-08-28 run that produced `incremental=true` for
   * a 61.2 GB, 52-minute transfer whose `Status.plist` reported `IsFullBackup: 1` —
   * the on-disk state at the start was a 4.4 GB partial with no `Manifest.db`, so it
   * was effectively a first sync.
   *
   * That is the single most damaging error possible for the duration model: first and
   * incremental are the two distributions it must separate, and a 52-minute full run
   * filed as incremental teaches it that incremental syncs take an hour.
   *
   * `idevicebackup2` prints "Full backup mode." or "Incremental backup mode." on
   * stderr under `-d`, which is the device's own answer. `null` is kept as a real
   * third state rather than defaulted, so telemetry can say whether the flag was
   * REPORTED or INFERRED instead of presenting both as the same fact.
   */
  deviceReportedBackupMode?: "incremental" | "full" | null;
  /**
   * Size of the backup in bytes, or `null` when the size could not be measured.
   *
   * BACKLOG-2917: this was `number`, and the walk that produces it returned `0` on
   * any throw. A backup that completed successfully could therefore report
   * `backupSize: 0`, which `deviceSyncOrchestrator` hands straight to
   * `syncTimeline.annotate("backup", { bytes })` — the instrument BACKLOG-2898 built
   * to answer "did this run transfer anything?". `null` cannot be added, averaged or
   * compared by accident, so an unmeasured size can no longer read as an empty one.
   */
  backupSize: number | null;
  /** Whether the backup is encrypted (TASK-007) */
  isEncrypted?: boolean;
  /** Error code for specific error handling (TASK-007) */
  errorCode?: BackupErrorCode;
  /**
   * BACKLOG-2913: what the DEVICE said went wrong, kept as data.
   *
   * Present only on failures. `error` above is a sentence written for the user and
   * is not safe to parse; this is the machine-readable original it was derived from.
   * BACKLOG-2950 will carry these fields to Sentry as tags and into the support
   * portal's diagnostics block, which is why the code and the device's own
   * description are kept apart rather than pre-joined into a string.
   */
  failureCause?: BackupFailureCause;
}

/**
 * BACKLOG-2913: the device's own account of a failed backup.
 *
 * idevicebackup2 reports failures twice — as a human line on stdout
 * (`ErrorCode 208: Device locked (MBErrorDomain/208)`) and as a
 * `DLMessageProcessMessage` plist on stderr. Both were logged and discarded; every
 * failure was then re-derived by substring-matching the `-d` debug stream, which is
 * full of `afc_lock(): Locked` mutex traces, so every failure reported "iPhone is
 * locked". This type is that answer, kept instead of thrown away.
 */
export interface BackupFailureCause {
  /**
   * The MBErrorDomain code the device reported (105 = host disk full,
   * 208 = device locked), or `null` when neither stream carried one. `null` means
   * "not reported", never "no error" — the caller must not treat it as a code.
   */
  deviceErrorCode: number | null;
  /**
   * The device's own `ErrorDescription`, verbatim, or `null` when absent.
   *
   * Note this string names no drive: the device says "Insufficient free disk space
   * on drive to back up" for a full HOST disk, which is why it must never be shown
   * to the user unqualified. The founder read it, checked his iPhone's storage
   * screen, saw 80 GB free and concluded Keepr was broken.
   */
  deviceErrorDescription: string | null;
  /** The process exit code, exactly as the OS reported it. `null` if killed by signal. */
  exitCode: number | null;
  /** Which stream the code came from, so a support log can say how much to trust it. */
  source: BackupFailureCauseSource;
}

/**
 * Where a {@link BackupFailureCause} code was read from.
 *
 * - `stdout-line` — idevicebackup2's own summary line. Always emitted, and stdout is
 *   low-volume enough to survive the 64KB tail cap. Preferred.
 * - `stderr-plist` — the `DLMessageProcessMessage` plist in the `-d` debug stream.
 *   Only present when `-d` is passed, and can be pushed out of the tail cap by the
 *   debug flood, so it is the fallback rather than the primary.
 * - `none` — no code was reported; the failure was classified from exit code and
 *   idevicebackup2's own stdout, or not at all.
 */
export type BackupFailureCauseSource = "stdout-line" | "stderr-plist" | "none";

/**
 * BACKLOG-2917: the result of measuring a backup directory.
 *
 * The unmeasured arm deliberately carries NO byte count. `calculateBackupSize`
 * returned `0` both for "this directory is empty" and for "the walk threw", and the
 * only thing preventing that from being read as a real size was that every caller
 * happened to be looking at a directory it believed in. Removing the property means
 * a caller cannot read bytes it was never given — the collapse stops compiling
 * rather than stopping occurring.
 *
 * Modelled on `checkAvailableDiskSpace`, which names `unavailable: true`, refuses to
 * log a 0 GB "reading", and acts on the boolean rather than on the number.
 */
export type BackupSizeReading =
  | { measured: true; bytes: number }
  | { measured: false; reason: string };

/**
 * BACKLOG-2911: the device's own verdict on the last backup, from `Status.plist`.
 *
 * BACKLOG-2926: this is returned to callers now. `readSnapshotState` has computed all
 * three states correctly since 2911, but `checkBackupStatus` collapsed it to
 * `isInterrupted = snapshotState === "unfinished"` and never returned the value, so
 * `"absent"` became `isInterrupted: false` and was indistinguishable from a finished
 * snapshot. The orchestrator had exactly two branches, and a directory that is neither
 * interrupted nor complete fired NEITHER — the user was told nothing at all.
 *
 * `"absent"` is a real third state, not a missing value: a `Status.plist` that is not
 * there carries no evidence either way. It is also the state before a device has ever
 * completed a backup into the directory.
 */
export type BackupSnapshotState = "finished" | "unfinished" | "absent";

/**
 * BACKLOG-2917: what `checkBackupStatus` found. Three states, never two.
 *
 * The previous signature was `{...} | null`, and `null` meant BOTH "ENOENT, this
 * device has no backup" and "the check itself threw". Those are opposite facts. The
 * orchestrator read the collapsed value as "first sync", so a failed check produced
 * a confident first-sync estimate, the 1.5x headroom branch, and — after
 * BACKLOG-2898 — a telemetry mark stating `reusedPreviousBackup: false` as fact.
 * A diagnostic that cannot report its own failure is worse than no diagnostic.
 *
 * `state` is a discriminant rather than a flag on purpose: `sizeBytes` exists on no
 * arm, so `if (status) { status.sizeBytes }` — the exact shape that shipped the bug —
 * does not type-check. That is the reintroduction guard for this item.
 */
export type BackupStatusReport =
  /** `fs.stat` returned ENOENT. Proven: this device has no backup directory. */
  | { state: "absent" }
  /**
   * The check could not complete. Proven: nothing. Never treat as "no backup" —
   * that is the BACKLOG-2917 defect. `reason` is for logs and telemetry only.
   */
  | { state: "unknown"; reason: string }
  /** The backup directory exists. Its size is a separate three-state reading. */
  | {
      state: "present";
      /** `Manifest.db` and `Info.plist` are both present. */
      isComplete: boolean;
      /**
       * BACKLOG-2911: the device did not report this snapshot as finished, so what is
       * on disk is a partial backup. See `readSnapshotState`.
       */
      isInterrupted: boolean;
      /**
       * BACKLOG-2926: the device's own verdict, no longer thrown away. `isInterrupted`
       * is `snapshotState === "unfinished"` and cannot express the difference between
       * "the device said it finished" and "nothing said anything".
       */
      snapshotState: BackupSnapshotState;
      lastModified: Date;
      size: BackupSizeReading;
    };

/**
 * Options for starting a backup
 */
export interface BackupOptions {
  /** UDID of the device to backup */
  udid: string;
  /** Output directory for backup. Default: app's userData/Backups folder */
  outputDir?: string;
  /** Force a full backup even if incremental is available. Default: false */
  forceFullBackup?: boolean;
  /** Skip application data to reduce backup size. Default: true */
  /** Password for encrypted backup (TASK-007) */
  password?: string;
}

/**
 * Capabilities of the backup system
 */
export interface BackupCapabilities {
  /** Whether domain filtering is supported (currently always false) */
  supportsDomainFiltering: boolean;
  /** Whether incremental backups are supported */
  supportsIncremental: boolean;
  /** Whether backup encryption is supported */
  supportsEncryption: boolean;
  /** List of available domains in backups */
  availableDomains: string[];
}

/**
 * Information about an existing backup
 */
export interface BackupInfo {
  /** Path to the backup directory */
  path: string;
  /** UDID of the device the backup is from */
  deviceUdid: string;
  /** When the backup was created */
  createdAt: Date;
  /**
   * Size of the backup in bytes, or `null` when the size could not be measured.
   * BACKLOG-2917 — see `BackupResult.backupSize`. A real backup must never be
   * listed to the user at size 0 because its directory walk threw.
   */
  size: number | null;
  /** Whether the backup is encrypted */
  isEncrypted: boolean;
  /** iOS version the backup was created from */
  iosVersion: string | null;
  /** Device name at time of backup */
  deviceName: string | null;
}

/**
 * Status of the backup service
 */
export interface BackupStatus {
  /** Whether a backup is currently in progress */
  isRunning: boolean;
  /** UDID of device being backed up, if any */
  currentDeviceUdid: string | null;
  /** Current progress, if backup is running */
  progress: BackupProgress | null;
}

// ============================================
// ENCRYPTION TYPES (TASK-007)
// ============================================

/**
 * Error codes for backup operations
 */
export type BackupErrorCode =
  | "PASSWORD_REQUIRED"
  | "INCORRECT_PASSWORD"
  | "DEVICE_NOT_FOUND"
  | "DEVICE_LOCKED"
  | "BACKUP_CANCELLED"
  | "BACKUP_TIMEOUT"
  | "INSUFFICIENT_SPACE"
  | "DECRYPTION_FAILED"
  // BACKLOG-2913: three causes the founder hit in one evening that had no code of
  // their own, so all three arrived as "iPhone is locked".
  /** The USB link dropped mid-backup (`usbmuxd_send returned -32 (Broken pipe)`). */
  | "CONNECTION_LOST"
  /** The device's mobilebackup2 service would not negotiate (`version exchange failed`). */
  | "SERVICE_UNAVAILABLE"
  /** The device could not find a file the backup needed (MBErrorDomain/4). */
  | "BACKUP_FILE_MISSING"
  | "UNKNOWN_ERROR";

/**
 * Encryption information for a backup
 */
export interface BackupEncryptionInfo {
  isEncrypted: boolean;
  needsPassword: boolean;
}

/**
 * Result of decryption operation
 */
export interface DecryptionResult {
  success: boolean;
  error: string | null;
  decryptedPath: string | null;
}

/**
 * iOS Backup Manifest.plist encryption metadata
 * Structure matches iOS backup format
 */
export interface ManifestPlist {
  IsEncrypted: boolean;
  ManifestKey?: Buffer;
  BackupKeyBag?: Buffer;
  Lockdown?: {
    ProductVersion?: string;
    DeviceName?: string;
    UniqueDeviceID?: string;
  };
}

/**
 * Keybag item from iOS backup
 */
export interface KeybagItem {
  uuid: Buffer;
  clas: number;
  wrap: number;
  ktyp?: number;
  wpky?: Buffer; // Wrapped protection key
  publicKey?: Buffer;
  privateKey?: Buffer;
  salt?: Buffer;
  iter?: number;
  dpwt?: number;
  dpic?: number;
  dpsl?: Buffer;
}

/**
 * Parsed Keybag structure
 */
export interface Keybag {
  uuid: Buffer;
  type: number;
  hmck?: Buffer; // HMAC key
  wrap?: number;
  salt?: Buffer;
  iter?: number;
  dpwt?: number;
  dpic?: number;
  dpsl?: Buffer;
  classKeys: Map<number, KeybagItem>;
}

/**
 * Derived encryption keys from user password
 */
export interface EncryptionKeys {
  keyEncryptionKey: Buffer;
  classKeys: Map<number, Buffer>;
}

/**
 * Manifest.db file entry
 */
export interface ManifestDbEntry {
  fileID: string;
  domain: string;
  relativePath: string;
  flags: number;
  file: Buffer; // Encrypted file metadata plist
}

/**
 * Decrypted file metadata from Manifest.db
 */
export interface FileMetadata {
  fileID: string;
  domain: string;
  relativePath: string;
  protectionClass: number;
  encryptionKey?: Buffer;
  size?: number;
  mode?: number;
  lastModified?: Date;
}

/**
 * Files we need to decrypt for message/contact extraction
 */
export const REQUIRED_BACKUP_FILES = {
  SMS_DB: {
    hash: "3d0d7e5fb2ce288813306e4d4636395e047a3d28",
    domain: "HomeDomain",
    relativePath: "Library/SMS/sms.db",
    description: "iMessage/SMS database",
  },
  ADDRESS_BOOK: {
    hash: "31bb7ba8914766d4ba40d6dfb6113c8b614be442",
    domain: "HomeDomain",
    relativePath: "Library/AddressBook/AddressBook.sqlitedb",
    description: "Contacts database",
  },
} as const;

/**
 * Protection class constants for iOS Data Protection
 * See: https://support.apple.com/guide/security/data-protection-classes-secb010e978a/web
 */
export const PROTECTION_CLASS = {
  NSFileProtectionComplete: 1,
  NSFileProtectionCompleteUnlessOpen: 2,
  NSFileProtectionCompleteUntilFirstUserAuthentication: 3,
  NSFileProtectionNone: 4,
  NSFileProtectionRecovery: 5,
  kSecAttrAccessibleWhenUnlocked: 6,
  kSecAttrAccessibleAfterFirstUnlock: 7,
  kSecAttrAccessibleAlways: 8,
  kSecAttrAccessibleWhenUnlockedThisDeviceOnly: 9,
  kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly: 10,
  kSecAttrAccessibleAlwaysThisDeviceOnly: 11,
} as const;

/**
 * Keybag type constants
 */
export const KEYBAG_TYPE = {
  System: 0,
  Backup: 1,
  Escrow: 2,
  OTA: 3,
} as const;

/**
 * Wrap type constants
 */
export const WRAP_TYPE = {
  AES: 1,
  Curve25519: 2,
} as const;
