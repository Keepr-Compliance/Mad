/**
 * The kept iPhone backup at rest (BACKLOG-3816 S4-C, founder decision: option C).
 *
 * Keepr keeps one backup chain per phone at `userData/Backups/<udid>` so the next
 * sync is incremental. Between syncs every file in it is sealed with the S0 data key
 * (KEPRENC container, fileCrypto.ts). That includes the three device-metadata plists at
 * the chain root (founder QA 2026-10-09: Info.plist holds the phone number, IMEI, ICCID,
 * serial number and the installed-apps list; this replaces design D3, which left them plain):
 *
 *   Info.plist      device name / model / iOS version — read by the backup list
 *   Status.plist    the device's own "snapshot finished" verdict (BACKLOG-2911)
 *   Manifest.plist  IsEncrypted + keybag — how Apple-encrypted chains are recognised
 *
 * C-DELTA unseals them with Manifest.db before `idevicebackup2` runs (the tool and the
 * device negotiate with them) and the seal after the sync closes them again. Readers
 * outside a sync decrypt them in memory (backupIndexFiles.ts).
 *
 * ## What is NOT sealed
 *
 *  - A chain whose OWNER turned on iPhone backup encryption (Manifest.plist
 *    `IsEncrypted = true`). Apple already encrypts every file in it; Keepr does not add
 *    a second layer, writes no marker for it, and removes a stale one.
 *  - Zero-byte files: there is nothing to protect, and on the founder's PC 93 of 200
 *    sampled files were empty (573k files in all). They are skipped and counted.
 *  - A file that starts with the KEPRENC magic but fails the structural header probe
 *    (damaged header — local tamper or disk corruption): left untouched and counted,
 *    the same rule as S3's C-S3a. Sealing it would hide the damage for good.
 *
 * ## Plaintext windows (the wording caution given to the founder)
 *
 * Apple's tool writes the backup unencrypted. Under C-FULL the whole chain is plaintext
 * from the unseal before `idevicebackup2` until the seal after persistence; under
 * C-DELTA only Manifest.db and the files the phone sent this time are. After a crash or
 * a quit mid-sync the marker stays `syncing` and the chain is sealed at the next launch.
 *
 * ## Markers (markers.ts)
 *
 *   absent / plaintext   never sealed (pre-2.40, or a first backup not yet sealed)
 *   migrating            the launch migration is sealing it
 *   syncing              unsealed (wholly or partly) for a sync, or a seal did not finish
 *   encrypted            a full scan after the last seal found zero plaintext files
 *
 * A first backup gets NO marker until it completed: the 3598 cleanup must still be able
 * to remove an unfinished first backup, and it never removes a folder whose marker says
 * migrating / encrypted / syncing (backupService classifier).
 *
 * ## Logs
 *
 * Counts and errno codes only — never a path or file name.
 */
import { EventEmitter } from "events";
import fs from "fs";
import path from "path";
import plist from "simple-plist";

import { hostAppPaths } from "../../capabilities/appPathsProvider";
import { hostLogger } from "../../capabilities/loggerProvider";
import {
  FILE_ID_PATTERN,
  selectReadFileRows,
} from "../backupDecryptionService";
import { DataKeyUnavailableError, getAtRestFiles, getDataKeyService } from "./dataKeyService";
import {
  AtRestIntegrityError,
  fsyncDir,
  KENC_TMP_SUFFIX,
  MAGIC,
  probeHeader,
  type AtRestKey,
  type FileCrypto,
} from "./fileCrypto";
import { BACKUP_ROOT_PLISTS, openBackupIndexBytes } from "./backupIndexFiles";
import { createMarkerStore, MARKER_DIR_NAME, type BackupAtRestState, type MarkerStore } from "./markers";
import type { FileOutcome, SealEngineOptions, SealMode } from "./sealEngine";
import { defaultSealWorkers, runPass, type PassFile } from "./sealPool";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export type BackupUnsealStrategy = "full" | "delta";

/**
 * C-FULL: decrypt the whole chain in place before `idevicebackup2`, seal it all after.
 * C-DELTA: decrypt only Manifest.db before; after, seal every file without a valid
 * header (what the phone sent this time). The default is C-DELTA: measured on the
 * founder's PC (Step 0b, BACKLOG-3816), an incremental read ZERO unchanged content files
 * (571,241 of 573,726 untouched; only the index files and new/rewritten files changed).
 * C-FULL stays selectable (`strategy` option / dep) and is forced for one phone after a
 * delta sync leaves a damaged file (see {@link BackupAtRest.finishSync}).
 */
export const BACKUP_UNSEAL_STRATEGY: BackupUnsealStrategy = "delta";

/** Why the next sync of a phone is forced to C-FULL (recorded in the log and the session). */
export const FORCE_FULL_REASON_DELTA_DAMAGED = "DELTA_DAMAGED";
/** The backup tool itself failed during a delta sync (it may have needed a sealed file). */
export const FORCE_FULL_REASON_DELTA_TOOL_FAILED = "DELTA_TOOL_FAILED";

/** Files C-DELTA unseals before `idevicebackup2` runs: the index and the root plists. */
export const DELTA_UNSEAL_FILES: readonly string[] = ["Manifest.db", ...BACKUP_ROOT_PLISTS];

/** The founder-approved sentence for the "securing your backup" phase (and only it). */
export const BACKUP_SECURING_SENTENCE = "Syncing your iPhone will be available when this finishes.";
export const BACKUP_SECURING_MESSAGE = `Keepr is securing your saved iPhone backup. ${BACKUP_SECURING_SENTENCE}`;
/** Shown in the sync while a background seal stops at a file boundary (seconds at most). */
export const BACKUP_PAUSING_MESSAGE = "Getting your saved iPhone backup ready for this sync...";
export const BACKUP_AT_REST_KEY_UNAVAILABLE_MESSAGE =
  "Keepr cannot open its encryption key on this computer, so it will not copy your iPhone backup unprotected. Restart Keepr and try again.";
export const BACKUP_AT_REST_DISK_MESSAGE =
  "There is not enough free disk space to prepare your saved iPhone backup for this sync. Free up some space and try again.";
export const BACKUP_AT_REST_UNREADABLE_MESSAGE =
  "Part of your saved iPhone backup could not be opened, so this sync was stopped before it changed anything.";
/** B2: a sealed backup that fails authentication was moved aside; this sync makes a full backup. */
export const BACKUP_AT_REST_QUARANTINED_MESSAGE =
  "Keepr couldn't read the saved iPhone backup, so it will make a fresh full backup — this takes longer.";

/**
 * B2 (founder D10, "quarantine unreadable data 30 days"): a kept chain with sealed files
 * that cannot be authenticated is moved, still sealed and otherwise untouched, to
 * `Backups/.quarantine/<udid>-<ms>`, and the sync makes a full backup. Deleted at launch
 * once older than {@link QUARANTINE_MAX_AGE_MS}. The name keeps it out of the 3598 sweep
 * and the launch job (neither matches a dot-name).
 */
