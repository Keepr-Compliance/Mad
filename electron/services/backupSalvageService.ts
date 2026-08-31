/**
 * BACKLOG-2915 (round 4, absorbing BACKLOG-3035) — JUDGE A FAILED BACKUP BEFORE
 * THROWING IT AWAY.
 *
 * ## What happened
 *
 * On 2026-08-31 the founder's sync waited ~19 minutes, transferred at ~49 MB/s, grew the
 * backup folder from 59.1 GB to 61.9 GB — and then the iPhone reported MBErrorDomain 205,
 * *"Manifest references files not in backup"*, and the app discarded all of it.
 *
 * Measured afterwards, on that exact directory:
 *
 * | Measure | Value |
 * |---|---|
 * | Files the manifest claims (`flags = 1`) | 506,993 |
 * | Blob files actually on disk | 506,979 |
 * | Missing | **14 — 0.003%** |
 * | `Manifest.db` `pragma quick_check` | **ok** |
 * | `Status.plist` `SnapshotState` | **finished** |
 *
 * 61.9 GB of sound data discarded over fourteen files, and the two files the sync
 * actually reads were both present. `deviceSyncOrchestrator`'s
 * `if (!backupResult.success || !backupResult.backupPath)` went straight to the error
 * path; **no branch examined the data**.
 *
 * ## The measurement rule this module exists to obey
 *
 * The first attempt at that measurement sampled 200 manifest rows and reported 46 blobs
 * missing — 23%, and completely wrong. It was an artefact of resolving blob paths per
 * row. The founder's *"i doubt it actually failed tbh"* is what prompted the re-measure.
 *
 * **COMPARE SET SIZES, NEVER SAMPLE.** Every count here comes from a whole-set
 * comparison, and the missing set is returned by IDENTITY so a caller can say which
 * files are gone rather than how many.
 *
 * ## The gate
 *
 * It is evidence about the DATA. It does not relax the error check, and it cannot: this
 * module never sees `backupResult.success`.
 *
 *   1. The device's own verdict — `Status.plist` `SnapshotState: finished`.
 *   2. `Manifest.db` integrity — `pragma quick_check`.
 *   3. **The files the sync actually reads are present**, by fileID. This is the real
 *      guard, and it is identity rather than ratio on purpose: a ratio cannot tell 14
 *      irrelevant files from 14 carrying the messages.
 *   4. Overall coverage above a floor, as belt-and-braces against a directory that is
 *      broadly shredded but happens to hold those two files.
 *
 * All four must hold. Anything else fails exactly as it does today.
 */

import path from "path";
import { promises as fs } from "fs";
import log from "electron-log";
import { iOSMessagesParser } from "./iosMessagesParser";
import { iOSContactsParser } from "./iosContactsParser";

/**
 * The blob files this app actually reads out of a backup, by fileID.
 *
 * Imported from the parsers rather than restated, so the gate and the reader can never
 * disagree about which files matter.
 */
export const REQUIRED_BACKUP_FILE_IDS: ReadonlyArray<{
  id: string;
  what: string;
}> = [
  { id: iOSMessagesParser.SMS_DB_HASH, what: "messages" },
  { id: iOSContactsParser.ADDRESSBOOK_DB_HASH, what: "contacts" },
];

/**
 * The floor for overall blob coverage, as a fraction of what the manifest claims.
 *
 * **THIS NUMBER IS A POLICY CHOICE, NOT A MEASUREMENT. DO NOT "TUNE" IT.**
 *
 * FOUNDER DECISION, 2026-08-31: 0.999, chosen over 0.99 and over identity-only. It is
 * deliberate, not a placeholder someone left behind, and the reasoning is worth keeping
 * because the next reader's instinct will be to adjust it:
 *
 *  - **The identity check above does the real work.** Whether the sync can proceed is
 *    decided by whether the two databases it actually reads are present — by fileID. A
 *    ratio cannot tell fourteen irrelevant files from fourteen carrying the messages,
 *    which is the entire question. This floor is belt-and-braces: it stops a directory
 *    that is broadly shredded but happens to hold those two files.
 *  - **The margin is enormous.** The only real data point is the founder's backup of
 *    2026-08-31: 506,979 of 506,993 present, or **0.99997** — thirty times clear of this
 *    floor. A backup anywhere near 0.999 is not the case this feature was built for.
 *  - Loosening it to 0.99 would admit a backup missing five thousand files out of half a
 *    million on the strength of two surviving databases. Removing it entirely would admit
 *    any directory at all with the right two files in it.
 */
export const MIN_BLOB_COVERAGE = 0.999;

/** Manifest rows with `flags = 1` are regular files, the ones that have a blob on disk. */
const MANIFEST_REGULAR_FILE_FLAG = 1;

/** How many missing fileIDs to carry back. The full set can be half a million entries. */
const MAX_REPORTED_MISSING = 50;

export interface BackupCoverage {
  /** Regular files the manifest claims. Whole-set count, never a sample. */
  manifestFiles: number;
  /** Of those, how many have a blob on disk. */
  blobsPresent: number;
  /** `manifestFiles - blobsPresent`, derived from the set difference. */
  missingCount: number;
  /** The first {@link MAX_REPORTED_MISSING} missing fileIDs, by identity. */
  missingFileIds: string[];
  /** Which of the files this app reads are absent. Empty means the sync can proceed. */
  missingRequired: string[];
}

export type BackupSalvageJudgement =
  | {
      salvageable: true;
      snapshotState: string;
      coverage: BackupCoverage;
    }
  | {
      salvageable: false;
      /** Why not, in words a support log can use. Never a bare boolean. */
      reason: string;
      snapshotState?: string;
      coverage?: BackupCoverage;
    };

