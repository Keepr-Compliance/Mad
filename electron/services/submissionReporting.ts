/**
 * BACKLOG-3403 / BACKLOG-3681 — what a submission reports about itself:
 * one row per attempt in `submission_attempts`, and Sentry events.
 *
 * COUNTS AND CODES ONLY. No names, addresses, subjects, file names, paths or
 * driver messages (a driver message can contain a path). Every value passed
 * here is a number, a fixed code, an id, or the app version.
 */

import * as os from "os";
import { app } from "electron";
import type { SupabaseClient } from "@supabase/supabase-js";
import { hostErrorReporter } from "../capabilities/errorReporterProvider";
import logService from "./logService";
import type { NotIncludedItem, NotIncludedReason } from "./submissionPreflight";

export type AttemptOutcome = "in_progress" | "failed" | "cancelled" | "unconfirmed";

export type SubmissionFailureReason =
  | "retries_exhausted"
  | "permanent_error"
  | "finalize_refused"
  | "abandoned"
  | "not_owner"
  | "not_found"
  | "rpc_missing"
  | "unconfirmed";

export interface ManifestCounts {
  messages: number;
  attachments: number;
  checklists: number | null;
}

/** finalize_submission's refusal counters, as the RPC returns them. */
export type FinalizeRefusalCounts = Partial<
  Record<
    | "messages_missing"
    | "messages_extra"
    | "attachment_rows_missing"
    | "attachment_rows_extra"
    | "objects_missing"
    | "paths_outside_submission"
    | "attachment_message_links_wrong"
    | "checklists_expected"
    | "checklists_found",
    number | null
  >
>;

const REFUSAL_KEYS: (keyof FinalizeRefusalCounts)[] = [
  "messages_missing",
  "messages_extra",
  "attachment_rows_missing",
  "attachment_rows_extra",
  "objects_missing",
  "paths_outside_submission",
  "attachment_message_links_wrong",
  "checklists_expected",
  "checklists_found",
];

/** Keep only the RPC's own counters, as whole numbers. */
export function pickRefusalCounts(data: unknown): FinalizeRefusalCounts {
  const out: FinalizeRefusalCounts = {};
  if (!data || typeof data !== "object") return out;
  const d = data as Record<string, unknown>;
  for (const k of REFUSAL_KEYS) {
    const v = d[k];
    if (typeof v === "number" && Number.isInteger(v) && v >= 0) out[k] = v;
  }
  return out;
}

/**
 * `record_submission_attempt` keeps only FLAT snake_case keys with whole
 * numbers (PR-A, 88c8c300). A nested object would be dropped silently.
 */
export function flatAttemptCounts(
  manifest: ManifestCounts | null,
  notIncluded: number,
  refusal: FinalizeRefusalCounts | null
): Record<string, number> {
  const out: Record<string, number> = {};
  if (manifest) {
    out.messages = manifest.messages;
    out.attachments = manifest.attachments;
    if (manifest.checklists !== null) out.checklists = manifest.checklists;
  }
  out.not_included = notIncluded;
  if (refusal) {
    for (const [k, v] of Object.entries(refusal)) {
      if (typeof v === "number") out[`refusal_${k}`] = v;
    }
  }
  return out;
}

/**
 * BACKLOG-3715 — the counts on the `in_progress` attempt row: what the desktop
 * is about to send. Successful attempts are finished by the server (finalize),
 * which never re-sends these keys, so they are what the Submissions report
 * shows for a commit.
 */
export function inProgressAttemptCounts(
  messages: number,
  attachments: number,
  notIncluded: number
): Record<string, number> {
  return { messages, attachments, not_included: notIncluded };
}

export interface AttemptRecord {
  submissionId: string;
  organizationId: string;
  outcome: AttemptOutcome;
  stage: string | null;
  reasonCode: string | null;
  retryCount: number;
  counts: Record<string, number>;
  isResubmit: boolean;
}

