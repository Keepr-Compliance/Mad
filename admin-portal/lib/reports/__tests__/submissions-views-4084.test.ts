/**
 * Submissions saved views, pure half (BACKLOG-4084 PR D).
 *
 * P1 serialize stores the period KEY, P2 defensive parse, P3 matcher includes
 * the period, I1-I4 the server resolver: explicit URL beats the default (each
 * key alone, views never read), bare URL opens the default with its period,
 * unrelated params do not count, a failed read means no default.
 */

import { describe, expect, it, vi } from 'vitest';
import { resolvePeriod } from '../period';
import { EMPTY_SUBMISSION_FILTERS } from '../submissions';
import { parseSubmissionsSavedView, parseSubmissionsSavedViews, resolveSubmissionsInitial, serializeSubmissionsView, submissionsViewMatchesState } from '../submissions-views';

const NOW = new Date('2026-10-04T12:00:00.000Z');

/** report_list_saved_views output shape. */
const RAW_DEFAULT = {
  id: 'view-default-1',
  name: 'Mine',
  filters: { statuses: ['failed'], orgs: ['org-a'], agents: ['user-1'], reasons: [], platforms: ['darwin'], search: 'x', period: { key: 'last-month' } },
  metric: { col: 'attempts', fn: 'count' },
  pinned: false,
  is_default: true,
  created_at: '2026-10-01T00:00:00.000Z',
};
const RAW_OTHER = { ...RAW_DEFAULT, id: 'view-other-1', name: 'Other', is_default: false };

describe('P1 serialize', () => {
  it('stores the preset key, never resolved bounds', () => {
    const period = resolvePeriod({ period: 'week' }, NOW);
    const out = serializeSubmissionsView({ ...EMPTY_SUBMISSION_FILTERS, statuses: ['committed'], search: '  q  ' }, period);
    expect(out.period).toEqual({ key: 'week' });
    expect(out.search).toBe('q');
    expect(out.statuses).toEqual(['committed']);
  });

  it('stores a custom range as its two dates', () => {
    const period = resolvePeriod({ period: 'custom', from: '2026-10-01', to: '2026-10-03' }, NOW);
    expect(serializeSubmissionsView(EMPTY_SUBMISSION_FILTERS, period).period).toEqual({ key: 'custom', from: '2026-10-01', to: '2026-10-03' });
  });

  it('caps the search at 200 characters', () => {
    const period = resolvePeriod({ period: 'week' }, NOW);
    expect(serializeSubmissionsView({ ...EMPTY_SUBMISSION_FILTERS, search: 'a'.repeat(300) }, period).search).toHaveLength(200);
  });
});

describe('P2 parse', () => {
  it('reads a row', () => {
    expect(parseSubmissionsSavedView(RAW_DEFAULT)).toEqual({
      id: 'view-default-1',
      name: 'Mine',
      filters: { statuses: ['failed'], orgs: ['org-a'], agents: ['user-1'], reasons: [], platforms: ['darwin'], search: 'x' },
      period: { key: 'last-month' },
      isDefault: true,
    });
  });

  it('missing is_default reads as not default; junk filters read as no filter; no id is skipped', () => {
    const { is_default: _drop, ...noFlag } = RAW_DEFAULT;
    void _drop;
    expect(parseSubmissionsSavedView(noFlag)?.isDefault).toBe(false);
    expect(parseSubmissionsSavedView({ ...RAW_OTHER, filters: 'junk' })?.filters).toEqual(EMPTY_SUBMISSION_FILTERS);
    expect(parseSubmissionsSavedViews([RAW_DEFAULT, { name: 'no id' }, null])).toHaveLength(1);
  });

  it('an unknown or malformed period reads as none', () => {
    for (const period of [{ key: 'fortnight' }, { key: 'custom', from: '2026-13-01', to: '2026-10-02' }, { key: 'custom', from: '2026-10-05', to: '2026-10-01' }, 'week']) {
      expect(parseSubmissionsSavedView({ ...RAW_DEFAULT, filters: { ...RAW_DEFAULT.filters, period } })?.period).toBeNull();
    }
  });
});

describe('P3 matcher includes the period', () => {
  it('same filters, other period -> no match; same period -> match', () => {
    const view = parseSubmissionsSavedView(RAW_DEFAULT)!;
    expect(submissionsViewMatchesState(view, view.filters, resolvePeriod({ period: 'last-month' }, NOW))).toBe(true);
    expect(submissionsViewMatchesState(view, view.filters, resolvePeriod({ period: 'week' }, NOW))).toBe(false);
    expect(submissionsViewMatchesState(view, { ...view.filters, search: 'other' }, resolvePeriod({ period: 'last-month' }, NOW))).toBe(false);
  });
});

describe('I1 an explicit URL beats the default and the views are not read', () => {
  for (const params of [{ period: 'week' }, { from: '2026-10-01' }, { to: '2026-10-02' }, { period: '' }]) {
    it(JSON.stringify(params), async () => {
      const listViews = vi.fn().mockResolvedValue([RAW_DEFAULT]);
      const out = await resolveSubmissionsInitial(params, listViews);
      expect(listViews).not.toHaveBeenCalled();
      expect(out.initialView).toBeNull();
      expect(out.periodInput.period).toBe(params.period);
    });
  }
});

describe('I2 a bare URL opens the default with its period', () => {
  it('default view and its stored period', async () => {
    const out = await resolveSubmissionsInitial({}, async () => [RAW_OTHER, RAW_DEFAULT]);
    expect(out.initialView?.id).toBe('view-default-1');
    expect(out.periodInput).toEqual({ period: 'last-month' });
  });

  it('no default -> no view, built-in period', async () => {
    const out = await resolveSubmissionsInitial({}, async () => [RAW_OTHER]);
    expect(out.initialView).toBeNull();
    expect(out.periodInput).toEqual({ period: undefined, from: undefined, to: undefined });
  });
});

describe('I3 unrelated params do not count', () => {
  it('error= still opens the default', async () => {
    const out = await resolveSubmissionsInitial({ error: 'x' }, async () => [RAW_DEFAULT]);
    expect(out.initialView?.id).toBe('view-default-1');
  });
});

describe('I4 a failed read means no default', () => {
  it('rejection -> null, built-in period', async () => {
    const out = await resolveSubmissionsInitial({}, async () => {
      throw new Error('read failed');
    });
    expect(out.initialView).toBeNull();
    expect(out.periodInput.period).toBeUndefined();
  });
});
