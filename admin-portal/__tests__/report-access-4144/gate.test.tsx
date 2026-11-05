/**
 * BACKLOG-4144 G1-G3: every report page and the Reports index go through the per-report gate.
 *
 * Behavioural, not a text guard: each page's default export is CALLED with the cookie client
 * stubbed. `report_my_access` answers only for the key the test grants; `has_permission` always
 * answers true, so a page that went back to the old analytics.view check would open without report
 * access and turn these red.
 *
 * Registry-driven: the page set is the registry, and it must equal the folders on disk.
 */

import { readdirSync, existsSync } from 'fs';
import path from 'path';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  access: {} as Record<string, string>,
  accessError: false,
  list: [] as unknown,
  listError: null as null | { code: string; message: string },
  rpcCalls: [] as { fn: string; args: unknown }[],
  tables: [] as string[],
}));

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard/reports',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));

/** Any chain of query-builder calls; awaiting it reads an empty, successful result. */
function emptyQuery(single: unknown = null): unknown {
  const result = { data: [], error: null, count: 0 };
  const proxy: unknown = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(result);
      if (prop === 'single' || prop === 'maybeSingle') return async () => ({ data: single, error: null });
      return () => proxy;
    },
    apply: () => proxy,
  });
  return proxy;
}

vi.mock('@/lib/supabase/server', () => ({
  getAuthenticatedUser: async () => ({
    user: { id: 'user-test' },
    supabase: {
      rpc: async (fn: string, args?: Record<string, unknown>) => {
        state.rpcCalls.push({ fn, args });
        if (fn === 'report_my_access') {
          if (state.accessError) return { data: null, error: { code: 'PGRST202', message: 'no such function' } };
          return { data: state.access[String(args?.p_key)] ?? null, error: null };
        }
        if (fn === 'report_list_my_reports') {
          return state.listError ? { data: null, error: state.listError } : { data: state.list, error: null };
        }
        if (fn === 'has_permission') return { data: true, error: null };
        return { data: [], error: null };
      },
      from: (table: string) => {
        state.tables.push(table);
        return emptyQuery(table === 'internal_roles' ? { role_id: 'role-test' } : null);
      },
    },
  }),
}));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ rpc: async () => ({ data: [], error: null }) }) }));

import { REPORTS } from '@/lib/reports/registry';
import { ReportAccessProvider } from '@/lib/reports/report-access-context';
import ReportsIndexPage from '@/app/dashboard/reports/page';

type Page = (props: { searchParams: Promise<Record<string, string>> }) => Promise<ReactNode>;

// One loader per registered report. The completeness tests below fail if the registry or the
// folders gain a report that is not listed here.
const PAGES: Record<string, () => Promise<{ default: Page }>> = {
  analytics: () => import('@/app/dashboard/reports/analytics/page') as never,
  'iphone-sync': () => import('@/app/dashboard/reports/iphone-sync/page') as never,
  'google-messages-sync': () => import('@/app/dashboard/reports/google-messages-sync/page') as never,
  'email-precache': () => import('@/app/dashboard/reports/email-precache/page') as never,
  submissions: () => import('@/app/dashboard/reports/submissions/page') as never,
  exports: () => import('@/app/dashboard/reports/exports/page') as never,
  'support-sla': () => import('@/app/dashboard/reports/support-sla/page') as never,
  'user-activity': () => import('@/app/dashboard/reports/user-activity/page') as never,
  funnel: () => import('@/app/dashboard/reports/funnel/page') as never,
};

const SLUGS = REPORTS.map((r) => r.slug);
const REPORTS_DIR = path.resolve(__dirname, '../../app/dashboard/reports');

async function callPage(slug: string): Promise<{ result?: ReactNode; error?: Error }> {
  const Page = (await PAGES[slug]()).default;
  try {
    return { result: await Page({ searchParams: Promise.resolve({}) }) };
  } catch (error) {
    return { error: error as Error };
  }
}

const accessCalls = () => state.rpcCalls.filter((c) => c.fn === 'report_my_access').map((c) => c.args);

