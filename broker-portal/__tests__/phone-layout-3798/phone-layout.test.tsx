/**
 * BACKLOG-3798 — phone width (375px) controls.
 *
 * jsdom loads no CSS, so these assert the class contract the layout rests on:
 * the phone classes are present and every desktop (md:) restore is present.
 * The rendered geometry (Reject on-screen at 375, desktop rects identical at
 * 768/1024/1280) is measured by scripts/phone-layout-3798/run.sh in Chromium.
 *
 * Every id, name and address is invented. The member shape follows the select
 * in app/dashboard/users/page.tsx.
 */

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';

let mockPath = '/dashboard/submissions/sub-1';
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
jest.mock('@/components/submission/AttachmentViewerModal', () => ({ AttachmentViewerModal: () => null }));

import { DashboardShell } from '@/components/layout/DashboardShell';
import { Sidebar } from '@/components/layout/Sidebar';
import { ReviewActions } from '@/components/submission/ReviewActions';
import { SupportWidget } from '@/app/dashboard/components/SupportWidget';
import { MessageList, type Message } from '@/components/submission/MessageList';
import { AttachmentList } from '@/components/submission/AttachmentList';
import UserListClient from '@/components/users/UserListClient';

const tokens = (el: Element | null) => (el?.getAttribute('class') || '').split(/\s+/).filter(Boolean);

function setMatchMedia(matches: boolean | null) {
  if (matches === null) {
    delete (window as unknown as { matchMedia?: unknown }).matchMedia;
    return;
  }
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

afterEach(() => {
  setMatchMedia(null);
  mockPath = '/dashboard/submissions/sub-1';
  document.documentElement.style.removeProperty('--review-bar-h');
});

const OPEN_SUBMISSION = { id: 'sub-1', status: 'under_review', organization_id: 'org-1' };

function renderShell() {
  return render(
    <DashboardShell role="broker" isImpersonating={false} displayName="Avery Example" displayEmail="broker@example.com" displayRole="broker">
      <p>page</p>
    </DashboardShell>
  );
}

const sidebarProps = {
  onToggle: () => {},
  role: 'broker',
  isImpersonating: false,
  displayName: 'Avery Example',
  displayEmail: 'broker@example.com',
  displayRole: 'broker',
};

describe('review bar', () => {
  it('C1 narrow: Reject sits in a 2-column grid row, Approve spans both, nothing hides it', () => {
    render(<ReviewActions submission={OPEN_SUBMISSION} showChecklistHint />);
    const reject = screen.getByRole('button', { name: /Reject/ });
    const row = reject.parentElement!;
    expect(tokens(row)).toEqual(expect.arrayContaining(['grid', 'grid-cols-2']));
    expect(tokens(row)).not.toContain('flex');
    expect(tokens(screen.getByRole('button', { name: /Approve/ }))).toContain('col-span-2');
    for (const name of [/Approve/, /Request Changes/, /Reject/]) {
      const t = tokens(screen.getByRole('button', { name }));
      expect(t).toContain('min-h-[44px]');
      // SR change 1: Button's base is already justify-center; no justify override.
      expect(t.filter((x) => x.includes('justify-start'))).toEqual([]);
    }
    expect(tokens(screen.getByTestId('request-changes-hint'))).toEqual(expect.arrayContaining(['col-span-2', 'order-last']));
    for (let el: Element | null = reject; el && !tokens(el).includes('fixed'); el = el.parentElement) {
      expect(tokens(el)).not.toContain('hidden');
    }
  });

  it('B1 the Confirm Rejection panel keeps --review-bar-h set while it is open', () => {
    const rect = jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ height: 220 } as DOMRect);
    try {
      render(<ReviewActions submission={OPEN_SUBMISSION} showChecklistHint />);
      fireEvent.click(screen.getByRole('button', { name: /^Reject$/ }));
      fireEvent.change(screen.getByPlaceholderText(/Explain why/), { target: { value: 'Missing signed disclosure pages' } });
      fireEvent.click(screen.getByRole('button', { name: /Reject Submission/ }));
      expect(screen.getByText('Confirm Rejection')).toBeInTheDocument();
      expect(document.documentElement.style.getPropertyValue('--review-bar-h')).toBe('220px');
    } finally {
      rect.mockRestore();
    }
  });

  it('C8 the bar publishes --review-bar-h on <html> and removes it on unmount', () => {
    const observed: Element[] = [];
    const RO = jest.fn().mockImplementation(() => ({
      observe: (el: Element) => observed.push(el),
      disconnect: jest.fn(),
      unobserve: jest.fn(),
    }));
    const prevRO = (global as unknown as { ResizeObserver?: unknown }).ResizeObserver;
    (global as unknown as { ResizeObserver: unknown }).ResizeObserver = RO;
    const rect = jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ height: 160 } as DOMRect);
    try {
      const { unmount } = render(<ReviewActions submission={OPEN_SUBMISSION} showChecklistHint />);
      expect(document.documentElement.style.getPropertyValue('--review-bar-h')).toBe('160px');
      expect(observed).toHaveLength(1);
      unmount();
      expect(document.documentElement.style.getPropertyValue('--review-bar-h')).toBe('');
    } finally {
      rect.mockRestore();
      (global as unknown as { ResizeObserver?: unknown }).ResizeObserver = prevRO;
    }
  });
});

