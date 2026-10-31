// @vitest-environment jsdom

/**
 * BACKLOG-4091 — Cards | List toggle on the Reports index.
 *
 * T1 resolver precedence (?view, then cookie, then cards; garbage = absent)
 * T2 page default + server wiring (searchParams + cookie -> initialView)
 * T3 list rows are every registry report, in registry order
 * T4 toggle writes the cookie and replaceState(view), keeps other params, no router calls
 * T5 server markup for list hydrates with zero errors (no client-side preference read)
 * T6 tablist / tabpanel / table semantics
 * T7 phone layout: overflow-x-auto table parent, Source hidden below md on th AND td,
 *    header wraps with the toggle on its own line
 * T8 card hrefs == list hrefs == REPORTS.map(reportHref)
 * T9 the gate stays in page.tsx; ReportsIndex.tsx has no supabase/redirect code
 */

import React from 'react';
import { readFileSync } from 'fs';
import path from 'path';
import { renderToString } from 'react-dom/server';
import { hydrateRoot } from 'react-dom/client';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
const jar = vi.hoisted(() => ({ view: undefined as string | undefined }));

vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/dashboard/reports',
  useSearchParams: () => new URLSearchParams(window.location.search),
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
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'reports-index-view' && jar.view !== undefined ? { name, value: jar.view } : undefined,
  }),
}));
vi.mock('@/lib/supabase/server', () => ({
  getAuthenticatedUser: async () => {
    const single = (data: unknown) => ({ select: () => ({ eq: () => ({ single: async () => ({ data, error: null }) }) }) });
    return {
      user: { id: 'u-1' },
      supabase: { rpc: async () => ({ data: true, error: null }), from: () => single({ role_id: 'r1' }) },
    };
  },
}));

import ReportsIndexPage from '@/app/dashboard/reports/page';
import { ReportsIndex } from '@/app/dashboard/reports/ReportsIndex';
import {
  REPORTS_INDEX_PANEL_ID,
  REPORTS_VIEW_COOKIE,
  resolveReportsIndexView,
} from '@/app/dashboard/reports/reportsIndexView';
import { REPORTS, reportHref } from '@/lib/reports/registry';

const ROOT = path.resolve(__dirname, '../../../..');
const EXPECTED_HREFS = REPORTS.map((r) => reportHref(r.slug));

function clearViewCookie() {
  document.cookie = `${REPORTS_VIEW_COOKIE}=; path=/dashboard/reports; max-age=0`;
  document.cookie = `${REPORTS_VIEW_COOKIE}=; path=/; max-age=0`;
}

beforeEach(() => {
  window.history.replaceState(null, '', '/dashboard/reports?period=30');
  clearViewCookie();
  jar.view = undefined;
  router.push.mockClear();
  router.replace.mockClear();
});

afterEach(() => {
  cleanup();
  clearViewCookie();
});

const panel = () => screen.getByRole('tabpanel');
const tab = (name: string) => screen.getByRole('tab', { name });
const cardHrefs = (root: HTMLElement) =>
  Array.from(root.querySelectorAll('[data-view="cards"] a')).map((a) => a.getAttribute('href'));
const listHrefs = (root: HTMLElement) =>
  Array.from(root.querySelectorAll('table tbody a')).map((a) => a.getAttribute('href'));

describe('T1 resolver: ?view first, then cookie, then cards; garbage counts as absent', () => {
  it.each([
    [{ url: 'list', cookie: 'cards' }, 'list'],
    [{ url: 'cards', cookie: 'list' }, 'cards'],
    [{ url: undefined, cookie: 'list' }, 'list'],
    [{ url: undefined, cookie: 'cards' }, 'cards'],
    [{ url: undefined, cookie: undefined }, 'cards'],
    [{ url: 'garbage', cookie: 'list' }, 'list'],
    [{ url: 'LIST', cookie: undefined }, 'cards'],
    [{ url: '', cookie: 'list' }, 'list'],
    [{ url: undefined, cookie: 'garbage' }, 'cards'],
    [{ url: 'garbage', cookie: 'garbage' }, 'cards'],
    [{ url: 'list', cookie: 'garbage' }, 'list'],
  ])('%o -> %s', (input, expected) => {
    expect(resolveReportsIndexView(input)).toBe(expected);
  });
});

