/**
 * Disk space inspection for the import path (BACKLOG-2743)
 *
 * The macOS Messages import copies every eligible attachment into app storage.
 * Before BACKLOG-2743 there was no free-space check anywhere on that path — the
 * only limit was a 100 MB PER-FILE cap — so a large library could be told to
 * copy far more than the volume holds.
 *
 * ============================================================================
 * WHY `bavail`, AND WHY A PURGEABLE-INCLUSIVE FIGURE IS FORBIDDEN
 * ============================================================================
 *
 * macOS reports two very different "free space" numbers:
 *
 *   1. `statfs().f_bavail` — blocks available to an unprivileged process RIGHT
 *      NOW. This is what `df` prints, and it is what a `copyFile` can actually
 *      consume before hitting ENOSPC.
 *
 *   2. `NSURLVolumeAvailableCapacityForImportantUsageKey` — what Finder and
 *      System Settings show. It ADDS purgeable space: local Time Machine
 *      snapshots, caches, and other content macOS is willing to DELETE to make
 *      room. On a real machine this can be several times larger than (1).
 *
 * A guard built on (2) is worse than no guard at all. It would report enough
 * room, let the copy start, and macOS would then free that space by EVICTING
 * the user's local Time Machine snapshots — destroying their restore points to
 * make room for an import, silently, and possibly still failing partway.
 * Preventing exactly that is why this module exists.
 *
 * So: `bavail * bsize`, never `bfree` (which includes superuser-reserved
 * blocks the app cannot touch), and never a purgeable-inclusive API.
 *
 * Verified equal to `df` on macOS: statfs bavail x bsize matched `df -k` Avail
 * to the byte.
 *
 * @module utils/diskSpace
 */

import * as fs from "fs";
import { app } from "electron";
import logService from "../services/logService";

const SERVICE_NAME = "DiskSpace";

/**
 * Headroom kept free beyond the attachment estimate.
 *
 * The attachment estimate covers COPIED FILES ONLY. The import also grows the
 * app database with the message text itself, which is not counted anywhere in
 * the attachment figure (on a large library this measured in the ~1 GB range).
 * Comparing the attachment bytes against available bytes exactly would let a
 * technically-passing import run the volume to zero, which breaks far more than
 * the import.
 *
 * 2 GB is deliberately coarse: it is a floor, not a prediction.
 */
export const ATTACHMENT_SPACE_HEADROOM_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Env var carrying the DEV-ONLY free-space override (BACKLOG-2762).
 *
 * ============================================================================
 * WHY THIS EXISTS, AND WHY IT IS SAFE
 * ============================================================================
 *
 * The guard above only refuses when a disk is genuinely too full. That state is
 * covered by automated tests (which inject a fake `statfs` result), but it is
 * invisible to a person looking at the screen: reproducing it by hand means
 * actually filling the volume. The founder hit the real refusal once, on
 * 2026-08-16 at 62.6 GB free vs 61.3 GB needed; his machine now has 124 GB free
 * and there is no way back. Every human review of the refusal copy, the
 * confirmation dialog and the toggle states needs that condition on demand.
 *
 * So this override makes ONLY the reported available-bytes figure fakeable, and
 * only in a dev build:
 *
 *   - DOUBLE-GATED, exactly like `KEEPR_E2E` (see main.ts `isE2EServeDistMode`):
 *     `!app.isPackaged` AND the env var explicitly set. A packaged/notarized
 *     artifact always has `app.isPackaged === true`, so the branch is dead code
 *     in anything that ships, regardless of the environment it is launched with.
 *   - It changes the DECIDED/DISPLAYED number only. Nothing here is written to
 *     the database, to settings, or to any synced surface — both call sites use
 *     the value transiently (one refusal decision, one IPC estimate response).
 *   - It CANNOT make the guard more permissive in a way that damages data: the
 *     worst a fake number does in dev is refuse an import that would have fitted,
 *     or allow one that then hits `copyFile`'s own ENOSPC backstop.
 *
 * WHY THE LOG LINE ON EVERY READ IS NOT OPTIONAL:
 * `KEEPR_E2E` once burned a founder QA session — it blanks the contact list by
 * design, and a session run with it set looked like a contacts bug for real.
 * The trap is a dev flag whose effect is indistinguishable from a real symptom.
 * Here the loud per-read warning is the mitigation: any log or screen recording
 * taken while the override is active carries the disclaimer inline, so a fake
 * measurement can never be mistaken for a real one. A once-only or cached log
 * would defeat this — the line must accompany EVERY overridden read.
 */
