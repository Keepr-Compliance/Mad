/**
 * BACKLOG-3896 fix-up — page title in the phone top bar, heading and subtitle
 * hidden below md. jsdom loads no CSS: these assert the class contract; the
 * rendered geometry is measured by scripts/phone-layout-3798/run.sh.
 */
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';
import fs from 'fs';
import path from 'path';

let mockPath = '/dashboard';
jest.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: jest.fn(), push: jest.fn() }),
  usePathname: () => mockPath,
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: null } }),
      getSession: async () => ({ data: { session: null } }),
    },
  }),
}));
jest.mock('@/lib/support-queries', () => ({
  createTicket: jest.fn(),
  getCategories: jest.fn(async () => []),
  buildCategoryTree: () => [],
  uploadAttachment: jest.fn(),
}));
jest.mock('html2canvas', () => jest.fn());
jest.mock('heic2any', () => jest.fn());
jest.mock('@/components/ImpersonationBanner', () => ({ ImpersonationBanner: () => null }));

import { DashboardShell } from '@/components/layout/DashboardShell';
import { getPhoneTitle } from '@/lib/dashboard-page-titles';
import { PageHeader } from '@keepr/design-system';

const ROOT = path.resolve(__dirname, '../..');
const DASH = path.join(ROOT, 'app/dashboard');

// Expected title per route, written by hand (not derived from the map).
const EXPECTED: Record<string, string> = {
  '/dashboard': 'Dashboard',
  '/dashboard/users': 'Users Management',
  '/dashboard/users/u-1': 'User',
  '/dashboard/settings': 'Settings',
  '/dashboard/settings/scim': 'SCIM Provisioning',
  '/dashboard/account': 'My Account',
  '/dashboard/support': 'Support',
  '/dashboard/support/new': 'Submit a Support Request',
  '/dashboard/support/t-1': 'Ticket',
  '/dashboard/checklists': 'Checklists',
  '/dashboard/checklists/new': 'Checklist',
  '/dashboard/checklists/c-1': 'Checklist',
  '/dashboard/my-transactions': 'My Transactions',
  '/dashboard/my-transactions/m-1': 'Transaction',
};
const SUBMISSIONS = ['/dashboard/submissions', '/dashboard/submissions/s-1'];

function pageRoutes(dir = DASH, rel = ''): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...pageRoutes(path.join(dir, e.name), `${rel}/${e.name}`));
    else if (e.name === 'page.tsx') out.push(rel);
  }
  return out;
}
const toUrl = (r: string) => '/dashboard' + r.replace(/\[[^\]]+\]/g, 'x-1');

function renderShell(p: string) {
  mockPath = p;
  return render(
    <DashboardShell isImpersonating={false} displayEmail="a@example.test">
      <div>content</div>
    </DashboardShell>
  );
}

describe('phone top bar title (BACKLOG-3896)', () => {
  it('sweep: every dashboard page.tsx outside submissions resolves a title', () => {
    const routes = pageRoutes().filter((r) => !r.startsWith('/submissions'));
    expect(routes.length).toBeGreaterThanOrEqual(12);
    for (const r of routes) {
      const url = toUrl(r);
      expect({ url, title: getPhoneTitle(url) }).toEqual({ url, title: expect.any(String) });
    }
    // and the hand-written table covers every one of them
    const covered = new Set(Object.keys(EXPECTED).map((u) => u.replace(/\/(u|t|c|m)-1$/, '/x-1')));
    for (const r of routes) expect(covered.has(toUrl(r))).toBe(true);
  });

  it.each(Object.entries(EXPECTED))('%s shows "%s" in the top bar, wordmark gone', (url, title) => {
    renderShell(url);
    expect(screen.getByTestId('mobile-top-bar-title')).toHaveTextContent(title);
    expect(screen.getByTestId('mobile-top-bar')).not.toHaveTextContent('Broker');
  });

  it.each(SUBMISSIONS)('%s keeps the wordmark top bar (owned by PR #2961)', (url) => {
    renderShell(url);
    expect(screen.queryByTestId('mobile-top-bar-title')).toBeNull();
    expect(screen.getByTestId('mobile-top-bar')).toHaveTextContent('Broker');
  });

  it('non-dashboard or empty paths give no title', () => {
    expect(getPhoneTitle(null)).toBeUndefined();
    expect(getPhoneTitle('/dashboards')).toBeUndefined();
  });
});