describe('T2 page passes the resolved view down (server wiring)', () => {
  it('no ?view and no cookie: Cards, no table', async () => {
    render(await ReportsIndexPage({ searchParams: Promise.resolve({}) }));
    expect(tab('Cards').getAttribute('aria-selected')).toBe('true');
    expect(document.querySelector('table')).toBeNull();
    expect(cardHrefs(document.body)).toEqual(EXPECTED_HREFS);
  });

  it('cookie list, no ?view: List', async () => {
    jar.view = 'list';
    render(await ReportsIndexPage({ searchParams: Promise.resolve({}) }));
    expect(tab('List').getAttribute('aria-selected')).toBe('true');
    expect(document.querySelector('table')).not.toBeNull();
  });

  it('?view=cards beats cookie list', async () => {
    jar.view = 'list';
    render(await ReportsIndexPage({ searchParams: Promise.resolve({ view: 'cards' }) }));
    expect(tab('Cards').getAttribute('aria-selected')).toBe('true');
    expect(document.querySelector('table')).toBeNull();
  });

  it('?view=garbage with cookie list: List', async () => {
    jar.view = 'list';
    render(await ReportsIndexPage({ searchParams: Promise.resolve({ view: 'garbage' }) }));
    expect(tab('List').getAttribute('aria-selected')).toBe('true');
  });
});

describe('T3 list shows every registry report, in registry order', () => {
  it('row titles and hrefs match REPORTS', () => {
    render(<ReportsIndex reports={REPORTS} initialView="list" />);
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getByRole('link').textContent)).toEqual(REPORTS.map((r) => r.title));
    expect(listHrefs(document.body)).toEqual(EXPECTED_HREFS);
  });
});

describe('T4 toggle remembers the choice without navigating', () => {
  it('writes the cookie and the URL, keeps other params, never calls the router', () => {
    render(<ReportsIndex reports={REPORTS} initialView="cards" />);

    fireEvent.click(tab('List'));
    expect(document.cookie).toContain(`${REPORTS_VIEW_COOKIE}=list`);
    expect(window.location.pathname).toBe('/dashboard/reports');
    expect(window.location.search).toBe('?period=30&view=list');
    expect(document.querySelector('table')).not.toBeNull();

    fireEvent.click(tab('Cards'));
    expect(document.cookie).toContain(`${REPORTS_VIEW_COOKIE}=cards`);
    expect(window.location.search).toBe('?period=30&view=cards');
    expect(document.querySelector('table')).toBeNull();

    expect(router.push).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
  });
});

describe('T5 server-rendered List hydrates cleanly', () => {
  it('SSR list markup is the table and hydration logs zero errors', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    clearViewCookie();
    const html = renderToString(<ReportsIndex reports={REPORTS} initialView="list" />);
    expect(html).toContain('<table');

    // The browser holds a different stored value than the server rendered with:
    // a client that reads its own preference during render would mismatch.
    document.cookie = `${REPORTS_VIEW_COOKIE}=cards; path=/dashboard/reports`;

    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.appendChild(container);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const recoverable: unknown[] = [];
    let root: ReturnType<typeof hydrateRoot> | undefined;
    await act(async () => {
      root = hydrateRoot(container, <ReportsIndex reports={REPORTS} initialView="list" />, {
        onRecoverableError: (e) => recoverable.push(e),
      });
    });
    expect(recoverable).toEqual([]);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(container.querySelector('table')).not.toBeNull();
    errorSpy.mockRestore();
    await act(async () => root?.unmount());
    container.remove();
  });
});

