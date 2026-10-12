/**
 * BACKLOG-3892 slice E: what the user is told when the saved iPhone backup cannot be
 * used, and the one report of it to Sentry.
 *
 * Founder-approved sentence (2026-10-12): "Your saved iPhone backup is damaged."
 * Each line below is that sentence followed by the next step Keepr already shows
 * today (the tail of the C-DELTA retry message), so no new wording is introduced.
 *
 * "Damaged" means a sealed file failed authentication (INTEGRITY). A file whose key
 * this computer does not hold (KEY_MISSING alone) reads "Keepr cannot decrypt your saved
 * iPhone backup on this computer." (founder-approved 2026-10-12), with the same next step. A transient failure (a lock, EIO, no space) is never damaged.
 *
 * Retired by the founder (2026-10-12): the "can't be opened. Check the backup password."
 * line (no password is ever asked for). "No longer on this computer" is not an error
 * during a sync (a missing backup means a full backup). See pm_comments on BACKLOG-3892.
 */
export const BACKUP_DAMAGED_SENTENCE = "Your saved iPhone backup is damaged.";
const FRESH_FULL_BACKUP_SENTENCE = "Keepr will make a fresh full backup, which takes longer.";

/** Status line while a sync moves a damaged backup aside and makes a full one. */
export const BACKUP_DAMAGED_QUARANTINED_MESSAGE = `${BACKUP_DAMAGED_SENTENCE} ${FRESH_FULL_BACKUP_SENTENCE}`;
/** A C-DELTA sync stopped because the messages or contacts database is damaged. */
export const BACKUP_DAMAGED_RETRY_MESSAGE = `${BACKUP_DAMAGED_SENTENCE} Select Try Again: ${FRESH_FULL_BACKUP_SENTENCE}`;

/** The timeline / sync_outcomes reason_code for a sync stopped by a damaged backup. */
export const BACKUP_KEY_MISSING_SENTENCE = "Keepr cannot decrypt your saved iPhone backup on this computer.";
/** Status line while a sync moves a backup whose key is not on this computer aside. */
export const BACKUP_KEY_MISSING_QUARANTINED_MESSAGE = `${BACKUP_KEY_MISSING_SENTENCE} ${FRESH_FULL_BACKUP_SENTENCE}`;
/** A C-DELTA sync stopped because the messages or contacts database cannot be decrypted here. */
export const BACKUP_KEY_MISSING_RETRY_MESSAGE = `${BACKUP_KEY_MISSING_SENTENCE} Select Try Again: ${FRESH_FULL_BACKUP_SENTENCE}`;

export const BACKUP_DAMAGED_REASON = "BACKUP_DAMAGED";

/**
 * BACKLOG-3892 S5: the saved backup is gone (founder-approved 2026-10-12, pm_comments
 * 7845fbe4). Shown by the backfill only: during a sync a missing backup means a full one.
 */
export const BACKUP_MISSING_SENTENCE = "Your saved iPhone backup is no longer on this computer.";

/** Why a kept file could not be opened, when no retry can fix it. */
export type UnreadableKind = "damaged" | "key-missing";

/** INTEGRITY anywhere in the failed codes -> damaged; otherwise (KEY_MISSING only) key-missing. */
export function unreadableKind(codes: readonly string[]): UnreadableKind {
  return codes.includes("INTEGRITY") ? "damaged" : "key-missing";
}

/** The closed set of reasons reported to Sentry. Never a path, a udid or message text. */
export type BackupProblemReason =
  | "damaged"
  | "key-missing"
  | "key-unavailable"
  | "disk-space"
  | "unreadable"
  | "apple-encrypted"
  // BACKLOG-3892 S5: the saved backup is no longer on this computer (backfill only).
  | "missing";

const REASONS: ReadonlySet<string> = new Set<BackupProblemReason>([
  "damaged",
  "key-missing",
  "key-unavailable",
  "disk-space",
  "unreadable",
  "apple-encrypted",
  "missing",
]);

/**
 * The Sentry reason for an at-rest refusal; null for a refusal that is not a problem
 * with the backup (busy = it is being secured, cancelled = the user).
 */
export function backupProblemForRefusal(reason: string, problem?: UnreadableKind): BackupProblemReason | null {
  if (problem) return problem;
  return REASONS.has(reason) ? (reason as BackupProblemReason) : null;
}
