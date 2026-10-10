// @vitest-environment jsdom

/**
 * BACKLOG-3841 — phone fixes on the in-scope pages (C10 tables scroll, C11
 * page restores). Each assert checks the phone token AND that the desktop
 * tokens on the same element are still there. Real geometry: the harness in
 * scripts/phone-layout-3841. Every id, name and address is invented.
 */

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/dashboard/support',
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ id: 'ticket-1' }),
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
  notFound: () => {
    throw new Error('notFound');
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
vi.mock('next/dynamic', () => ({
  __esModule: true,
  default: (loader: () => Promise<React.ComponentType<Record<string, unknown>>>) => {
    const Lazy = React.lazy(() => loader().then((c) => ({ default: c })));
    return function Dynamic(props: Record<string, unknown>) {
      return (
        <React.Suspense fallback={null}>
          <Lazy {...props} />
        </React.Suspense>
      );
    };
  },
}));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => {
    // Any builder call returns the chain; awaiting it yields empty data.
    const chain: unknown = new Proxy(function () {}, {
      get(_t, prop) {
        if (prop === 'then') return (ok: (x: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok);
        if (prop === 'single' || prop === 'maybeSingle') return async () => ({ data: null, error: null });
        return () => chain;
      },
    });
    return { from: () => chain, rpc: async () => ({ data: null, error: null }), auth: {} };
  },
}));
vi.mock('@/components/providers/AuthProvider', () => ({
  useAuth: () => ({
    user: { id: 'agent-1', email: 'agent.one@example.test', user_metadata: { full_name: 'Avery Example' } },
    signOut: vi.fn(),
  }),
}));
vi.mock('@/components/providers/PermissionsProvider', () => ({
  usePermissions: () => ({ hasPermission: () => true, roleName: 'Super Admin', loading: false }),
}));

const fixtures = vi.hoisted(() => {
  const ticket = (i: number) => ({
    id: `ticket-${i}`,
    ticket_number: 1000 + i,
    subject: `Export does not finish for invented transaction ${i}`,
    description: 'The export spins.',
    status: 'in_progress',
    priority: 'high',
    ticket_type: null,
    category_id: null,
    subcategory_id: null,
    requester_id: null,
    requester_email: 'requester@example.test',
    requester_name: 'Requester Example',
    assignee_id: 'agent-1',
    organization_id: null,
    source_channel: 'web_form',
    pending_reason: null,
    first_response_at: null,
    resolved_at: null,
    closed_at: null,
    reopened_count: 0,
    created_at: '2026-10-01T10:00:00Z',
    updated_at: '2026-10-02T10:00:00Z',
  });
  return { ticket };
});

vi.mock('@/lib/support-queries', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(actual)) {
    out[k] = typeof v === 'function' && k !== 'buildCategoryTree' ? vi.fn(async () => []) : v;
  }
  out.listTickets = vi.fn(async () => ({
    tickets: [1, 2].map(fixtures.ticket),
    total_count: 2,
    page: 1,
    page_size: 20,
    total_pages: 1,
  }));
  out.getTicketStats = vi.fn(async () => ({ total_open: 2, unassigned: 0, by_status: {}, by_priority: {} }));
  out.getRelatedTickets = vi.fn(async () => ({ auto_related: [], manual_links: [] }));
  out.getTicketDiagnostics = vi.fn(async () => null);
  out.getTicketDetail = vi.fn(async () => ({
    ticket: fixtures.ticket(1),
    messages: [
      {
        id: 'msg-1',
        ticket_id: 'ticket-1',
        sender_id: 'agent-1',
        sender_email: 'agent.one@example.test',
        sender_name: 'Avery Example',
        message_type: 'internal_note',
        body: 'Reproduced on a fixture account.',
        created_at: '2026-10-01T12:00:00Z',
        edited_at: null,
        edited_by: null,
      },
    ],
    events: [],
    attachments: [
      {
        id: 'att-1',
        ticket_id: 'ticket-1',
        message_id: null,
        file_name: 'screenshot.png',
        file_size: 1000,
        file_type: 'image/png',
        storage_path: 'x/att-1',
        uploaded_by: null,
        created_at: '2026-10-01T10:00:00Z',
      },
    ],
    participants: [],
  }));
  return out;
});