/** `Status.plist` `SnapshotState`, or null when it cannot be read. */
async function readSnapshotState(backupPath: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(backupPath, "Status.plist"));
    // Lazily required for the same reason backupService does it: `Status.plist` may be
    // binary or XML and `simple-plist` handles both.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const simplePlist = require("simple-plist") as {
      parse: (data: Buffer) => unknown;
    };
    const parsed = simplePlist.parse(raw) as { SnapshotState?: unknown } | null;
    const state = parsed?.SnapshotState;
    return typeof state === "string" ? state : null;
  } catch {
    return null;
  }
}

/**
 * Every blob filename on disk, as a Set.
 *
 * iOS backups shard blobs into 256 two-hex-character directories. Read the directory
 * listings — not one `stat` per manifest row, which is what produced the 23% artefact.
 */
async function readBlobIdsOnDisk(backupPath: string): Promise<Set<string>> {
  const present = new Set<string>();
  const entries = await fs.readdir(backupPath, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!/^[0-9a-f]{2}$/.test(entry.name)) continue;
    const shard = await fs.readdir(path.join(backupPath, entry.name));
    for (const blob of shard) present.add(blob);
  }
  return present;
}

/**
 * BACKLOG-2915: is this failed backup's data sound enough to use?
 *
 * Judges the artefacts only. It is given a path and nothing else — in particular it is
 * never told whether the run "succeeded", so it cannot be used to soften the error check.
 */
export async function judgeFailedBackup(
  backupPath: string,
): Promise<BackupSalvageJudgement> {
  const snapshotStateRaw = await readSnapshotState(backupPath);
  const snapshotState = snapshotStateRaw ?? "unreadable";

  if (snapshotStateRaw !== "finished") {
    // The device itself says it did not finish this snapshot. Nothing below can
    // outweigh that, and BACKLOG-2911 already established this reading.
    return {
      salvageable: false,
      reason: `the device reported SnapshotState "${snapshotState}", not "finished"`,
      snapshotState,
    };
  }

  const manifestPath = path.join(backupPath, "Manifest.db");

  /** The narrow slice of better-sqlite3 this module uses. */
  interface ManifestDb {
    pragma: (p: string, o?: { simple?: boolean }) => unknown;
    prepare: (sql: string) => { all: () => Array<{ fileID: string }> };
    close: () => void;
  }
  type ManifestDbCtor = new (
    file: string,
    opts?: { readonly?: boolean; fileMustExist?: boolean },
  ) => ManifestDb;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require("better-sqlite3-multiple-ciphers") as ManifestDbCtor;

  let db: ManifestDb | null = null;
  try {
    db = new Database(manifestPath, { readonly: true, fileMustExist: true });

    const quickCheck = db.pragma("quick_check", { simple: true });
    if (quickCheck !== "ok") {
      return {
        salvageable: false,
        reason: `Manifest.db failed its integrity check (${String(quickCheck)})`,
        snapshotState,
      };
    }

    const rows = db
      .prepare(
        `SELECT fileID FROM Files WHERE flags = ${MANIFEST_REGULAR_FILE_FLAG}`,
      )
      .all();
    const claimed = new Set(rows.map((r: { fileID: string }) => r.fileID));
    const onDisk = await readBlobIdsOnDisk(backupPath);

    // THE SET DIFFERENCE. Not a sample, and not a per-row stat.
    const missing: string[] = [];
    for (const id of claimed) {
      if (!onDisk.has(id)) missing.push(id);
    }

    const missingRequired = REQUIRED_BACKUP_FILE_IDS.filter(
      (f: { id: string; what: string }) =>
        claimed.has(f.id) && !onDisk.has(f.id),
    ).map((f: { id: string; what: string }) => f.what);

    const coverage: BackupCoverage = {
      manifestFiles: claimed.size,
      blobsPresent: claimed.size - missing.length,
      missingCount: missing.length,
      missingFileIds: missing.slice(0, MAX_REPORTED_MISSING),
      missingRequired,
    };

    if (missingRequired.length > 0) {
      return {
        salvageable: false,
        reason: `the backup is missing the ${missingRequired.join(" and ")} database`,
        snapshotState,
        coverage,
      };
    }

    const ratio =
      claimed.size === 0 ? 0 : coverage.blobsPresent / claimed.size;
    if (ratio < MIN_BLOB_COVERAGE) {
      return {
        salvageable: false,
        reason: `only ${coverage.blobsPresent} of ${claimed.size} files were transferred`,
        snapshotState,
        coverage,
      };
    }

    log.info("[BackupSalvage] A failed backup judged usable", {
      manifestFiles: coverage.manifestFiles,
      missingCount: coverage.missingCount,
      snapshotState,
    });
    return { salvageable: true, snapshotState, coverage };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      salvageable: false,
      reason: `the backup could not be examined (${reason})`,
      snapshotState,
    };
  } finally {
    try {
      db?.close();
    } catch {
      /* nothing useful to do */
    }
  }
}

/**
 * What to tell the user about a backup that failed but is being used anyway.
 *
 * Names the number, because "everything except 14 files" is a claim a user can check
 * and "mostly complete" is not.
 */
export function describeSalvagedBackup(coverage: BackupCoverage): string {
  const missing = coverage.missingCount;
  return (
    `Your iPhone reported a problem at the end of the backup, but ${
      missing === 1 ? "only one file" : `only ${missing} files`
    } out of ${coverage.manifestFiles.toLocaleString()} did not transfer. ` +
    "Your messages and contacts are complete, so the sync has carried on with them."
  );
}
