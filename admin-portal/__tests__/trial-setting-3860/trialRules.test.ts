/**
 * BACKLOG-3860 PR-3 — the days rule and the state label (control c, e).
 */
import { describe, expect, it } from 'vitest';
import { checkTrialDays, trialChangeLabel, trialStateLabel } from '@/lib/billing/trialSettingRules';
import { ABSENT, AUDIT_ROW, PRESENT_OFF, PRESENT_ON } from './fixtures';

describe('checkTrialDays sweeps the 1-90 boundary', () => {
  it.each(['1', '2', '14', '89', '90', ' 30 ', 1, 90])('accepts %s', (v) => {
    expect(checkTrialDays(v).ok).toBe(true);
  });
  it.each(['0', '91', '', '   ', '-1', '14.5', '1e1', 'abc', '100', 0, 91, -1, 14.5, null, undefined])('refuses %s', (v) => {
    expect(checkTrialDays(v as string).ok).toBe(false);
  });
  it('returns the number it accepted', () => {
    expect(checkTrialDays('7')).toEqual({ ok: true, days: 7 });
  });
});

describe('trialStateLabel', () => {
  it('reads an absent row as Off', () => expect(trialStateLabel(ABSENT)).toBe('Off'));
  it('reads a present off row as Off', () => expect(trialStateLabel(PRESENT_OFF)).toBe('Off'));
  it('reads a present on row as On, 14 days', () => expect(trialStateLabel(PRESENT_ON)).toBe('On, 14 days'));
  it('reads null (unreadable) as Off', () => expect(trialStateLabel(null)).toBe('Off'));
  it('says 1 day, not 1 days', () => expect(trialStateLabel({ enabled: true, days: 1 })).toBe('On, 1 day'));
});

describe('trialChangeLabel', () => {
  it('reads old and new from the audit metadata', () => {
    expect(trialChangeLabel(AUDIT_ROW.metadata)).toBe('Off → On, 14 days');
  });
  it('is null for a row without the shape', () => expect(trialChangeLabel({})).toBeNull());
});
