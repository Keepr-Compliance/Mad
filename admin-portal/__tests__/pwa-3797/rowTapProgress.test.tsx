// @vitest-environment jsdom
/**
 * BACKLOG-3797 — tapping a ticket row (router.push, not an <a>) starts the
 * top loading bar; and app/dashboard/loading.tsx exists and renders.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard/support',
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
}));

import { NavigationProgress } from '@/components/pwa/NavigationProgress';
import { TicketTable } from '@/app/dashboard/support/components/TicketTable';
import DashboardLoading from '@/app/dashboard/loading';
import type { SupportTicket } from '@/lib/support-types';

const ticket = {
  id: 't-1',
  ticket_number: 7,
  subject: 'Cannot sign in',
  description: 'd',
  status: 'new',
  priority: 'normal',
  ticket_type: null,
  category_id: null,
  subcategory_id: null,
  requester_id: null,
  requester_email: 'a@example.test',
  requester_name: 'Requester',
  assignee_id: null,
  organization_id: null,
  source_channel: 'web',
  pending_reason: null,
  first_response_at: null,
  resolved_at: null,
  closed_at: null,
  reopened_count: 0,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
} as unknown as SupportTicket;

afterEach(() => {
  cleanup();
  push.mockClear();
});

describe('BACKLOG-3797 row taps start the loading bar', () => {
  it('tapping a ticket row shows the bar in the same event as router.push', () => {
    render(
      <>
        <NavigationProgress />
        <TicketTable tickets={[ticket]} totalCount={1} page={1} pageSize={25} totalPages={1} onPageChange={() => {}} />
      </>,
    );
    expect(screen.queryByTestId('nav-progress')).toBeNull();
    fireEvent.click(screen.getByText('Cannot sign in'));
    expect(push).toHaveBeenCalledWith('/dashboard/support/t-1');
    expect(screen.getByTestId('nav-progress').getAttribute('data-state')).toBe('loading');
  });
});

describe('BACKLOG-3797 app/dashboard/loading.tsx', () => {
  it('exists and renders a status skeleton without data fetching', () => {
    expect(existsSync(resolve(__dirname, '../../app/dashboard/loading.tsx'))).toBe(true);
    render(<DashboardLoading />);
    expect(screen.getByTestId('dashboard-loading').getAttribute('role')).toBe('status');
  });
});