describe('shell', () => {
  it('C2 --sidebar-w is 0 below md and is not an inline style', () => {
    const { container } = renderShell();
    const root = container.firstElementChild as HTMLElement;
    expect(root.style.getPropertyValue('--sidebar-w')).toBe('');
    expect(tokens(root)).toContain('[--sidebar-w:0px]');
  });

  it('C4 the drawer closes when the route changes', () => {
    const view = renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    expect(screen.getByRole('dialog', { name: 'Main menu' })).toBeInTheDocument();
    mockPath = '/dashboard/users';
    view.rerender(
      <DashboardShell role="broker" isImpersonating={false} displayName="Avery Example" displayEmail="broker@example.com" displayRole="broker">
        <p>page</p>
      </DashboardShell>
    );
    expect(screen.queryByRole('dialog', { name: 'Main menu' })).not.toBeInTheDocument();
  });

  it('C5 Escape closes the drawer and returns focus to Open menu; Tab wraps inside it', () => {
    renderShell();
    const opener = screen.getByRole('button', { name: 'Open menu' });
    fireEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'Main menu' });
    const closeBtn = within(dialog).getByRole('button', { name: 'Close menu' });
    expect(closeBtn).toHaveFocus();

    const signOut = within(dialog).getByRole('link', { name: /Sign Out/ });
    signOut.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(closeBtn).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(signOut).toHaveFocus();

    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Main menu' })).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
    expect(document.body.style.overflow).toBe('');
  });

  it('C5b a tap on a drawer link or the backdrop closes it', () => {
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('link', { name: 'Submissions' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    const overlay = screen.getByTestId('mobile-nav-overlay');
    fireEvent.click(overlay.firstElementChild as Element);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('C6 the drawer shows labels even when the desktop sidebar is collapsed', () => {
    render(<Sidebar {...sidebarProps} collapsed mobileOpen onMobileClose={() => {}} />);
    const dialog = screen.getByRole('dialog', { name: 'Main menu' });
    expect(within(dialog).getByText('Submissions')).toBeInTheDocument();
    expect(within(dialog).getByText('Sign Out')).toBeInTheDocument();
  });

  it('C7 a closed drawer is not in the DOM: one link per nav item', () => {
    render(<Sidebar {...sidebarProps} collapsed={false} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Submissions' })).toHaveLength(1);
  });

  it('C7b the drawer is rendered outside the desktop aside (display:none below md)', () => {
    render(<Sidebar {...sidebarProps} collapsed={false} mobileOpen onMobileClose={() => {}} />);
    const desktop = screen.getByTestId('desktop-sidebar');
    const dialog = screen.getByRole('dialog', { name: 'Main menu' });
    expect(desktop.contains(dialog)).toBe(false);
    for (let el: Element | null = dialog; el; el = el.parentElement) {
      if (el === dialog) continue;
      // The only hidden ancestor allowed is none; the overlay is md:hidden (visible below md).
      expect(tokens(el)).not.toContain('hidden');
    }
  });
});

describe('C3 desktop restores (md:) are in place', () => {
  it('shell root, main, desktop aside, FAB', () => {
    const { container, rerender } = renderShell();
    const root = container.firstElementChild as HTMLElement;
    expect(tokens(root)).toContain('md:[--sidebar-w:16rem]');
    expect(tokens(container.querySelector('main'))).toEqual(expect.arrayContaining(['p-4', 'md:p-6']));
    const aside = screen.getByTestId('desktop-sidebar');
    expect(tokens(aside)).toEqual(expect.arrayContaining(['hidden', 'md:flex']));
    expect(tokens(screen.getByTestId('mobile-top-bar'))).toContain('md:hidden');
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(tokens(root)).toContain('md:[--sidebar-w:4rem]');
    rerender(<SupportWidget />);
    const fab = screen.getByRole('button', { name: 'Contact Support' });
    expect(tokens(fab)).toEqual(
      expect.arrayContaining(['md:bottom-6', 'md:left-[calc(var(--sidebar-w,0px)_+_1.5rem)]', 'left-4', 'right-auto', 'bottom-[calc(var(--review-bar-h,0px)_+_1rem)]'])
    );
  });

  it('review bar row, label, buttons, hint', () => {
    render(<ReviewActions submission={OPEN_SUBMISSION} showChecklistHint />);
    const reject = screen.getByRole('button', { name: /Reject/ });
    expect(tokens(reject.parentElement)).toEqual(expect.arrayContaining(['md:flex', 'md:items-center', 'md:gap-3']));
    expect(tokens(screen.getByText('Review Actions:'))).toEqual(
      expect.arrayContaining(['md:col-span-1', 'md:text-sm', 'md:normal-case', 'md:tracking-normal'])
    );
    expect(tokens(screen.getByRole('button', { name: /Approve/ }))).toEqual(expect.arrayContaining(['md:col-span-1', 'md:min-h-0']));
    expect(tokens(reject)).toContain('md:min-h-0');
    expect(tokens(screen.getByTestId('request-changes-hint'))).toEqual(expect.arrayContaining(['md:col-span-1', 'md:order-none']));
  });

  it('messages header, pills, thread row, View Full', () => {
    const messages: Message[] = [
      {
        id: 'msg-1',
        channel: 'email',
        direction: 'inbound',
        subject: 'Invented subject',
        body_text: 'x',
        sent_at: '2026-10-02T22:15:00+00:00',
        has_attachments: false,
        attachment_count: 0,
        thread_id: 't1',
        message_type: 'email',
        participants: { from: 'Avery Example <avery@fixture.example.test>', to: ['agent@fixture.example.test'] },
      },
    ];
    render(<MessageList messages={messages} />);
    const header = screen.getByRole('heading', { name: /Messages/ }).parentElement!.parentElement!;
    expect(tokens(header)).toEqual(expect.arrayContaining(['flex-col', 'md:flex-row', 'md:items-center', 'md:justify-between', 'md:gap-0']));
    const pill = screen.getByRole('button', { name: /^All/ });
    expect(tokens(pill.parentElement)).toEqual(expect.arrayContaining(['flex-wrap', 'md:flex-nowrap']));
    const viewFull = screen.getByRole('button', { name: /View Full/ });
    expect(tokens(viewFull)).toEqual(expect.arrayContaining(['md:self-auto', 'md:ml-4']));
    expect(tokens(viewFull.parentElement)).toEqual(expect.arrayContaining(['flex-col', 'md:flex-row', 'md:items-center', 'md:justify-between', 'md:gap-0']));
  });

  it('users view toggle is desktop-only', () => {
    render(<UserListClient initialMembers={[]} currentUserId="u0" currentUserRole="admin" organizationId="org-1" />);
    expect(tokens(screen.getByRole('button', { name: 'List view' }).parentElement)).toEqual(expect.arrayContaining(['hidden', 'md:flex']));
  });
});

const MEMBERS = [1, 2].map((i) => ({
  id: `m${i}`,
  organization_id: 'org-1',
  user_id: `u${i}`,
  role: 'agent' as const,
  license_status: 'active' as const,
  invited_email: null,
  invitation_token: null,
  invitation_expires_at: null,
  invited_by: null,
  invited_at: null,
  joined_at: '2024-01-01T00:00:00Z',
  last_invited_at: null,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  user: { id: `u${i}`, email: `agent${i}@example.test`, first_name: 'Agent', last_name: `Number${i}`, display_name: null, avatar_url: null },
}));

describe('users', () => {
  function renderUsers() {
    return render(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      <UserListClient initialMembers={MEMBERS as any} currentUserId="u0" currentUserRole="admin" organizationId="org-1" />
    );
  }

  it('C9 below md the cards render in a grid-cols-1 grid (no table)', async () => {
    setMatchMedia(true);
    await act(async () => {
      renderUsers();
    });
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    const card = screen.getByText('Agent Number1');
    const grid = card.closest('.grid');
    expect(tokens(grid)).toEqual(expect.arrayContaining(['grid-cols-1', 'sm:grid-cols-2', 'lg:grid-cols-3']));
  });

  it('C9b at md and up (and without matchMedia) the table stays the default', () => {
    setMatchMedia(false);
    const first = renderUsers();
    expect(screen.getByRole('table')).toBeInTheDocument();
    first.unmount();
    setMatchMedia(null);
    renderUsers();
    expect(screen.getByRole('table')).toBeInTheDocument();
  });
});

describe('attachments', () => {
  it('C10 Documents stays the default tab, and the tabs wrap below md', () => {
    render(
      <AttachmentList
        attachments={[
          { id: 'a1', filename: 'Agreement.pdf', mime_type: 'application/pdf', file_size_bytes: 1000, storage_path: 'x/a1', document_type: null },
          { id: 'a2', filename: 'photo.jpg', mime_type: 'image/jpeg', file_size_bytes: 1000, storage_path: 'x/a2', document_type: null },
        ]}
      />
    );
    const docs = screen.getByRole('button', { name: /^Documents/ });
    expect(tokens(docs)).toContain('bg-white');
    expect(tokens(screen.getByRole('button', { name: /^All/ }))).not.toContain('bg-white');
    expect(tokens(docs.parentElement)).toEqual(expect.arrayContaining(['flex-wrap', 'md:flex-nowrap']));
    expect(tokens(docs.parentElement!.parentElement)).toEqual(
      expect.arrayContaining(['flex-col', 'md:flex-row', 'md:items-center', 'md:justify-between', 'md:gap-0'])
    );
  });
});

describe('iOS focus-zoom: fields are 16px below md', () => {
  it('review notes textarea is text-base below md and md:text-sm from md up', () => {
    render(<ReviewActions submission={OPEN_SUBMISSION} showChecklistHint />);
    fireEvent.click(screen.getByRole('button', { name: /Approve/ }));
    const ta = document.querySelector('textarea')!;
    expect(ta).not.toBeNull();
    const t = tokens(ta);
    expect(t).toContain('text-base');
    expect(t).toContain('md:text-sm');
    expect(t).not.toContain('text-sm');
  });

  it('users search and role/status filters carry the important 16px/md:14px pair', async () => {
    setMatchMedia(true);
    await act(async () => {
      render(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        <UserListClient initialMembers={MEMBERS as any} currentUserId="u0" currentUserRole="admin" organizationId="org-1" />
      );
    });
    for (const id of ['user-search', 'role-filter', 'status-filter']) {
      expect(tokens(document.getElementById(id))).toEqual(expect.arrayContaining(['!text-base', 'md:!text-sm']));
    }
  });
});