export const QUARANTINE_DIR_NAME = ".quarantine";
export const QUARANTINE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * Unseal failures that no retry can fix: the file does not authenticate (tampered,
 * truncated, flipped bit) or its key is not held on this computer. Anything else —
 * disk space, a lock, an I/O error — keeps refusing, because a later try can succeed.
 */
const UNRECOVERABLE_CODES: ReadonlySet<string> = new Set(["INTEGRITY", "KEY_MISSING"]);

/**
 * An unencrypted chain moved out of the way when the owner turned on phone backup
 * encryption (S4 #2884): `Backups/.keepr-replaced-<udid>-<ms>`. Single source —
 * backupService re-exports it.
 */
export const REPLACED_CHAIN_PREFIX = ".keepr-replaced-";

export const DISK_HEADROOM_BYTES = 1024 * 1024 * 1024;
export const RETRY_ATTEMPTS = 3;
export const DEFAULT_CONCURRENCY = 8;
const RETRYABLE_CODES = new Set(["EBUSY", "EPERM", "EACCES"]);
const UDID_DIR_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FileClass = "sealed" | "plaintext" | "empty" | "damaged";

export interface PassReport {
  /** Files looked at (*.kenc-tmp excluded). */
  files: number;
  /** The pass was paused at a file boundary (a sync asked for the phone) before it finished. */
  paused?: boolean;
  /** Files this pass sealed / unsealed. */
  changed: number;
  /** Already in the target form. */
  already: number;
  empty: number;
  damaged: number;
  /** Gave up after retries; errno code → count. */
  failed: number;
  failedCodes: Record<string, number>;
  /** Orphaned *.kenc-tmp files removed (a killed seal or unseal leaves one). */
  tempsRemoved: number;
  ms: number;
}

export interface ScanReport {
  sealed: number;
  plaintext: number;
  empty: number;
  damaged: number;
  /** Stopped at a file boundary for a sync: the counts are partial and prove nothing. */
  paused?: boolean;
}

export interface BackupAtRestProgress {
  udid: string;
  /** `pausing`: a sync is waiting for a background seal to stop at a file boundary. */
  phase: "unsealing" | "sealing" | "migrating" | "pausing";
  /** Files. */
  done: number;
  total: number;
  /**
   * Work units for the percentage: bytes plus {@link PROGRESS_FILE_WEIGHT_BYTES} per file,
   * so the percentage tracks elapsed time (a 0-byte file still costs an open). Absent =
   * the percentage is by files.
   */
  doneUnits?: number;
  totalUnits?: number;
  /** Time left, from the pass's own rate so far (time-based; absent until it is meaningful). */
  etaMs?: number;
}

/**
 * Per-file cost in the progress percentage, as bytes. An ESTIMATE, not a measurement.
 * The fixed cost of a file depends on what the pass does to it. On the Mac bench
 * (BACKLOG-3816), a file that is SEALED costs ~6 ms more with its fsync than without
 * (252.9 s vs 24.4 s over 37,372 files), which equals ~2 MB of data at 323 MB/s. A file
 * that is only CHECKED (already sealed, the bulk of an incremental) costs tens of µs. The
 * pass cannot tell the two apart before it starts, so this value sits between them. The
 * PC benchmark gives the Windows figures.
 */
export const PROGRESS_FILE_WEIGHT_BYTES = 256 * 1024;
/** While a sync waits for a background pass to pause, its status line is repeated this often. */
export const PAUSE_REPORT_INTERVAL_MS = 5000;
/** Progress for a seal pass is emitted at most this often (plus its start and end). */
export const PROGRESS_INTERVAL_MS = 1000;

/**
 * The status line for a seal/unseal pass, shown through the existing sync status channel
 * (`sync:progress`). Unsealing happens inside a sync, before the transfer; sealing and
 * migrating happen after a sync and at launch.
 */
export function describeBackupAtRestProgress(p: BackupAtRestProgress): { message: string; percent: number } {
  const units = p.totalUnits !== undefined && p.doneUnits !== undefined;
  const done = units ? (p.doneUnits as number) : p.done;
  const total = units ? (p.totalUnits as number) : p.total;
  const percent = total > 0 ? Math.min(100, Math.floor((done / total) * 100)) : 100;
  if (p.phase === "pausing") {
    return { message: BACKUP_PAUSING_MESSAGE, percent: 0 };
  }
  if (p.phase === "unsealing") {
    return {
      message: `Preparing your saved iPhone backup (${p.done.toLocaleString()} of ${p.total.toLocaleString()} files)...`,
      percent,
    };
  }
  const eta = p.etaMs !== undefined && percent < 100 ? ` (${describeEta(p.etaMs)})` : "";
  return { message: `Securing your iPhone backup… ${percent}%${eta}`, percent };
}

/** "about 12 min left" / "about 1 h 5 min left" / "less than a minute left". */
export function describeEta(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return "less than a minute left";
  if (min < 60) return `about ${min} min left`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest === 0 ? `about ${h} h left` : `about ${h} h ${rest} min left`;
}

export type MarkerReading = BackupAtRestState | "absent" | "unreadable";

/** What a sync is holding while it runs. Returned by {@link BackupAtRest.beginSync}. */
export type BackupSyncSession =
  | { kind: "none"; udid: string } // mock mode / nothing to manage
  | { kind: "apple"; udid: string } // owner-encrypted chain: Apple encrypts, Keepr does not seal
  // no chain yet: sealed only once the first backup exists. `quarantined`: the kept chain
  // could not be read and was moved to Backups/.quarantine (B2) — this sync is a full backup.
  | { kind: "first"; udid: string; quarantined?: { reasonCode: string } }
  | { kind: "keepr"; udid: string; strategy: BackupUnsealStrategy };

export class BackupAtRestRefusal extends Error {
  constructor(
    readonly reason: "busy" | "key-unavailable" | "disk-space" | "unreadable" | "cancelled",
    message: string,
  ) {
    super(message);
    this.name = "BackupAtRestRefusal";
  }
}

type LogFn = (level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>) => void;

export interface BackupAtRestDeps {
  backupsRoot: () => string;
  files: () => FileCrypto;
  markers: () => MarkerStore;
  /** Throws (DataKeyUnavailableError) when the data key cannot be opened or created. */
  ensureKey: () => Promise<void>;
  /** Bytes available on the volume holding `dir`. */
  freeBytes?: (dir: string) => Promise<number>;
  sleep?: (ms: number) => Promise<void>;
  log?: LogFn;
  concurrency?: number;
  /** Test seam: the default strategy for {@link BackupAtRest.beginSync}. */
  strategy?: () => BackupUnsealStrategy;
  /** Test seam: the clock used to name and age quarantined chains. */
  now?: () => number;
  /**
   * The key new containers are sealed with, handed to the seal workers. Default: the
   * FileCrypto's own (`files().sealingKey()`).
   */
  sealKey?: () => Promise<AtRestKey>;
  /** Seal worker threads. 0 (the default here) = in-process; the app singleton uses {@link defaultSealWorkers}. */
  workers?: number;
  /** Compiled worker script (default: sealWorker.js beside sealPool.js). */
  workerScript?: string;
  /** Plaintext bytes per chunk for containers this writes (default fileCrypto's 1 MiB). */
  chunkSize?: number;
  /** Test seams for the in-process seal engine (fault injection, retry delay). */
  sealEngineOptions?: SealEngineOptions;
  /** Test seam: how often a sync waiting for a pause re-checks and repeats its line (default 5 s). */
  pauseWaitMs?: number;
}

