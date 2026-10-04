/**
 * Submissions report — pure derivation (BACKLOG-3715)
 *
 * One `submission_attempts` row per submission id. This file turns those rows
 * into the view model the page renders. Nothing here imports React or touches
 * the network, and `now` is always injected so every time boundary can be
 * asserted exactly.
 *
 * COUNTS AND CODES ONLY. The report shows organization, agent, a short
 * submission id, the codes and the counts. Staff cannot read
 * `transaction_submissions`, so no address, transaction name or file name is
 * reachable from here.
 *
 * Rows that are still `in_progress` ARE counted. They are attempts, and a
 * stall is exactly what this report exists to show — do not copy the iPhone
 * report's exclusion of running syncs.
 */

import { daysInRange, formatDayLabel, type PeriodRange } from './period';
import { formatDuration, formatUtc } from './iphone-sync';

// ─── Rows, as the database stores them ───────────────────────────

export interface SubmissionAttemptRow {
  id: string;
  submission_id: string;
  user_id: string | null;
  organization_id: string | null;
  is_resubmit: boolean | null;
  outcome: string;
  stage: string | null;
  reason_code: string | null;
  retry_count: number | null;
  counts: unknown;
  app_version: string | null;
  platform: string | null;
  started_at: string;
  updated_at: string | null;
  ended_at: string | null;
}

export interface SubmissionUser {
  id: string;
  email: string | null;
  display_name: string | null;
}

export interface SubmissionOrg {
  id: string;
  name: string | null;
}

// ─── Thresholds ──────────────────────────────────────────────────

export const IN_PROGRESS = 'in_progress';

/**
 * An open attempt is "Stalled" once it has been open this long. The desktop
 * app writes the in_progress row once and does not report progress after it,
 * so the only clock available is the age of `started_at`. A large upload can
 * therefore read as stalled while it is still running.
 */
export const STALL_MINUTES = 30;

/**
 * Past this age an open attempt is outside the window in which the server
 * sweep normally clears an upload that stopped sending files: the sweep waits
 * 2 h with no new file activity and runs once an hour, so 2 h + 1 h.
 */
export const SWEEP_WINDOW_MINUTES = 180;

const MS_PER_MINUTE = 60_000;
const EM_DASH = '—';

// ─── Labels ──────────────────────────────────────────────────────

export type SubmissionStatus =
  | 'committed'
  | 'failed'
  | 'unconfirmed'
  | 'abandoned'
  | 'cancelled'
  | 'running'
  | 'stalled'
  | 'other';

export type StatusTone = 'good' | 'critical' | 'warning' | 'neutral';

export const STATUS_LABELS: Record<Exclude<SubmissionStatus, 'other'>, string> = {
  committed: 'Committed',
  failed: 'Failed',
  unconfirmed: 'Outcome unknown',
  abandoned: 'Did not finish',
  cancelled: 'Cancelled',
  running: 'Running',
  stalled: 'Stalled',
};

const STATUS_TONES: Record<SubmissionStatus, StatusTone> = {
  committed: 'good',
  failed: 'critical',
  unconfirmed: 'critical',
  abandoned: 'warning',
  cancelled: 'neutral',
  running: 'neutral',
  stalled: 'warning',
  other: 'neutral',
};

/**
 * Stage codes. `server_sweep` is the stage the server sweep writes
 * (migration 20261005120000). Any code not listed renders under its raw name.
 */
export const STAGE_LABELS: Record<string, string> = {
  gather: 'Gathering',
  preflight: 'Pre-flight check',
  sweep: 'Clearing an earlier attempt',
  parent: 'Creating the submission',
  messages: 'Uploading messages',
  attachment_rows: 'Recording files',
  uploads: 'Uploading files',
  checklists: 'Checklists',
  finalize: 'Finalize',
  read_back: 'Confirming with the server',
  abandon: 'Abandoning',
  server_sweep: 'Server sweep',
};

