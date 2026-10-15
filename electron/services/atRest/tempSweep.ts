/**
 * Temp-file sweep (BACKLOG-3823 / BACKLOG-3816 slice S6).
 *
 * Removes leftovers that Keepr itself wrote to the OS temp folder and to its
 * own at-rest scratch folders, once they are older than 24 hours. A crash or a
 * killed process can leave these behind; nothing else ever removes them.
 *
 * Every rule matches the FULL shape its producer emits, not a prefix. The OS
 * temp folder is shared with every other program (and with jest's
 * `keepr-net-guard-*` fixtures), so a loose prefix would delete files Keepr
 * does not own.
 *
 *   OS temp (top level only):
 *     keepr-amds-XXXXXX/                     appleDriverService.ts:568 (mkdtemp)
 *     keepr-cleanup-<mode>-<pid>-<ms>.sh|ps1 appCleanupService.ts:679
 *     keepr-cleanup-<mode>-<pid>-<ms>.failed appCleanupService.ts:680 (kept 7 days)
 *     pdf-export-<ms>-<rand>.html            pdfExportService.ts:46
 *     export-<ms>-<rand>.html                folderExportService.ts:970
 *     pdf-combine-<ms>-<rand>.html           folderExportService.ts:1018
 *   userData:
 *     at-rest-tmp/*, at-rest-open/*          at-rest scratch (S0/S2)
 *     *.kenc-tmp                             interrupted in-place encryption (S0)
 *
 * Never throws. Logs counts and bytes only.
 */

import { app } from "electron";
import { promises as fsp } from "fs";
import * as path from "path";
import logService from "../logService";
import { addCounts, emptyCounts, removeTreeNoFollow, type SweepCounts } from "./legacySweep";

const MODULE = "TempSweep";

/** Shared names — S0/S2 import these so writer and sweeper use the same strings. */
export const AT_REST_TMP_DIR = "at-rest-tmp";
export const AT_REST_OPEN_DIR = "at-rest-open";
export const KENC_TMP_SUFFIX = ".kenc-tmp";

export const HOUR_MS = 60 * 60 * 1000;
export const TEMP_MAX_AGE_MS = 24 * HOUR_MS;
export const FAILED_MARKER_MAX_AGE_MS = 7 * 24 * HOUR_MS;

interface TempRule {
  id: string;
  pattern: RegExp;
  kind: "file" | "dir";
  maxAgeMs: number;
}

/** OS-temp rules, matched against top-level entry names. */
export const OS_TEMP_RULES: readonly TempRule[] = Object.freeze([
  { id: "keepr-amds", pattern: /^keepr-amds-[A-Za-z0-9]{6}$/, kind: "dir", maxAgeMs: TEMP_MAX_AGE_MS },
  {
    id: "keepr-cleanup-script",
    pattern: /^keepr-cleanup-(reset|uninstall)-\d+-\d+\.(sh|ps1)$/,
    kind: "file",
    maxAgeMs: TEMP_MAX_AGE_MS,
  },
  {
    id: "keepr-cleanup-failed",
    pattern: /^keepr-cleanup-(reset|uninstall)-\d+-\d+\.failed$/,
    kind: "file",
    maxAgeMs: FAILED_MARKER_MAX_AGE_MS,
  },
  {
    id: "export-html",
    pattern: /^(pdf-export|export|pdf-combine)-\d+-[a-z0-9]+\.html$/,
    kind: "file",
    maxAgeMs: TEMP_MAX_AGE_MS,
  },
]);

/** userData sub-folders scanned (non-recursively) for *.kenc-tmp files. */
export const DEFAULT_KENC_TMP_SCOPES: readonly string[] = Object.freeze([
  ".",
  "message-attachments",
  "attachments",
]);

export interface TempSweepDeps {
  /** OS temp folder (`app.getPath("temp")`). */
  tempDir: string;
  /** `app.getPath("userData")`. */
  userDataDir: string;
  /**
   * userData-relative folders searched for *.kenc-tmp (recursively, links not
   * followed). Backups is excluded by default — it can hold 500k+ files.
   */
  kencTmpScopes: readonly string[];
  /** Clock, injectable for tests. */
  now: () => number;
}

export interface TempSweepResult {
  total: SweepCounts;
  byRule: Record<string, SweepCounts>;
}

