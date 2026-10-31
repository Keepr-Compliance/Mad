// @vitest-environment jsdom
/**
 * Support SLA report page (BACKLOG-3721)
 *
 * Renders the REAL server page with the real queries, builder and report
 * shell; only the Supabase server client and the router are stubbed. Ticket
 * rows are the transcribed BACKLOG-3651 fixture. Covers the numbers, the
 * minutes-vs-ms discriminator (C2 of 3651), the failed-read path, and the
 * page's own permission gate.
 *
 * BACKLOG-4086: `support_sla_settings` is stubbed as well. The default stub
 * row is the migration's seeded defaults; one test serves NON-default
 * settings so nothing can pass on literals. Every duration is business time.
 */
import React from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_A, NOW, TICKETS, USERS } from '@/lib/reports/__tests__/support-sla.fixture';
import { synthetic } from '@/lib/reports/__tests__/support-sla-attainment.fixture';
import { READ_FAILED_MESSAGE, SLA_SETTINGS_READ_FAILED_MESSAGE, type SupportTicketRow } from '@/lib/reports/support-sla';

/** The migration's seeded row, as PostgREST returns it. */
const DEFAULT_SETTINGS_ROW = {
  first_response_target_minutes: 480,
  resolution_target_business_days: 3,
  business_day_start_minute: 540,
  business_day_end_minute: 1020,
  business_days: [1, 2, 3, 4, 5],
  time_zone: 'America/Los_Angeles',
};

