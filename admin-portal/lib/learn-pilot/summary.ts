/**
 * Learn pilot — the summary table's rows (BACKLOG-4219). Pure: no React, no Supabase.
 *
 * One row per pilot user per org (key `orgIndex:userId`, so a user who reported from two orgs is
 * two rows). Each row reads ONE column of that user's detail table: the newest-submitted report
 * (coordinator default Q2, 2026-11-12), which is not always the highest version. Every number is
 * the detail table's own cell for that column; nothing is recomputed here.
 */

import { MARK_LABELS } from './group';
import type { Cell, OrgGroup, UserGroup, VersionColumn } from './types';
import { wilsonInterval } from './wilson';

export type SummaryKey = 'name' | 'userId' | 'org' | 'version' | 'recall' | 'recallYes' | 'precision' | 'knownWrong' | 'lastReport';

export type SortDirection = 'asc' | 'desc';

export interface SummaryRow {
  /** `orgIndex:userId` — stable across sort and search. */
  key: string;
  orgName: string;
  pin: OrgGroup['pin'];
  user: UserGroup;
  /** Index into user.columns of the report this row shows. */
  col: number;
  column: VersionColumn;
  recall: Cell;
  recallYes: Cell;
  precision: Cell;
  knownWrong: Cell;
}

const TEXT_KEYS: readonly SummaryKey[] = ['name', 'userId', 'org'];

/** Numbers open descending, text ascending (the report kit's rule). */
export function defaultDirectionFor(key: SummaryKey): SortDirection {
  return TEXT_KEYS.includes(key) ? 'asc' : 'desc';
}

const time = (iso: string): number | null => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

/** The index of the user's newest-submitted column (by time, not by version). */
export function newestColumn(user: UserGroup): number {
  let best = 0;
  for (let i = 1; i < user.columns.length; i++) {
    const a = time(user.columns[i].submittedAt) ?? -Infinity;
    const b = time(user.columns[best].submittedAt) ?? -Infinity;
    if (a >= b) best = i;
  }
  return best;
}

function cellOf(user: UserGroup, rowId: string, col: number): Cell {
  return user.rows.find((r) => r.id === rowId)?.cells[col] ?? null;
}

export function summaryRows(orgs: OrgGroup[]): SummaryRow[] {
  const out: SummaryRow[] = [];
  orgs.forEach((org, orgIndex) => {
    for (const user of org.users) {
      if (user.columns.length === 0) continue;
      const col = newestColumn(user);
      out.push({
        key: `${orgIndex}:${user.userId}`,
        orgName: org.name,
        pin: org.pin,
        user,
        col,
        column: user.columns[col],
        recall: cellOf(user, 'recall', col),
        recallYes: cellOf(user, 'recall_with_cleanup_yes', col),
        precision: cellOf(user, 'precision_after_cleanup', col),
        knownWrong: cellOf(user, 'known_wrong', col),
      });
    }
  });
  return out;
}

/** The version mark, the same text the detail table's column header shows. */
export function markText(col: VersionColumn): string {
  return `${MARK_LABELS[col.mark]}${col.mark === 'released' && col.bundled ? ', bundled' : ''}`;
}

/** A k/n cell, short: "66.7% · 2/3", "no data · 0/0", "—". */
export function compactCellText(cell: Cell): string {
  if (!cell) return '—';
  if (cell.kind === 'count') return String(cell.value);
  const w = wilsonInterval(cell.k, cell.n);
  return w ? `${w.rate}% · ${cell.k}/${cell.n}` : `no data · ${cell.k}/${cell.n}`;
}

/** Trimmed, case-insensitive substring on name, Keepr user id or org name. Empty matches all. */
export function matchesQuery(row: SummaryRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  return [row.user.userName, row.user.userId, row.orgName].some((v) => typeof v === 'string' && v.toLowerCase().includes(q));
}

/** A cell's sort value: the rate (never the display string) or the count; null when there is none. */
function cellValue(cell: Cell): number | null {
  if (!cell) return null;
  if (cell.kind === 'count') return cell.value;
  return wilsonInterval(cell.k, cell.n)?.rate ?? null;
}

function value(row: SummaryRow, key: SummaryKey): number | string | null {
  switch (key) {
    case 'name':
      return row.user.userName && row.user.userName.length > 0 ? row.user.userName : null;
    case 'userId':
      return row.user.userId;
    case 'org':
      return row.orgName;
    case 'version':
      return row.column.version;
    case 'recall':
      return cellValue(row.recall);
    case 'recallYes':
      return cellValue(row.recallYes);
    case 'precision':
      return cellValue(row.precision);
    case 'knownWrong':
      return cellValue(row.knownWrong);
    case 'lastReport':
      return time(row.column.submittedAt);
  }
}

function compareValues(a: number | string, b: number | string): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { sensitivity: 'base' });
}

/** Tiebreak, always ascending: name (no name last), then Keepr user id, then row key. */
function tiebreak(a: SummaryRow, b: SummaryRow): number {
  const an = value(a, 'name');
  const bn = value(b, 'name');
  if (an !== bn) {
    if (an === null) return 1;
    if (bn === null) return -1;
    const c = compareValues(an, bn);
    if (c !== 0) return c;
  }
  if (a.user.userId !== b.user.userId) return a.user.userId < b.user.userId ? -1 : 1;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/** Missing values (no cell, n = 0, no name) sort last in BOTH directions. */
export function compareSummary(a: SummaryRow, b: SummaryRow, key: SummaryKey, direction: SortDirection): number {
  const av = value(a, key);
  const bv = value(b, key);
  if (av === null && bv !== null) return 1;
  if (bv === null && av !== null) return -1;
  if (av !== null && bv !== null) {
    const c = compareValues(av, bv);
    if (c !== 0) return direction === 'asc' ? c : -c;
  }
  return tiebreak(a, b);
}

export function sortSummary(rows: readonly SummaryRow[], key: SummaryKey, direction: SortDirection): SummaryRow[] {
  return [...rows].sort((a, b) => compareSummary(a, b, key, direction));
}
