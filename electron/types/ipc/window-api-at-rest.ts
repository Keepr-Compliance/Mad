/**
 * WindowApi at-rest sub-interface — BACKLOG-3816 S3.
 *
 * The renderer's view of `window.api.atRest`: the progress of the background
 * migration that encrypts files Keepr saved before 2.40. Counts only — no paths,
 * no file names.
 */

export const AT_REST_STATUS_CHANNEL = "at-rest:migration-status";
export const AT_REST_GET_STATUS_CHANNEL = "at-rest:get-migration-status";

/**
 * idle     — nothing to do, or not started yet.
 * running  — encrypting files in the background.
 * paused   — stopped for a reason the user can act on (see pauseReason).
 * done     — every file this run looked at is encrypted.
 */
export type AtRestMigrationPhase = "idle" | "running" | "paused" | "done";

/**
 * disk-space    — not enough free space to write the encrypted copy; retried automatically.
 * files-in-use  — some files were locked (antivirus, another program); retried next launch.
 */
export type AtRestPauseReason = "disk-space" | "files-in-use";

export interface AtRestMigrationStatus {
  phase: AtRestMigrationPhase;
  pauseReason?: AtRestPauseReason;
  /** Files encrypted (or found already encrypted) so far in this run. */
  done: number;
  /** Plaintext files this run set out to encrypt. */
  total: number;
  /** Whole minutes left, rounded up; null until there is a rate to estimate from. */
  minutesLeft: number | null;
  /** Files encrypted during this launch. 0 = the run had nothing to do. */
  encryptedThisLaunch: number;
}

export interface WindowApiAtRest {
  getMigrationStatus(): Promise<AtRestMigrationStatus>;
  /** Returns an unsubscribe function. */
  onMigrationStatus(callback: (status: AtRestMigrationStatus) => void): () => void;
}