// ---------------------------------------------------------------------------
// Marker reading shared with backupService (no hostAppPaths needed there)
// ---------------------------------------------------------------------------

/**
 * Read `Backups/.keepr-at-rest/<udid>.json` given the Backups root. Used by the 3598
 * classifier, which knows the Backups root but not userData. Never throws.
 */
export async function readMarkerAt(backupsRoot: string, udid: string): Promise<MarkerReading> {
  if (!UDID_DIR_PATTERN.test(udid)) return "unreadable";
  let raw: string;
  try {
    raw = await fs.promises.readFile(path.join(backupsRoot, MARKER_DIR_NAME, `${udid}.json`), "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "absent" : "unreadable";
  }
  try {
    const parsed = JSON.parse(raw) as { udid?: unknown; state?: unknown };
    if (
      parsed?.udid === udid &&
      (parsed.state === "plaintext" ||
        parsed.state === "migrating" ||
        parsed.state === "encrypted" ||
        parsed.state === "syncing" ||
        parsed.state === "apple-encrypted")
    ) {
      return parsed.state;
    }
  } catch {
    // fall through
  }
  return "unreadable";
}

/**
 * True when the 3598 leftover cleanup must never treat the folder as a leftover: it
 * holds (or may hold) Keepr ciphertext, or it is a recorded phone-encrypted chain.
 */
export function markerProtectsChain(reading: MarkerReading): boolean {
  return (
    reading === "migrating" ||
    reading === "encrypted" ||
    reading === "syncing" ||
    reading === "apple-encrypted"
  );
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function errCode(error: unknown): string {
  if (error instanceof AtRestIntegrityError) return "INTEGRITY";
  if (error instanceof DataKeyUnavailableError) return "KEY_MISSING";
  const code = (error as NodeJS.ErrnoException)?.code;
  return typeof code === "string" ? code : error instanceof Error ? error.name : "UNKNOWN";
}

function emptyReport(): PassReport {
  return { files: 0, changed: 0, already: 0, empty: 0, damaged: 0, failed: 0, failedCodes: {}, tempsRemoved: 0, ms: 0 };
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.promises.lstat(p);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw error;
  }
}

async function defaultFreeBytes(dir: string): Promise<number> {
  const stats = await fs.promises.statfs(dir);
  return Number(stats.bavail) * Number(stats.bsize);
}

/** Owner-encrypted chain? Manifest.plist `IsEncrypted` (plain device metadata). Never throws. */
export async function isAppleEncryptedChain(
  chainDir: string,
  readPlist: (p: string) => Promise<Buffer> = async (p) => openBackupIndexBytes(await fs.promises.readFile(p)),
): Promise<boolean> {
  let buf: Buffer;
  try {
    // Sealed in a Keepr chain (decrypted in memory); an Apple chain's is never sealed.
    buf = await readPlist(path.join(chainDir, "Manifest.plist"));
  } catch {
    return false;
  }
  try {
    const parsed = plist.parse(buf) as { IsEncrypted?: unknown };
    return parsed?.IsEncrypted === true;
  } catch {
    return false;
  }
}

/** Run `work` over `items` with at most `limit` in flight. */
async function pool<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await work(items[i]);
    }
  });
  await Promise.all(workers);
}

interface ListedFile {
  path: string;
  size: number;
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

type BusyReason = "migrating" | "syncing" | "sealing";

export class BackupAtRest extends EventEmitter {
  private readonly busy = new Map<string, BusyReason>();
  private readonly log: LogFn;
  /** Damaged-file count from the last scan after a seal, per phone. */
  private readonly lastScanDamaged = new Map<string, number>();
  /** Why the next sync of this phone is C-FULL, if it is. Kept in the phone's marker file, so it survives a restart. */
  async forcedFullReason(udid: string): Promise<string | null> {
    try {
      const marker = await this.deps.markers().readBackupMarker(udid);
      return marker?.nextStrategy === "full" ? (marker.reasonCode ?? "FORCED") : null;
    } catch {
      return null;
    }
  }
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly concurrency: number;
  /**
   * Pause flags of the background passes that a sync may interrupt (the launch migration
   * and the seal after a sync), per phone. Present only while such a pass holds the lock.
   */
  private readonly pausable = new Map<string, Int32Array>();
  /** Phones whose background pass was paused for a sync, to be resumed if that sync never unseals. */
  private readonly pausedForSync = new Set<string>();

  constructor(private readonly deps: BackupAtRestDeps) {
    super();
    this.log =
      deps.log ??
      ((level, message, data) => {
        const line = data ? `${message} ${JSON.stringify(data)}` : message;
        hostLogger[level](line);
      });
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;
  }

  /** Reads a root plist whether sealed or not (the FileCrypto's own reader). */
  private readonly readPlist = (p: string): Promise<Buffer> => this.deps.files().readAllDecrypted(p);

  chainDir(udid: string): string {
    if (!UDID_DIR_PATTERN.test(udid)) throw new Error("invalid device id for a backup chain");
    return path.join(this.deps.backupsRoot(), udid);
  }

  /**
   * Where a pass reports progress: the caller's callback (a sync shows it in its own
   * status), or else the `progress` event — the seal after a sync and the launch job
   * have no caller watching; syncHandlers forwards the event to `sync:progress`.
   */
  private progressSink(onProgress?: (p: BackupAtRestProgress) => void): (p: BackupAtRestProgress) => void {
    return onProgress ?? ((p) => this.emit("progress", p));
  }

  /** Release the per-phone lock and wake a sync waiting for it. */
  private release(udid: string): void {
    this.busy.delete(udid);
    this.pausable.delete(udid);
    this.emit("released", udid);
  }

