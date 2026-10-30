// @vitest-environment jsdom
/**
 * Support SLA report page (BACKLOG-3721)
 *
 * Renders the REAL server page with the real queries, builder and report
 * shell; only the Supabase server client and the router are stubbed. Ticket
 * rows are the transcribed BACKLOG-3651 fixture. Covers the numbers, the
 * minutes-vs-ms discriminator (C2 of 3651), the failed-read path, and the
 * page's own permission gate.
 */
import React from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NOW, TICKETS, USERS } from '@/lib/reports/__tests__/support-sla.fixture';
import { READ_FAILED_MESSAGE } from '@/lib/reports/support-sla';

const state = vi.hoisted(() => ({
  user: { id: 'u-1' } as { id: string } | null,
  internalRole: { role_id: 'r1' } as unknown,
  hasPerm: true,
  failTickets: false,
  permAsked: [] as string[],
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));

function stubSupabase() {
  return {
    rpc: async (_fn: string, args: { required_permission: string }) => {
      state.permAsked.push(args.required_permission);
      return { data: state.hasPerm, error: null };
    },
    from(table: string) {
      let head = false;
      const builder: Record<string, unknown> = {
        single: async () => ({ data: state.internalRole, error: null }),
        then(resolve: (v: unknown) => unknown) {
          if (table === 'users') return Promise.resolve({ data: USERS, error: null }).then(resolve);
          if (head) return Promise.resolve({ data: null, count: 76, error: null }).then(resolve);
          if (state.failTickets) return Promise.resolve({ data: null, error: { message: 'boom' } }).then(resolve);
          return Promise.resolve({ data: TICKETS, error: null }).then(resolve);
        },
      };
      for (const m of ['select', 'eq', 'neq', 'or', 'order', 'limit', 'in', 'not']) {
        builder[m] = (...args: unknown[]) => {
          if (m === 'select' && (args[1] as { head?: boolean } | undefined)?.head) head = true;
          return builder;
        };
      }
      return builder;
    },
  };
}

vi.mock('@/lib/supabase/server', () => ({
  getAuthenticatedUser: async () => ({ user: state.user, supabase: stubSupabase() }),
}));

import SupportSlaReportPage from '@/app/dashboard/reports/support-sla/page';

/** Same window as the 3651 fixture's 30 days: [2026-09-30, 2026-10-30). */
const LAST_30 = { period: 'custom', from: '2026-09-30', to: '2026-10-29' };

async function renderPage(params: Record<string, string> = LAST_30) {
  render(await SupportSlaReportPage({ searchParams: Promise.resolve(params) }));
}

const tile = (key: string) =>
  document.querySelector(`[data-tile-value="${key}"]`)?.textContent ?? null;

beforeEach(() => {
  state.user = { id: 'u-1' };
  state.internalRole = { role_id: 'r1' };
  state.hasPerm = true;
  state.failTickets = false;
  state.permAsked = [];
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Support SLA report page', () => {
  it('shows the exact open count and the period numbers', async () => {
    await renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'Support SLA' })).toBeTruthy();
    expect(tile('open-now')).toBe('76');
    expect(tile('created')).toBe('5');
    expect(tile('resolved')).toBe('2');
    expect(screen.getByText(/Sep 30 to Oct 29/)).toBeTruthy();
  });

  it('agent rows: name falls back to email; 74h06m first response shows "3d 2h"', async () => {
    await renderPage();
    const tr = screen.getByText('agent-b@example.com').closest('tr')!;
    expect(within(tr).getByText('3d 2h')).toBeTruthy();
    expect(screen.getByText('Agent A').closest('tr')).toBeTruthy();
    expect(screen.queryByText('Unknown agent')).toBeNull();
  });

  it('a failed read says so and shows no numbers', async () => {
    state.failTickets = true;
    await renderPage();
    expect(screen.getByText(READ_FAILED_MESSAGE)).toBeTruthy();
    for (const k of ['open-now', 'created', 'resolved', 'avg-first-response', 'avg-resolution']) {
      expect(tile(k)).toBe('-');
    }
  });

  it('asks for analytics.view and sends a user without it to the dashboard', async () => {
    state.hasPerm = false;
    await expect(renderPage()).rejects.toThrow('redirect:/dashboard?error=insufficient_permissions');
    expect(state.permAsked).toEqual(['analytics.view']);
  });

  it('a signed-in user with no internal role is not authorised', async () => {
    state.internalRole = null;
    await expect(renderPage()).rejects.toThrow('redirect:/login?error=not_authorized');
  });

  it('signed out goes to login', async () => {
    state.user = null;
    await expect(renderPage()).rejects.toThrow('redirect:/login');
  });
});
