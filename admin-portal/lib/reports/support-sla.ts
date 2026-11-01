/**
 * Support analytics — pure builder (BACKLOG-3651)
 *
 * Computes the Support Analytics numbers from `support_tickets` rows in app
 * code. Rules:
 *
 * - Deleted tickets are excluded everywhere.
 * - "Open" = status not in OPEN_EXCLUDES (so `pending` counts as open). The
 *   same list drives the exact-count query, the row prefilter and this builder.
 * - A ticket's resolved time is coalesce(resolved_at, closed_at), and only
 *   when its status is resolved or closed — a reopened ticket with a stale
 *   resolved_at is not resolved.
 * - The period is half-open [fromIso, toIso).
 * - Avg first response: tickets CREATED in the period that have a first
 *   response. Avg resolution: tickets RESOLVED in the period.
 * - Unassigned tickets count in the summary but get no agent row.
 *
 * BACKLOG-4086 adds SLA attainment on a pausing business-hours clock:
 * - With `options.settings`, every duration (averages, agent rows, median,
 *   p90) is BUSINESS minutes (lib/reports/business-hours.ts), and the summary
 *   carries first-response and resolution attainment.
 * - Attainment cohort = tickets CREATED in the period. met: the timestamp is
 *   present and within target (<=). missed: present and late, OR absent and
 *   the business time since creation already exceeds the target. awaiting:
 *   absent and still inside the target (excluded from the rate).
 * - First response = `first_response_at` only (an agent reply). A ticket
 *   resolved or closed (per resolvedAt) with no reply is MISSED immediately,
 *   whatever its age (strict); a later reply sets `first_response_at` and the
 *   ticket is then judged on time. Awaiting applies only to tickets still
 *   open with no reply and inside the target.
 * - `options` is REQUIRED. `options.settings === null` (the settings read
 *   failed): every duration and both attainments are null; counts are still
 *   computed. No code default stands in for the stored targets, and there is
 *   no calendar-minute path.
 */

import { businessMinutes, createDayCalendar, type BusinessWindow, type DayCalendar } from './business-hours';
import { median, percentileNearestRank } from './percentiles';

/** Statuses that are NOT open. Deleted is also excluded from every number. */
export const OPEN_EXCLUDES = ['resolved', 'closed', 'deleted'] as const;
export const RESOLVED_STATUSES = ['resolved', 'closed'] as const;
export const DELETED_STATUS = 'deleted';

export const READ_FAILED_MESSAGE = 'Support tickets could not be read. The numbers below are not shown.';

export const SLA_SETTINGS_READ_FAILED_MESSAGE =
  'SLA targets could not be read. Times and target rates are not shown.';

/** One row of `public.support_sla_settings`, validated (support-sla-queries.ts). */
export interface SupportSlaSettings {
  firstResponseTargetMinutes: number;
  resolutionTargetBusinessDays: number;
  businessDayStartMinute: number;
  businessDayEndMinute: number;
  /** Local weekdays, 0 = Sunday ... 6 = Saturday. */
  businessDays: number[];
  timeZone: string;
}

export interface SupportSlaOptions {
  /** null = the settings read failed: durations and attainment are not shown. */
  settings: SupportSlaSettings | null;
  /** Injected clock for the awaiting-vs-missed decision. */
  now: Date;
}

export interface SlaAttainment {
  met: number;
  missed: number;
  awaiting: number;
  /** round(100 * met / (met + missed)); null when met + missed = 0. */
  ratePct: number | null;
  targetMinutes: number;
}

export function slaWindow(settings: SupportSlaSettings): BusinessWindow {
  return {
    startMinute: settings.businessDayStartMinute,
    endMinute: settings.businessDayEndMinute,
    days: settings.businessDays,
    timeZone: settings.timeZone,
  };
}

/** Business minutes in one business day (end - start). */
export function businessDayMinutes(settings: SupportSlaSettings): number {
  return settings.businessDayEndMinute - settings.businessDayStartMinute;
}

