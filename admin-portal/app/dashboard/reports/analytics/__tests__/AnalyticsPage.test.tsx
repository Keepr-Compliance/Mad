// @vitest-environment jsdom

/**
 * Analytics report — page wiring (BACKLOG-3723, PLAN T6). Renders the async
 * server page with a mocked authenticated client (the behaving stub), so these
 * prove page.tsx resolves the period, runs the reads and passes every
 * section's `failed` through — not just that the report component can render.
 */

import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { NOW } from '@/lib/reports/__tests__/analytics.fixture';
import type { StubCall, StubOptions } from '@/lib/reports/__tests__/postgrest-stub';

const db = vi.hoisted(() => ({ opts: {} as StubOptions, calls: [] as StubCall[] }));

vi.mock('../components/VersionChart', () => ({ VersionChart: () => <div data-chart="versions" /> }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/dashboard/reports/analytics',
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
vi.mock('@/lib/supabase/server', async () => {
  const { stubClient } = await import('@/lib/reports/__tests__/postgrest-stub');
  const { TABLES } = await import('@/lib/reports/__tests__/analytics.fixture');
  return {
    getAuthenticatedUser: async () => {
      const { client, calls } = stubClient(TABLES, db.opts);
      db.calls = calls;
      const roles = { select: () => ({ eq: () => ({ single: async () => ({ data: { role_id: 'r1' }, error: null }) }) }) };
      return {
        user: { id: 'u-1' },
        supabase: {
          rpc: async () => ({ data: true, error: null }),
          from: (table: string) => (table === 'internal_roles' ? roles : client.from(table)),
        },
      };
    },
  };
});

import AnalyticsPage from '@/app/dashboard/reports/analytics/page';

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterAll(() => {
  vi.useRealTimers();
});

afterEach(() => {
  cleanup();
  db.opts = {};
});

async function renderPage(search: Record<string, string> = {}) {
  render(await AnalyticsPage({ searchParams: Promise.resolve(search) }));
  return document.body.innerHTML;
}

const tile = (markup: string, key: string) => markup.match(new RegExp(`data-tile-value="${key}"[^>]*>([^<]+)<`))?.[1];

describe('T6 page wiring', () => {
  it('keeps the Analytics heading and adds an All reports link', async () => {
    const m = await renderPage();
    expect(m).toContain('>Analytics<');
    expect(m).toContain('href="/dashboard/reports"');
  });

  it('a devices read error reaches the page as banners, not empty text or zeros', async () => {
    db.opts = { failTables: ['devices'] };
    const m = await renderPage();
    expect(m).toContain('data-banner="versions-failed"');
    expect(m).toContain('data-banner="platform-failed"');
    expect(m).toContain('data-banner="counts-failed"');
    expect(m).not.toContain('No device data available');
    expect(tile(m, 'active_users')).toBe('—');
    expect(tile(m, 'total_users')).toBe('9');
  });

  it('prefs and members errors reach the page', async () => {
    db.opts = { failTables: ['user_preferences', 'organization_members'] };
    const m = await renderPage();
    expect(m).toContain('data-banner="phone-failed"');
    expect(m).toContain('data-banner="license-failed"');
    expect(m).not.toContain('data-banner="versions-failed"');
  });

  it('?period=7 drives the tiles; a crafted custom URL is 30 days; all has no gte', async () => {
    let m = await renderPage({ period: '7' });
    expect(tile(m, 'active_users')).toBe('4');
    expect(tile(m, 'active_devices')).toBe('6');
    cleanup();
    m = await renderPage({ period: 'custom', from: '2026-01-01', to: '2026-01-02' });
    expect(m).toContain('Last 30 days');
    cleanup();
    await renderPage({ period: 'all' });
    expect(db.calls.filter((c) => c.method === 'gte')).toEqual([]);
  });
});
