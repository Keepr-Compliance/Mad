/**
 * Exports report — the pure half (BACKLOG-4004)
 *
 * No Supabase, no React. Turns `analytics_events` rows named
 * `export-completed` into one view model that the cards, the chart and both
 * tables all read.
 *
 * TWO COUNTERS, everywhere a count appears (founder ruling on BACKLOG-4004):
 * - Exports: every export-completed event, repeats included.
 * - Unique exports: distinct (user, deal) pairs, where the deal is
 *   `event_data.transaction_id`. Format is NOT part of the pair: a PDF and a
 *   folder export of the same deal by the same user are one unique export.
 *   Two users exporting the same deal are two.
 * There is no time-window rule. Both numbers come from {@link countExports}
 * and nowhere else.
 *
 * Days are UTC, the same as every other report: an event belongs to the UTC
 * calendar day of `created_at`, whatever the viewer's timezone.
 */

import { formatUtc } from './iphone-sync';
import { daysInRange, formatDayLabel, type PeriodRange } from './period';

export const EXPORT_EVENT_NAME = 'export-completed';

/** Organization filter value for a user with no membership. */
export const NO_ORG = '__none__';
/** Organization filter value when the membership lookup failed. */
export const UNKNOWN_ORG = '__unknown__';
/** User filter value for an event with no user id. */
export const UNKNOWN_USER = '__unknown__';

export const NO_ORG_LABEL = 'No organization';
export const UNKNOWN_ORG_LABEL = 'Unknown organization';
export const UNKNOWN_USER_LABEL = 'Unknown user';

// ─── Rows as the database returns them ───────────────────────────

export interface ExportEventRow {
  id: string;
  user_id: string | null;
  event_name: string;
  /** `{ transaction_id, mode, format }` as the desktop app sends it. */
  event_data: unknown;
  created_at: string;
}

export interface ExportUser {
  id: string;
  email: string | null;
  display_name: string | null;
}

export interface ExportMembership {
  user_id: string | null;
  organization_id: string;
}

export interface ExportOrg {
  id: string;
  name: string | null;
}

export interface ExportLookups {
  users: ExportUser[];
  memberships: ExportMembership[];
  orgs: ExportOrg[];
  /** A lookup query failed. Labels then read "Unknown", never "No organization". */
  failed: boolean;
}

// ─── The view model ──────────────────────────────────────────────

export interface ExportEvent {
  id: string;
  userId: string | null;
  /** The value the User filter uses. */
  userKey: string;
  userLabel: string;
  userEmail: string;
  /** The values the Organization filter uses. Never empty. */
  orgKeys: string[];
  orgLabel: string;
  dealId: string | null;
  format: string;
  mode: string;
  /** Normalised ISO string, UTC. */
  createdAtIso: string;
  /** UTC calendar day, YYYY-MM-DD. */
  dayIso: string;
  whenUtc: string;
}

export interface ExportsReportModel {
  /** Oldest first. */
  events: ExportEvent[];
  /** Organization filter key → label, for every key on any event. Plain object: crosses the server/client boundary. */
  orgNames: Record<string, string>;
  lookupFailed: boolean;
}

function readString(blob: Record<string, unknown>, key: string): string | null {
  const v = blob[key];
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

export function parseEventData(raw: unknown): { dealId: string | null; format: string; mode: string } {
  const blob =
    raw != null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    dealId: readString(blob, 'transaction_id'),
    format: readString(blob, 'format') ?? 'unknown',
    mode: readString(blob, 'mode') ?? '—',
  };
}

