// @vitest-environment jsdom
/**
 * Support Analytics page (BACKLOG-3651)
 *
 * Renders the real page with the real queries and builder; only the Supabase
 * client is stubbed. Ticket rows are the transcribed fixture. Before this fix
 * the page read field names the database never returned and showed 0 and "-".
 */
import { render, screen, cleanup, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NOW, TICKETS, USERS } from '@/lib/reports/__tests__/support-sla.fixture';
import { READ_FAILED_MESSAGE } from '@/lib/reports/support-sla';

let failTickets = false;

function stubClient() {
  return {
    from(table: string) {
      let head = false;
      const builder: Record<string, unknown> = {
        then(resolve: (v: unknown) => unknown) {
          if (table === 'users') return Promise.resolve({ data: USERS, error: null }).then(resolve);
          if (head) return Promise.resolve({ data: null, count: 76, error: null }).then(resolve);
          if (failTickets) return Promise.resolve({ data: null, error: { message: 'boom' } }).then(resolve);
          return Promise.resolve({ data: TICKETS, error: null }).then(resolve);
        },
      };
      for (const m of ['select', 'neq', 'or', 'order', 'limit', 'in', 'not']) {
        builder[m] = (...args: unknown[]) => {
          if (m === 'select' && (args[1] as { head?: boolean } | undefined)?.head) head = true;
          return builder;
        };
      }
      return builder;
    },
  };
}

vi.mock('@/lib/supabase/client', () => ({ createClient: () => stubClient() }));

import SupportAnalyticsPage from '@/app/dashboard/support/analytics/page';

beforeEach(() => {
  failTickets = false;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function card(label: string) {
  const el = screen.getByText(label, { selector: 'p' });
  return el.parentElement!.parentElement!;
}

describe('Support Analytics page', () => {
  it('shows the exact open count and the period numbers', async () => {
    render(<SupportAnalyticsPage />);
    expect(await screen.findByText('Agent A', {}, { timeout: 2000 })).toBeTruthy();
    expect(within(card('Open now')).getByText('76')).toBeTruthy();
    expect(within(card('Created (30d)')).getByText('5')).toBeTruthy();
    expect(within(card('Resolved (30d)')).getByText('2')).toBeTruthy();
  });

  it('agent rows: name falls back to email; 74h06m first response shows "3d 2h" (C2)', async () => {
    render(<SupportAnalyticsPage />);
    const nameCell = await screen.findByText('agent-b@example.com', {}, { timeout: 2000 });
    const tr = nameCell.closest('tr')!;
    expect(within(tr).getByText('3d 2h')).toBeTruthy();
    expect(screen.queryByText('Unknown agent')).toBeNull();
  });

  it('a failed read says so and shows no numbers (C5)', async () => {
    failTickets = true;
    render(<SupportAnalyticsPage />);
    expect(await screen.findByText(READ_FAILED_MESSAGE, {}, { timeout: 2000 })).toBeTruthy();
    expect(within(card('Open now')).queryByText('0')).toBeNull();
    expect(within(card('Open now')).getByText('-')).toBeTruthy();
  });
});