  /** Resolves when `udid`'s lock is released, or false after `ms`. */
  private waitForRelease(udid: string, ms: number): Promise<boolean> {
    if (!this.busy.has(udid)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const onRelease = (released: string) => {
        if (released !== udid) return;
        clearTimeout(timer);
        this.off("released", onRelease);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.off("released", onRelease);
        resolve(false);
      }, ms);
      this.on("released", onRelease);
    });
  }

  /**
   * Ask the background pass holding `udid` (launch migration or post-sync seal) to stop at
   * the next file boundary. True when there was one to ask.
   */
  requestPause(udid: string): boolean {
    const flag = this.pausable.get(udid);
    if (!flag) return false;
    Atomics.store(flag, 0, 1);
    return true;
  }

  /**
   * A background pass paused for a sync that then never unsealed (refused, or its own
   * new-chain step failed): finish it now instead of waiting for the next launch.
   */
  private resumeIfPausedForSync(udid: string): void {
    if (!this.pausedForSync.delete(udid)) return;
    setImmediate(() => {
      void (async () => {
        // The paused pass may still be finishing its current file.
        while (this.busy.has(udid)) await this.waitForRelease(udid, PAUSE_REPORT_INTERVAL_MS);
        await this.migrate(udid);
      })().catch((error) => {
        this.log("warn", "[BackupAtRest] could not resume a paused seal; the next launch retries", { code: errCode(error) });
      });
    });
  }

  /** Why `udid` cannot sync right now, or null. */
  busyReason(udid: string): BusyReason | null {
    return this.busy.get(udid) ?? null;
  }

  /** Any phone whose backup is being migrated or sealed (for status displays). */
  activeWork(): Array<{ udid: string; reason: BusyReason }> {
    return [...this.busy.entries()].map(([udid, reason]) => ({ udid, reason }));
  }

  async readMarker(udid: string): Promise<MarkerReading> {
    return readMarkerAt(this.deps.backupsRoot(), udid);
  }

  private async setMarker(udid: string, state: BackupAtRestState): Promise<void> {
    await this.deps.markers().writeBackupMarker(udid, state);
  }

  async removeMarker(udid: string): Promise<void> {
    await fs.promises.rm(this.deps.markers().backupMarkerPath(udid), { force: true });
  }

  /** A phone-encrypted chain: recorded as `apple-encrypted` when it has an index, else no marker. */
  private async recordAppleChain(udid: string): Promise<void> {
    if (await exists(path.join(this.chainDir(udid), "Manifest.db"))) {
      await this.setMarker(udid, "apple-encrypted");
    } else {
      await this.removeMarker(udid);
    }
  }

  // -------------------------------------------------------------------------
  // Walking and classifying
  // -------------------------------------------------------------------------

  /**
   * Every regular file in the chain, root plists included. Symlinks are not
   * followed (a backup never contains one). Orphaned *.kenc-tmp files — a killed seal
   * leaves ciphertext, a killed unseal leaves PLAINTEXT — are deleted here.
   */
  private async listFiles(chainDir: string, report: PassReport | null): Promise<ListedFile[]> {
    const out: ListedFile[] = [];
    const walk = async (dir: string, atRoot: boolean): Promise<void> => {
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
        throw error;
      }
      const subdirs: string[] = [];
      const candidates: string[] = [];
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          subdirs.push(full);
          continue;
        }
        if (!entry.isFile()) continue;
        if (entry.name.endsWith(KENC_TMP_SUFFIX)) {
          await fs.promises.rm(full, { force: true }).catch(() => undefined);
          if (report) report.tempsRemoved++;
          continue;
        }
        candidates.push(full);
      }
      // Sizes in parallel (a backup has ~256 directories of ~2,000 files each).
      const sizes = new Array<number>(candidates.length);
      await pool(candidates.map((_, i) => i), 32, async (i) => {
        try {
          sizes[i] = (await fs.promises.lstat(candidates[i])).size;
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code === "ENOENT") sizes[i] = -1;
          else throw error;
        }
      });
      candidates.forEach((full, i) => {
        if (sizes[i] >= 0) out.push({ path: full, size: sizes[i] });
      });
      for (const sub of subdirs) await walk(sub, false);
    };
    await walk(chainDir, true);
    return out;
  }

  /** Magic first (one open for the common plaintext case), structural probe only on a magic hit. */
  async classify(file: string, size?: number): Promise<FileClass> {
    const handle = await fs.promises.open(file, "r");
    let head: Buffer;
    let fileSize: number;
    try {
      fileSize = size ?? (await handle.stat()).size;
      if (fileSize === 0) return "empty";
      head = Buffer.alloc(MAGIC.length);
      const { bytesRead } = await handle.read(head, 0, MAGIC.length, 0);
      if (bytesRead < MAGIC.length || !head.equals(MAGIC)) return "plaintext";
    } finally {
      await handle.close();
    }
    return (await probeHeader(file)).encrypted ? "sealed" : "damaged";
  }

  private async withRetry(op: () => Promise<void>): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await op();
        return;
      } catch (error) {
        const code = errCode(error);
        const retryable =
          RETRYABLE_CODES.has(code) ||
          (error instanceof AtRestIntegrityError && /changed while/.test(error.message));
        if (!retryable || attempt >= RETRY_ATTEMPTS - 1) throw error;
        await this.sleep(100 * 2 ** attempt);
      }
    }
  }

  private async diskOk(dir: string, largest: number): Promise<boolean> {
    if (largest <= 0) return true;
    const free = this.deps.freeBytes ?? defaultFreeBytes;
    try {
      return (await free(dir)) >= largest + DISK_HEADROOM_BYTES;
    } catch {
      return true; // cannot measure: the per-file write fails cleanly on ENOSPC
    }
  }

  // -------------------------------------------------------------------------
  // Passes
  // -------------------------------------------------------------------------

  /**
   * Seal every plaintext file in the chain (idempotent: sealed files are skipped by
   * header). Returns what happened; never leaves a file half-written (fileCrypto's
   * temp → verify → rename). Throws only when the chain cannot be listed.
   */
  async seal(udid: string, onProgress?: (p: BackupAtRestProgress) => void, phase: "sealing" | "migrating" = "sealing"): Promise<PassReport> {
    return this.sealAt(this.chainDir(udid), udid, onProgress, phase, this.pausable.get(udid));
  }

  private async sealAt(
    chain: string,
    udid: string,
    onProgress?: (p: BackupAtRestProgress) => void,
    phase: "sealing" | "migrating" = "sealing",
    pause?: Int32Array,
  ): Promise<PassReport> {
    const started = Date.now();
    const report = emptyReport();
    const listed = await this.listFiles(chain, report);
    report.files = listed.length;
    const largest = listed.reduce((m, f) => Math.max(m, f.size), 0);
    if (!(await this.diskOk(chain, largest))) {
      report.failed = listed.length;
      report.failedCodes.DISK_SPACE = listed.length;
      report.ms = Date.now() - started;
      return report;
    }
    if (listed.length === 0) {
      report.ms = Date.now() - started;
      return report;
    }
    let key: AtRestKey;
    try {
      key = await this.sealKey();
    } catch (error) {
      const code = errCode(error);
      report.failed = listed.length;
      report.failedCodes[code] = listed.length;
      report.ms = Date.now() - started;
      return report;
    }
    const notify = this.progressSink(onProgress);
    const totalUnits = listed.reduce((sum, f) => sum + f.size + PROGRESS_FILE_WEIGHT_BYTES, 0);
    let done = 0;
    let doneUnits = 0;
    let lastEmit = Date.now();
    notify({ udid, phase, done: 0, total: listed.length, doneUnits: 0, totalUnits });
    const result = await this.pass(listed, "seal", key, pause, (indexes, outcomes) => {
      outcomes.forEach((o, k) => {
        this.tally(report, o);
        done++;
        doneUnits += listed[indexes[k]].size + PROGRESS_FILE_WEIGHT_BYTES;
      });
      const now = Date.now();
      if (now - lastEmit >= PROGRESS_INTERVAL_MS && done < listed.length) {
        lastEmit = now;
        const elapsed = now - started;
        // An estimate only once there is something to go on (10 s and 1% in).
        const etaMs =
          elapsed >= 10_000 && doneUnits >= totalUnits / 100
            ? Math.round((elapsed * (totalUnits - doneUnits)) / doneUnits)
            : undefined;
        notify({ udid, phase, done, total: listed.length, doneUnits, totalUnits, ...(etaMs !== undefined ? { etaMs } : {}) });
      }
    });
    if (result.stopped) report.paused = true;
    // One directory fsync per touched directory makes the renames durable before any
    // marker can say `encrypted` (see sealEngine.ts: a lost rename leaves the plaintext,
    // never loses it).
    await pool([...result.touchedDirs], 4, (dir) => fsyncDir(dir));
    if (!result.stopped) notify({ udid, phase, done: listed.length, total: listed.length, doneUnits: totalUnits, totalUnits });
    report.ms = Date.now() - started;
    return report;
  }

  private tally(report: PassReport, o: FileOutcome): void {
    switch (o.v) {
      case "sealed-now":
        report.changed++;
        break;
      case "sealed":
        report.already++;
        break;
      case "empty":
        report.empty++;
        break;
      case "damaged":
        report.damaged++;
        break;
      case "gone":
        report.files--; // deleted while we walked (idevicebackup2 / 3598): nothing to protect
        break;
      default: {
        // "failed" (or "plaintext", which a seal pass never returns: counted against).
        const code = o.code ?? "UNKNOWN";
        report.failed++;
        report.failedCodes[code] = (report.failedCodes[code] ?? 0) + 1;
      }
    }
  }

  private async sealKey(): Promise<AtRestKey> {
    if (this.deps.sealKey) return this.deps.sealKey();
    const files = this.deps.files();
    if (typeof files.sealingKey !== "function") {
      throw new Error("the at-rest file service does not expose its sealing key");
    }
    return files.sealingKey();
  }

  /** One worker (or in-process) pass over `listed`. */
  private pass(
    listed: readonly PassFile[],
    mode: SealMode,
    key: AtRestKey,
    pause: Int32Array | undefined,
    onBatch?: (indexes: readonly number[], outcomes: readonly FileOutcome[]) => void,
  ) {
    return runPass({
      files: listed,
      mode,
      key,
      chunkSize: this.deps.chunkSize,
      workers: this.deps.workers ?? 0,
      workerScript: this.deps.workerScript,
      stop: pause ?? new Int32Array(new SharedArrayBuffer(4)),
      engineOptions: { retryDelayMs: this.deps.sleep ? 0 : 100, ...this.deps.sealEngineOptions },
      onBatch,
      log: this.log,
    });
  }

  /** Decrypt sealed files in place. `only` limits the pass to those chain-relative paths. */
  async unseal(udid: string, only?: readonly string[], onProgress?: (p: BackupAtRestProgress) => void): Promise<PassReport> {
    const started = Date.now();
    const report = emptyReport();
    const chain = this.chainDir(udid);
    let listed: ListedFile[];
    if (only) {
      listed = [];
      for (const rel of only) {
        const full = path.join(chain, rel);
        try {
          listed.push({ path: full, size: (await fs.promises.lstat(full)).size });
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
        }
      }
    } else {
      listed = await this.listFiles(chain, report);
    }
    report.files = listed.length;
    const largest = listed.reduce((m, f) => Math.max(m, f.size), 0);
    if (!(await this.diskOk(chain, largest))) {
      report.failed = listed.length;
      report.failedCodes.DISK_SPACE = listed.length;
      report.ms = Date.now() - started;
      return report;
    }
    const files = this.deps.files();
    const notify = this.progressSink(onProgress);
    let done = 0;
    if (listed.length > 0) notify({ udid, phase: "unsealing", done: 0, total: listed.length });
    await pool(listed, this.concurrency, async (f) => {
      try {
        const cls = await this.classify(f.path, f.size);
        if (cls === "empty") report.empty++;
        else if (cls === "damaged") report.damaged++;
        else if (cls === "plaintext") report.already++;
        else {
          await this.withRetry(async () => {
            await files.decryptToFile(f.path, f.path);
          });
          report.changed++;
        }
      } catch (error) {
        report.failed++;
        const code = errCode(error);
        report.failedCodes[code] = (report.failedCodes[code] ?? 0) + 1;
      }
      done++;
      if (done % 500 === 0 || done === listed.length) {
        notify({ udid, phase: "unsealing", done, total: listed.length });
      }
    });
    report.ms = Date.now() - started;
    return report;
  }

  /** Header scan: what the chain holds right now. */
  async scan(udid: string): Promise<ScanReport> {
    return this.scanAt(this.chainDir(udid), this.pausable.get(udid));
  }

  private async scanAt(dir: string, pause?: Int32Array): Promise<ScanReport> {
    const result: ScanReport = { sealed: 0, plaintext: 0, empty: 0, damaged: 0 };
    const listed = await this.listFiles(dir, null);
    if (listed.length === 0) return result;
    // Classification needs no key; the workers are started with an empty one.
    const noKey: AtRestKey = { keyId: "0".repeat(32), key: Buffer.alloc(32) };
    const pass = await this.pass(listed, "classify", noKey, pause);
    if (pass.stopped) result.paused = true;
    for (const o of pass.outcomes) {
      if (!o || o.v === "gone") continue;
      if (o.v === "sealed" || o.v === "sealed-now") result.sealed++;
      else if (o.v === "empty") result.empty++;
      else if (o.v === "damaged") result.damaged++;
      else result.plaintext++; // plaintext, or unreadable: counts against
    }
    return result;
  }

  /**
   * Seal, scan, and record. `encrypted` is written only when the scan finds zero
   * plaintext; otherwise the marker is left `syncing` so the next launch retries.
   * A folder with no Manifest.db (an unfinished first backup) is sealed but gets NO
   * marker, so the 3598 cleanup can still remove it.
   */
  private async sealAndRecord(udid: string, phase: "sealing" | "migrating", onProgress?: (p: BackupAtRestProgress) => void): Promise<"encrypted" | "incomplete" | "absent" | "apple" | "unindexed" | "paused"> {
    const chain = this.chainDir(udid);
    // Per scan: an early return below must not leave the previous scan's count behind.
    this.lastScanDamaged.delete(udid);
    if (!(await exists(chain))) {
      await this.removeMarker(udid);
      return "absent";
    }
    if (await isAppleEncryptedChain(chain, this.readPlist)) {
      await this.recordAppleChain(udid);
      return "apple";
    }
    const report = await this.seal(udid, onProgress, phase);
    if (report.paused) {
      // A sync asked for this phone. The marker stays as it is (migrating / syncing), so
      // nothing claims `encrypted`; that sync's own seal — or the next launch — finishes.
      this.log("info", "[BackupAtRest] paused for a sync", {
        phase,
        files: report.files,
        sealedNow: report.changed,
        ms: report.ms,
      });
      return "paused";
    }
    const indexed = await exists(path.join(chain, "Manifest.db"));
    const scan = await this.scan(udid);
    if (scan.paused) {
      this.log("info", "[BackupAtRest] paused for a sync (after sealing, during the check)", { phase, sealedNow: report.changed });
      return "paused";
    }
    this.lastScanDamaged.set(udid, scan.damaged);
    this.log("info", "[BackupAtRest] sealed", {
      phase,
      files: report.files,
      sealedNow: report.changed,
      already: report.already,
      empty: report.empty,
      damaged: report.damaged,
      failed: report.failed,
      failedCodes: report.failedCodes,
      tempsRemoved: report.tempsRemoved,
      ms: report.ms,
      plaintextLeft: scan.plaintext,
    });
    if (!indexed) {
      await this.removeMarker(udid);
      return "unindexed";
    }
    if (scan.plaintext === 0) {
      await this.setMarker(udid, "encrypted");
      return "encrypted";
    }
    await this.setMarker(udid, phase === "migrating" ? "migrating" : "syncing");
    return "incomplete";
  }

  // -------------------------------------------------------------------------
  // Sync lifecycle
  // -------------------------------------------------------------------------

  /**
   * Called by the sync BEFORE `idevicebackup2` runs. Refuses (throws
   * {@link BackupAtRestRefusal}) when the backup is being migrated or sealed, when the
   * data key cannot be opened (nothing would protect the new files), when there is not
   * enough room to unseal, or when a sealed file cannot be opened. Otherwise unseals per
   * strategy and returns the session the sync must hand to {@link finishSync}.
   *
   * `underLock` runs UNDER the per-phone lock, before the chain is looked at: the
   * orchestrator's new-chain step (move the old chain aside / delete it) goes there, so a
   * launch migration can never start on a chain that is about to be moved. An error from
   * `underLock` releases the lock and propagates unchanged (it is not a refusal).
   */
  async beginSync(
    udid: string,
    opts: {
      strategy?: BackupUnsealStrategy;
      onProgress?: (p: BackupAtRestProgress) => void;
      underLock?: () => Promise<void>;
      /** The sync's cancel: ends a wait for a background pass to pause (reason `cancelled`). */
      signal?: AbortSignal;
    } = {},
  ): Promise<BackupSyncSession> {
    const chain = this.chainDir(udid);
    // A background pass (the launch migration, or the seal after the previous sync) gives
    // way: it stops at the next file boundary and this sync starts. What it did not reach
    // is sealed by this sync's own seal at the end (it seals every plaintext file), or by
    // the next launch. The sync is never refused for it and never waits for the whole seal.
    // The wait is NOT bounded: a pass stops within one file, and a sync must never fail
    // because a seal is running (founder decision 2026-10-09). The line repeats while it
    // waits, and the user's Cancel ends the wait as a cancel, not a failure.
    let pausedOne = false;
    while (this.requestPause(udid)) {
      pausedOne = true;
      opts.onProgress?.({ udid, phase: "pausing", done: 0, total: 0 });
      const released = await this.waitForRelease(udid, this.deps.pauseWaitMs ?? PAUSE_REPORT_INTERVAL_MS);
      if (opts.signal?.aborted) {
        this.pausedForSync.add(udid);
        this.resumeIfPausedForSync(udid);
        throw new BackupAtRestRefusal("cancelled", "Sync cancelled by user");
      }
      if (!released) continue; // still finishing its current file: say so again, keep waiting
    }
    if (pausedOne) this.pausedForSync.add(udid);
    const holder = this.busy.get(udid);
    if (holder) {
      this.resumeIfPausedForSync(udid);
      throw new BackupAtRestRefusal("busy", BACKUP_SECURING_MESSAGE);
    }
    // Claimed in the same tick as the check: a launch migration that starts while this
    // awaits finds the phone busy (and vice versa). Released by finishSync, or below
    // when no session is handed out.
    this.busy.set(udid, "syncing");
    let handedOut = false;
    try {
      if (opts.underLock) await opts.underLock();
      const forcedFull = await this.forcedFullReason(udid);
      const strategy: BackupUnsealStrategy =
        opts.strategy ?? (forcedFull ? "full" : (this.deps.strategy?.() ?? BACKUP_UNSEAL_STRATEGY));
      if (forcedFull && !opts.strategy) {
        this.log("warn", "[BackupAtRest] this sync unseals the whole backup (C-FULL)", { reasonCode: forcedFull });
      }
      const chainExists = await exists(chain);
      if (chainExists && (await isAppleEncryptedChain(chain, this.readPlist))) {
        await this.recordAppleChain(udid);
        handedOut = true;
        return { kind: "apple", udid };
      }

      try {
        await this.deps.ensureKey();
      } catch {
        throw new BackupAtRestRefusal("key-unavailable", BACKUP_AT_REST_KEY_UNAVAILABLE_MESSAGE);
      }

      if (!chainExists || !(await exists(path.join(chain, "Manifest.db")))) {
        // First backup (or an unfinished one the 3598 sweep will remove): no marker yet.
        await this.removeMarker(udid);
        handedOut = true;
        return { kind: "first", udid };
      }

      const session = await this.unsealKeptChain(udid, strategy, opts.onProgress);
      handedOut = true;
      return session;
    } finally {
      if (!handedOut) {
        this.release(udid);
        this.resumeIfPausedForSync(udid);
      }
    }
  }

  /** beginSync for a Keepr-managed chain; the caller holds the lock. */
  private async unsealKeptChain(
    udid: string,
    strategy: BackupUnsealStrategy,
    onProgress?: (p: BackupAtRestProgress) => void,
  ): Promise<BackupSyncSession> {
    const opts = { onProgress };
    try {
      // C3 (BACKLOG-3816 seal throughput): a chain left `syncing` / `migrating` (a crash, a
      // quit, or a background seal that paused for this sync) still holds plaintext files.
      // They are NOT sealed before this sync any more: under C-DELTA a chain that is part
      // sealed, part plain is the normal state during a sync (idevicebackup2 reads no
      // unchanged content file — Step 0b), under C-FULL everything is unsealed anyway, and
      // the seal at the end of this sync seals every plaintext file it finds. The launch
      // job still seals such a chain when no sync comes first.
      // From the first unsealed byte on, the marker says `syncing`.
      await this.setMarker(udid, "syncing");
      const report =
        strategy === "full"
          ? await this.unseal(udid, undefined, opts.onProgress)
          : await this.unseal(udid, DELTA_UNSEAL_FILES, opts.onProgress);
      this.log("info", "[BackupAtRest] unsealed for sync", {
        strategy,
        files: report.files,
        unsealed: report.changed,
        damaged: report.damaged,
        failed: report.failed,
        failedCodes: report.failedCodes,
        ms: report.ms,
      });
      if (report.failed > 0) {
        const codes = Object.keys(report.failedCodes).sort();
        if (codes.length > 0 && codes.every((c) => UNRECOVERABLE_CODES.has(c))) {
          // B2: no retry can open these files. Refusing would end iPhone sync for good;
          // the backup is a cache of the phone, so move it aside and back up in full.
          return await this.quarantineChain(udid, codes.join("+"), opts.onProgress);
        }
        const disk = report.failedCodes.DISK_SPACE !== undefined;
        throw new BackupAtRestRefusal(
          disk ? "disk-space" : "unreadable",
          disk ? BACKUP_AT_REST_DISK_MESSAGE : BACKUP_AT_REST_UNREADABLE_MESSAGE,
        );
      }
      return { kind: "keepr", udid, strategy };
    } catch (error) {
      // Put back what was unsealed before refusing; the marker is `syncing` until then.
      const session: BackupSyncSession = { kind: "keepr", udid, strategy };
      await this.finishSync(session);
      if (error instanceof BackupAtRestRefusal) throw error;
      throw new BackupAtRestRefusal("unreadable", BACKUP_AT_REST_UNREADABLE_MESSAGE);
    }
  }

  /**
   * B2: re-seal what the failed unseal opened, then move the chain (still sealed, its
   * unreadable files untouched) to `Backups/.quarantine/<udid>-<ms>` and drop its marker.
   * The caller holds the lock and keeps it: the returned session is a first backup.
   * Throws when the move fails; the caller then re-seals and refuses as before.
   */
  private async quarantineChain(
    udid: string,
    reasonCode: string,
    onProgress?: (p: BackupAtRestProgress) => void,
  ): Promise<BackupSyncSession> {
    this.busy.set(udid, "sealing");
    const sealed = await this.sealAndRecord(udid, "sealing", onProgress);
    this.busy.set(udid, "syncing");
    // Nothing seals `.quarantine` afterwards, so a chain that still holds a plaintext
    // file (one re-seal failed: EIO, an antivirus lock) must not be moved into it. Throw
    // before the rename: the caller re-seals and refuses, as for a failed move.
    if (sealed !== "encrypted") {
      throw new BackupAtRestRefusal("unreadable", BACKUP_AT_REST_UNREADABLE_MESSAGE);
    }
    const quarantineRoot = path.join(this.deps.backupsRoot(), QUARANTINE_DIR_NAME);
    await fs.promises.mkdir(quarantineRoot, { recursive: true, mode: 0o700 });
    const dest = path.join(quarantineRoot, `${udid}-${this.now()}`);
    await this.withRetry(async () => {
      await fs.promises.rename(this.chainDir(udid), dest);
    });
    await this.removeMarker(udid);
    this.log("warn", "[BackupAtRest] moved an unreadable backup to quarantine; this sync makes a full backup", {
      reasonCode,
    });
    return { kind: "first", udid, quarantined: { reasonCode } };
  }

  /**
   * Launch: delete quarantined chains older than {@link QUARANTINE_MAX_AGE_MS}, aged by
   * the time in the folder name (the move keeps the chain's own mtime). Never throws.
   * Returns how many were deleted.
   */
  async purgeQuarantine(): Promise<number> {
    const root = path.join(this.deps.backupsRoot(), QUARANTINE_DIR_NAME);
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(root, { withFileTypes: true });
    } catch {
      return 0;
    }
    const now = this.now();
    let removed = 0;
    for (const entry of entries) {
      const full = path.join(root, entry.name);
      try {
        const stamp = /-(\d{10,})$/.exec(entry.name);
        const movedAt = stamp ? Number(stamp[1]) : (await fs.promises.lstat(full)).mtimeMs;
        if (now - movedAt <= QUARANTINE_MAX_AGE_MS) continue;
        await fs.promises.rm(full, { recursive: true, force: true });
        removed++;
      } catch (error) {
        this.log("warn", "[BackupAtRest] could not delete an expired quarantined backup", { code: errCode(error) });
      }
    }
    return removed;
  }

  /**
   * Deletes the oldest quarantined chain (by the time in its folder name). The sync calls
   * this when its disk guard would refuse: a quarantined copy is unreadable and must never
   * block the fresh full backup. Never throws. Returns true when one was deleted.
   */
  async deleteOldestQuarantined(): Promise<boolean> {
    const root = path.join(this.deps.backupsRoot(), QUARANTINE_DIR_NAME);
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(root, { withFileTypes: true });
    } catch {
      return false;
    }
    const dated: Array<{ name: string; at: number }> = [];
    for (const entry of entries) {
      const stamp = /-(\d{10,})$/.exec(entry.name);
      let at = stamp ? Number(stamp[1]) : 0;
      if (!stamp) {
        try {
          at = (await fs.promises.lstat(path.join(root, entry.name))).mtimeMs;
        } catch {
          at = 0;
        }
      }
      dated.push({ name: entry.name, at });
    }
    dated.sort((a, b) => a.at - b.at);
    for (const { name } of dated) {
      try {
        await fs.promises.rm(path.join(root, name), { recursive: true, force: true });
        this.log("warn", "[BackupAtRest] deleted a quarantined backup to make room for the fresh full backup");
        return true;
      } catch (error) {
        this.log("warn", "[BackupAtRest] could not delete a quarantined backup", { code: errCode(error) });
      }
    }
    return false;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /**
   * Called on EVERY end of a sync that {@link beginSync} returned a session for — success
   * after persistence, persistence cancel/fail, and every error/cancel/disconnect/disk
   * guard/watchdog exit. Never throws. Releases the per-phone lock.
   */
  async finishSync(
    session: BackupSyncSession,
    onProgress?: (p: BackupAtRestProgress) => void,
    opts: { forceFullNext?: string; succeeded?: boolean } = {},
  ): Promise<void> {
    if (session.kind === "none") return;
    // This sync's seal also seals whatever a paused background pass did not reach.
    this.pausedForSync.delete(session.udid);
    try {
      this.busy.set(session.udid, "sealing");
      // The next sync may pause this seal at a file boundary (see beginSync).
      this.pausable.set(session.udid, new Int32Array(new SharedArrayBuffer(4)));
      // An Apple-encrypted chain is detected inside and only recorded; a phone that
      // turned encryption OFF produced a plaintext chain, which is sealed.
      const outcome = await this.sealAndRecord(session.udid, "sealing", onProgress);
      // Safety net for C-DELTA. Reading a still-sealed file leaves no trace, so that is not
      // detectable; what IS detectable is damage: a file that carries the sealed header but
      // does not parse (an incremental that rewrote or truncated sealed content). Then the
      // next sync of this phone unseals everything, and a clean C-FULL sync clears it.
      if (session.kind === "keepr") {
        const damaged = this.lastScanDamaged.get(session.udid) ?? 0;
        if (session.strategy === "delta" && opts.forceFullNext) {
          // The backup tool itself failed. It may have needed a sealed file, and a failure
          // that damages nothing would otherwise repeat on every sync.
          await this.deps.markers().setNextStrategy(session.udid, opts.forceFullNext);
          this.log("warn", "[BackupAtRest] a delta sync failed in the backup tool; the next sync unseals everything", {
            reasonCode: opts.forceFullNext,
            damaged,
          });
        } else if (session.strategy === "delta" && damaged > 0) {
          await this.deps.markers().setNextStrategy(session.udid, FORCE_FULL_REASON_DELTA_DAMAGED);
          this.log("warn", "[BackupAtRest] a delta sync left damaged files; the next sync unseals everything", {
            reasonCode: FORCE_FULL_REASON_DELTA_DAMAGED,
            damaged,
          });
        } else if (session.strategy === "full" && damaged === 0 && outcome === "encrypted" && opts.succeeded === true) {
          // Only a C-FULL sync that COMPLETED (persistence stored) clears the force-full flag.
          // A failed or cancelled forced FULL leaves the chain unproven, so the flag stays.
          await this.deps.markers().setNextStrategy(session.udid, null);
        }
      }
      // A plaintext chain moved aside for this phone (#2884) is sealed too; it stays
      // until the new encrypted chain verifies, possibly forever. Not when this seal was
      // paused for a sync: that sync's own seal does it.
      const aside = outcome === "paused" ? 0 : await this.sealAsideChains(session.udid);
      this.log("info", "[BackupAtRest] sync ended", { session: session.kind, outcome, asideSealed: aside });
    } catch (error) {
      this.log("error", "[BackupAtRest] could not seal after sync; the next launch retries", {
        code: errCode(error),
      });
    } finally {
      this.release(session.udid);
    }
  }

  // -------------------------------------------------------------------------
  // Launch: recovery + migration
  // -------------------------------------------------------------------------

  /**
   * Startup job `backups`. For every chain under Backups/:
   *   Apple-encrypted        → skipped, stale marker removed
   *   busy (a sync started)  → skipped (that sync's finishSync seals it)
   *   no Manifest.db         → sealed without a marker (3598 still removes it)
   *   encrypted              → nothing (trusted; a scan of 573k files each launch is too slow)
   *   anything else          → marker `migrating`, seal, scan, `encrypted` when clean
   * Resumable by header presence. Never throws for one chain's failure.
   */
  async runLaunchJob(onProgress?: (p: BackupAtRestProgress) => void): Promise<Record<string, string>> {
    const outcomes: Record<string, string> = {};
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(this.deps.backupsRoot(), { withFileTypes: true });
    } catch {
      return outcomes;
    }
    outcomes.quarantinePurged = String(await this.purgeQuarantine());
    try {
      outcomes.aside = String(await this.sealAsideChains());
    } catch (error) {
      outcomes.aside = `failed:${errCode(error)}`;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !UDID_DIR_PATTERN.test(entry.name)) continue;
      const udid = entry.name;
      try {
        outcomes[udid] = await this.migrate(udid, onProgress);
      } catch (error) {
        outcomes[udid] = `failed:${errCode(error)}`;
        this.log("error", "[BackupAtRest] launch job failed for one backup", { code: errCode(error) });
      }
    }
    return outcomes;
  }

  /**
   * Seal every moved-aside chain (`.keepr-replaced-<udid>-*`), or only `udid`'s. Same
   * rules as a chain: root plists sealed too, empty/damaged untouched, Apple-encrypted
   * skipped. No marker (the name keeps it out of the 3598 sweep, and removal is by
   * name after the new chain verifies). Returns how many directories are fully sealed.
   */
  async sealAsideChains(udid?: string): Promise<number> {
    const root = this.deps.backupsRoot();
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(root, { withFileTypes: true });
    } catch {
      return 0;
    }
    const prefix = udid ? `${REPLACED_CHAIN_PREFIX}${udid}-` : REPLACED_CHAIN_PREFIX;
    let clean = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
      const dir = path.join(root, entry.name);
      if (await isAppleEncryptedChain(dir, this.readPlist)) continue;
      const label = entry.name.slice(REPLACED_CHAIN_PREFIX.length);
      const pause = udid ? this.pausable.get(udid) : undefined;
      const report = await this.sealAt(dir, label, undefined, "sealing", pause);
      if (report.paused) break;
      const scan = await this.scanAt(dir, pause);
      if (scan.paused) break;
      this.log("info", "[BackupAtRest] sealed a moved-aside backup", {
        files: report.files,
        sealedNow: report.changed,
        failed: report.failed,
        plaintextLeft: scan.plaintext,
      });
      if (scan.plaintext === 0) clean++;
    }
    return clean;
  }

  /** Seal one chain at launch (migration of a pre-2.40 backup, or crash recovery). */
  async migrate(udid: string, onProgress?: (p: BackupAtRestProgress) => void): Promise<string> {
    const chain = this.chainDir(udid);
    if (this.busy.has(udid)) return "busy";
    this.busy.set(udid, "migrating"); // same tick as the check (see beginSync)
    // A sync that starts meanwhile pauses this at a file boundary (see beginSync).
    this.pausable.set(udid, new Int32Array(new SharedArrayBuffer(4)));
    try {
      if (await isAppleEncryptedChain(chain, this.readPlist)) {
        await this.recordAppleChain(udid);
        return "apple";
      }
      const marker = await this.readMarker(udid);
      if (marker === "encrypted") return "encrypted";
      try {
        await this.deps.ensureKey();
      } catch {
        return "key-unavailable";
      }
      const indexed = await exists(path.join(chain, "Manifest.db"));
      if (indexed && marker !== "syncing") await this.setMarker(udid, "migrating");
      return await this.sealAndRecord(udid, "migrating", onProgress);
    } finally {
      this.release(udid);
    }
  }

  // -------------------------------------------------------------------------
  // C-DELTA read path
  // -------------------------------------------------------------------------

  /**
   * Build a parse copy of what the sync reads (sms.db, AddressBook, message attachments)
   * from a chain whose files are a mix of sealed and plaintext. Laid out like a backup
   * (`XX/<fileID>`), so the parsers and the attachment copier read it unchanged.
   * `outDir` must be a fresh parse-copy directory (decryptionService.newParseCopyDir()),
   * so the existing cleanup and launch sweep own its lifetime.
   */
  async buildParseCopy(udid: string, outDir: string): Promise<{ copied: number; missing: number }> {
    const chain = this.chainDir(udid);
    const files = this.deps.files();
    await fs.promises.mkdir(outDir, { recursive: true, mode: 0o700 });
    const manifestCopy = path.join(outDir, "Manifest.db");
    let copied = 0;
    let missing = 0;
    try {
      await files.decryptToFile(path.join(chain, "Manifest.db"), manifestCopy);
      const rows = selectReadFileRows(manifestCopy);
      await pool(rows, this.concurrency, async (row) => {
        const fileId = String(row.fileID).toLowerCase();
        if (!FILE_ID_PATTERN.test(fileId)) {
          missing++;
          return;
        }
        const src = path.join(chain, fileId.slice(0, 2), fileId);
        const dest = path.join(outDir, fileId.slice(0, 2), fileId);
        try {
          await files.decryptToFile(src, dest);
          copied++;
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
            missing++;
            return;
          }
          throw error;
        }
      });
    } finally {
      await fs.promises.rm(manifestCopy, { force: true });
    }
    return { copied, missing };
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: BackupAtRest | null = null;

export function getBackupAtRest(): BackupAtRest {
  if (!instance) {
    instance = new BackupAtRest({
      backupsRoot: () => path.join(hostAppPaths.userData(), "Backups"),
      files: () => getAtRestFiles(),
      markers: (() => {
        let store: MarkerStore | null = null;
        return () => (store ??= createMarkerStore({ userData: () => hostAppPaths.userData() }));
      })(),
      ensureKey: async () => {
        await getDataKeyService().currentKey();
      },
      // BACKLOG-3816: seal off the main thread (sealWorker.js beside sealPool.js).
      workers: defaultSealWorkers(),
    });
  }
  return instance;
}

/** Test seam. */
export function setBackupAtRestForTests(value: BackupAtRest | null): void {
  instance = value;
}