describe('T6 semantics', () => {
  it('tablist, one tabpanel with a fixed id, scoped column headers', () => {
    render(<ReportsIndex reports={REPORTS} initialView="list" />);
    expect(screen.getByRole('tablist', { name: 'Report layout' })).toBeTruthy();
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Cards', 'List']);
    for (const t of tabs) expect(t.getAttribute('aria-controls')).toBe(REPORTS_INDEX_PANEL_ID);
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
    expect(panel().id).toBe(REPORTS_INDEX_PANEL_ID);
    expect(panel().getAttribute('aria-label')).toBe('Reports, list view');
    const ths = within(screen.getByRole('table')).getAllByRole('columnheader');
    expect(ths.map((th) => th.textContent)).toEqual(['Report', 'What it answers', 'Source']);
    for (const th of ths) expect(th.getAttribute('scope')).toBe('col');

    fireEvent.click(tab('Cards'));
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
    expect(panel().id).toBe(REPORTS_INDEX_PANEL_ID);
    expect(panel().getAttribute('aria-label')).toBe('Reports, card view');
  });

  it('only the title is a link in the list', () => {
    render(<ReportsIndex reports={REPORTS} initialView="list" />);
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1);
    for (const r of rows) expect(within(r).getAllByRole('link')).toHaveLength(1);
  });
});

describe('T7 phone layout', () => {
  const classes = (el: Element | null) => (el?.getAttribute('class') ?? '').split(/\s+/);

  it('table scrolls sideways; nothing between it and the panel clips', () => {
    render(<ReportsIndex reports={REPORTS} initialView="list" />);
    const table = screen.getByRole('table');
    expect(classes(table.parentElement)).toContain('overflow-x-auto');
    let el: HTMLElement | null = table.parentElement;
    while (el && el !== document.body) {
      expect(classes(el)).not.toContain('overflow-hidden');
      el = el.parentElement;
    }
  });

  it('Source column is hidden below md on the header AND every cell', () => {
    render(<ReportsIndex reports={REPORTS} initialView="list" />);
    const table = screen.getByRole('table');
    const sourceTh = within(table).getByRole('columnheader', { name: 'Source' });
    expect(classes(sourceTh)).toContain('max-md:hidden');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(REPORTS.length);
    for (const r of rows) {
      const cells = r.querySelectorAll('td');
      expect(cells).toHaveLength(3);
      expect(classes(cells[2])).toContain('max-md:hidden');
    }
  });

  it('header wraps; toggle takes its own line below md and sits top right at md+', () => {
    render(<ReportsIndex reports={REPORTS} initialView="cards" />);
    const tablist = screen.getByRole('tablist', { name: 'Report layout' });
    const slot = tablist.parentElement as HTMLElement;
    expect(classes(slot)).toEqual(expect.arrayContaining(['w-full', 'md:w-auto']));
    const header = slot.parentElement as HTMLElement;
    expect(classes(header)).toEqual(expect.arrayContaining(['flex', 'flex-wrap', 'md:justify-between']));
    expect(within(header).getByRole('heading', { level: 1, name: 'Reports' })).toBeTruthy();
  });
});

describe('T8 both views map ONE array', () => {
  it('card hrefs == list hrefs == registry order', () => {
    render(<ReportsIndex reports={REPORTS} initialView="cards" />);
    const cards = cardHrefs(document.body);
    fireEvent.click(tab('List'));
    const list = listHrefs(document.body);
    expect(cards).toEqual(EXPECTED_HREFS);
    expect(list).toEqual(EXPECTED_HREFS);
    expect(cards).toEqual(list);
  });
});

describe('T9 the gate stays in page.tsx', () => {
  it('ReportsIndex.tsx carries no auth or redirect code', () => {
    const src = readFileSync(path.join(ROOT, 'app/dashboard/reports/ReportsIndex.tsx'), 'utf8');
    expect(src).not.toMatch(/supabase/i);
    expect(src).not.toContain('redirect');
    expect(src).not.toContain('has_permission');
  });

  it('page.tsx keeps the gate before it reads the view', () => {
    const src = readFileSync(path.join(ROOT, 'app/dashboard/reports/page.tsx'), 'utf8');
    const gate = src.indexOf("redirect('/dashboard?error=insufficient_permissions')");
    expect(gate).toBeGreaterThan(-1);
    expect(src.indexOf('await searchParams')).toBeGreaterThan(gate);
  });
});
