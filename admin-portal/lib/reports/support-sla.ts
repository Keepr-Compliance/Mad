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
 */

/** Statuses that are NOT open. Deleted is also excluded from every number. */
export const OPEN_EXCLUDES = ['resolved', 'closed', 'deleted'] as const;
export const RESOLVED_STATUSES = ['resolved', 'closed'] as const;
export const DELETED_STATUS = 'deleted';

const MS_PER_MINUTE = 60000;

export const READ_FAILED_MESSAGE = 'Support tickets could not be read. The numbers below are not shown.';

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

function minutesBetween(startIso: string, endIso: string): number {
  return (Date.parse(endIso) - Date.parse(startIso)) / MS_PER_MINUTE;
}

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

function addRow(b: Bucket, row: SupportTicketRow, from: number, to: number): { created: boolean } {
  if (isOpen(row)) b.openNow += 1;
  const created = inPeriod(row.created_at, from, to);
  if (created && row.first_response_at) {
    b.firstResponse.push(minutesBetween(row.created_at, row.first_response_at));
  }
  const done = resolvedAt(row);
  if (inPeriod(done, from, to)) {
    b.resolvedInPeriod += 1;
    b.resolution.push(minutesBetween(row.created_at, done as string));
  }
  return { created };
}

/**
 * @param openNowCount exact count from the database; when null the headline
 *   falls back to the open rows that were read.
 */
export function buildSupportSlaReport(
  rows: SupportTicketRow[],
  users: SupportAgentUser[],
  period: SlaPeriod,
  openNowCount: number | null = null
): SupportSlaReport {
  const from = Date.parse(period.fromIso);
  const to = Date.parse(period.toIso);
  const usersById = new Map(users.map((u) => [u.id, u]));

  const total = emptyBucket();
  let createdInPeriod = 0;
  const byAgent = new Map<string, Bucket>();

  for (const row of rows) {
    if (row.status === DELETED_STATUS) continue;
    if (addRow(total, row, from, to).created) createdInPeriod += 1;
    if (row.assignee_id) {
      let b = byAgent.get(row.assignee_id);
      if (!b) {
        b = emptyBucket();
        byAgent.set(row.assignee_id, b);
      }
      addRow(b, row, from, to);
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
      avgFirstResponseMinutes: average(b.firstResponse),
      avgResolutionMinutes: average(b.resolution),
    };
  });

  return {
    summary: {
      openNow: openNowCount ?? total.openNow,
      createdInPeriod,
      resolvedInPeriod: total.resolvedInPeriod,
      avgFirstResponseMinutes: average(total.firstResponse),
      avgResolutionMinutes: average(total.resolution),
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
