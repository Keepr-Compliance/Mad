/**
 * The Sidebar's floor bucket — BACKLOG-3080 (C-sidebar).
 *
 * Exact href lists. The broker / admin / it_admin / impersonation lists were
 * TRANSCRIBED by rendering the Sidebar at 777ad1a40, before any BACKLOG-3080
 * edit, and must stay byte-identical.
 */

import { render } from '@testing-library/react';

jest.mock('next/navigation', () => ({ usePathname: () => '/dashboard' }));

import { Sidebar, type SidebarProps } from '@/components/layout/Sidebar';

function hrefs(props: Partial<SidebarProps>): string[] {
  const { container, unmount } = render(
    <Sidebar
      collapsed={false}
      onToggle={() => {}}
      isImpersonating={false}
      displayEmail="member@example.test"
      {...props}
    />
  );
  const out = Array.from(container.querySelectorAll('nav a')).map(
    (a) => a.getAttribute('href') as string
  );
  unmount();
  return out;
}

// Transcribed at 777ad1a40 (before any edit).
const BEFORE = {
  broker: ['/dashboard', '/dashboard/submissions', '/dashboard/support', '/dashboard/account'],
  admin: [
    '/dashboard',
    '/dashboard/submissions',
    '/dashboard/support',
    '/dashboard/users',
    '/dashboard/settings',
    '/dashboard/account',
  ],
  it_admin: ['/dashboard/users', '/dashboard/settings', '/dashboard/account'],
  impersonation: ['/dashboard', '/dashboard/submissions', '/dashboard/support', '/dashboard/account'],
  brokerWithChecklists: [
    '/dashboard',
    '/dashboard/submissions',
    '/dashboard/support',
    '/dashboard/checklists',
    '/dashboard/account',
  ],
  adminWithChecklists: [
    '/dashboard',
    '/dashboard/submissions',
    '/dashboard/support',
    '/dashboard/users',
    '/dashboard/checklists',
    '/dashboard/settings',
    '/dashboard/account',
  ],
  itAdminWithChecklists: [
    '/dashboard/users',
    '/dashboard/checklists',
    '/dashboard/settings',
    '/dashboard/account',
  ],
};

const FLOOR = ['/dashboard', '/dashboard/support', '/dashboard/account'];

/**
 * BACKLOG-4007 PR-4 (founder e8571c1f): admin, IT admin and broker also get People, right
 * before Billing (or My Account). Inserted by hand into the transcribed lists above.
 */
function withPeople(list: readonly string[]): string[] {
  const at = list.includes('/dashboard/billing') ? list.indexOf('/dashboard/billing') : list.indexOf('/dashboard/account');
  return [...list.slice(0, at), '/dashboard/people', ...list.slice(at)];
}

describe('Sidebar — the floor', () => {
  it.each(['agent', 'viewer', undefined])('role %s with floorOnly shows exactly the floor', (role) => {
    expect(hrefs({ role, floorOnly: true })).toEqual(FLOOR);
  });

  it('adds Checklists only when the checklist gate says so', () => {
    expect(hrefs({ role: 'agent', floorOnly: true, showChecklists: true })).toEqual([
      '/dashboard',
      '/dashboard/support',
      '/dashboard/checklists',
      '/dashboard/account',
    ]);
  });

  it('labels the footer role "Agent"', () => {
    const { getByText, unmount } = render(
      <Sidebar
        collapsed={false}
        onToggle={() => {}}
        isImpersonating={false}
        displayEmail="member@example.test"
        role="agent"
        displayRole="agent"
        floorOnly
      />
    );
    expect(getByText('Agent')).toBeTruthy();
    unmount();
  });
});

describe('Sidebar — full-portal and support buckets are unchanged', () => {
  it.each([
    ['broker', { role: 'broker' }, withPeople(BEFORE.broker)],
    ['admin', { role: 'admin' }, withPeople(BEFORE.admin)],
    ['it_admin', { role: 'it_admin' }, withPeople(BEFORE.it_admin)],
    ['impersonation', { isImpersonating: true }, BEFORE.impersonation],
    ['impersonation even if floorOnly were set', { isImpersonating: true, floorOnly: true }, BEFORE.impersonation],
    ['broker + checklists', { role: 'broker', showChecklists: true }, withPeople(BEFORE.brokerWithChecklists)],
    ['admin + checklists', { role: 'admin', showChecklists: true }, withPeople(BEFORE.adminWithChecklists)],
    ['it_admin + checklists', { role: 'it_admin', showChecklists: true }, withPeople(BEFORE.itAdminWithChecklists)],
  ] as [string, Partial<SidebarProps>, string[]][])('%s', (_name, props, expected) => {
    expect(hrefs({ ...props, floorOnly: props.floorOnly ?? false })).toEqual(expected);
  });
});

/**
 * BACKLOG-3844: Billing sits immediately before My Account for every role,
 * only when the layout passes showBilling, and never during impersonation.
 * Each expected list is a BEFORE list above with one href inserted by hand.
 */
describe('Sidebar — Billing (BACKLOG-3844)', () => {
  it.each([
    ['floor', { role: 'agent', floorOnly: true }, ['/dashboard', '/dashboard/support', '/dashboard/billing', '/dashboard/account']],
    ['broker', { role: 'broker' }, ['/dashboard', '/dashboard/submissions', '/dashboard/support', '/dashboard/billing', '/dashboard/account']],
    [
      'admin',
      { role: 'admin' },
      [
        '/dashboard',
        '/dashboard/submissions',
        '/dashboard/support',
        '/dashboard/users',
        '/dashboard/settings',
        '/dashboard/billing',
        '/dashboard/account',
      ],
    ],
    ['it_admin', { role: 'it_admin' }, ['/dashboard/users', '/dashboard/settings', '/dashboard/billing', '/dashboard/account']],
    [
      'broker + checklists',
      { role: 'broker', showChecklists: true },
      [
        '/dashboard',
        '/dashboard/submissions',
        '/dashboard/support',
        '/dashboard/checklists',
        '/dashboard/billing',
        '/dashboard/account',
      ],
    ],
  ] as [string, Partial<SidebarProps>, string[]][])('%s with showBilling', (_name, props, expected) => {
    expect(hrefs({ ...props, showBilling: true })).toEqual(props.floorOnly ? expected : withPeople(expected));
  });

  it('impersonation never shows Billing, even if showBilling were set', () => {
    expect(hrefs({ isImpersonating: true, showBilling: true })).toEqual(BEFORE.impersonation);
  });

  it.each([
    ['floor', { role: 'agent', floorOnly: true }, FLOOR],
    ['broker', { role: 'broker' }, withPeople(BEFORE.broker)],
    ['admin', { role: 'admin' }, withPeople(BEFORE.admin)],
    ['it_admin', { role: 'it_admin' }, withPeople(BEFORE.it_admin)],
  ] as [string, Partial<SidebarProps>, string[]][])('%s without showBilling is unchanged', (_name, props, expected) => {
    expect(hrefs({ ...props, showBilling: false })).toEqual(expected);
  });
});