/** Resolution target in business minutes: days x the window's length. */
export function resolutionTargetMinutes(settings: SupportSlaSettings): number {
  return settings.resolutionTargetBusinessDays * businessDayMinutes(settings);
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** "8 business hours (one working day)", "1 business hour", "90 business minutes". */
export function firstResponseTargetLabel(settings: SupportSlaSettings): string {
  const t = settings.firstResponseTargetMinutes;
  const base = t % 60 === 0 ? plural(t / 60, 'business hour') : plural(t, 'business minute');
  return t === businessDayMinutes(settings) ? `${base} (one working day)` : base;
}

/** "3 business days". */
export function resolutionTargetLabel(settings: SupportSlaSettings): string {
  return plural(settings.resolutionTargetBusinessDays, 'business day');
}

export interface SupportTicketRow {
  id: string;
  status: string;
  assignee_id: string | null;
  created_at: string;
  first_response_at: string | null;
  resolved_at: string | null;
  closed_at: string | null;
}

export interface SupportAgentUser {
  id: string;
  email: string | null;
  display_name: string | null;
  first_name: string | null;
  last_name: string | null;
}

export interface SlaPeriod {
  fromIso: string;
  toIso: string;
}

export interface SupportSlaSummary {
  openNow: number;
  createdInPeriod: number;
  resolvedInPeriod: number;
  avgFirstResponseMinutes: number | null;
  avgResolutionMinutes: number | null;
  medianFirstResponseMinutes: number | null;
  p90FirstResponseMinutes: number | null;
  medianResolutionMinutes: number | null;
  p90ResolutionMinutes: number | null;
  /** null when no settings were given or the settings read failed. */
  firstResponseSla: SlaAttainment | null;
  resolutionSla: SlaAttainment | null;
}

export interface SupportSlaAgentRow {
  agentId: string;
  name: string;
  email: string | null;
  openNow: number;
  resolvedInPeriod: number;
  avgFirstResponseMinutes: number | null;
  avgResolutionMinutes: number | null;
}

export interface SupportSlaReport {
  summary: SupportSlaSummary;
  agents: SupportSlaAgentRow[];
}

export function isOpen(row: Pick<SupportTicketRow, 'status'>): boolean {
  return !(OPEN_EXCLUDES as readonly string[]).includes(row.status);
}

/** coalesce(resolved_at, closed_at), only for resolved/closed tickets. */
export function resolvedAt(row: SupportTicketRow): string | null {
  if (!(RESOLVED_STATUSES as readonly string[]).includes(row.status)) return null;
  return row.resolved_at ?? row.closed_at;
}

function inPeriod(iso: string | null, from: number, to: number): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return t >= from && t < to;
}

type Clock = (startIso: string, endIso: string) => number;

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function agentName(user: SupportAgentUser | undefined): string {
  if (!user) return 'Unknown agent';
  const display = user.display_name?.trim();
  if (display) return display;
  const full = [user.first_name, user.last_name].filter((p) => p && p.trim()).join(' ').trim();
  if (full) return full;
  return user.email?.trim() || 'Unknown agent';
}

interface Bucket {
  openNow: number;
  resolvedInPeriod: number;
  firstResponse: number[];
  resolution: number[];
}

function emptyBucket(): Bucket {
  return { openNow: 0, resolvedInPeriod: 0, firstResponse: [], resolution: [] };
}

function addRow(b: Bucket, row: SupportTicketRow, from: number, to: number, clock: Clock): { created: boolean } {
  if (isOpen(row)) b.openNow += 1;
  const created = inPeriod(row.created_at, from, to);
  if (created && row.first_response_at) {
    b.firstResponse.push(clock(row.created_at, row.first_response_at));
  }
  const done = resolvedAt(row);
  if (inPeriod(done, from, to)) {
    b.resolvedInPeriod += 1;
    b.resolution.push(clock(row.created_at, done as string));
  }
  return { created };
}

interface Tally {
  met: number;
  missed: number;
  awaiting: number;
}

/** One ticket of the created cohort against one target. */
function tallyTarget(
  t: Tally,
  createdIso: string,
  doneIso: string | null,
  target: number,
  nowIso: string,
  cal: DayCalendar,
  missedIfUnanswered = false
): void {
  if (doneIso) {
    if (businessMinutes(createdIso, doneIso, cal) <= target) t.met += 1;
    else t.missed += 1;
  } else if (missedIfUnanswered || businessMinutes(createdIso, nowIso, cal) > target) {
    t.missed += 1;
  } else {
    t.awaiting += 1;
  }
}

function attainment(t: Tally, targetMinutes: number): SlaAttainment {
  const decided = t.met + t.missed;
  return {
    ...t,
    ratePct: decided === 0 ? null : Math.round((100 * t.met) / decided),
    targetMinutes,
  };
}

