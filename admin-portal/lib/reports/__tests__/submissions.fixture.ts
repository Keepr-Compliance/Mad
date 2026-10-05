/**
 * Submissions report fixtures (BACKLOG-3715)
 *
 * Every row is TRANSCRIBED from the code that writes it, not invented:
 *
 * - in_progress: desktop `submissionService.ts:968-977` — outcome in_progress,
 *   stage `parent`, reason null, retry 0, counts `{}`, ended_at null.
 * - committed: `finalize_submission` ON CONFLICT (migration 20261004192647
 *   :298-299) sets outcome/stage/reason/updated_at/ended_at only, so counts and
 *   retry_count stay as the in_progress write left them.
 * - failed / cancelled / unconfirmed: `submissionService.ts:1388-1397`, counts
 *   from `flatAttemptCounts` (messages, attachments, [checklists], not_included,
 *   refusal_*), merged onto the row by `record_submission_attempt`.
 * - abandoned by the sweep: migration 20261005120000:266-269 (PR #2796 head
 *   a418e0d1a) sets outcome `abandoned`, stage `server_sweep`, reason `swept`,
 *   ended_at, updated_at — counts and retry_count untouched.
 *
 * Two count shapes: BEFORE counts were recorded on the in_progress write
 * (`{}` on every committed row) and AFTER (the planned counts, same keys as
 * `flatAttemptCounts`). The report must handle both.
 */

import type { SubmissionAttemptRow, SubmissionOrg, SubmissionUser } from '../submissions';

/** Sunday 2026-10-04 20:00 UTC. "This week" = Mon 2026-09-28 00:00 → now. */
export const NOW = new Date('2026-10-04T20:00:00.000Z');

export const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

const ORG_A = 'org-a';
const ORG_B = 'org-b';
const USER_1 = 'user-1';
const USER_2 = 'user-2';

export const FIXTURE_USERS: SubmissionUser[] = [
  { id: USER_1, email: 'agent.one@example.test', display_name: 'fixture agent 1' },
  { id: USER_2, email: 'agent.two@example.test', display_name: null },
];

export const FIXTURE_ORGS: SubmissionOrg[] = [
  { id: ORG_A, name: 'Office A' },
  { id: ORG_B, name: 'Office B' },
];

function sid(n: number): string {
  return `5ub00000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function row(n: number, over: Partial<SubmissionAttemptRow>): SubmissionAttemptRow {
  return {
    id: `a7700000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    submission_id: sid(n),
    user_id: USER_1,
    organization_id: ORG_A,
    is_resubmit: false,
    outcome: 'in_progress',
    stage: 'parent',
    reason_code: null,
    retry_count: 0,
    counts: {},
    app_version: '2.39.0',
    platform: 'darwin',
    started_at: minutesAgo(10),
    updated_at: minutesAgo(10),
    ended_at: null,
    ...over,
  };
}

/** in_progress, 10 min old — Running. */
export const RUNNING = row(1, {});

/** in_progress, 45 min old — Stalled, not past the sweep window. */
export const STALLED = row(2, { started_at: minutesAgo(45), updated_at: minutesAgo(45), user_id: USER_2 });

/** Committed BEFORE counts were recorded at start: counts `{}`. */
export const COMMITTED_PRE = row(3, {
  outcome: 'committed',
  stage: 'finalize',
  started_at: minutesAgo(60 * 24),
  updated_at: minutesAgo(60 * 24 - 3),
  ended_at: minutesAgo(60 * 24 - 3),
});

/** Committed AFTER counts were recorded at start: planned counts kept. */
export const COMMITTED_POST = row(4, {
  outcome: 'committed',
  stage: 'finalize',
  counts: { messages: 12, attachments: 3, not_included: 0 },
  started_at: minutesAgo(60 * 25),
  updated_at: minutesAgo(60 * 25 - 2),
  ended_at: minutesAgo(60 * 25 - 2),
  organization_id: ORG_B,
});

/** Failed at uploads after retries. */
export const FAILED = row(5, {
  outcome: 'failed',
  stage: 'uploads',
  reason_code: 'retries_exhausted',
  retry_count: 2,
  counts: { messages: 40, attachments: 7, not_included: 2 },
  started_at: minutesAgo(60 * 48),
  updated_at: minutesAgo(60 * 48 - 5),
  ended_at: minutesAgo(60 * 48 - 5),
});

/** Refused by finalize, with the refusal counters. */
export const REFUSED = row(6, {
  outcome: 'failed',
  stage: 'finalize',
  reason_code: 'finalize_refused',
  counts: {
    messages: 9,
    attachments: 2,
    not_included: 0,
    refusal_objects_missing: 2,
    refusal_messages_missing: 0,
  },
  started_at: minutesAgo(60 * 49),
  updated_at: minutesAgo(60 * 49 - 1),
  ended_at: minutesAgo(60 * 49 - 1),
});

export const UNCONFIRMED = row(7, {
  outcome: 'unconfirmed',
  stage: 'read_back',
  reason_code: 'unconfirmed',
  counts: { messages: 5, attachments: 0, not_included: 0 },
  started_at: minutesAgo(60 * 50),
  updated_at: minutesAgo(60 * 50 - 1),
  ended_at: minutesAgo(60 * 50 - 1),
});

export const CANCELLED = row(8, {
  outcome: 'cancelled',
  stage: 'uploads',
  reason_code: 'user_cancelled',
  counts: { messages: 5, attachments: 1, not_included: 0 },
  started_at: minutesAgo(60 * 72),
  updated_at: minutesAgo(60 * 72 - 1),
  ended_at: minutesAgo(60 * 72 - 1),
  user_id: USER_2,
});

/** Abandoned by the server sweep (migration 20261005120000:266-269). */
export const SWEPT = row(9, {
  outcome: 'abandoned',
  stage: 'server_sweep',
  reason_code: 'swept',
  started_at: minutesAgo(60 * 96),
  updated_at: minutesAgo(60 * 93),
  ended_at: minutesAgo(60 * 93),
});

/** A code this report does not know — must render raw. */
export const UNKNOWN_CODES = row(10, {
  outcome: 'failed',
  stage: 'brand_new_stage',
  reason_code: 'brand_new_reason',
  counts: { brand_new_counter: 4 },
  started_at: minutesAgo(60 * 97),
  updated_at: minutesAgo(60 * 97 - 1),
  ended_at: minutesAgo(60 * 97 - 1),
});

/** Open 200 min — past the sweep window. Started BEFORE this week. */
export const OLD_OPEN = row(11, {
  started_at: '2026-09-20T08:00:00.000Z',
  updated_at: '2026-09-20T08:00:00.000Z',
});

/** Every row whose start is inside "this week". */
export const PERIOD_ROWS: SubmissionAttemptRow[] = [
  RUNNING,
  STALLED,
  COMMITTED_PRE,
  COMMITTED_POST,
  FAILED,
  REFUSED,
  UNCONFIRMED,
  CANCELLED,
  SWEPT,
  UNKNOWN_CODES,
];

/** What the open-attempts query returns: every in_progress row, any date. */
export const OPEN_ROWS: SubmissionAttemptRow[] = [OLD_OPEN, STALLED, RUNNING];

export { ORG_A, ORG_B, USER_1, USER_2, row };
