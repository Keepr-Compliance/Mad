/**
 * Deleting attachment FILES safely — BACKLOG-4040 S1.
 *
 * Every path that deletes a file an `attachments` row pointed at goes through
 * `removeUnreferencedFiles` (RCS clear, RCS auto-delete, RCS staging recovery
 * and per-chat failure, iPhone sync rollback, email Force Re-cache). One rule,
 * one shape; there is no per-file variant.
 *
 * ## The rule
 *
 * Files are content-addressed (`<sha256><ext>`) and SHARED: the same bytes
 * synced from a Mac, an iPhone and Google Messages, or by two users on one
 * Mac, are one file. A candidate is deleted only when:
 *
 *   1. its path resolves (realpath, links followed) to a regular file inside an
 *      allowed attachment folder (`resolveContainedAttachment`). Anything else
 *      is refused and left alone — including a row that points outside.
 *   2. NO attachments row of any user or source has the same file name,
 *      compared case-insensitively, whatever directory the row stores and
 *      whether it is absolute or relative (`attachmentFileKey`).
 *
 * ## Why folding case is safe: the two sides are treated differently
 *
 * The LOOKUP folds case, so a fold can only make a file count as still used.
 * The DELETE always uses the candidate's own resolved real path, never a
 * folded or rebuilt one. On a case-sensitive volume a kept `h.PNG` row keeps
 * `h.png` too: one orphan file, never the deletion of a different file. The
 * bytes are identical anyway (same sha256; only the extension's case differs).
 *
 * Rows whose file is missing still count as references (the check never reads
 * the disk); a row with no path references nothing.
 *
 * ## Ordering
 *
 * Candidates are collected inside (or synchronously before) the transaction
 * that removed their rows; this runs after it commits. All awaits (the
 * containment realpaths) come FIRST. Then, in one synchronous block, the
 * referenced names are read and the unreferenced files unlinked, so no row can
 * be inserted between the read and the unlink. A large set is split into
 * blocks of about BLOCK_BUDGET_MS; each block re-reads the names, so a row
 * written while the loop yielded is honoured.
 *
 * ## Known residuals (accepted, BACKLOG-4040 SR review)
 *
 * - A concurrent writer of the same hash: it decides the hash is new, awaits
 *   its seal, and inserts its row after this check read the names. Narrow and
 *   limited to concurrent jobs; S2's existsSync on the Mac/iPhone dedup repairs
 *   the row on the next import.
 * - A row whose name differs by MORE than case (`h.jpeg` for a file actually
 *   named `h.jpg`) cannot protect `h.jpg`. Since S2 the Mac and iPhone writers
 *   no longer produce such rows: a new row links to the existing file's own
 *   name (attachmentDedupIndex.ts). Rows written that way BEFORE S2 are not
 *   repaired and remain this blind spot.
 *
 * Best-effort by contract: it never throws. A failure leaves a file behind.
 */
import fs from "fs";
import path from "path";
import type { Database as DatabaseType } from "better-sqlite3";

import { ATTACHMENT_ROOTS, resolveContainedAttachment, type AttachmentScope } from "./atRest/containment";
import { unreferencedAttachmentPaths } from "./db/attachmentFileRefsSql";

/** A synchronous block (names read + unlinks) longer than this is split. */
export const BLOCK_BUDGET_MS = 200;

export interface FileCleanupResult {
  /** Files unlinked. */
  removed: number;
  /** Still used by an attachments row: left alone. */
  stillReferenced: number;
  /** Missing, outside the allowed folders, or not a regular file: left alone. */
  refused: number;
  /** Unlink attempted and failed: left behind. */
  failed: number;
  /** Time spent reading the referenced names and looking candidates up (all blocks). */
  lookupMs: number;
  /** The longest single read of the names (one block's lookup). */
  maxLookupMs: number;
  /** The longest synchronous block (lookup + its unlinks). */
  longestBlockMs: number;
  /** Time spent unlinking. */
  unlinkMs: number;
  /** Synchronous blocks used. */
  blocks: number;
}

export interface FileCleanupDeps {
  /** The candidate's real path inside an allowed folder, or null (refused). May await. */
  contain(storedPath: string): Promise<string | null>;
  /** Of `paths`, the ones no attachments row points at. SYNCHRONOUS. */
  unreferenced(paths: readonly string[]): Set<string>;
  /** Unlink a real path. SYNCHRONOUS. Returns false (or throws) on failure. */
  deleteFile?(realPath: string): boolean;
  /** Test seams. */
  now?(): number;
  yieldToLoop?(): Promise<void>;
  blockBudgetMs?: number;
}