vi.mock('@/lib/supabase/server', () => {
  const single = (row: unknown) => {
    const c: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'not', 'is', 'order']) c[m] = () => c;
    c.single = async () => ({ data: row, error: null });
    return c;
  };
  const list = (rows: unknown[]) => {
    const c: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'not', 'order']) c[m] = () => c;
    c.is = () => list([]);
    c.then = (ok: (x: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(ok);
    return c;
  };
  return {
    getAuthenticatedUser: async () => ({
      user: { id: 'agent-1' },
      supabase: {
        rpc: async () => ({ data: true, error: null }),
        from: (t: string) =>
          t === 'internal_roles'
            ? single({ role_id: 'r1' })
            : t === 'organizations'
              ? single({ id: 'org-1', name: 'Invented Brokerage Group', slug: 'invented-brokerage', max_seats: 5, created_at: '2025-01-01T00:00:00Z', organization_plans: [] })
              : list([
                  {
                    user_id: 'u1',
                    role: 'agent',
                    license_status: 'active',
                    joined_at: '2025-01-01T00:00:00Z',
                    users: { id: 'u1', email: 'agent@example.test', display_name: 'Agent Number1', status: 'active', suspended_at: null },
                  },
                ]),
      },
    }),
  };
});

import SupportPage from '@/app/dashboard/support/page';
import MyTicketsPage from '@/app/dashboard/support/my-tickets/page';
import TicketDetailPage from '@/app/dashboard/support/[id]/page';
import { UserResultsTable } from '@/app/dashboard/users/components/UserResultsTable';
import { UserProfileCard } from '@/app/dashboard/users/[id]/components/UserProfileCard';
import { OrganizationsTable } from '@/app/dashboard/organizations/components/OrganizationsTable';
import OrganizationDetailPage from '@/app/dashboard/organizations/[id]/page';

afterEach(cleanup);

