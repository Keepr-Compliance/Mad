/**
 * BACKLOG-4238 — the AI apps entry in the sidebar: directly under My Account,
 * in every navigation the sidebar renders (normal, floor, suspended, brokerage
 * suspended), only while MCP is on, and never in a support session. On the AI
 * apps page the entry is the one highlighted, not My Account.
 */

import { render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';

let mockPathname = '/dashboard';
jest.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
}));

import { Sidebar, type SidebarProps } from '@/components/layout/Sidebar';
import { AI_APPS } from '@/lib/mcp/account/messages';

const ACCOUNT_HREF = '/dashboard/account';
const AI_APPS_HREF = '/dashboard/account/ai-apps';
const ACTIVE = 'bg-gray-800 text-white';

beforeEach(() => {
  mockPathname = '/dashboard';
});

function railHrefs(props: Partial<SidebarProps>): string[] {
  render(
    <Sidebar collapsed={false} onToggle={() => {}} isImpersonating={false} displayEmail="member@example.test" {...props} />
  );
  const aside = screen.getByTestId('desktop-sidebar');
  return Array.from(aside.querySelectorAll('nav a')).map((a) => a.getAttribute('href') ?? '');
}

const VARIANTS: [string, Partial<SidebarProps>][] = [
  ['admin', { role: 'admin' }],
  ['it_admin', { role: 'it_admin' }],
  ['broker', { role: 'broker' }],
  ['floor (agent)', { role: 'agent', floorOnly: true }],
  ['suspended', { role: 'agent', floorOnly: true, suspended: true }],
  ['brokerage suspended', { role: 'broker', orgSuspended: true }],
];

describe('MCP on', () => {
  it.each(VARIANTS)('%s: AI apps directly after My Account', (_label, props) => {
    const hrefs = railHrefs({ ...props, mcpOn: true });
    const i = hrefs.indexOf(ACCOUNT_HREF);
    expect(i).toBeGreaterThanOrEqual(0);
    expect(hrefs[i + 1]).toBe(AI_APPS_HREF);
    expect(hrefs.filter((h) => h === AI_APPS_HREF)).toHaveLength(1);
  });

  it('is labelled with the AI apps string and indented under My Account', () => {
    railHrefs({ role: 'admin', mcpOn: true });
    const link = within(screen.getByTestId('desktop-sidebar')).getByRole('link', { name: AI_APPS.accountLink });
    expect(link).toHaveAttribute('href', AI_APPS_HREF);
    expect(link.className).toContain('pl-9');
  });

  it('on the AI apps page: AI apps is highlighted, My Account is not', () => {
    mockPathname = AI_APPS_HREF;
    railHrefs({ role: 'admin', mcpOn: true });
    const aside = within(screen.getByTestId('desktop-sidebar'));
    expect(aside.getByRole('link', { name: AI_APPS.accountLink }).className).toContain(ACTIVE);
    expect(aside.getByRole('link', { name: 'My Account' }).className).not.toContain(ACTIVE);
  });

  it('on My Account: My Account is highlighted', () => {
    mockPathname = ACCOUNT_HREF;
    railHrefs({ role: 'admin', mcpOn: true });
    const aside = within(screen.getByTestId('desktop-sidebar'));
    expect(aside.getByRole('link', { name: 'My Account' }).className).toContain(ACTIVE);
    expect(aside.getByRole('link', { name: AI_APPS.accountLink }).className).not.toContain(ACTIVE);
  });

  it('support session: no AI apps entry (My Account stays)', () => {
    const hrefs = railHrefs({ isImpersonating: true, mcpOn: true });
    expect(hrefs).toContain(ACCOUNT_HREF);
    expect(hrefs).not.toContain(AI_APPS_HREF);
  });
});

describe('MCP off', () => {
  it.each(VARIANTS)('%s: no AI apps entry', (_label, props) => {
    const hrefs = railHrefs({ ...props, mcpOn: false });
    expect(hrefs).toContain(ACCOUNT_HREF);
    expect(hrefs).not.toContain(AI_APPS_HREF);
  });

  it('no flag: no AI apps entry, and My Account keeps its prefix highlight', () => {
    mockPathname = AI_APPS_HREF;
    const hrefs = railHrefs({ role: 'admin' });
    expect(hrefs).not.toContain(AI_APPS_HREF);
    expect(
      within(screen.getByTestId('desktop-sidebar')).getByRole('link', { name: 'My Account' }).className
    ).toContain(ACTIVE);
  });
});
