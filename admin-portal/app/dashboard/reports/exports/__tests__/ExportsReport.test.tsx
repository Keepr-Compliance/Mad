/**
 * Exports report — render tests (BACKLOG-4004)
 *
 * Static render, no router: `ExportsReport` takes navigation as a prop.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { buildExportsReport } from '@/lib/reports/exports';
import { EXPORT_ROWS, LOOKUPS, PERIOD } from '@/lib/reports/__tests__/exports.fixture';
import { ExportsReport } from '../ExportsReport';

function html(rows = EXPORT_ROWS, lookups = LOOKUPS, truncated = false) {
  return renderToStaticMarkup(
    <ExportsReport report={buildExportsReport(rows, lookups)} period={PERIOD} rowCap={500} truncated={truncated} />
  );
}

function tile(markup: string, id: string): string | null {
  const m = markup.match(new RegExp(`data-tile-value="${id}"[^>]*>([^<]*)<`));
  return m ? m[1] : null;
}

describe('stat cards', () => {
  it('show both counters, users, and the format cards', () => {
    const out = html();
    expect(tile(out, 'exports')).toBe('11');
    expect(tile(out, 'unique')).toBe('7');
    expect(tile(out, 'users')).toBe('4');
    expect(tile(out, 'pdf')).toBe('7');
    expect(tile(out, 'folder')).toBe('3');
    expect(tile(out, 'other')).toBe('1');
    expect(out).not.toContain('Deals exported');
  });

  it('hide Other formats when there are none', () => {
    const out = html(EXPORT_ROWS.filter((r) => (r.event_data as { format: string }).format !== 'excel'));
    expect(tile(out, 'other')).toBeNull();
    expect(tile(out, 'pdf')).toBe('7');
  });
});

describe('tables and notices', () => {
  it('renders a row per user and per organization, including no organization', () => {
    const out = html();
    expect(out.match(/data-user-row=/g)).toHaveLength(4);
    expect(out).toContain('data-org-row="org-a"');
    expect(out).toContain('data-org-row="org-b"');
    expect(out).toContain('data-org-row="__none__"');
    expect(out).toContain('No organization');
  });

  it('sorts users by Exports, most first, by default', () => {
    const order = [...html().matchAll(/data-user-row="([^"]+)"/g)].map((m) => m[1]);
    expect(order).toEqual(['user-1', 'user-2', 'user-3', 'user-4']);
  });

  it('a failed lookup says Unknown organization and never No organization', () => {
    const out = html(EXPORT_ROWS, { users: [], memberships: [], orgs: [], failed: true });
    expect(out).toContain('Unknown organization');
    expect(out).not.toContain('No organization');
    expect(tile(out, 'exports')).toBe('11');
  });

  it('shows the truncation notice only when capped', () => {
    expect(html(EXPORT_ROWS, LOOKUPS, true)).toContain('data-notice="truncated"');
    expect(html()).not.toContain('data-notice="truncated"');
  });

  it('has a column for every day of the period and says days are UTC', () => {
    const out = html();
    expect(out.match(/data-day="/g)).toHaveLength(7);
    expect(out).toContain('Days are UTC.');
  });
});