/** Reason codes. `swept` is written by the server sweep. Unknown codes render raw. */
export const REASON_LABELS: Record<string, string> = {
  retries_exhausted: 'Gave up after retries',
  permanent_error: 'Permanent error',
  finalize_refused: 'Server refused to finalize',
  abandoned: 'Abandoned by the app',
  not_owner: 'Not the owner',
  not_found: 'Submission not found',
  rpc_missing: 'Server function missing',
  unconfirmed: 'Could not confirm the result',
  user_cancelled: 'Cancelled by the agent',
  swept: 'Removed by the server sweep',
};

/** Count keys. Unknown keys render under their raw name, never dropped. */
export const COUNT_LABELS: Record<string, string> = {
  messages: 'Messages',
  attachments: 'Files',
  checklists: 'Checklists',
  not_included: 'Left out',
  refusal_messages_missing: 'Messages missing on the server',
  refusal_messages_extra: 'Extra messages on the server',
  refusal_attachment_rows_missing: 'File records missing on the server',
  refusal_attachment_rows_extra: 'Extra file records on the server',
  refusal_objects_missing: 'Files missing on the server',
  refusal_paths_outside_submission: 'Files stored outside this submission',
  refusal_attachment_message_links_wrong: 'Files linked to the wrong message',
  refusal_checklists_expected: 'Checklists expected',
  refusal_checklists_found: 'Checklists found',
};

export function stageLabel(code: string | null): string {
  if (!code) return EM_DASH;
  return STAGE_LABELS[code] ?? code;
}

export function reasonLabel(code: string | null): string {
  if (!code) return EM_DASH;
  return REASON_LABELS[code] ?? code;
}

export function countLabel(key: string): string {
  return COUNT_LABELS[key] ?? key;
}

// ─── Counts ──────────────────────────────────────────────────────