export const FAKE_FREE_BYTES_ENV_VAR = "KEEPR_FAKE_FREE_BYTES";

/**
 * Resolve the dev-only free-space override, or null to use the real measurement.
 *
 * Parses defensively. A typo must never become `NaN` free bytes flowing into the
 * guard's arithmetic (`NaN <= 0` is false, so a NaN shortfall would refuse every
 * import while claiming an unreadable number). Anything that is not a finite,
 * non-negative number is IGNORED with one warning and the real figure is used.
 *
 * `0` IS honoured — "the disk is completely full" is a state worth reviewing.
 */
function resolveFakeFreeBytesOverride(): number | null {
  // GATE 1 — packaged builds ignore the env var unconditionally.
  if (app.isPackaged) {
    return null;
  }

  // GATE 2 — the var must be explicitly set. Note this is NOT a truthiness test:
  // an explicitly-empty value (`KEEPR_FAKE_FREE_BYTES= npm run dev`) is a typo
  // that deserves the warning below, whereas an unset var is the normal dev path
  // and must stay silent.
  const raw = process.env[FAKE_FREE_BYTES_ENV_VAR];
  if (raw === undefined) {
    return null;
  }

  const trimmed = raw.trim();
  const parsed = trimmed === "" ? Number.NaN : Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) {
    logService.warn(
      `[diskSpace] ${FAKE_FREE_BYTES_ENV_VAR}=${JSON.stringify(raw)} is not a non-negative ` +
        `number — IGNORING the override and reporting the REAL available space`,
      SERVICE_NAME,
      { rawValue: raw }
    );
    return null;
  }

  const overrideBytes = Math.floor(parsed);
  logService.warn(
    `[diskSpace] ${FAKE_FREE_BYTES_ENV_VAR}=${overrideBytes} in force — this is NOT a real ` +
      `measurement. Free-space decisions in this session are SIMULATED (dev build only).`,
    SERVICE_NAME,
    { overrideBytes, isPackaged: false }
  );
  return overrideBytes;
}

/**
 * Bytes currently available to this (unprivileged) process on the volume
 * containing `targetPath`.
 *
 * @returns available bytes, or `null` when the platform/filesystem cannot
 *   report it. Callers MUST treat `null` as "unknown" and fail OPEN — blocking
 *   every import because the sensor is unavailable is worse than the risk it
 *   guards against, and `copyFile`'s own ENOSPC remains the final backstop.
 */
export async function getAvailableDiskBytes(targetPath: string): Promise<number | null> {
  // BACKLOG-2762: dev-only override, resolved on EVERY read so the warning that
  // accompanies it is never cached away. Returns null in any packaged build and
  // whenever the env var is unset or unparseable, leaving the real read below
  // as the only path.
  const overrideBytes = resolveFakeFreeBytesOverride();
  if (overrideBytes !== null) {
    return overrideBytes;
  }

  try {
    // `fs.promises.statfs` is available on Node 18.15+ / Electron 25+.
    // bavail = blocks available to NON-superuser = the `df` "Avail" column.
    // Using bfree here would over-report by the superuser-reserved blocks.
    const stats = await fs.promises.statfs(targetPath);
    const available = Number(stats.bavail) * Number(stats.bsize);
    if (!Number.isFinite(available) || available < 0) {
      return null;
    }
    return available;
  } catch (error) {
    logService.warn(
      `Could not read available disk space for ${targetPath}; space guard will not block this import`,
      SERVICE_NAME,
      { error: error instanceof Error ? error.message : String(error) }
    );
    return null;
  }
}

/**
 * Verdict for a proposed attachment copy.
 */
export interface AttachmentSpaceVerdict {
  /**
   * False ONLY when free space is known AND insufficient. Unknown free space
   * yields true (fail open) — see getAvailableDiskBytes.
   */
  fits: boolean;
  /** Bytes the copy is estimated to write. */
  estimatedBytes: number;
  /** Available bytes, or null when unknown. */
  availableBytes: number | null;
  /** Extra bytes needed to satisfy estimate + headroom. 0 when it fits. */
  shortfallBytes: number;
  /** Headroom applied on top of the estimate. */
  headroomBytes: number;
}

