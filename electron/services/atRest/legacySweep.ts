/**
 * Legacy app-folder sweep (BACKLOG-3823, slice S6 of BACKLOG-3816).
 *
 * Before the rename to Keepr the app was called "magic-audit", so every
 * customer who ran an old build may still have an orphaned
 * `<appData>/magic-audit` folder (and on macOS `~/Library/Logs/magic-audit`).
 * Nothing in the current app reads it. This sweep removes the re-creatable
 * content in it (founder decision D4) and keeps the legacy database and its key
 * material (founder decision D5).
 *
 * SAFETY RULES (each one has a control in legacySweep.test.ts):
 *   - A root is acted on only when its basename is EXACTLY "magic-audit" and
 *     `lstat` says it is a real directory — never a symlink or junction.
 *   - Only children named in LEGACY_DELETE_CHILDREN are removed, by exact name.
 *     Everything else (mad.db*, mad-backup-*.db, db-key-store.json,
 *     session.json, license-cache.json, Local State, sentry/, ...) survives by
 *     construction.
 *   - The tree walker uses `lstat` for every decision and never follows a link:
 *     a symlink/junction inside a deleted child is removed as a link, its
 *     target is untouched.
 *   - A locked file (Windows EBUSY/EPERM/EACCES) is skipped. There is no
 *     completion marker: the sweep runs again on the next launch, which IS the
 *     retry.
 *   - Logs counts and bytes only — never a file name.
 *   - Runs only in a packaged build on the real profile. A dev or feature build
 *     (or a profile override / E2E `--user-data-dir`) never touches the folder,
 *     which keeps the founder's Windows QA fixture intact until the QA run.
 */

import { app } from "electron";
import { promises as fsp } from "fs";
import type { Stats } from "fs";
import * as path from "path";
import logService from "../logService";
import { getAppliedAppDataPaths } from "../../bootstrap/appDataPaths";

const MODULE = "LegacySweep";

/** The legacy app folder name, matched exactly. */
export const LEGACY_DIR_NAME = "magic-audit";

/**
 * Children of the legacy userData folder that are removed (D4). Exact names.
 * Data: the kept iPhone backup, message and email attachments, logs.
 * Chromium profile directories: names measured on a real Electron profile
 * (keepr-dev on macOS) and on the founder's Windows inventory (BACKLOG-3818).
 */
export const LEGACY_DELETE_CHILDREN: readonly string[] = Object.freeze([
  "Backups",
  "message-attachments",
  "attachments",
  "logs",
  "blob_storage",
  "Cache",
  "Code Cache",
  "Crashpad",
  "DawnCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "GPUCache",
  "IndexedDB",
  "Local Storage",
  "Network",
  "Service Worker",
  "Session Storage",
  "Shared Dictionary",
  "shared_proto_db",
  "VideoDecodeStats",
  "WebStorage",
]);

/**
 * Files in the legacy root that must survive (D5). The sweep never names them;
 * this list exists so tests and reviewers can see the contract.
 */
export const LEGACY_KEEP_NAMES: readonly string[] = Object.freeze([
  "mad.db",
  "mad.db-wal",
  "mad.db-shm",
  "db-key-store.json",
  "session.json",
  "Local State",
]);

/** Error codes treated as "locked / in use — retry next launch". */
const LOCK_CODES = new Set(["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"]);

export interface SweepCounts {
  removedFiles: number;
  removedDirs: number;
  /** Symlinks / junctions removed as links (target never touched). */
  removedLinks: number;
  bytes: number;
  /** Entries left in place because they were locked; retried next launch. */
  skipped: number;
  /** Unexpected errors (also left in place). */
  errors: number;
}

export function emptyCounts(): SweepCounts {
  return { removedFiles: 0, removedDirs: 0, removedLinks: 0, bytes: 0, skipped: 0, errors: 0 };
}