function defaultDeps(): TempSweepDeps {
  return {
    tempDir: app.getPath("temp"),
    userDataDir: app.getPath("userData"),
    kencTmpScopes: DEFAULT_KENC_TMP_SCOPES,
    now: () => Date.now(),
  };
}

function bucket(result: TempSweepResult, id: string): SweepCounts {
  const counts = result.byRule[id] ?? emptyCounts();
  result.byRule[id] = counts;
  return counts;
}

/** True when the entry's mtime is at least `maxAgeMs` before `now`. */
function isOldEnough(mtimeMs: number, now: number, maxAgeMs: number): boolean {
  return now - mtimeMs >= maxAgeMs;
}

async function sweepOsTemp(deps: TempSweepDeps, result: TempSweepResult): Promise<void> {
  let names: string[];
  try {
    names = await fsp.readdir(deps.tempDir);
  } catch {
    return;
  }
  const now = deps.now();
  for (const name of names) {
    const rule = OS_TEMP_RULES.find((r) => r.pattern.test(name));
    if (!rule) continue;
    const p = path.join(deps.tempDir, name);
    try {
      const st = await fsp.lstat(p);
      if (st.isSymbolicLink()) continue;
      if (rule.kind === "dir" ? !st.isDirectory() : !st.isFile()) continue;
      if (!isOldEnough(st.mtimeMs, now, rule.maxAgeMs)) continue;
    } catch {
      continue;
    }
    await removeTreeNoFollow(p, bucket(result, rule.id));
  }
}

/** Remove entries directly inside `dir` older than the max age. */
async function sweepScratchDir(
  dir: string,
  id: string,
  deps: TempSweepDeps,
  result: TempSweepResult,
): Promise<void> {
  try {
    const st = await fsp.lstat(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return;
  } catch {
    return;
  }
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return;
  }
  const now = deps.now();
  for (const name of names) {
    const p = path.join(dir, name);
    try {
      const st = await fsp.lstat(p);
      if (!isOldEnough(st.mtimeMs, now, TEMP_MAX_AGE_MS)) continue;
    } catch {
      continue;
    }
    await removeTreeNoFollow(p, bucket(result, id));
  }
}

/** Find *.kenc-tmp files under `dir` (links not followed) and remove old ones. */
async function sweepKencTmp(
  dir: string,
  recursive: boolean,
  deps: TempSweepDeps,
  result: TempSweepResult,
): Promise<void> {
  let entries: import("fs").Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const now = deps.now();
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (recursive) await sweepKencTmp(p, true, deps, result);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(KENC_TMP_SUFFIX)) continue;
    try {
      const st = await fsp.lstat(p);
      if (!isOldEnough(st.mtimeMs, now, TEMP_MAX_AGE_MS)) continue;
    } catch {
      continue;
    }
    await removeTreeNoFollow(p, bucket(result, "kenc-tmp"));
  }
}

/**
 * Run the temp sweep. Never throws.
 *
 * Registration (S0 startup queue): `queue.add("temp-sweep", () => runTempSweep())`.
 */
export async function runTempSweep(overrides?: Partial<TempSweepDeps>): Promise<TempSweepResult> {
  const result: TempSweepResult = { total: emptyCounts(), byRule: {} };
  try {
    const deps: TempSweepDeps = { ...defaultDeps(), ...overrides };

    await sweepOsTemp(deps, result);
    await sweepScratchDir(path.join(deps.userDataDir, AT_REST_TMP_DIR), AT_REST_TMP_DIR, deps, result);
    await sweepScratchDir(path.join(deps.userDataDir, AT_REST_OPEN_DIR), AT_REST_OPEN_DIR, deps, result);
    for (const scope of deps.kencTmpScopes) {
      const dir = path.join(deps.userDataDir, scope);
      // "." scans userData's top level only; named scopes are walked recursively.
      await sweepKencTmp(dir, scope !== ".", deps, result);
    }

    for (const counts of Object.values(result.byRule)) addCounts(result.total, counts);
    const t = result.total;
    if (t.removedFiles + t.removedDirs + t.removedLinks + t.skipped + t.errors > 0) {
      logService.info("[TempSweep] Temp sweep finished", MODULE, { ...t, byRule: result.byRule });
    }
  } catch (error) {
    logService.warn("[TempSweep] Temp sweep failed; will retry next launch", MODULE, {
      error: error instanceof Error ? error.name : "unknown",
    });
  }
  return result;
}