/**
 * The single comparison used BOTH by the selection-time estimate (over IPC) and
 * by the pre-flight check immediately before the first copy.
 *
 * Deliberately one function: if the renderer did its own `estimate > available`
 * math, the number shown to the user and the number the import enforces could
 * drift apart. The renderer is shipped the verdict, never the comparison.
 */
export function evaluateAttachmentSpace(
  estimatedBytes: number,
  availableBytes: number | null,
  headroomBytes: number = ATTACHMENT_SPACE_HEADROOM_BYTES
): AttachmentSpaceVerdict {
  if (availableBytes === null) {
    return {
      fits: true,
      estimatedBytes,
      availableBytes: null,
      shortfallBytes: 0,
      headroomBytes,
    };
  }

  // Nothing to copy means nothing to guard. Without this the headroom ALONE
  // would refuse a zero-byte operation on a tight disk — which is precisely what
  // a routine re-sync of an already-imported library looks like once the
  // already-stored attachments are excluded. That would block imports forever
  // while writing nothing.
  if (estimatedBytes <= 0) {
    return {
      fits: true,
      estimatedBytes,
      availableBytes,
      shortfallBytes: 0,
      headroomBytes,
    };
  }

  const required = estimatedBytes + headroomBytes;
  const shortfall = required - availableBytes;

  return {
    fits: shortfall <= 0,
    estimatedBytes,
    availableBytes,
    shortfallBytes: shortfall > 0 ? shortfall : 0,
    headroomBytes,
  };
}

/* ==========================================================================
 * BACKLOG-2870 — the DB-write half of the guard, and the words it says
 * ==========================================================================
 *
 * Everything above this line guards the ATTACHMENT COPY. That is not what
 * failed. The founder's force re-import died on a message INSERT with SQLite's
 * `database or disk is full`, and nothing on the DB-write path looked at free
 * space at all.
 *
 * The attachment guard could not have caught it, and must not be changed to try.
 * `evaluateAttachmentSpace` returns `fits: true` at `estimatedBytes <= 0`, which
 * is exactly what a force re-import of an already-imported library looks like —
 * every attachment is content-deduped, so the estimate is zero and the guard is
 * a no-op — but that early return is load-bearing for the re-sync case it
 * documents, and weakening it would block routine imports forever. The DB-write
 * path needs its own floor, which is what `DISK_SPACE_THRESHOLDS.messagesImport`
 * and the two functions below provide.
 */

/** Bytes in a gibibyte / mebibyte, for the human-facing formatter below. */
const BYTES_PER_GIB = 1024 * 1024 * 1024;
const BYTES_PER_MIB = 1024 * 1024;

/**
 * Render a byte count the way a person reading a disk-space warning needs it:
 * two significant places near the boundary, none of the false precision of
 * "1.23456 GB", and MB rather than "0.1 GB" once the number gets small.
 */
export function formatSpace(bytes: number): string {
  if (bytes >= BYTES_PER_GIB) {
    const gb = bytes / BYTES_PER_GIB;
    // 1.4 GB, but 14 GB — a tenth of a GB is noise once past ten.
    return `${gb >= 10 ? Math.round(gb) : Math.round(gb * 10) / 10} GB`;
  }
  return `${Math.max(1, Math.round(bytes / BYTES_PER_MIB))} MB`;
}

/** Inputs to the ONE user-facing disk-space sentence. */
export interface DiskShortfallCopy {
  /** Bytes the operation needs free. */
  requiredBytes: number;
  /**
   * Bytes actually available (`bavail`), or null when unreadable. A null drops
   * the comparison rather than printing a placeholder.
   */
  availableBytes: number | null;
  /**
   * Local Time Machine snapshots on this volume, or null when unreadable.
   * See `utils/localSnapshots.ts` for why this is a COUNT and never bytes.
   */
  snapshotCount: number | null;
  /**
   * `"before"` — refused up front, nothing was written.
   * `"during"` — the disk filled mid-run, after the pre-flight had passed.
   */
  phase: "before" | "during";
}

