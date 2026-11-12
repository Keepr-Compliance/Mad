'use client';

/**
 * Learn pilot — the page body (BACKLOG-4219). Read-only; renders the model page.tsx built on the
 * server (lib/learn-pilot/group.ts). One card per org; per pilot user, a table with one column per
 * sender-rules version (ascending) and the change from the column to its left.
 */

import Link from 'next/link';
import { AlertBanner, AlertBannerDescription, AlertBannerTitle, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@keepr/ui';
import { InfoTip } from '@/components/shared/InfoTip';
import { formatDate } from '@/lib/format';
import { MARK_LABELS } from '@/lib/learn-pilot/group';
import { TIPS } from '@/lib/learn-pilot/tips';
import type { Cell, Change, MetricRow, OrgGroup, PilotViewModel, UserGroup, VersionColumn } from '@/lib/learn-pilot/types';
import { wilsonInterval } from '@/lib/learn-pilot/wilson';

export interface LearnPilotViewProps {
  model: PilotViewModel;
}

export const EMPTY_TEXT = 'No pilot reports yet.';
export const TRUNCATED_TEXT = 'Showing the newest 200.';

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
        {MARK_LABELS[col.mark]}
        {col.mark === 'released' && col.bundled ? ', bundled' : ''}
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

function OrgCard({ org }: { org: OrgGroup }) {
  return (
    <Card data-testid="pilot-org">
      <CardHeader>
        <CardTitle className="text-base">{org.name}</CardTitle>
        <CardDescription data-testid="pilot-org-pin">
          {org.pin ? `Testing v${org.pin.version} since ${formatDate(org.pin.since)}.` : 'On the released rules.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {org.users.map((u) => (
          <UserTable key={u.userId} user={u} />
        ))}
      </CardContent>
    </Card>
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
      {model.orgs.length === 0 ? (
        <p className="text-sm text-gray-500" data-testid="learn-pilot-empty">
          {EMPTY_TEXT}
        </p>
      ) : (
        model.orgs.map((org, i) => <OrgCard key={i} org={org} />)
      )}
    </div>
  );
}