export function addCounts(into: SweepCounts, from: SweepCounts): void {
  into.removedFiles += from.removedFiles;
  into.removedDirs += from.removedDirs;
  into.removedLinks += from.removedLinks;
  into.bytes += from.bytes;
  into.skipped += from.skipped;
  into.errors += from.errors;
}

function errCode(error: unknown): string {
  return (error as NodeJS.ErrnoException)?.code ?? "";
}

function noteError(counts: SweepCounts, error: unknown): void {
  if (errCode(error) === "ENOENT") return; // already gone — nothing to do
  if (LOCK_CODES.has(errCode(error))) counts.skipped += 1;
  else counts.errors += 1;
}

/** Remove a symlink / junction itself. Never touches its target. */
async function removeLink(p: string): Promise<void> {
  try {
    await fsp.unlink(p);
  } catch (error) {
    // Windows directory symlinks and junctions are removed with rmdir, which
    // removes the reparse point, not the target's contents.
    const code = errCode(error);
    if (code === "EPERM" || code === "EISDIR") {
      await fsp.rmdir(p);
      return;
    }
    throw error;
  }
}

/**
 * Delete `p` without ever following a link. `lstat` decides every step:
 * link → remove the link; directory → recurse then rmdir; anything else →
 * count bytes, unlink. Errors are counted per entry and never thrown.
 */
export async function removeTreeNoFollow(p: string, counts: SweepCounts): Promise<void> {
  let st: Stats;
  try {
    st = await fsp.lstat(p);
  } catch (error) {
    noteError(counts, error);
    return;
  }

  if (st.isSymbolicLink()) {
    try {
      await removeLink(p);
      counts.removedLinks += 1;
    } catch (error) {
      noteError(counts, error);
    }
    return;
  }

  if (st.isDirectory()) {
    let names: string[];
    try {
      names = await fsp.readdir(p);
    } catch (error) {
      noteError(counts, error);
      return;
    }
    for (const name of names) {
      await removeTreeNoFollow(path.join(p, name), counts);
    }
    try {
      await fsp.rmdir(p);
      counts.removedDirs += 1;
    } catch (error) {
      noteError(counts, error);
    }
    return;
  }

  try {
    await fsp.unlink(p);
    counts.removedFiles += 1;
    counts.bytes += st.size;
  } catch (error) {
    noteError(counts, error);
  }
}

/**
 * Find `<parent>/magic-audit` as a REAL directory. Matches the basename exactly
 * from a directory listing and rejects symlinks/junctions via lstat.
 */
export async function findLegacyRoot(parent: string): Promise<string | null> {
  let names: string[];
  try {
    names = await fsp.readdir(parent);
  } catch {
    return null;
  }
  const match = names.find((name) => name === LEGACY_DIR_NAME);
  if (!match) return null;
  const candidate = path.join(parent, match);
  try {
    const st = await fsp.lstat(candidate);
    if (st.isSymbolicLink() || !st.isDirectory()) return null;
  } catch {
    return null;
  }
  return candidate;
}

export interface LegacySweepDeps {
  /** `app.isPackaged`. The sweep never runs in a dev build. */
  isPackaged: boolean;
  /** True when the profile was moved (KEEPR_USER_DATA_DIR / dev dir / --user-data-dir). */
  profileOverridden: boolean;
  /** `app.getPath("appData")` — parent of the legacy userData folder. */
  appDataDir: string;
  /** macOS only: `~/Library/Logs` — parent of the legacy logs folder. null elsewhere. */
  macLogsDir: string | null;
  /** userData of the running app. A root equal to it is refused. */
  userDataDir: string;
}

export type LegacySweepSkipReason = "not-packaged" | "profile-override" | "failed";

export interface LegacySweepResult {
  ran: boolean;
  skipReason?: LegacySweepSkipReason;
  /** Number of legacy roots found (0, 1 or 2). */
  rootsFound: number;
  total: SweepCounts;
  /** Per deleted child name (fixed allow-list names, never user file names). */
  byChild: Record<string, SweepCounts>;
}