describe('page headings below md (BACKLOG-3896)', () => {
  it('phoneHideTitle/phoneHideSubtitle: h1 stays a level-1 heading, sr-only below md; subtitle hidden below md', () => {
    const { container } = render(
      <PageHeader title="Settings" subtitle="Manage" phoneHideTitle phoneHideSubtitle />
    );
    const h1 = screen.getByRole('heading', { level: 1, name: 'Settings' });
    expect(h1).toHaveClass('max-md:sr-only');
    expect(screen.getByText('Manage')).toHaveClass('max-md:hidden');
    expect(container.firstElementChild).toHaveClass('max-md:mb-0');
  });

  it('title hidden but subtitle kept: subtitle visible and the gap stays', () => {
    const { container } = render(<PageHeader title="My Transactions" subtitle="3 submissions" phoneHideTitle />);
    expect(screen.getByText('3 submissions')).not.toHaveClass('max-md:hidden');
    expect(container.firstElementChild).not.toHaveClass('max-md:mb-0');
  });

  it('actions keep the row (gap kept) when the title is hidden', () => {
    const { container } = render(
      <PageHeader title="Support" phoneHideTitle phoneHideSubtitle actions={<button>New Ticket</button>} />
    );
    expect(screen.getByRole('button', { name: 'New Ticket' })).toBeInTheDocument();
    expect(container.firstElementChild).not.toHaveClass('max-md:mb-0');
  });

  it('default render is byte-for-byte the previous class strings (desktop and phone unchanged)', () => {
    const { container } = render(<PageHeader title="T" subtitle="S" actions={<i />} />);
    expect(container.firstElementChild?.getAttribute('class')).toBe('mb-6 flex items-center justify-between');
    expect(screen.getByRole('heading', { level: 1 }).getAttribute('class')).toBe('text-2xl font-bold text-gray-900');
    expect(screen.getByText('S').getAttribute('class')).toBe('mt-1 text-sm text-gray-500');
  });

  it('sweep: every PageHeader in the broker dashboard pages (outside submissions) opts in, with PAGE_TITLES', () => {
    const files = [
      ...pageRoutes().filter((r) => !r.startsWith('/submissions')).map((r) => path.join(DASH, r, 'page.tsx')),
      path.join(DASH, 'settings/OrgSettingsClient.tsx'),
      path.join(DASH, 'settings/scim/ScimSettingsClient.tsx'),
      path.join(DASH, 'account/AccountClient.tsx'),
      path.join(DASH, 'components/FloorDashboard.tsx'),
      path.join(ROOT, 'components/my-transactions/UpsellPanel.tsx'),
    ];
    let headers = 0;
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      const parts = src.split(/<PageHeader(?=[\s>])/).slice(1);
      for (const part of parts) {
        headers++;
        const tag = part.slice(0, part.search(/\/>|>\s*\n?\s*</) + 2);
        expect({ f: path.basename(f), ok: /phoneHideTitle/.test(tag) }).toEqual({ f: path.basename(f), ok: true });
        expect(/(?<![A-Za-z])title="/.test(tag)).toBe(false); // titles come from PAGE_TITLES or a computed greeting
      }
    }
    expect(headers).toBeGreaterThanOrEqual(13);
  });

  it('no submissions file was touched by this change', () => {
    const src = fs.readFileSync(path.join(DASH, 'submissions/page.tsx'), 'utf8');
    expect(src).not.toMatch(/phoneHide/);
  });
});