function platformCode(): string {
  const p = os.platform();
  return /^[a-z0-9_]{1,20}$/.test(p) ? p : "other";
}

/**
 * Write the attempt row. Never throws and never fails the submission: the
 * report is for the founder's dashboard, not part of the commit.
 * `committed` is not accepted by the server from a client (only finalize
 * writes it), so it is not a value this function can send.
 */
export async function recordSubmissionAttempt(
  client: SupabaseClient,
  record: AttemptRecord
): Promise<void> {
  try {
    const { error } = await client.rpc("record_submission_attempt", {
      p_submission_id: record.submissionId,
      p_organization_id: record.organizationId,
      p_outcome: record.outcome,
      p_stage: record.stage,
      p_reason_code: record.reasonCode,
      p_retry_count: record.retryCount,
      p_counts: record.counts,
      p_is_resubmit: record.isResubmit,
      p_app_version: app.getVersion(),
      p_platform: platformCode(),
    });
    if (error) {
      logService.warn(
        `[Submission] Could not record the attempt (${error.code ?? "no code"})`,
        "SubmissionService"
      );
    }
  } catch {
    logService.warn("[Submission] Could not record the attempt (no answer)", "SubmissionService");
  }
}

export interface FailureReport {
  submissionId: string;
  isResubmit: boolean;
  stage: string;
  reason: SubmissionFailureReason;
  attempts: number;
  errorCode: string | null;
  manifest: ManifestCounts | null;
  refusal: FinalizeRefusalCounts | null;
  cleanupComplete: boolean | null;
}

/** One Sentry ERROR per failed submission. Not for a cancel (a user action). */
export function reportSubmissionFailure(report: FailureReport): void {
  hostErrorReporter.captureMessage("Submission failed", {
    level: "error",
    tags: { area: "submission", stage: report.stage, reason: report.reason },
    extra: {
      submission_id: report.submissionId,
      is_resubmit: report.isResubmit,
      attempts: report.attempts,
      error_code: report.errorCode,
      manifest_counts: report.manifest,
      refusal: report.refusal,
      cleanup_complete: report.cleanupComplete,
      app_version: app.getVersion(),
    },
  });
}

/**
 * BACKLOG-3681 — one Sentry WARNING per SUCCESSFUL submission that left
 * anything out. Reason codes and cloud message ids only.
 */
export function reportSubmissionExclusions(
  submissionId: string,
  notIncluded: NotIncludedItem[],
  cloudIdByLocal: Map<string, string>
): void {
  if (notIncluded.length === 0) return;
  const byReason: Partial<Record<NotIncludedReason, number>> = {};
  for (const item of notIncluded) {
    byReason[item.reason] = (byReason[item.reason] ?? 0) + 1;
  }
  hostErrorReporter.captureMessage("Submission sent with exclusions", {
    level: "warning",
    tags: { area: "submission" },
    extra: {
      submission_id: submissionId,
      app_version: app.getVersion(),
      not_included_total: notIncluded.length,
      not_included_by_reason: byReason,
      not_included: notIncluded.map((item) => ({
        kind: item.kind,
        reason: item.reason,
        submission_message_id: cloudIdByLocal.get(`${item.kind}:${item.localMessageId}`) ?? null,
      })),
    },
  });
}

/** BACKLOG-3683: what the scope preview counted. Numbers only. */
export interface SubmissionScopeCounts {
  inWindow: { emails: number; texts: number; textThreads: number; attachments: number };
}

/**
 * BACKLOG-3683 — one Sentry INFO each time the agent reaches the summary:
 * how much of what is linked falls inside the dates. Counts only; the
 * transaction id is the one identifier.
 */
export function reportSubmissionScope(
  transactionId: string,
  counts: SubmissionScopeCounts
): void {
  hostErrorReporter.captureMessage("Submission scope previewed", {
    level: "info",
    tags: { area: "submission" },
    extra: {
      transaction_id: transactionId,
      app_version: app.getVersion(),
      in_window: { ...counts.inWindow },
    },
  });
}