function defaultDeps(): LegacySweepDeps {
  return {
    isPackaged: app.isPackaged,
    profileOverridden:
      getAppliedAppDataPaths() !== null || app.commandLine.hasSwitch("user-data-dir"),
    appDataDir: app.getPath("appData"),
    macLogsDir:
      process.platform === "darwin" ? path.join(app.getPath("home"), "Library", "Logs") : null,
    userDataDir: app.getPath("userData"),
  };
}

async function sweepUserDataRoot(
  root: string,
  byChild: Record<string, SweepCounts>,
): Promise<void> {
  let names: string[];
  try {
    names = await fsp.readdir(root);
  } catch {
    return;
  }
  for (const name of names) {
    if (!LEGACY_DELETE_CHILDREN.includes(name)) continue;
    const counts = byChild[name] ?? emptyCounts();
    byChild[name] = counts;
    await removeTreeNoFollow(path.join(root, name), counts);
  }
}

/** macOS legacy logs folder: remove regular *.log files directly inside it. */
async function sweepMacLogsRoot(
  root: string,
  byChild: Record<string, SweepCounts>,
): Promise<void> {
  let names: string[];
  try {
    names = await fsp.readdir(root);
  } catch {
    return;
  }
  const counts = byChild["Library/Logs"] ?? emptyCounts();
  byChild["Library/Logs"] = counts;
  for (const name of names) {
    if (!name.toLowerCase().endsWith(".log")) continue;
    const p = path.join(root, name);
    try {
      const st = await fsp.lstat(p);
      if (!st.isFile()) continue;
      await fsp.unlink(p);
      counts.removedFiles += 1;
      counts.bytes += st.size;
    } catch (error) {
      noteError(counts, error);
    }
  }
  // Remove the folder itself only when it is now empty.
  try {
    await fsp.rmdir(root);
    counts.removedDirs += 1;
  } catch {
    // not empty / locked — leave it
  }
}

/**
 * Run the legacy sweep. Never throws. Safe to run on every launch: when there
 * is no legacy folder it costs two directory listings.
 *
 * Registration (S0 startup queue): `queue.add("legacy-sweep", () => runLegacySweep())`.
 */
export async function runLegacySweep(
  overrides?: Partial<LegacySweepDeps>,
): Promise<LegacySweepResult> {
  const result: LegacySweepResult = { ran: false, rootsFound: 0, total: emptyCounts(), byChild: {} };
  try {
    const deps: LegacySweepDeps = { ...defaultDeps(), ...overrides };
    if (!deps.isPackaged) {
      result.skipReason = "not-packaged";
      return result;
    }
    if (deps.profileOverridden) {
      result.skipReason = "profile-override";
      return result;
    }
    result.ran = true;

    const userRoot = await findLegacyRoot(deps.appDataDir);
    if (userRoot && path.resolve(userRoot) !== path.resolve(deps.userDataDir)) {
      result.rootsFound += 1;
      await sweepUserDataRoot(userRoot, result.byChild);
    }

    if (deps.macLogsDir) {
      const logsRoot = await findLegacyRoot(deps.macLogsDir);
      if (logsRoot) {
        result.rootsFound += 1;
        await sweepMacLogsRoot(logsRoot, result.byChild);
      }
    }

    for (const counts of Object.values(result.byChild)) addCounts(result.total, counts);
    if (result.rootsFound > 0) {
      logService.info("[LegacySweep] Legacy folder sweep finished", MODULE, {
        rootsFound: result.rootsFound,
        ...result.total,
        byChild: result.byChild,
      });
    }
    return result;
  } catch (error) {
    logService.warn("[LegacySweep] Legacy folder sweep failed; will retry next launch", MODULE, {
      error: error instanceof Error ? error.name : "unknown",
    });
    result.ran = false;
    result.skipReason = "failed";
    return result;
  }
}