const state = vi.hoisted(() => ({
  user: { id: 'u-1' } as { id: string } | null,
  internalRole: { role_id: 'r1' } as unknown,
  hasPerm: true,
  failTickets: false,
  permAsked: [] as string[],
  tickets: null as SupportTicketRow[] | null,
  settingsRow: null as Record<string, unknown> | null,
  failSettings: false,
  settingsAsked: 0,
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
        maybeSingle: async () => {
          if (table !== 'support_sla_settings') throw new Error(`unexpected maybeSingle on ${table}`);
          state.settingsAsked += 1;
          if (state.failSettings) return { data: null, error: { message: 'relation does not exist' } };
          return { data: state.settingsRow ?? DEFAULT_SETTINGS_ROW, error: null };
        },
        then(resolve: (v: unknown) => unknown) {
          if (table === 'users') return Promise.resolve({ data: USERS, error: null }).then(resolve);
          if (head) return Promise.resolve({ data: null, count: 76, error: null }).then(resolve);
          if (state.failTickets) return Promise.resolve({ data: null, error: { message: 'boom' } }).then(resolve);
          return Promise.resolve({ data: state.tickets ?? TICKETS, error: null }).then(resolve);
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
const subtitle = (key: string) =>
  document.querySelector(`[data-tile="${key}"] p.mt-0\\.5`)?.textContent ?? null;
const howTo = (key: string) => document.querySelector(`[data-howto="${key}"]`)?.textContent ?? '';

const DURATION_TILES = [
  'avg-first-response',
  'fr-median',
  'fr-p90',
  'fr-within-target',
  'avg-resolution',
  'res-median',
  'res-p90',
  'res-within-target',
];

beforeEach(() => {
  state.user = { id: 'u-1' };
  state.internalRole = { role_id: 'r1' };
  state.hasPerm = true;
  state.failTickets = false;
  state.permAsked = [];
  state.tickets = null;
  state.settingsRow = null;
  state.failSettings = false;
  state.settingsAsked = 0;
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

  it('business-time durations: averages with median and p90 (fixture: FR 53m + 24h, RES 3h 15m + 10h 19m)', async () => {
    await renderPage();
    expect(state.settingsAsked).toBe(1);
    expect(tile('avg-first-response')).toBe('12h 27m');
    expect(tile('fr-median')).toBe('12h 27m');
    expect(tile('fr-p90')).toBe('24h');
    expect(tile('avg-resolution')).toBe('6h 47m');
    expect(tile('res-median')).toBe('6h 47m');
    expect(tile('res-p90')).toBe('10h 19m');
    expect(document.querySelector('[data-notice="settings-read-failed"]')).toBeNull();
  });

  it('within-target rates on the created cohort: FR 25% (1 met, 3 missed, 1 awaiting), RES 50%', async () => {
    await renderPage();
    expect(tile('fr-within-target')).toBe('25%');
    expect(subtitle('fr-within-target')).toBe(
      '1 of 4 met · 1 awaiting · target 8 business hours (one working day)'
    );
    expect(tile('res-within-target')).toBe('50%');
    expect(subtitle('res-within-target')).toBe('2 of 4 met · 1 awaiting · target 3 business days');
  });

  it('HowToUse states the stored targets, the window and the founder example', async () => {
    await renderPage();
    expect(howTo('targets')).toContain('first response within 8 business hours (one working day)');
    expect(howTo('targets')).toContain('resolution within 3 business days');
    expect(howTo('window')).toContain('Monday to Friday, 9:00 AM to 5:00 PM Pacific Time; the clock pauses');
    expect(howTo('window')).toContain(
      'A ticket opened Friday at 4:59 PM and answered Monday at 9:00 AM has one minute on the clock.'
    );
    expect(howTo('window')).toContain('Holidays are not excluded.');
    expect(howTo('clock')).toContain('8h is one working day and 24h is three.');
    expect(screen.getByText(/resolved or closed with no agent reply has no first response and counts as missed/)).toBeTruthy();
  });

  it('NON-default stored settings drive the targets, the window and HowToUse (no literals)', async () => {
    state.settingsRow = {
      first_response_target_minutes: 60,
      resolution_target_business_days: 2,
      business_day_start_minute: 480,
      business_day_end_minute: 1080,
      business_days: [1, 2, 3, 4, 5, 6],
      time_zone: 'America/New_York',
    };
    await renderPage();
    expect(subtitle('fr-within-target')).toMatch(/ · target 1 business hour$/);
    expect(subtitle('res-within-target')).toMatch(/ · target 2 business days$/);
    expect(howTo('targets')).toContain('first response within 1 business hour, resolution within 2 business days');
    expect(howTo('window')).toContain('Monday to Saturday, 8:00 AM to 6:00 PM Eastern Time');
    expect(howTo('window')).toContain(
      'A ticket opened Saturday at 5:59 PM and answered Monday at 8:00 AM has one minute on the clock.'
    );
    expect(howTo('clock')).toContain('10h is one working day.');
    expect(document.body.textContent).not.toContain('8 business hours');
    expect(document.body.textContent).not.toContain('3 business days');
  });

  it('settings read fails: every duration and target tile is "-", counts stay, the notice says so', async () => {
    state.failSettings = true;
    await renderPage();
    expect(screen.getByText(SLA_SETTINGS_READ_FAILED_MESSAGE)).toBeTruthy();
    expect(tile('open-now')).toBe('76');
    expect(tile('created')).toBe('5');
    expect(tile('resolved')).toBe('2');
    for (const k of DURATION_TILES) expect([k, tile(k)]).toEqual([k, '-']);
    expect(subtitle('fr-within-target')).toBeNull();
    const tr = screen.getByText('agent-b@example.com').closest('tr')!;
    expect(within(tr).queryByText('24h')).toBeNull();
    expect(howTo('targets')).toBe('The SLA targets could not be read, so times and target rates are not shown.');
    expect(document.body.textContent).not.toContain('8 business hours');
  });

  it('zero business minutes renders "0m" in the cards and the agent columns, not "-"', async () => {
    // Sat 2026-10-24, answered and resolved the same Saturday: 0 business minutes.
    state.tickets = [
      {
        ...synthetic(70, 'resolved', '2026-10-24T11:00:00-07:00', '2026-10-24T11:30:00-07:00', '2026-10-24T12:00:00-07:00'),
        assignee_id: AGENT_A,
      },
    ];
    await renderPage();
    expect(tile('avg-first-response')).toBe('0m');
    expect(tile('avg-resolution')).toBe('0m');
    const tr = screen.getByText('Agent A').closest('tr')!;
    expect(within(tr).getAllByText('0m')).toHaveLength(2);
  });

  it('agent rows: name falls back to email; 74h06m first response is 24 business hours, "24h"', async () => {
    await renderPage();
    const tr = screen.getByText('agent-b@example.com').closest('tr')!;
    expect(within(tr).getByText('24h')).toBeTruthy();
    expect(screen.getByText('Agent A').closest('tr')).toBeTruthy();
    expect(screen.queryByText('Unknown agent')).toBeNull();
  });

  it('a failed read says so and shows no numbers', async () => {
    state.failTickets = true;
    await renderPage();
    expect(screen.getByText(READ_FAILED_MESSAGE)).toBeTruthy();
    for (const k of ['open-now', 'created', 'resolved', ...DURATION_TILES]) {
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
