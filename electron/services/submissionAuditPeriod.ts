/**
 * BACKLOG-3683 — the ONE reader of a transaction's audit period for a
 * submission.
 *
 * Both the submit gather (`submissionService.gatherForSubmission`) and the
 * scope preview (`submissionService.getSubmissionScope`) turn
 * `started_at` / `closed_at` into the window through this function. The
 * preview is computed from the dates the agent has typed but not yet saved;
 * the gather reads the same strings back from the row after the save. If the
 * two read them differently, the summary promises one set and the submission
 * sends another — which is the defect this item fixes. Do not inline a copy.
 *
 * The end bound passed on here is the raw `closed_at`; each query widens it
 * to the end of that calendar day with `auditWindowEnd` (`exportPlan.ts`).
 */

export interface AuditPeriodSource {
  started_at?: string | null;
  closed_at?: string | null;
}

export interface AuditPeriod {
  auditStartDate: Date | null;
  auditEndDate: Date | null;
}

export function auditPeriodFromRow(row: AuditPeriodSource): AuditPeriod {
  return {
    auditStartDate: row.started_at ? new Date(row.started_at) : null,
    auditEndDate: row.closed_at ? new Date(row.closed_at) : null,
  };
}