function unlinkSyncOrThrow(realPath: string): boolean {
  fs.unlinkSync(realPath);
  return true;
}

/**
 * The core: containment (awaits) first, then names + unlinks in synchronous
 * blocks. The only implementation of "delete the files nothing uses".
 */
export async function removeUnreferencedFiles(
  candidates: readonly (string | null | undefined)[],
  deps: FileCleanupDeps,
): Promise<FileCleanupResult> {
  const result: FileCleanupResult = {
    removed: 0, stillReferenced: 0, refused: 0, failed: 0, lookupMs: 0, maxLookupMs: 0, longestBlockMs: 0, unlinkMs: 0, blocks: 0,
  };
  const now = deps.now ?? (() => performance.now());
  const yieldToLoop = deps.yieldToLoop ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));
  const deleteFile = deps.deleteFile ?? unlinkSyncOrThrow;
  const budget = deps.blockBudgetMs ?? BLOCK_BUDGET_MS;

  // 1. Containment: every await happens here, before any name is read.
  const pending: Array<{ stored: string; real: string }> = [];
  const seenReal = new Set<string>();
  for (const stored of new Set(candidates)) {
    if (typeof stored !== "string" || stored.length === 0) continue;
    let real: string | null;
    try {
      real = await deps.contain(stored);
    } catch {
      real = null;
    }
    if (!real) {
      result.refused++;
      continue;
    }
    if (seenReal.has(real)) continue; // two stored spellings of one file
    seenReal.add(real);
    pending.push({ stored, real });
  }

  // 2. Synchronous blocks: read the names, look up, unlink. No await inside.
  let i = 0;
  while (i < pending.length) {
    if (result.blocks > 0) await yieldToLoop();
    result.blocks++;
    const start = now();
    let unreferenced: Set<string>;
    try {
      unreferenced = deps.unreferenced(pending.slice(i).map((c) => c.stored));
    } catch {
      // Could not read the names: delete nothing.
      result.failed += pending.length - i;
      result.lookupMs += now() - start;
      break;
    }
    const afterLookup = now();
    result.lookupMs += afterLookup - start;
    result.maxLookupMs = Math.max(result.maxLookupMs, afterLookup - start);
    // At least half a budget of unlinks per block, so a slow read of the names
    // cannot turn the loop into one read per file.
    const unlinkBudget = Math.max(budget - (afterLookup - start), budget / 2);
    do {
      const c = pending[i++];
      if (!unreferenced.has(c.stored)) {
        result.stillReferenced++;
        continue;
      }
      try {
        if (deleteFile(c.real)) result.removed++;
        else result.failed++;
      } catch {
        result.failed++;
      }
    } while (i < pending.length && now() - afterLookup < unlinkBudget);
    const end = now();
    result.unlinkMs += end - afterLookup;
    result.longestBlockMs = Math.max(result.longestBlockMs, end - start);
  }
  return result;
}

/**
 * A containment check for `removeUnreferencedFiles`: the stored path (relative
 * ones are under userData) must be a regular file inside one of `scopes`.
 */
export function containedIn(
  userData: string,
  scopes: readonly AttachmentScope[],
  resolve: (storedPath: string) => string = (p) => (path.isAbsolute(p) ? p : path.join(userData, p)),
): (storedPath: string) => Promise<string | null> {
  return async (storedPath) => {
    const hit = await resolveContainedAttachment(resolve(storedPath), userData);
    return scopes.includes(hit.scope) ? hit.realPath : null;
  };
}

/** Every attachment folder (texts and email). */
export const ALL_ATTACHMENT_SCOPES: readonly AttachmentScope[] = ATTACHMENT_ROOTS.map((r) => r.scope);

/** The real wiring: this database, real files under `userData`. */
export function removeUnreferencedAttachmentFiles(
  db: DatabaseType,
  candidates: readonly (string | null | undefined)[],
  options: { userData: string; scopes: readonly AttachmentScope[] },
): Promise<FileCleanupResult> {
  return removeUnreferencedFiles(candidates, {
    contain: containedIn(options.userData, options.scopes),
    unreferenced: (paths) => unreferencedAttachmentPaths(db, paths),
  });
}
