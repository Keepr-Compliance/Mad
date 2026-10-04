/**
 * BACKLOG-3403 — remove a submission that will not be finalized, without ever
 * touching one that was.
 *
 * THE FENCE COMES FIRST, ON EVERY PATH (SR condition 1, d0e108ff).
 *
 *   UPDATE transaction_submissions SET abandoned_at = <now>
 *    WHERE id = $1 AND status = 'uploading' AND abandoned_at IS NULL
 *
 * The fence waits on `finalize_submission`'s row lock. So if a finalize we
 * stopped listening to is still running, the fence returns only after it has
 * committed — and then matches 0 rows. 0 rows means "committed, or already
 * abandoned": delete NOTHING and re-read the status. Only 1 row lets the
 * deletes run, and from then on `finalize_submission` refuses (`abandoned`).
 *
 * THEN FILES, THEN ROWS. The bucket's SELECT and DELETE policies read the
 * parent row, and storage `remove()` needs both, so deleting the rows first
 * would leave every file undeletable. Messages and checklists go with the
 * parent (`ON DELETE CASCADE`); clients have no DELETE policy on them.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  SubmissionStageError,
  withStageRetry,
} from "./submissionStageRetry";

const STORAGE_BUCKET = "submission-attachments";
const REMOVE_CHUNK = 100;

export type AbandonOutcome =
  /** Fence held: files and rows were deleted (see `cleanupComplete`). */
  | "abandoned"
  /** The submission is out of `uploading` — it committed. Nothing deleted. */
  | "committed"
  /** Already fenced by another path. Nothing deleted. */
  | "already_abandoned"
  /** No such row. Nothing deleted. */
  | "not_found"
  /** The fence or the re-read got no answer. Nothing deleted. */
  | "unknown";

export interface AbandonResult {
  outcome: AbandonOutcome;
  /** The status read back when the fence matched 0 rows. */
  status?: string;
  /** True only when every delete answered. Leftovers stay hidden (`uploading`). */
  cleanupComplete: boolean;
  /** Files storage reported removed. */
  filesRemoved: number;
}

/** Read a submission's status. `null` = no row. Throws on no answer. */
export async function readSubmissionStatus(
  client: SupabaseClient,
  submissionId: string
): Promise<{ status: string; abandoned: boolean } | null> {
  const row = await withStageRetry("read_back", () =>
    client
      .from("transaction_submissions")
      .select("status, abandoned_at")
      .eq("id", submissionId)
      .maybeSingle()
  );
  if (!row) return null;
  const r = row as { status: string; abandoned_at?: string | null };
  return { status: r.status, abandoned: !!r.abandoned_at };
}

export interface AbandonOptions {
  /**
   * Stale-upload sweep only. A row that is still `uploading` and ALREADY
   * fenced is this user's own unfinished cleanup (BACKLOG-3725: only the
   * submitter can set `abandoned_at`, and finalize refuses a fenced row, so it
   * can never commit). Its files and rows may be removed — and must be, or
   * the next insert of this deal collides on its version.
   */
  finishEarlierAbandon?: boolean;
}

export async function abandonSubmission(
  client: SupabaseClient,
  submissionId: string,
  storagePaths: string[],
  options: AbandonOptions = {}
): Promise<AbandonResult> {
  // 1. Fence.
  let fenced: unknown[];
  try {
    fenced = (await withStageRetry("abandon", () =>
      client
        .from("transaction_submissions")
        .update({ abandoned_at: new Date().toISOString() })
        .eq("id", submissionId)
        .eq("status", "uploading")
        .is("abandoned_at", null)
        .select("id")
    )) as unknown[];
  } catch {
    return { outcome: "unknown", cleanupComplete: false, filesRemoved: 0 };
  }

  if (!Array.isArray(fenced) || fenced.length === 0) {
    // 0 rows: committed or already abandoned. Delete nothing; find out which.
    try {
      const row = await readSubmissionStatus(client, submissionId);
      if (!row) return { outcome: "not_found", cleanupComplete: true, filesRemoved: 0 };
      if (row.status !== "uploading") {
        return { outcome: "committed", status: row.status, cleanupComplete: true, filesRemoved: 0 };
      }
      if (!(options.finishEarlierAbandon && row.abandoned)) {
        return { outcome: "already_abandoned", status: row.status, cleanupComplete: false, filesRemoved: 0 };
      }
      // Fenced earlier and never committed: finish the earlier cleanup below.
    } catch {
      return { outcome: "unknown", cleanupComplete: false, filesRemoved: 0 };
    }
  }

  // 2. Files, by exact path.
  let complete = true;
  let filesRemoved = 0;
  const paths = Array.from(new Set(storagePaths.filter((p) => typeof p === "string" && p.length > 0)));
  for (let i = 0; i < paths.length; i += REMOVE_CHUNK) {
    const chunk = paths.slice(i, i + REMOVE_CHUNK);
    try {
      const removed = await withStageRetry("abandon", () =>
        client.storage.from(STORAGE_BUCKET).remove(chunk)
      );
      filesRemoved += Array.isArray(removed) ? removed.length : 0;
    } catch (e) {
      if (!(e instanceof SubmissionStageError)) throw e;
      complete = false;
    }
  }

  // C4 (SR 8fa92bef): a file that could not be removed stops here. The fenced
  // row still names its path, so this client's stale sweep or the server
  // sweep can finish it; deleting the rows now would orphan the file.
  if (!complete) {
    return { outcome: "abandoned", cleanupComplete: false, filesRemoved };
  }

  // 3. Attachment rows, then 4. the parent (messages/checklists cascade).
  try {
    await withStageRetry("abandon", () =>
      client.from("submission_attachments").delete().eq("submission_id", submissionId).select("id")
    );
  } catch (e) {
    if (!(e instanceof SubmissionStageError)) throw e;
    complete = false;
  }
  try {
    const deleted = await withStageRetry("abandon", () =>
      client.from("transaction_submissions").delete().eq("id", submissionId).select("id")
    );
    if (!Array.isArray(deleted) || deleted.length !== 1) complete = false;
  } catch (e) {
    if (!(e instanceof SubmissionStageError)) throw e;
    complete = false;
  }

  return { outcome: "abandoned", cleanupComplete: complete, filesRemoved };
}
