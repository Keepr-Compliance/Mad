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