export function utcDay(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

export function buildExportsReport(rows: ExportEventRow[], lookups: ExportLookups): ExportsReportModel {
  const users = new Map(lookups.users.map((u) => [u.id, u]));
  const orgNames = new Map(lookups.orgs.map((o) => [o.id, o.name]));
  const orgsByUser = new Map<string, string[]>();
  for (const m of lookups.memberships) {
    if (!m.user_id) continue;
    const list = orgsByUser.get(m.user_id) ?? [];
    if (!list.includes(m.organization_id)) list.push(m.organization_id);
    orgsByUser.set(m.user_id, list);
  }

  const events: ExportEvent[] = [];
  for (const row of rows) {
    if (row.event_name !== EXPORT_EVENT_NAME) continue;
    const d = new Date(row.created_at);
    if (Number.isNaN(d.getTime())) continue;
    const createdAtIso = d.toISOString();
    const { dealId, format, mode } = parseEventData(row.event_data);
    const user = row.user_id ? users.get(row.user_id) : undefined;
    const userLabel =
      user?.display_name?.trim() || user?.email?.trim() || UNKNOWN_USER_LABEL;

    let orgKeys: string[];
    let orgLabel: string;
    if (lookups.failed) {
      orgKeys = [UNKNOWN_ORG];
      orgLabel = UNKNOWN_ORG_LABEL;
    } else {
      const ids = row.user_id ? (orgsByUser.get(row.user_id) ?? []) : [];
      if (ids.length === 0) {
        orgKeys = [NO_ORG];
        orgLabel = NO_ORG_LABEL;
      } else {
        orgKeys = [...ids].sort();
        orgLabel = orgKeys
          .map((id) => orgNames.get(id)?.trim() || UNKNOWN_ORG_LABEL)
          .sort((a, b) => a.localeCompare(b))
          .join(', ');
      }
    }

    events.push({
      id: row.id,
      userId: row.user_id,
      userKey: row.user_id ?? UNKNOWN_USER,
      userLabel,
      userEmail: user?.email ?? '',
      orgKeys,
      orgLabel,
      dealId,
      format,
      mode,
      createdAtIso,
      dayIso: createdAtIso.slice(0, 10),
      whenUtc: formatUtc(createdAtIso),
    });
  }
  events.sort((a, b) => a.createdAtIso.localeCompare(b.createdAtIso) || a.id.localeCompare(b.id));

  const names: Record<string, string> = {};
  for (const e of events) {
    for (const key of e.orgKeys) {
      if (key in names) continue;
      names[key] =
        key === NO_ORG
          ? NO_ORG_LABEL
          : key === UNKNOWN_ORG
            ? UNKNOWN_ORG_LABEL
            : orgNames.get(key)?.trim() || UNKNOWN_ORG_LABEL;
    }
  }
  return { events, orgNames: names, lookupFailed: lookups.failed };
}

// ─── THE counting rule ───────────────────────────────────────────

export interface ExportCounts {
  /** Every export, repeats included. */
  exports: number;
  /** Distinct (user, deal) pairs. */
  unique: number;
}

/**
 * The (user, deal) pair an export belongs to. An event with no deal id is its
 * own pair, so it is never merged with another and never dropped.
 */
export function uniqueKey(e: Pick<ExportEvent, 'id' | 'userKey' | 'dealId'>): string {
  return e.dealId ? `${e.userKey}|${e.dealId}` : `event|${e.id}`;
}

/** The one place both counters are computed. */
export function countExports(events: ExportEvent[]): ExportCounts {
  return { exports: events.length, unique: new Set(events.map(uniqueKey)).size };
}

/** Distinct users in a set. */
export function countUsers(events: ExportEvent[]): number {
  return new Set(events.map((e) => e.userKey)).size;
}

// ─── Formats ─────────────────────────────────────────────────────

export const KNOWN_FORMATS = ['pdf', 'folder'] as const;

export function formatLabel(format: string): string {
  if (format === 'pdf') return 'PDF';
  if (format === 'folder') return 'Folder';
  return format;
}

export interface FormatCounts {
  pdf: ExportCounts;
  folder: ExportCounts;
  /** Every format that is neither pdf nor folder. */
  other: ExportCounts;
}

export function countByFormat(events: ExportEvent[]): FormatCounts {
  return {
    pdf: countExports(events.filter((e) => e.format === 'pdf')),
    folder: countExports(events.filter((e) => e.format === 'folder')),
    other: countExports(events.filter((e) => !(KNOWN_FORMATS as readonly string[]).includes(e.format))),
  };
}

/** "pdf 5 · folder 1", by count, then name. */
export function formatSummary(events: ExportEvent[]): string {
  const counts = new Map<string, number>();
  for (const e of events) counts.set(e.format, (counts.get(e.format) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([f, n]) => `${f} ${n}`)
    .join(' · ');
}

// ─── Filters ─────────────────────────────────────────────────────

export interface ExportFilters {
  orgs: string[];
  users: string[];
  formats: string[];
  search: string;
}

export const EMPTY_EXPORT_FILTERS: ExportFilters = { orgs: [], users: [], formats: [], search: '' };

export const SEARCH_MAX = 120;

export function hasActiveFilters(f: ExportFilters): boolean {
  return f.orgs.length > 0 || f.users.length > 0 || f.formats.length > 0 || f.search.trim().length > 0;
}

export function activeFilterNames(f: ExportFilters): string[] {
  const names: string[] = [];
  if (f.orgs.length > 0) names.push(`Organization (${f.orgs.length})`);
  if (f.users.length > 0) names.push(`User (${f.users.length})`);
  if (f.formats.length > 0) names.push(`Format (${f.formats.length})`);
  if (f.search.trim().length > 0) names.push(`Search "${f.search.trim().slice(0, SEARCH_MAX)}"`);
  return names;
}

/**
 * AND across filters, ANY within one. An Organization filter keeps a user who
 * belongs to ANY selected organization; {@link NO_ORG} selects users with none.
 */
export function applyExportFilters(events: ExportEvent[], f: ExportFilters): ExportEvent[] {
  const search = f.search.trim().slice(0, SEARCH_MAX).toLowerCase();
  return events.filter((e) => {
    if (f.orgs.length > 0 && !e.orgKeys.some((k) => f.orgs.includes(k))) return false;
    if (f.users.length > 0 && !f.users.includes(e.userKey)) return false;
    if (f.formats.length > 0 && !f.formats.includes(e.format)) return false;
    if (search.length > 0) {
      const hay = `${e.userLabel} ${e.userEmail}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });
}

// ─── Per-user and per-organization rows ──────────────────────────

export type SortDirection = 'asc' | 'desc';

export interface ExportUserRow extends ExportCounts {
  key: string;
  userId: string | null;
  label: string;
  email: string;
  orgLabel: string;
  formats: string;
  firstIso: string;
  lastIso: string;
  first: string;
  last: string;
}

export function groupByUser(events: ExportEvent[]): ExportUserRow[] {
  const groups = new Map<string, ExportEvent[]>();
  for (const e of events) {
    const list = groups.get(e.userKey) ?? [];
    list.push(e);
    groups.set(e.userKey, list);
  }
  return [...groups.entries()].map(([key, list]) => {
    const sorted = [...list].sort((a, b) => a.createdAtIso.localeCompare(b.createdAtIso));
    const firstEvent = sorted[0];
    const lastEvent = sorted[sorted.length - 1];
    return {
      key,
      userId: firstEvent.userId,
      label: firstEvent.userLabel,
      email: firstEvent.userEmail,
      orgLabel: firstEvent.orgLabel,
      formats: formatSummary(sorted),
      firstIso: firstEvent.createdAtIso,
      lastIso: lastEvent.createdAtIso,
      first: firstEvent.whenUtc,
      last: lastEvent.whenUtc,
      ...countExports(sorted),
    };
  });
}

export interface ExportOrgRow extends ExportCounts {
  key: string;
  label: string;
  users: number;
}

/**
 * One row per organization. A user in two organizations counts in each, so
 * the column can sum above the card. `orgNames` is the model's key → label.
 */
export function groupByOrg(events: ExportEvent[], orgNames: Record<string, string>): ExportOrgRow[] {
  const groups = new Map<string, ExportEvent[]>();
  for (const e of events) {
    for (const key of e.orgKeys) {
      const list = groups.get(key) ?? [];
      list.push(e);
      groups.set(key, list);
    }
  }
  return [...groups.entries()].map(([key, list]) => ({
    key,
    label: orgNames[key] ?? UNKNOWN_ORG_LABEL,
    users: countUsers(list),
    ...countExports(list),
  }));
}

export type ExportUserSortKey = 'user' | 'org' | 'exports' | 'unique' | 'formats' | 'first' | 'last';
export type ExportOrgSortKey = 'org' | 'exports' | 'unique' | 'users';

export const USER_SORT_LABELS: Record<ExportUserSortKey, string> = {
  user: 'User',
  org: 'Organization',
  exports: 'Exports',
  unique: 'Unique exports',
  formats: 'Formats',
  first: 'First export',
  last: 'Last export',
};

export const ORG_SORT_LABELS: Record<ExportOrgSortKey, string> = {
  org: 'Organization',
  exports: 'Exports',
  unique: 'Unique exports',
  users: 'Users',
};

const TEXT_KEYS = new Set(['user', 'org', 'formats']);

export function defaultDirection(key: string): SortDirection {
  return TEXT_KEYS.has(key) ? 'asc' : 'desc';
}

function compare(a: string | number, b: string | number): number {
  return typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b));
}

export function sortUserRows(
  rows: ExportUserRow[],
  key: ExportUserSortKey,
  direction: SortDirection
): ExportUserRow[] {
  const pick = (r: ExportUserRow): string | number =>
    key === 'user'
      ? r.label
      : key === 'org'
        ? r.orgLabel
        : key === 'formats'
          ? r.formats
          : key === 'first'
            ? r.firstIso
            : key === 'last'
              ? r.lastIso
              : r[key];
  const sign = direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => sign * compare(pick(a), pick(b)) || a.label.localeCompare(b.label));
}

export function sortOrgRows(rows: ExportOrgRow[], key: ExportOrgSortKey, direction: SortDirection): ExportOrgRow[] {
  const pick = (r: ExportOrgRow): string | number => (key === 'org' ? r.label : r[key]);
  const sign = direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => sign * compare(pick(a), pick(b)) || a.label.localeCompare(b.label));
}

export const INITIAL_VISIBLE_ROWS = 10;
export const SHOW_MORE_STEP = 10;

// ─── Per-day chart ───────────────────────────────────────────────

export interface ExportDayBucket extends ExportCounts {
  dayIso: string;
  dayLabel: string;
  formats: string;
}

/**
 * One bucket per UTC day of the period, empty days included.
 *
 * `unique` on a day is how many (user, deal) pairs were exported for the FIRST
 * time in the period on that day — computed with {@link countExports} as the
 * difference of the running totals, so the days sum to the card exactly.
 */
export function bucketExportsByDay(events: ExportEvent[], range: PeriodRange): ExportDayBucket[] {
  const sorted = [...events].sort((a, b) => a.createdAtIso.localeCompare(b.createdAtIso));
  return daysInRange(range).map((dayIso) => {
    const day = sorted.filter((e) => e.dayIso === dayIso);
    const before = sorted.filter((e) => e.dayIso < dayIso);
    const through = sorted.filter((e) => e.dayIso <= dayIso);
    return {
      dayIso,
      dayLabel: formatDayLabel(dayIso),
      exports: countExports(day).exports,
      unique: countExports(through).unique - countExports(before).unique,
      formats: formatSummary(day),
    };
  });
}

export function exportTooltipLines(b: ExportDayBucket): string[] {
  if (b.exports === 0) return [b.dayLabel, 'No exports'];
  return [
    b.dayLabel,
    `${b.exports} ${b.exports === 1 ? 'export' : 'exports'} · ${b.unique} unique`,
    b.formats,
  ];
}

/** First eight characters of a deal id, for the drill-down. */
export function shortDeal(dealId: string | null): string {
  return dealId ? dealId.slice(0, 8) : '—';
}
