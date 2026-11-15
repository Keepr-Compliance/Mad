/**
 * Learn pilot — turn admin-list rows into the page's view model (BACKLOG-4219). Pure.
 *
 * Runs on the server (page.tsx), so the org ids and canary-org ids in the rows never reach the
 * browser. Layout (plan v2 §6, SR delta D4):
 *   - grouped by org (orgs ordered by their newest report), then by Keepr user id;
 *   - per user, one column per sender-rules version, ascending by VERSION (not by submit time:
 *     a user can move down a version as well as up);
 *   - each column marked from its own row's version fields, never from the org's current pin
 *     (the pin is gone after a release, the mark must stay);
 *   - each cell after the first carries the change from the column to its left.
 */

import { SIGNAL_LABELS } from '@/lib/sender-rules/labels';
import { SIGNALS } from '@/lib/sender-rules/types';
import type { AdminListRow, Cell, Change, MetricRow, OrgGroup, PilotViewModel, UserGroup, VersionColumn, VersionMark, AdminListResult } from './types';

export const MARK_LABELS: Record<VersionMark, string> = {
  released: 'Released',
  'test-this-org': 'Test for this org',
  'test-other-org': 'Test for another org',
  unknown: 'Unknown to the server',
};

export const UNKNOWN_ORG = 'Unknown organization';

/** Precedence: a test for this org, then released true / false; no server row is unknown. */
export function versionMark(row: Pick<AdminListRow, 'version_was_canary_for_this_org' | 'version_released'>): VersionMark {
  if (row.version_was_canary_for_this_org) return 'test-this-org';
  if (row.version_released === true) return 'released';
  if (row.version_released === false) return 'test-other-org';
  return 'unknown';
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

function at(obj: unknown, ...path: (string | number)[]): unknown {
  let cur: unknown = obj;
  for (const p of path) {
    if (Array.isArray(cur) && typeof p === 'number') cur = cur[p];
    else if (isObject(cur) && typeof p === 'string') cur = cur[p];
    else return undefined;
  }
  return cur;
}

function kn(v: unknown): Cell {
  return isObject(v) && isCount(v.k) && isCount(v.n) ? { kind: 'kn', k: v.k, n: v.n } : null;
}
function count(v: unknown): Cell {
  return isCount(v) ? { kind: 'count', value: v } : null;
}

export function change(prev: Cell, cur: Cell): Change {
  if (!prev || !cur || prev.kind !== cur.kind) return null;
  if (prev.kind === 'kn' && cur.kind === 'kn') return { kind: 'kn', dk: cur.k - prev.k, dn: cur.n - prev.n };
  if (prev.kind === 'count' && cur.kind === 'count') return { kind: 'count', d: cur.value - prev.value };
  return null;
}

type Pick1 = (report: Record<string, unknown>) => Cell;

const SCORE_ROWS: { id: string; label: string; pick: Pick1 }[] = [
  { id: 'recall', label: 'Recall', pick: (r) => kn(r.recall) },
  { id: 'recall_with_cleanup_yes', label: 'Recall, cleanup yes counted', pick: (r) => kn(r.recall_with_cleanup_yes) },
  { id: 'precision_before_cleanup', label: 'Precision before cleanup', pick: (r) => kn(r.precision_before_cleanup) },
  { id: 'precision_after_cleanup', label: 'Precision after cleanup', pick: (r) => kn(r.precision_after_cleanup) },
];

const DETECTION_ROWS: { id: string; label: string; pick: Pick1 }[] = [
  { id: 'detections', label: 'Detections', pick: (r) => count(r.detections) },
  { id: 'true_detections', label: 'True detections', pick: (r) => count(r.true_detections) },
  { id: 'known_wrong', label: 'Known wrong', pick: (r) => count(r.known_wrong) },
];

const CENSUS_BLOCKS: { key: string; label: string }[] = [
  { key: 'learn_questions', label: 'Learn questions' },
  { key: 'detector', label: 'Deal detection' },
];

const PROVIDER_LABELS: Record<string, string> = { gmail: 'Gmail', outlook: 'Outlook' };

function mailboxes(report: Record<string, unknown>, block: string): Record<string, unknown>[] {
  const list = at(report, 'census', block, 'mailboxes');
  return Array.isArray(list) ? list.filter(isObject) : [];
}

function mailboxByOrdinal(report: Record<string, unknown>, block: string, ordinal: number): Record<string, unknown> | undefined {
  return mailboxes(report, block).find((m) => m.ordinal === ordinal);
}

/** The metric rows of one user's table, given that user's reports in column order. */
export function metricRows(reports: Record<string, unknown>[]): MetricRow[] {
  const rows: MetricRow[] = [];
  const push = (id: string, section: string, label: string, pick: Pick1) => {
    const cells = reports.map(pick);
    const changes = cells.map((c, i) => (i === 0 ? null : change(cells[i - 1], c)));
    rows.push({ id, section, label, cells, changes });
  };

  for (const r of SCORE_ROWS) push(r.id, 'Scores', r.label, r.pick);
  for (const r of DETECTION_ROWS) push(r.id, 'Detections', r.label, r.pick);

  for (const block of CENSUS_BLOCKS) {
    const ordinals = Array.from(
      new Set(reports.flatMap((rep) => mailboxes(rep, block.key).map((m) => m.ordinal).filter((o): o is number => typeof o === 'number'))),
    ).sort((a, b) => a - b);
    for (const ord of ordinals) {
      const providerRaw = reports.map((rep) => mailboxByOrdinal(rep, block.key, ord)?.provider).find((p) => typeof p === 'string');
      const provider = typeof providerRaw === 'string' ? (PROVIDER_LABELS[providerRaw] ?? providerRaw) : null;
      const section = `${block.label}: mailbox ${ord}${provider ? ` (${provider})` : ''}`;
      push(`${block.key}.${ord}.hidden`, section, 'Would hide', (rep) => {
        const m = mailboxByOrdinal(rep, block.key, ord);
        return m && isCount(at(m, 'full', 'k')) && isCount(m.n) ? { kind: 'kn', k: at(m, 'full', 'k') as number, n: m.n as number } : null;
      });
      for (const s of SIGNALS) {
        push(`${block.key}.${ord}.${s}`, section, SIGNAL_LABELS[s], (rep) => count(at(mailboxByOrdinal(rep, block.key, ord), 'full', 'by_signal', s)));
      }
    }
    push(`${block.key}.bulk_caught`, block.label, 'Bulk sample caught', (rep) => kn(at(rep, 'census', block.key, 'bulk_caught')));
    push(`${block.key}.real_estate_suppressed`, block.label, 'Real-estate mail hidden', (rep) => kn(at(rep, 'census', block.key, 'real_estate_suppressed')));
  }
  return rows;
}

function column(row: AdminListRow): VersionColumn {
  return {
    version: row.sender_rules_version,
    submittedAt: row.submitted_at,
    appVersion: row.app_version,
    mark: versionMark(row),
    bundled: row.version_bundled === true,
  };
}

const time = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
};
const newest = (rows: AdminListRow[]) => Math.max(...rows.map((r) => time(r.submitted_at)));
const byNewestDesc = <T extends { rows: AdminListRow[] }>(a: T, b: T) => newest(b.rows) - newest(a.rows);