/**
 * @param openNowCount exact count from the database; when null the headline
 *   falls back to the open rows that were read.
 */
export function buildSupportSlaReport(
  rows: SupportTicketRow[],
  users: SupportAgentUser[],
  period: SlaPeriod,
  openNowCount: number | null,
  options: SupportSlaOptions
): SupportSlaReport {
  const from = Date.parse(period.fromIso);
  const to = Date.parse(period.toIso);
  const usersById = new Map(users.map((u) => [u.id, u]));

  const { settings } = options;
  // One day calendar per build, shared by every ticket.
  const cal = settings ? createDayCalendar(slaWindow(settings)) : null;
  // settings === null: the read failed, so no duration is measured or shown.
  const clock: Clock = cal ? (a, b) => businessMinutes(a, b, cal) : () => 0;
  const dur = (v: number | null) => (cal ? v : null);

  const frTarget = settings ? settings.firstResponseTargetMinutes : 0;
  const resTarget = settings ? resolutionTargetMinutes(settings) : 0;
  const nowIso = options.now.toISOString();
  const fr: Tally = { met: 0, missed: 0, awaiting: 0 };
  const res: Tally = { met: 0, missed: 0, awaiting: 0 };

  const total = emptyBucket();
  let createdInPeriod = 0;
  const byAgent = new Map<string, Bucket>();

  for (const row of rows) {
    if (row.status === DELETED_STATUS) continue;
    if (addRow(total, row, from, to, clock).created) {
      createdInPeriod += 1;
      if (cal) {
        tallyTarget(
          fr,
          row.created_at,
          row.first_response_at,
          frTarget,
          nowIso,
          cal,
          // Resolved or closed with no reply: missed regardless of age.
          resolvedAt(row) !== null
        );
        tallyTarget(res, row.created_at, resolvedAt(row), resTarget, nowIso, cal);
      }
    }
    if (row.assignee_id) {
      let b = byAgent.get(row.assignee_id);
      if (!b) {
        b = emptyBucket();
        byAgent.set(row.assignee_id, b);
      }
      addRow(b, row, from, to, clock);
    }
  }

  const agents: SupportSlaAgentRow[] = [...byAgent.entries()].map(([agentId, b]) => {
    const user = usersById.get(agentId);
    return {
      agentId,
      name: agentName(user),
      email: user?.email ?? null,
      openNow: b.openNow,
      resolvedInPeriod: b.resolvedInPeriod,
      avgFirstResponseMinutes: dur(average(b.firstResponse)),
      avgResolutionMinutes: dur(average(b.resolution)),
    };
  });

  return {
    summary: {
      openNow: openNowCount ?? total.openNow,
      createdInPeriod,
      resolvedInPeriod: total.resolvedInPeriod,
      avgFirstResponseMinutes: dur(average(total.firstResponse)),
      avgResolutionMinutes: dur(average(total.resolution)),
      medianFirstResponseMinutes: dur(median(total.firstResponse)),
      p90FirstResponseMinutes: dur(percentileNearestRank(total.firstResponse, 90)),
      medianResolutionMinutes: dur(median(total.resolution)),
      p90ResolutionMinutes: dur(percentileNearestRank(total.resolution, 90)),
      firstResponseSla: cal ? attainment(fr, frTarget) : null,
      resolutionSla: cal ? attainment(res, resTarget) : null,
    },
    agents,
  };
}

/** Last `days` days ending at `now`, half-open. */
export function lastDays(days: number, now: Date): SlaPeriod {
  const to = now.getTime();
  return { fromIso: new Date(to - days * 86400000).toISOString(), toIso: new Date(to).toISOString() };
}

export function formatDuration(minutes: number | null): string {
  if (minutes === null || minutes === 0) return '-';
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  const mins = Math.round(minutes % 60);
  if (hours < 24) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remainHours = hours % 24;
  return remainHours > 0 ? `${days}d ${remainHours}h` : `${days}d`;
}

/**
 * Business-time duration (BACKLOG-4086). Rounds the TOTAL to whole minutes
 * first, then splits; hours may exceed 24 and never roll into days (24
 * business hours is three working days, so "1d" would mislead).
 * null -> "-", 0 -> "0m", 53 -> "53m", 59.6 -> "1h", 1440 -> "24h".
 */
export function formatBusinessDuration(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes)) return '-';
  const total = Math.max(0, Math.round(minutes));
  if (total < 60) return `${total}m`;
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}
