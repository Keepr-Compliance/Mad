/**
 * Saved-view access (BACKLOG-4087): the shared helper, every parser that reads
 * `report_list_saved_views`, and the default-view choice.
 *
 * Row shapes are transcribed from the PR 1 list function
 * (supabase/migrations/20261104200000_backlog_4087_report_view_shares.sql, report_list_saved_views):
 * own rows carry `access: 'owner'` and no `owner_name`; shared rows carry `access: 'viewer' | 'editor'`
 * and `owner_name`, with `pinned` and `is_default` masked false. A database before sharing sends
 * neither field. Names are invented.
 *
 * H  the helper's rule (fails closed)
 * P1 one test per parser: access and owner name are read, shared rows are never default or pinned
 * P3 a shared row is never the initial / default view
 */

import { describe, expect, it } from 'vitest';
import { parseViewAccess } from '../saved-view-access';
import { parseSavedViews } from '../report-views';
import { parseExportSavedViews } from '../exports-views';
import { parseGmSavedViews } from '../google-messages-sync-views';
import { analyticsViews, funnelViews, supportSlaViews } from '../period-only-views';
import { parseSubmissionsSavedViews } from '../submissions-views';
import { parseUserActivitySavedViews } from '../user-activity-views';
import { resolveInitialView } from '../default-view';
import { resolveInitialSavedView } from '../initial-saved-view';
import { resolveReportInitial } from '../report-initial-view';
import { resolveUserActivityInitial } from '../user-activity-views';

const vid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const METRIC = { col: 'runs', fn: 'count' };
const FILTERS = { period: { key: 'month' } };

/** What the PR 1 list function returns: own rows first, then shared rows (masked). */
const OWN = {
  id: vid(1),
  name: 'Mine',
  filters: FILTERS,
  metric: METRIC,
  pinned: true,
  is_default: true,
  created_at: '2026-11-01T00:00:00Z',
  access: 'owner',
};
const SHARED_VIEWER = {
  id: vid(2),
  name: 'From Quinn',
  filters: FILTERS,
  metric: METRIC,
  pinned: false,
  is_default: false,
  created_at: '2026-11-01T00:00:00Z',
  access: 'viewer',
  owner_name: 'Quinn Example',
};
const SHARED_EDITOR = { ...SHARED_VIEWER, id: vid(3), name: 'Edit me', access: 'editor', owner_name: 'Robin Sample' };
/** A shared row whose mask failed: the parser must still refuse the flags. */
const SHARED_UNMASKED = { ...SHARED_VIEWER, id: vid(4), name: 'Unmasked', pinned: true, is_default: true };
const SERVER_ROWS = [OWN, SHARED_VIEWER, SHARED_EDITOR, SHARED_UNMASKED];

describe('H parseViewAccess', () => {
  it('H1 uses owner / viewer / editor as the server sends them', () => {
    expect(parseViewAccess(OWN)).toMatchObject({ access: 'owner', accessFromServer: true, pinned: true, isDefault: true });
    expect(parseViewAccess(OWN).ownerName).toBeUndefined();
    expect(parseViewAccess(SHARED_VIEWER)).toMatchObject({ access: 'viewer', ownerName: 'Quinn Example' });
    expect(parseViewAccess(SHARED_EDITOR)).toMatchObject({ access: 'editor', ownerName: 'Robin Sample' });
  });

  it('H2 fails closed: an unknown access is viewer, never owner', () => {
    for (const access of ['admin', 'OWNER', '', 'superuser', 7, null, true, {}]) {
      const parsed = parseViewAccess({ ...OWN, access });
      expect(parsed.access, String(access)).toBe('viewer');
      expect(parsed.pinned).toBe(false);
      expect(parsed.isDefault).toBe(false);
    }
  });

  it('H3 a row with no access field: owner only when it has no owner name', () => {
    const { access: _ignored, ...legacyOwn } = OWN;
    void _ignored;
    expect(parseViewAccess(legacyOwn)).toMatchObject({ access: 'owner', accessFromServer: false, isDefault: true, pinned: true });
    const { access: _ignored2, ...noAccessShared } = SHARED_UNMASKED;
    void _ignored2;
    expect(parseViewAccess(noAccessShared)).toMatchObject({ access: 'viewer', isDefault: false, pinned: false });
  });

  it('H4 "owner" on a row that carries an owner name (only shared rows do) is viewer', () => {
    expect(parseViewAccess({ ...SHARED_UNMASKED, access: 'owner' })).toMatchObject({
      access: 'viewer',
      isDefault: false,
      pinned: false,
    });
  });

  it('H5 a shared row with a blank owner name still names someone', () => {
    expect(parseViewAccess({ ...SHARED_VIEWER, owner_name: '  ' }).ownerName).toBe('another user');
  });
});