function groupBy(rows: AdminListRow[], key: (r: AdminListRow) => string): AdminListRow[][] {
  const m = new Map<string, AdminListRow[]>();
  for (const r of rows) {
    const k = key(r);
    const list = m.get(k);
    if (list) list.push(r);
    else m.set(k, [r]);
  }
  return Array.from(m.values());
}

function userGroup(rows: AdminListRow[]): UserGroup {
  const sorted = [...rows].sort((a, b) => a.sender_rules_version - b.sender_rules_version);
  return {
    userId: sorted[0].user_id,
    userName: sorted.map((r) => r.user_name).find((n): n is string => typeof n === 'string' && n.length > 0) ?? null,
    columns: sorted.map(column),
    rows: metricRows(sorted.map((r) => r.report)),
  };
}

function orgGroup(rows: AdminListRow[]): OrgGroup {
  const first = rows[0];
  const users = groupBy(rows, (r) => r.user_id)
    .map((g) => ({ rows: g }))
    .sort(byNewestDesc)
    .map((g) => userGroup(g.rows));
  return {
    name: first.org_name ?? UNKNOWN_ORG,
    pin: first.org_current_pin_version === null ? null : { version: first.org_current_pin_version, since: first.org_current_pin_at },
    users,
  };
}

/** The whole page's model. Org ids are used to group here and are not copied out. */
export function buildViewModel(list: AdminListResult): PilotViewModel {
  if (!list.ok) return { ok: false, message: list.message };
  const orgs = groupBy(list.rows, (r) => r.org_id)
    .map((g) => ({ rows: g }))
    .sort(byNewestDesc)
    .map((g) => orgGroup(g.rows));
  return { ok: true, truncated: list.truncated, orgs };
}