beforeEach(() => {
  state.access = {};
  state.accessError = false;
  state.list = [];
  state.listError = null;
  state.rpcCalls = [];
  state.tables = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('the page set is the registry', () => {
  it('9 registered reports, one loader each', () => {
    expect(SLUGS).toHaveLength(9);
    expect(Object.keys(PAGES).sort()).toEqual([...SLUGS].sort());
  });

  it('every report folder on disk is registered', () => {
    const dirs = readdirSync(REPORTS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(path.join(REPORTS_DIR, d.name, 'page.tsx')))
      .map((d) => d.name);
    expect(dirs.sort()).toEqual([...SLUGS].sort());
  });
});

describe('G1 each page asks report_my_access for ITS OWN key and opens with it', () => {
  it.each(SLUGS)('%s', async (slug) => {
    state.access = { [slug]: 'viewer' };
    const { result, error } = await callPage(slug);
    expect(error?.message).not.toBe('NOT_FOUND');
    expect(accessCalls()).toEqual([{ p_key: slug }]);
    expect(state.rpcCalls.map((c) => c.fn)).not.toContain('has_permission');
    // The browser side gets the same key and the access the server answered.
    expect(isValidElement(result)).toBe(true);
    const el = result as ReactElement<{ reportKey: string; access: string }>;
    expect(el.type).toBe(ReportAccessProvider);
    expect(el.props).toMatchObject({ reportKey: slug, access: 'viewer' });
  });
});

describe('G2 no access is a 404, not a redirect, and reads no report data', () => {
  it.each(SLUGS)('%s with no access', async (slug) => {
    const { error } = await callPage(slug);
    expect(error?.message).toBe('NOT_FOUND');
    expect(state.tables).toEqual(['internal_roles']);
    expect(state.rpcCalls.map((c) => c.fn)).toEqual(['report_my_access']);
  });

  it.each(SLUGS)('%s with access to every OTHER report only', async (slug) => {
    state.access = Object.fromEntries(SLUGS.filter((s) => s !== slug).map((s) => [s, 'owner']));
    const { error } = await callPage(slug);
    expect(error?.message).toBe('NOT_FOUND');
  });

  it('an unreadable answer (function missing) is a 404 too', async () => {
    state.accessError = true;
    expect((await callPage('funnel')).error?.message).toBe('NOT_FOUND');
  });
});

describe('G3 the index lists only report_list_my_reports', () => {
  async function callIndex() {
    try {
      return { result: (await ReportsIndexPage({ searchParams: Promise.resolve({}) })) as ReactElement<{ reports: { slug: string }[] }> };
    } catch (error) {
      return { error: error as Error };
    }
  }

  it('lists exactly my reports, in registry order', async () => {
    state.list = [
      { report_key: 'funnel', access: 'viewer' },
      { report_key: 'exports', access: 'editor' },
    ];
    const { result } = await callIndex();
    expect(result!.props.reports.map((r) => r.slug)).toEqual(['exports', 'funnel']);
    expect(state.rpcCalls.map((c) => c.fn)).toEqual(['report_list_my_reports']);
  });

  it('an owner list shows all 8', async () => {
    state.list = SLUGS.map((s) => ({ report_key: s, access: 'owner' }));
    expect((await callIndex()).result!.props.reports.map((r) => r.slug)).toEqual(SLUGS);
  });

  it('an empty list is a 404', async () => {
    expect((await callIndex()).error?.message).toBe('NOT_FOUND');
  });

  // PostgREST always sets a code. A missing function (PGRST202) must not fall back to listing
  // every report; neither may any other refusal.
  it.each([
    { code: 'PGRST202', message: 'Could not find the function' },
    { code: '42501', message: 'Access denied' },
  ])('a list that cannot be read ($code) is a 404', async (err) => {
    state.listError = err;
    state.list = SLUGS.map((s) => ({ report_key: s, access: 'owner' }));
    expect((await callIndex()).error?.message).toBe('NOT_FOUND');
  });
});