type Parsed = { id: string; access?: string; ownerName?: string; isDefault: boolean; pinned?: boolean; accessFromServer?: boolean };

const PARSERS: [string, (raw: unknown) => Parsed[], boolean][] = [
  ['report-views (iPhone sync)', parseSavedViews, true],
  ['exports-views', parseExportSavedViews, true],
  ['google-messages-sync-views', parseGmSavedViews, false],
  ['period-only-views (funnel, analytics, support SLA)', funnelViews.parseRows, false],
  ['submissions-views', parseSubmissionsSavedViews, false],
  ['user-activity-views', parseUserActivitySavedViews, false],
];

describe('P1 every parser reads access through the helper', () => {
  for (const [label, parse, hasPin] of PARSERS) {
    it(`P1 ${label}`, () => {
      const views = parse(SERVER_ROWS);
      expect(views.map((v) => [v.id, v.access, v.ownerName ?? null])).toEqual([
        [vid(1), 'owner', null],
        [vid(2), 'viewer', 'Quinn Example'],
        [vid(3), 'editor', 'Robin Sample'],
        [vid(4), 'viewer', 'Quinn Example'],
      ]);
      expect(views.every((v) => v.accessFromServer === true)).toBe(true);
      expect(views.map((v) => v.isDefault)).toEqual([true, false, false, false]);
      if (hasPin) expect(views.map((v) => v.pinned)).toEqual([true, false, false, false]);
      // An unknown access from the server fails closed in every parser.
      expect(parse([{ ...OWN, access: 'admin' }])[0]).toMatchObject({ access: 'viewer', isDefault: false });
    });
  }

  it('P1 the period-only factory is the same parser for all three of its reports', () => {
    for (const views of [analyticsViews, supportSlaViews]) {
      expect(views.parseRows([SHARED_VIEWER])[0]).toMatchObject({ access: 'viewer', ownerName: 'Quinn Example' });
    }
  });
});

describe('T1 a viewer row transcribed from the live list function (keepr-test e2e, 2026-11-04)', () => {
  // Captured from report_list_saved_views as the viewer fixture; only the id is swapped for vid(21).
  const LIVE_VIEWER_ROW = {
    id: vid(21),
    name: 'Errors this week',
    access: 'viewer',
    metric: { fn: 'count', col: 'runs' },
    pinned: false,
    filters: { types: [], period: { key: 'week' }, search: '', outcomes: ['error'], platforms: [], stalledOnly: false },
    created_at: '2026-11-04T19:21:47.378643+00:00',
    is_default: false,
    owner_name: 'Olive Owner',
  };

  it('the iPhone parser reads it as a viewer row shared by its owner, apply-only', () => {
    expect(parseSavedViews([LIVE_VIEWER_ROW])[0]).toMatchObject({
      id: vid(21),
      name: 'Errors this week',
      access: 'viewer',
      ownerName: 'Olive Owner',
      accessFromServer: true,
      pinned: false,
      isDefault: false,
      filters: { outcomes: ['error'] },
      period: { key: 'week' },
    });
  });
});

describe('P3 a shared view is never the initial or default view', () => {
  // Fed as PARSED views, so the default-view guard itself is under test (the parser mask is bypassed).
  const sharedDefault = { id: vid(10), isDefault: true, access: 'viewer' as const, period: null };
  const editorDefault = { id: vid(11), isDefault: true, access: 'editor' as const, period: null };
  const ownDefault = { id: vid(12), isDefault: true, access: 'owner' as const, period: null };

  it('P3a resolveInitialView skips shared rows even when flagged', () => {
    expect(resolveInitialView({ params: {}, views: [sharedDefault, editorDefault] })).toBeNull();
    expect(resolveInitialView({ params: {}, views: [sharedDefault, ownDefault] })?.id).toBe(vid(12));
  });

  it('P3b a row with no access is the user own view (fixtures before sharing)', () => {
    expect(resolveInitialView({ params: {}, views: [{ id: vid(13), isDefault: true }] })?.id).toBe(vid(13));
  });

  it('P3c the server-page resolvers open no shared view', async () => {
    const list = async () => [SHARED_UNMASKED];
    const asParsedFlagged = () => [sharedDefault];
    expect((await resolveInitialSavedView({ params: {}, listViews: list, parse: asParsedFlagged })).initialView).toBeNull();
    expect((await resolveReportInitial({}, list, asParsedFlagged)).initialView).toBeNull();
    expect((await funnelViews.resolveInitial({}, list)).initialView).toBeNull();
    expect((await resolveUserActivityInitial({}, list)).initialView).toBeNull();
  });
});