/**
 * The single builder for every disk-space sentence this feature shows.
 *
 * ONE function on purpose. The pre-flight refusal and the mid-run ENOSPC
 * translation are two different moments telling the user the same fact, and if
 * each wrote its own copy they would drift — one would carry the snapshot
 * explanation and the other would not, and the one that did not is the one the
 * founder would hit at 1am and disbelieve.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SNAPSHOT CLAUSE CARRIES NO BYTE FIGURE
 * ---------------------------------------------------------------------------
 * Because the byte figure is not readable. Every macOS interface that could
 * report snapshot-held bytes was enumerated (see `utils/localSnapshots.ts`) and
 * none does. The only way to produce one is to subtract `bavail` from Finder's
 * purgeable-inclusive capacity — a derived number, which also silently folds in
 * caches and trash, presented to the user as a measurement. Quoting an invented
 * "about 159 GB" to a person who is already doubting the app's numbers is the
 * failure mode this whole item exists to fix, so the clause names the snapshot
 * COUNT, which was genuinely read, and stops there.
 *
 * It also does NOT tell him to delete anything. The fact is his to act on.
 */
export function describeDiskShortfall(copy: DiskShortfallCopy): string {
  const { requiredBytes, availableBytes, snapshotCount, phase } = copy;

  const need = formatSpace(requiredBytes);
  const opening =
    phase === "before"
      ? `Keepr needs about ${need} of free disk space to import your messages`
      : `Keepr ran out of disk space while importing your messages, and stopped`;

  const sentences: string[] = [];

  if (phase === "before") {
    sentences.push(
      availableBytes === null
        ? `${opening}.`
        : `${opening}, but only ${formatSpace(availableBytes)} is actually available.`
    );
  } else {
    sentences.push(
      availableBytes === null
        ? `${opening}. Nothing was changed — your existing messages are as they were.`
        : `${opening} — only ${formatSpace(availableBytes)} is actually available. ` +
            `Nothing was changed — your existing messages are as they were.`
    );
  }

  // The clause that stops the true number reading as a lie. Omitted entirely
  // when the count is unreadable (null) or when this Mac genuinely holds no
  // snapshots (0) — in both cases there is nothing truthful to say here.
  if (snapshotCount !== null && snapshotCount > 0) {
    sentences.push(
      `Your Mac may show more free space than this: ${snapshotCount} local Time Machine ` +
        `${snapshotCount === 1 ? "snapshot is" : "snapshots are"} holding space that macOS ` +
        `reports as free but apps cannot use until it reclaims them.`
    );
  }

  return sentences.join(" ");
}

/**
 * Does this error mean the volume is full?
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS RATHER THAN REUSING THE ONE IN deviceSyncOrchestrator
 * ---------------------------------------------------------------------------
 * `deviceSyncOrchestrator.ts` already tests `/disk space|no space|ENOSPC|not
 * enough space/i`. That pattern DOES NOT MATCH the error the founder actually
 * saw. SQLite's message is `database or disk is full`: it contains no "disk
 * space", no "no space", no "ENOSPC" and no "not enough space". The substring
 * that matters — `disk is full` — is in none of the four alternatives.
 *
 * That is precisely how a raw driver error reached his screen untranslated, and
 * it is why the exact string is pinned by test rather than trusted to a reading
 * of the regex.
 *
 * Both spellings are matched because both occur: `SQLITE_FULL` /
 * `database or disk is full` from the SQLite driver on a write, and
 * `ENOSPC` / `no space left on device` from Node's fs on an attachment copy.
 */
export function isDiskFullError(error: unknown): boolean {
  const haystack = [
    error instanceof Error ? error.message : String(error ?? ""),
    // better-sqlite3 carries the symbolic name on `.code` (SQLITE_FULL), and
    // Node's fs errors carry ENOSPC there. The message alone is not always
    // enough — a driver upgrade may reword the sentence but will not rename the
    // result code.
    typeof (error as { code?: unknown } | null)?.code === "string"
      ? (error as { code: string }).code
      : "",
  ]
    .join(" ")
    .toLowerCase();

  return (
    haystack.includes("sqlite_full") ||
    haystack.includes("disk is full") ||
    haystack.includes("enospc") ||
    haystack.includes("no space left on device") ||
    haystack.includes("disk full")
  );
}
