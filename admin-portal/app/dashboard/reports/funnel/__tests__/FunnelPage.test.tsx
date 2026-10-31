// @vitest-environment jsdom

/**
 * Paywall Funnel — page wiring (BACKLOG-3722, R5). Renders the async server
 * page with a mocked authenticated client, so these prove page.tsx passes the
 * read's rows, `failed` and `truncated` through — not just that the report
 * component can render them.
 */

import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ALL_TIME_ROWS, uuid } from '@/lib/reports/__tests__/funnel.fixture';

type Mode = { kind: 'rows'; rows: Record<string, unknown>[] } | { kind: 'error' } | { kind: 'endless' };
const db = vi.hoisted(() => ({ mode: { kind: 'error' } as Mode, eventCalls: [] as string[] }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/dashboard/reports/funnel',
  useSearchParams: () => new URLSearchParams(),
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));
vi.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/lib/supabase/server', () => ({
  getAuthenticatedUser: async () => {
    const roles = { select: () => ({ eq: () => ({ single: async () => ({ data: { role_id: 'r1' }, error: null }) }) }) };
    const events = () => {
      let range: [number, number] = [0, 0];
      const b: Record<string, unknown> = {
        then(resolve: (v: unknown) => unknown) {
          const m = db.mode;
          if (m.kind === 'error') return Promise.resolve({ data: null, error: { message: 'timeout' } }).then(resolve);
          if (m.kind === 'endless') {
            const page = Array.from({ length: range[1] - range[0] + 1 }, (_, i) => ({
              id: uuid(100_000 + range[0] + i),
              event_name: 'paywall-viewed',
              user_id: uuid(1),
            }));
            return Promise.resolve({ data: page, error: null }).then(resolve);
          }
          return Promise.resolve({ data: m.rows.slice(range[0], range[1] + 1), error: null }).then(resolve);
        },
      };
      for (const k of ['select', 'in', 'gte', 'lt', 'order']) {
        b[k] = (...args: unknown[]) => {
          db.eventCalls.push(`${k}:${JSON.stringify(args)}`);
          return b;
        };
      }
      b.range = (from: number, to: number) => {
        range = [from, to];
        return b;
      };
      return b;
    };
    return {
      user: { id: 'u-1' },
      supabase: {
        rpc: async () => ({ data: true, error: null }),
        from: (table: string) => (table === 'internal_roles' ? roles : table === 'analytics_events' ? events() : null),
      },
    };
  },
}));

import FunnelPage from '@/app/dashboard/reports/funnel/page';

afterEach(() => {
  cleanup();
  db.eventCalls = [];
});

async function renderPage(search: Record<string, string> = {}) {
  render(await FunnelPage({ searchParams: Promise.resolve(search) }));
  return document.body.innerHTML;
}

const tile = (markup: string, id: string) => markup.match(new RegExp(`data-tile-value="${id}"[^>]*>(\\d+)<`))?.[1];

describe('R5 page wiring', () => {
  it('a failed analytics_events read shows the failure banner, not the empty state', async () => {
    db.mode = { kind: 'error' };
    const markup = await renderPage();
    expect(markup).toContain('data-banner="events-failed"');
    expect(markup).not.toContain('No funnel events in this range');
  });

  it('the rows read reach the tiles (computeFunnel on the paged rows)', async () => {
    db.mode = { kind: 'rows', rows: ALL_TIME_ROWS.map(({ id, event_name, user_id }) => ({ id, event_name, user_id })) };
    const markup = await renderPage({ period: 'all' });
    expect(markup).not.toContain('data-banner="events-failed"');
    expect(markup).not.toContain('data-notice="truncated"');
    expect(tile(markup, 'paywall-viewed')).toBe('14');
    expect(tile(markup, 'export-completed')).toBe('14');
    expect(db.eventCalls.filter((c) => c.startsWith('gte:'))).toEqual([]);
  });

  it('a read that hits the 20-page ceiling shows the truncation notice with the 20,000 cap', async () => {
    db.mode = { kind: 'endless' };
    const markup = await renderPage();
    expect(markup).toContain('data-notice="truncated"');
    expect(markup).toContain('at most 20000 events');
  });

  it('keeps the "Paywall Funnel" heading and an All reports link', async () => {
    db.mode = { kind: 'rows', rows: [] };
    const markup = await renderPage();
    expect(markup).toContain('Paywall Funnel');
    expect(markup).toContain('href="/dashboard/reports"');
  });
});