/** Keep only finite numbers. Anything else in the jsonb is not a count. */
export function parseCounts(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/**
 * A count, or NULL when the row does not carry that key.
 *
 * Absent is not zero. Rows written before counts were recorded on every
 * attempt carry `{}`; those show "—", whatever the outcome.
 */
export function countOf(counts: Record<string, number>, key: string): number | null {
  return Object.prototype.hasOwnProperty.call(counts, key) ? counts[key] : null;
}

export function formatCountCell(value: number | null): string {
  if (value == null) return EM_DASH;
  return value.toLocaleString('en-US');
}

// ─── Status ──────────────────────────────────────────────────────

export function minutesOpen(row: Pick<SubmissionAttemptRow, 'started_at'>, now: Date): number | null {
  const start = Date.parse(row.started_at);
  if (Number.isNaN(start)) return null;
  return (now.getTime() - start) / MS_PER_MINUTE;
}

export function isStalled(row: Pick<SubmissionAttemptRow, 'outcome' | 'started_at'>, now: Date): boolean {
  if (row.outcome !== IN_PROGRESS) return false;
  const minutes = minutesOpen(row, now);
  return minutes != null && minutes >= STALL_MINUTES;
}

export function isPastSweepWindow(
  row: Pick<SubmissionAttemptRow, 'outcome' | 'started_at'>,
  now: Date
): boolean {
  if (row.outcome !== IN_PROGRESS) return false;
  const minutes = minutesOpen(row, now);
  return minutes != null && minutes >= SWEEP_WINDOW_MINUTES;
}

export function statusOf(row: Pick<SubmissionAttemptRow, 'outcome' | 'started_at'>, now: Date): SubmissionStatus {
  switch (row.outcome) {
    case 'committed':
    case 'failed':
    case 'unconfirmed':
    case 'abandoned':
    case 'cancelled':
      return row.outcome;
    case IN_PROGRESS:
      return isStalled(row, now) ? 'stalled' : 'running';
    default:
      return 'other';
  }
}

// ─── View model ──────────────────────────────────────────────────

export interface Submission {
  id: string;
  submissionId: string;
  shortId: string;
  startedAtIso: string;
  whenUtc: string;
  userId: string | null;
  agentLabel: string;
  agentEmail: string | null;
  orgId: string | null;
  orgLabel: string;
  /** The raw database outcome. */
  outcome: string;
  status: SubmissionStatus;
  /** Humanised status; an unknown outcome shows its raw value. */
  statusLabel: string;
  tone: StatusTone;
  stage: string | null;
  stageLabel: string;
  reason: string | null;
  reasonLabel: string;
  retryCount: number;
  /** `ended_at − started_at`; NULL while open. */
  durationMs: number | null;
  durationLabel: string;
  counts: Record<string, number>;
  messages: number | null;
  files: number | null;
  notIncluded: number | null;
  isResubmit: boolean;
  appVersion: string;
  platform: string;
  /** Minutes since start, for open rows only. */
  openMinutes: number | null;
  pastSweepWindow: boolean;
}

export function buildSubmission(
  row: SubmissionAttemptRow,
  users: Map<string, SubmissionUser>,
  orgs: Map<string, SubmissionOrg>,
  now: Date
): Submission {
  const user = row.user_id ? users.get(row.user_id) : undefined;
  const org = row.organization_id ? orgs.get(row.organization_id) : undefined;
  const status = statusOf(row, now);
  const counts = parseCounts(row.counts);
  const start = Date.parse(row.started_at);
  const end = row.ended_at ? Date.parse(row.ended_at) : NaN;
  const durationMs =
    row.outcome !== IN_PROGRESS && !Number.isNaN(start) && !Number.isNaN(end) && end >= start
      ? end - start
      : null;
  const open = row.outcome === IN_PROGRESS;

  return {
    id: row.id,
    submissionId: row.submission_id,
    shortId: row.submission_id.slice(0, 8),
    startedAtIso: row.started_at,
    whenUtc: formatUtc(row.started_at),
    userId: row.user_id,
    agentLabel: user?.display_name?.trim() || user?.email || 'Unknown agent',
    agentEmail: user?.email ?? null,
    orgId: row.organization_id,
    orgLabel: org?.name?.trim() || 'Unknown organization',
    outcome: row.outcome,
    status,
    statusLabel: status === 'other' ? row.outcome : STATUS_LABELS[status],
    tone: STATUS_TONES[status],
    stage: row.stage,
    stageLabel: stageLabel(row.stage),
    reason: row.reason_code,
    reasonLabel: reasonLabel(row.reason_code),
    retryCount: row.retry_count ?? 0,
    durationMs,
    durationLabel: durationMs == null ? EM_DASH : formatDuration(durationMs),
    counts,
    messages: countOf(counts, 'messages'),
    files: countOf(counts, 'attachments'),
    notIncluded: countOf(counts, 'not_included'),
    isResubmit: row.is_resubmit === true,
    appVersion: row.app_version ?? EM_DASH,
    platform: row.platform ?? EM_DASH,
    openMinutes: open ? minutesOpen(row, now) : null,
    pastSweepWindow: isPastSweepWindow(row, now),
  };
}

export interface SubmissionsReportModel {
  /** Every row of the period, newest first. In-progress rows included. */
  submissions: Submission[];
}

function lookupMaps(users: SubmissionUser[], orgs: SubmissionOrg[]) {
  return {
    users: new Map(users.map((u) => [u.id, u])),
    orgs: new Map(orgs.map((o) => [o.id, o])),
  };
}

export function buildSubmissionsReport(
  rows: SubmissionAttemptRow[],
  users: SubmissionUser[],
  orgs: SubmissionOrg[],
  now: Date
): SubmissionsReportModel {
  const maps = lookupMaps(users, orgs);
  const submissions = rows
    .map((row) => buildSubmission(row, maps.users, maps.orgs, now))
    .sort((a, b) => b.startedAtIso.localeCompare(a.startedAtIso));
  return { submissions };
}

/** The open-attempts panel: in_progress rows only, oldest first. */
export function buildOpenAttempts(
  rows: SubmissionAttemptRow[],
  users: SubmissionUser[],
  orgs: SubmissionOrg[],
  now: Date
): Submission[] {
  const maps = lookupMaps(users, orgs);
  return rows
    .filter((row) => row.outcome === IN_PROGRESS)
    .map((row) => buildSubmission(row, maps.users, maps.orgs, now))
    .sort((a, b) => a.startedAtIso.localeCompare(b.startedAtIso));
}

// ─── Tiles ───────────────────────────────────────────────────────

export interface SubmissionCounts {
  attempts: number;
  committed: number;
  /** Committed as a whole-number percent of attempts; NULL when there are none. */
  committedPct: number | null;
  /** failed + outcome unknown. */
  failed: number;
  /** Abandoned (the server sweep or the app gave up). */
  didNotFinish: number;
  cancelled: number;
  running: number;
  stalled: number;
}

export function computeCounts(subs: Submission[]): SubmissionCounts {
  const by = (s: SubmissionStatus) => subs.filter((x) => x.status === s).length;
  const committed = by('committed');
  return {
    attempts: subs.length,
    committed,
    committedPct: subs.length === 0 ? null : Math.round((committed / subs.length) * 100),
    failed: by('failed') + by('unconfirmed'),
    didNotFinish: by('abandoned'),
    cancelled: by('cancelled'),
    running: by('running'),
    stalled: by('stalled'),
  };
}

// ─── Filters ─────────────────────────────────────────────────────

export interface SubmissionFilters {
  statuses: string[];
  orgs: string[];
  agents: string[];
  reasons: string[];
  platforms: string[];
  search: string;
}

export const EMPTY_SUBMISSION_FILTERS: SubmissionFilters = {
  statuses: [],
  orgs: [],
  agents: [],
  reasons: [],
  platforms: [],
  search: '',
};

/** The reason filter's value for a row with no reason code. */
export const NO_REASON = '__none__';

export function hasActiveFilters(f: SubmissionFilters): boolean {
  return (
    f.statuses.length > 0 ||
    f.orgs.length > 0 ||
    f.agents.length > 0 ||
    f.reasons.length > 0 ||
    f.platforms.length > 0 ||
    f.search.trim().length > 0
  );
}

export function activeFilterNames(f: SubmissionFilters): string[] {
  const names: string[] = [];
  if (f.statuses.length > 0) names.push(`Outcome (${f.statuses.length})`);
  if (f.orgs.length > 0) names.push(`Organization (${f.orgs.length})`);
  if (f.agents.length > 0) names.push(`Agent (${f.agents.length})`);
  if (f.reasons.length > 0) names.push(`Reason (${f.reasons.length})`);
  if (f.platforms.length > 0) names.push(`Platform (${f.platforms.length})`);
  if (f.search.trim().length > 0) names.push(`Search "${f.search.trim()}"`);
  return names;
}

export function applySubmissionFilters(subs: Submission[], f: SubmissionFilters): Submission[] {
  const search = f.search.trim().toLowerCase();
  return subs.filter((s) => {
    if (f.statuses.length > 0 && !f.statuses.includes(s.status)) return false;
    if (f.orgs.length > 0 && !f.orgs.includes(s.orgId ?? '')) return false;
    if (f.agents.length > 0 && !f.agents.includes(s.userId ?? '')) return false;
    if (f.reasons.length > 0 && !f.reasons.includes(s.reason ?? NO_REASON)) return false;
    if (f.platforms.length > 0 && !f.platforms.includes(s.platform)) return false;
    if (search) {
      const hay = `${s.submissionId} ${s.agentEmail ?? ''}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });
}

// ─── Sort ────────────────────────────────────────────────────────

export type SubmissionSortKey =
  | 'started'
  | 'agent'
  | 'org'
  | 'outcome'
  | 'stage'
  | 'reason'
  | 'retries'
  | 'duration'
  | 'messages'
  | 'files'
  | 'notIncluded'
  | 'resubmit'
  | 'version'
  | 'id';

export type SortDirection = 'asc' | 'desc';

type SortValue = string | number | null;

export const SUBMISSION_SORT_SPECS: Record<
  SubmissionSortKey,
  { label: string; value: (s: Submission) => SortValue; numeric: boolean }
> = {
  started: { label: 'Started', value: (s) => s.startedAtIso, numeric: false },
  agent: { label: 'Agent', value: (s) => s.agentLabel.toLowerCase(), numeric: false },
  org: { label: 'Organization', value: (s) => s.orgLabel.toLowerCase(), numeric: false },
  outcome: { label: 'Outcome', value: (s) => s.statusLabel, numeric: false },
  stage: { label: 'Stopped at', value: (s) => (s.stage ? s.stageLabel : null), numeric: false },
  reason: { label: 'Reason', value: (s) => (s.reason ? s.reasonLabel : null), numeric: false },
  retries: { label: 'Retries', value: (s) => s.retryCount, numeric: true },
  duration: { label: 'Duration', value: (s) => s.durationMs, numeric: true },
  messages: { label: 'Messages', value: (s) => s.messages, numeric: true },
  files: { label: 'Files', value: (s) => s.files, numeric: true },
  notIncluded: { label: 'Left out', value: (s) => s.notIncluded, numeric: true },
  resubmit: { label: 'Resubmit', value: (s) => (s.isResubmit ? 1 : 0), numeric: true },
  version: { label: 'App · Platform', value: (s) => `${s.appVersion} ${s.platform}`, numeric: false },
  id: { label: 'Submission', value: (s) => s.submissionId, numeric: false },
};

export function defaultSubmissionDirection(key: SubmissionSortKey): SortDirection {
  return SUBMISSION_SORT_SPECS[key].numeric || key === 'started' ? 'desc' : 'asc';
}

/** Stable sort; rows with no value always sink to the bottom, either direction. */
export function sortSubmissions(
  subs: Submission[],
  key: SubmissionSortKey,
  direction: SortDirection
): Submission[] {
  const spec = SUBMISSION_SORT_SPECS[key];
  const sign = direction === 'asc' ? 1 : -1;
  return subs
    .map((s, i) => ({ s, i, v: spec.value(s) }))
    .sort((a, b) => {
      if (a.v == null && b.v == null) return a.i - b.i;
      if (a.v == null) return 1;
      if (b.v == null) return -1;
      const cmp =
        typeof a.v === 'number' && typeof b.v === 'number'
          ? a.v - b.v
          : String(a.v).localeCompare(String(b.v));
      return cmp === 0 ? a.i - b.i : cmp * sign;
    })
    .map((x) => x.s);
}

export const INITIAL_VISIBLE_SUBMISSIONS = 10;
export const SUBMISSION_SHOW_MORE_STEP = 10;

// ─── Per-day buckets ─────────────────────────────────────────────

export interface SubmissionDayBucket {
  dayIso: string;
  dayLabel: string;
  attempts: number;
  committed: number;
  /** failed + outcome unknown — the red segment. */
  failed: number;
  /** abandoned + stalled — the amber segment. */
  didNotFinish: number;
  /** Shown in the tooltip only; it is the agent's own action. */
  cancelled: number;
  running: number;
}

/**
 * One bucket per UTC day in the range, INCLUDING empty days. Bucketed on the
 * UTC day of `started_at` by slicing the ISO string, so an attempt still open
 * lands on the day it started.
 */
export function bucketSubmissionsByDay(subs: Submission[], range: PeriodRange): SubmissionDayBucket[] {
  const byDay = new Map<string, Submission[]>();
  for (const day of daysInRange(range)) byDay.set(day, []);
  for (const s of subs) {
    const bucket = byDay.get(s.startedAtIso.slice(0, 10));
    if (bucket) bucket.push(s);
  }
  return [...byDay.entries()].map(([dayIso, day]) => {
    const by = (st: SubmissionStatus) => day.filter((x) => x.status === st).length;
    return {
      dayIso,
      dayLabel: formatDayLabel(dayIso),
      attempts: day.length,
      committed: by('committed'),
      failed: by('failed') + by('unconfirmed'),
      didNotFinish: by('abandoned') + by('stalled'),
      cancelled: by('cancelled'),
      running: by('running'),
    };
  });
}

export function attemptsTooltipLines(b: SubmissionDayBucket): string[] {
  if (b.attempts === 0) return [b.dayLabel, 'No submit attempts'];
  return [b.dayLabel, `${b.attempts} ${b.attempts === 1 ? 'attempt' : 'attempts'} · ${b.committed} committed`];
}

export function failureTooltipLines(b: SubmissionDayBucket): string[] {
  if (b.attempts === 0) return [b.dayLabel, 'No submit attempts'];
  return [
    b.dayLabel,
    `${b.failed} failed or unknown · ${b.didNotFinish} did not finish or stalled`,
    `${b.cancelled} cancelled · ${b.committed} committed`,
  ];
}
