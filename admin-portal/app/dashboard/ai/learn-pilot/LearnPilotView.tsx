'use client';

/**
 * Learn pilot — the page body (BACKLOG-4219). Read-only; renders the model page.tsx built on the
 * server (lib/learn-pilot/group.ts). One summary table, one row per pilot user per org, showing
 * that user's newest-submitted report; "Details" opens the user's full table (one column per
 * sender-rules version, ascending, with the change from the column to its left) in a dialog.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  AlertBanner,
  AlertBannerDescription,
  AlertBannerTitle,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  EmptyState,
  FilterBar,
  Input,
  Label,
  SortableTh,
  useSortState,
} from '@keepr/ui';
import { InfoTip } from '@/components/shared/InfoTip';
import { formatDate } from '@/lib/format';
import { compactCellText, defaultDirectionFor, markText, matchesQuery, sortSummary, summaryRows, type SummaryKey, type SummaryRow } from '@/lib/learn-pilot/summary';
import { TIPS } from '@/lib/learn-pilot/tips';
import type { Cell, Change, MetricRow, OrgGroup, PilotViewModel, UserGroup, VersionColumn } from '@/lib/learn-pilot/types';
import { wilsonInterval } from '@/lib/learn-pilot/wilson';

export interface LearnPilotViewProps {
  model: PilotViewModel;
}

export const EMPTY_TEXT = 'No pilot reports yet.';
export const TRUNCATED_TEXT = 'Showing the newest 200.';
export const NO_MATCH_TEXT = 'No pilot user matches this search.';
export const SEARCH_LABEL = 'Find a user (name, id or org)';

const signed = (d: number) => (d > 0 ? `+${d}` : d < 0 ? `−${-d}` : '0');

export function cellText(cell: Cell): string {
  if (!cell) return '—';
  if (cell.kind === 'count') return String(cell.value);
  const w = wilsonInterval(cell.k, cell.n);
  if (!w) return `${cell.k}/${cell.n}, no data`;
  return `${cell.k}/${cell.n} · ${w.rate}% (${w.low}–${w.high})`;
}

export function changeText(c: Change): string | null {
  if (!c) return null;
  if (c.kind === 'count') return signed(c.d);
  return `${signed(c.dk)} / ${signed(c.dn)}`;
}

function ColumnHeader({ col }: { col: VersionColumn }) {
  return (
    <th scope="col" className="px-3 py-2 text-left align-bottom font-medium text-gray-900" data-testid="version-column">
      <div>v{col.version}</div>
      <div className="text-xs font-normal text-gray-600" data-testid="version-mark">
        {markText(col)}
      </div>
      <div className="text-xs font-normal text-gray-500">
        {formatDate(col.submittedAt)}
        {col.appVersion ? ` · app ${col.appVersion}` : ''}
      </div>
    </th>
  );
}

function Row({ row }: { row: MetricRow }) {
  return (
    <tr className="border-t border-gray-100" data-testid={`metric-${row.id}`}>
      <th scope="row" className="px-3 py-1.5 text-left font-normal text-gray-700 whitespace-nowrap">
        {row.label}
      </th>
      {row.cells.map((cell, i) => {
        const change = changeText(row.changes[i]);
        return (
          <td key={i} className="px-3 py-1.5 tabular-nums text-gray-900 whitespace-nowrap" data-testid="metric-cell">
            <div>{cellText(cell)}</div>
            {change !== null && (
              <div className="text-xs text-gray-500" data-testid="metric-change">
                {change}
              </div>
            )}
          </td>
        );
      })}
    </tr>
  );
}

function UserTable({ user }: { user: UserGroup }) {
  const sections: { name: string; rows: MetricRow[] }[] = [];
  for (const r of user.rows) {
    const last = sections[sections.length - 1];
    if (last && last.name === r.section) last.rows.push(r);
    else sections.push({ name: r.section, rows: [r] });
  }
  return (
    <section className="space-y-2" data-testid="pilot-user">
      <h3 className="text-sm font-medium text-gray-900">
        {user.userName && (
          <>
            <span data-testid="pilot-user-name">{user.userName}</span>
            {' · '}
          </>
        )}
        <Link href={`/dashboard/users/${user.userId}`} className="font-mono text-xs text-primary-700 hover:underline" data-testid="pilot-user-id">
          {user.userId}
        </Link>
      </h3>
      <div className="overflow-x-auto rounded-md border border-gray-200">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th scope="col" className="px-3 py-2 text-left font-medium text-gray-500">
                Version
              </th>
              {user.columns.map((col) => (
                <ColumnHeader key={col.version} col={col} />
              ))}
            </tr>
          </thead>
          {sections.map((s) => (
            <tbody key={s.name}>
              <tr className="bg-gray-50/60">
                <th scope="colgroup" colSpan={user.columns.length + 1} className="px-3 pt-3 pb-1 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                  {s.name}
                </th>
              </tr>
              {s.rows.map((r) => (
                <Row key={r.id} row={r} />
              ))}
            </tbody>
          ))}
        </table>
      </div>
    </section>
  );
}

function pinText(pin: OrgGroup['pin']): string {
  return pin ? `Testing v${pin.version} since ${formatDate(pin.since)}.` : 'On the released rules.';
}

const COLUMNS: { key: SummaryKey; label: string; align: 'left' | 'right' }[] = [
  { key: 'name', label: 'Name', align: 'left' },
  { key: 'userId', label: 'Keepr user id', align: 'left' },
  { key: 'org', label: 'Org', align: 'left' },
  { key: 'version', label: 'Rules version', align: 'left' },
  { key: 'recall', label: 'Deals found', align: 'right' },
  { key: 'recallYes', label: 'Deals found incl. Yes', align: 'right' },
  { key: 'precision', label: 'Shown deals that are real', align: 'right' },
  { key: 'knownWrong', label: 'Known wrong', align: 'right' },
  { key: 'lastReport', label: 'Last report', align: 'left' },
];

const NUM_CELL = 'whitespace-nowrap py-2 px-3 text-right tabular-nums text-gray-700';

function SummaryTableRow({ row, onOpen }: { row: SummaryRow; onOpen: (key: string) => void }) {
  const { user, column } = row;
  return (
    <tr className="border-b border-gray-100 last:border-0 hover:bg-gray-50" data-testid="pilot-summary-row" data-row-key={row.key}>
      <th scope="row" className="py-2 px-3 text-left font-normal text-gray-900" data-cell="name">
        {user.userName ?? ''}
      </th>
      <td className="whitespace-nowrap py-2 px-3" data-cell="user-id">
        <Link href={`/dashboard/users/${user.userId}`} className="font-mono text-xs text-primary-700 hover:underline">
          {user.userId}
        </Link>
      </td>
      <td className="py-2 px-3 text-gray-700" data-cell="org">
        {row.orgName}
      </td>
      <td className="whitespace-nowrap py-2 px-3 text-gray-700" data-cell="version">
        <div>v{column.version}</div>
        <div className="text-xs text-gray-500">{markText(column)}</div>
      </td>
      <td className={NUM_CELL} data-cell="recall">
        {compactCellText(row.recall)}
      </td>
      <td className={NUM_CELL} data-cell="recall-yes">
        {compactCellText(row.recallYes)}
      </td>
      <td className={NUM_CELL} data-cell="precision">
        {compactCellText(row.precision)}
      </td>
      <td className={NUM_CELL} data-cell="known-wrong">
        {compactCellText(row.knownWrong)}
      </td>
      <td className="whitespace-nowrap py-2 px-3 text-gray-700" data-cell="last-report">
        {formatDate(column.submittedAt)}
      </td>
      <td className="whitespace-nowrap py-2 px-3 text-right">
        <Button size="sm" variant="ghost" aria-haspopup="dialog" aria-label={`Details for ${user.userName ? `${user.userName}, ` : ''}${user.userId}`} onClick={() => onOpen(row.key)}>
          Details
        </Button>
      </td>
    </tr>
  );
}

function PilotSummaryTable({ orgs }: { orgs: OrgGroup[] }) {
  const all = useMemo(() => summaryRows(orgs), [orgs]);
  const [query, setQuery] = useState('');
  const [openKey, setOpenKey] = useState<string | null>(null);
  const { sortKey, sortDirection, onSort } = useSortState<SummaryKey>({ initialKey: 'lastReport', defaultDirectionFor });
  const visible = useMemo(() => sortSummary(all.filter((r) => matchesQuery(r, query)), sortKey, sortDirection), [all, query, sortKey, sortDirection]);
  const open = openKey === null ? undefined : all.find((r) => r.key === openKey);
  const clear = () => setQuery('');

  return (
    <div className="space-y-3">
      <FilterBar hasFilters={query.trim() !== ''} onClear={clear} clearLabel="Clear search">
        <div className="flex items-center gap-2">
          <Label htmlFor="pilot-user-search">{SEARCH_LABEL}</Label>
          <Input id="pilot-user-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} className="h-8 w-64" />
        </div>
      </FilterBar>
      <p role="status" className="text-sm text-gray-500" data-testid="pilot-summary-count">
        Showing {visible.length} of {all.length}
      </p>
      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white shadow-sm">
        <table className="w-full text-sm" data-testid="pilot-summary-table">
          <caption className="sr-only">Pilot users, one row each</caption>
          <thead>
            <tr className="border-b border-gray-200">
              {COLUMNS.map((c) => (
                <SortableTh key={c.key} sortKey={c.key} activeKey={sortKey} direction={sortDirection} onSort={onSort} align={c.align} className="whitespace-nowrap">
                  {c.label}
                </SortableTh>
              ))}
              <th scope="col" className="py-2 px-3">
                <span className="sr-only">Details</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <SummaryTableRow key={r.key} row={r} onOpen={setOpenKey} />
            ))}
          </tbody>
        </table>
        {visible.length === 0 && (
          <EmptyState
            card={false}
            data-testid="pilot-summary-no-match"
            title={NO_MATCH_TEXT}
            action={
              <Button variant="ghost" size="sm" onClick={clear}>
                Clear search
              </Button>
            }
          />
        )}
      </div>
      {open && (
        <Dialog open onOpenChange={(o) => !o && setOpenKey(null)}>
          <DialogContent className="max-w-6xl max-h-[85vh] overflow-auto">
            <DialogHeader>
              <DialogTitle data-testid="pilot-dialog-title" data-user-id={open.user.userId}>
                {open.user.userName ? `${open.user.userName} · ${open.user.userId}` : open.user.userId}
              </DialogTitle>
              <DialogDescription>
                {open.orgName}. <span data-testid="pilot-org-pin">{pinText(open.pin)}</span>
              </DialogDescription>
            </DialogHeader>
            <UserTable user={open.user} />
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

export function LearnPilotView({ model }: LearnPilotViewProps) {
  if (!model.ok) {
    return (
      <AlertBanner variant="destructive" data-testid="learn-pilot-unreadable">
        <AlertBannerTitle>{model.message}</AlertBannerTitle>
        <AlertBannerDescription>Nothing is shown until they can be read.</AlertBannerDescription>
      </AlertBanner>
    );
  }
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-gray-600">
        <span className="inline-flex items-center gap-1">
          About this page <InfoTip label="this page" text={TIPS.page} />
        </span>
        <span className="inline-flex items-center gap-1">
          Version marks <InfoTip label="version marks" text={TIPS.mark} />
        </span>
        <span className="inline-flex items-center gap-1">
          Changes <InfoTip label="changes" text={TIPS.change} />
        </span>
        <span className="inline-flex items-center gap-1">
          Ranges <InfoTip label="ranges" text={TIPS.interval} />
        </span>
        <span className="inline-flex items-center gap-1">
          Mailbox counts <InfoTip label="mailbox counts" text={TIPS.census} />
        </span>
      </div>
      {model.truncated && (
        <p className="text-sm text-gray-500" data-testid="learn-pilot-truncated">
          {TRUNCATED_TEXT}
        </p>
      )}
      {model.orgs.length === 0 ? <EmptyState data-testid="learn-pilot-empty" title={EMPTY_TEXT} /> : <PilotSummaryTable orgs={model.orgs} />}
    </div>
  );
}
