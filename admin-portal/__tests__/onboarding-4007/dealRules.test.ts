/**
 * BACKLOG-4007 PR-2: pure rules behind the Billing card (start date, deal state, subscription line).
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEAL_STATUS_BADGE,
  checkStartDate,
  dealErrorMessage,
  formatDay,
  startDateEditable,
  subscriptionLine,
} from '@/lib/billing/dealRules';
import { ACTIVE, ACTIVE_DEAL, WAITING, WAITING_DEAL } from './fixtures';

describe('checkStartDate (mirror of _billing_save_deal: business date or later)', () => {
  // Boundary sweep around the business date, including month and year edges.
  it.each([
    ['2026-10-18', '2026-10-19', 'start_date_past'],
    ['2026-10-19', '2026-10-19', null],
    ['2026-10-20', '2026-10-19', null],
    ['2026-09-30', '2026-10-01', 'start_date_past'],
    ['2026-10-01', '2026-10-01', null],
    ['2029-12-31', '2030-01-01', 'start_date_past'],
    ['2030-01-01', '2030-01-01', null],
  ])('%s against business date %s on a new deal -> %s', (value, today, want) => {
    expect(checkStartDate(value, today, null)).toBe(want);
  });
  it('an unchanged date on a waiting deal is not re-checked, even when it has passed', () => {
    expect(checkStartDate('2026-10-01', '2026-10-19', '2026-10-01')).toBeNull();
    expect(checkStartDate('2026-10-02', '2026-10-19', '2026-10-01')).toBe('start_date_past');
  });
  it('a blank or malformed date is refused', () => {
    expect(checkStartDate('', '2026-10-19', null)).toBe('invalid_start_date');
    expect(checkStartDate('10/24/2026', '2026-10-19', null)).toBe('invalid_start_date');
  });
  it('every refusal code has its own sentence', () => {
    for (const code of ['start_date_past', 'start_date_locked', 'invalid_start_date']) {
      expect(dealErrorMessage(code)).not.toBe('Something went wrong. Nothing was saved.');
    }
  });
});

describe('startDateEditable', () => {
  it('new deal and waiting deal: editable; after setup: locked', () => {
    expect(startDateEditable(null)).toBe(true);
    expect(startDateEditable(WAITING_DEAL)).toBe(true);
    for (const status of ['active', 'suspended', 'canceling', 'canceled'] as const) {
      expect(startDateEditable({ ...ACTIVE_DEAL, status })).toBe(false);
    }
  });
});

describe('deal state badge', () => {
  it('draft reads "Waiting for customer setup", active reads "Active"', () => {
    expect(DEAL_STATUS_BADGE.draft).toEqual({ label: 'Waiting for customer setup', hue: 'amber' });
    expect(DEAL_STATUS_BADGE.active).toEqual({ label: 'Active', hue: 'green' });
  });
});

describe('formatDay: a date with no time is not shifted by the time zone', () => {
  const saved = process.env.TZ;
  afterEach(() => { process.env.TZ = saved; });
  it.each(['America/Los_Angeles', 'UTC', 'Pacific/Kiritimati'])('2026-10-24 in %s', (tz) => {
    process.env.TZ = tz;
    expect(formatDay('2026-10-24')).toBe('Oct 24, 2026');
    expect(formatDay('2026-11-01')).toBe('Nov 1, 2026');
  });
  it('missing date', () => {
    expect(formatDay(null)).toBe('Not set');
  });
});

describe('subscriptionLine', () => {
  it('waiting deal: not started, starts at setup or the start date', () => {
    expect(subscriptionLine(WAITING)).toEqual({
      value: 'Not started',
      help: 'Starts when the broker finishes billing setup, or Oct 24, 2026 if later.',
    });
  });
  it('trialing (setup done, start date later): "Billing starts <billing_starts_on>"', () => {
    const b = {
      ...ACTIVE,
      deal: { ...ACTIVE_DEAL, billing_starts_on: '2026-11-01', start_date: '2026-11-01', setup_completed_at: '2026-10-20T18:00:00Z' },
      stripe: { ...ACTIVE.stripe!, status: 'trialing' },
    };
    expect(subscriptionLine(b)).toEqual({ value: 'Billing starts Nov 1, 2026' });
  });
  it('active subscription', () => {
    expect(subscriptionLine(ACTIVE)).toEqual({ value: 'Active' });
  });
  it('no deal: nothing', () => {
    expect(subscriptionLine({ ...ACTIVE, deal: null })).toBeNull();
  });
});