const tokens = (el: Element | null | undefined) => (el?.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
const has = (el: Element | null | undefined, ...t: string[]) => expect(tokens(el)).toEqual(expect.arrayContaining(t));

async function tableLoaded(container: HTMLElement) {
  await waitFor(() => {
    if (!container.querySelector('table tbody tr')) throw new Error('table not loaded');
  });
}

describe('C10 wide tables scroll inside their card instead of clipping', () => {
  it('OrganizationsTable', () => {
    const { container } = render(
      <OrganizationsTable
        canEdit
        organizations={[
          { id: 'org-1', name: 'Invented Brokerage Group', slug: 'invented-brokerage', plan_name: 'Pro', plan_tier: 'professional', created_at: '2025-01-01T00:00:00Z', member_count: 3 },
        ]}
      />
    );
    const table = container.querySelector('table');
    expect(table).toBeTruthy();
    has(table!.parentElement, 'overflow-x-auto');
    expect(tokens(table!.parentElement)).not.toContain('overflow-hidden');
  });

  it('UserResultsTable', () => {
    const { container } = render(
      <UserResultsTable
        query="agent"
        isLoading={false}
        error={null}
        users={[
          { id: 'u1', first_name: 'Agent', last_name: 'One', display_name: null, email: 'agent@example.test', avatar_url: null, org_name: 'Invented', org_slug: 'invented', org_role: 'agent', status: 'active', last_login_at: null },
        ]}
      />
    );
    const table = container.querySelector('table');
    expect(table?.querySelector('tbody tr')).toBeTruthy();
    has(table!.parentElement, 'overflow-x-auto');
    expect(tokens(table!.parentElement)).not.toContain('overflow-hidden');
  });
});

describe('C11 page restores: phone token present, desktop tokens kept', () => {
  it('support queue header and filter row', async () => {
    const { container } = render(<SupportPage />);
    await tableLoaded(container);
    const header = screen.getByRole('heading', { name: 'Support' }).closest('.mb-6');
    has(header, 'flex', 'items-center', 'justify-between', 'max-md:flex-wrap', 'max-md:gap-3');
    const filterRow = container.querySelector('.mb-4.items-start');
    has(filterRow, 'flex', 'items-start', 'justify-between', 'gap-4', 'max-md:flex-col', 'max-md:gap-3');
    has(filterRow!.lastElementChild, 'flex', 'items-center', 'gap-2', 'max-md:flex-wrap');
  });

  it('my tickets filter row', async () => {
    const { container } = render(<MyTicketsPage />);
    await tableLoaded(container);
    const filterRow = container.querySelector('.mb-4.items-start');
    has(filterRow, 'flex', 'items-start', 'justify-between', 'gap-4', 'max-md:flex-col', 'max-md:gap-3');
    has(filterRow!.lastElementChild, 'flex', 'items-center', 'gap-2', 'max-md:flex-wrap');
  });

  it('ticket detail: title row, tap targets, note actions visible on touch, reply actions', async () => {
    render(<TicketDetailPage />);
    const h1 = await screen.findByRole('heading', { level: 1 });
    await act(async () => {});
    has(h1, 'text-xl', 'max-md:break-words', 'max-md:w-full');
    has(h1.parentElement, 'flex', 'items-center', 'gap-3', 'max-md:flex-wrap', 'max-md:gap-2');
    has(h1.parentElement!.parentElement, 'flex', 'items-center', 'justify-between', 'max-md:flex-col', 'max-md:items-start', 'max-md:gap-2');
    has(screen.getByRole('button', { name: /Back to Queue/ }), 'max-md:min-h-[44px]');
    has(screen.getByRole('button', { name: /attachments/ }), 'max-md:min-h-[44px]');
    has(screen.getByTitle('Delete ticket'), 'max-md:min-h-[44px]');

    for (const title of ['Edit note', 'Delete note']) {
      const b = screen.getByTitle(title);
      has(b, 'p-1', 'max-md:min-h-[44px]', 'max-md:min-w-[44px]', 'max-md:inline-flex', 'max-md:items-center', 'max-md:justify-center');
      has(b.parentElement, 'opacity-0', 'group-hover:opacity-100', 'max-md:opacity-100');
    }
    const noteHeader = screen.getByTitle('Edit note').closest('.mb-2');
    has(noteHeader, 'flex', 'items-center', 'justify-between', 'max-md:flex-col', 'max-md:items-start', 'max-md:gap-1');
    has(noteHeader!.firstElementChild, 'flex', 'items-center', 'gap-2', 'max-md:flex-wrap');
    has(screen.getByText('agent.one@example.test'), 'max-md:break-all');

    // The composer starts minimized; open it and switch to Reply.
    await act(async () => {
      fireEvent.click(screen.getByText('Click to respond...'));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    });
    const send = screen.getByRole('button', { name: /Send Reply/ });
    has(send, 'inline-flex', 'max-md:min-h-[44px]', 'max-md:justify-center');
    has(send.parentElement, 'flex', 'items-center', 'justify-between', 'max-md:flex-col', 'max-md:items-stretch', 'max-md:gap-2');
  });

  it('user profile: name row wraps, suspend/impersonate are 44px', () => {
    render(
      <UserProfileCard
        canImpersonate
        user={{ id: 'u1', email: 'agent@example.test', display_name: 'Avery Example', avatar_url: null, oauth_provider: 'google', status: 'active', subscription_tier: null, created_at: '2025-01-01T00:00:00Z', last_login_at: null }}
      />
    );
    const nameRow = screen.getByRole('heading', { name: 'Avery Example' }).parentElement;
    has(nameRow, 'flex', 'items-center', 'justify-between', 'gap-3', 'max-md:flex-wrap');
    has(nameRow!.lastElementChild, 'flex', 'items-center', 'gap-2', 'max-md:gap-3');
    has(screen.getByRole('button', { name: /Suspend User/ }), 'max-md:min-h-[44px]');
    has(screen.getByRole('button', { name: /View as User/ }), 'max-md:min-h-[44px]');
  });

  it('organizations list and detail rows wrap', async () => {
    let r = render(
      <OrganizationsTable
        canEdit
        organizations={[{ id: 'org-1', name: 'Invented Brokerage Group', slug: 'invented', plan_name: null, plan_tier: null, created_at: null, member_count: 1 }]}
      />
    );
    has(screen.getByRole('button', { name: /Create Organization/ }).parentElement, 'flex', 'items-center', 'gap-3', 'max-md:flex-wrap');
    r.unmount();

    r = render(await OrganizationDetailPage({ params: Promise.resolve({ id: 'org-1' }) }));
    await act(async () => {});
    has(screen.getByRole('heading', { level: 1, name: 'Invented Brokerage Group' }).parentElement!.parentElement, 'flex', 'items-start', 'gap-4', 'max-md:flex-wrap');
    has(screen.getByRole('link', { name: /Identity Providers/ }).parentElement, 'flex', 'items-center', 'gap-3', 'max-md:flex-wrap');
    r.unmount();
  });
});
