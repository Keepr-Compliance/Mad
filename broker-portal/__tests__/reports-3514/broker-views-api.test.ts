/**
 * The broker saved-views adapter (BACKLOG-3514): the four broker RPCs, the
 * organization on every call, rows read against the report spec. Never the
 * admin portal's report_* saved-view functions.
 *
 * @jest-environment node
 */

const rpc = jest.fn();
jest.mock('@/lib/supabase/client', () => ({ createClient: () => ({ rpc }) }));

import type { ReportSavedViewSpec } from '@/lib/reports/registry';
import { createBrokerViewsApi, parseBrokerViews } from '@/lib/reports/saved-views/broker-views-api';

const ORG = 'org-fixture-1';
const SPEC: ReportSavedViewSpec = { filterKeys: ['status'], sortKeys: ['price'], metricColumns: ['deals'] };

beforeEach(() => rpc.mockReset());

describe('createBrokerViewsApi', () => {
  it('list calls broker_report_list_views with the org and the key, and degrades rows', async () => {
    rpc.mockResolvedValue({
      data: [
        { id: 'v1', name: 'Open', filters: { filters: { status: 'open', gone: 1 } }, metric: null, pinned: false, is_default: true },
      ],
      error: null,
    });
    const views = await createBrokerViewsApi(ORG, SPEC).list('pipeline');
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('broker_report_list_views', { p_org: ORG, p_report_key: 'pipeline' });
    expect(views).toEqual([
      {
        id: 'v1',
        name: 'Open',
        pinned: false,
        isDefault: true,
        filters: { status: 'open' },
        sort: null,
        metric: null,
        dropped: ['filter gone'],
      },
    ]);
  });

  it('save sends every argument to broker_report_save_view', async () => {
    rpc.mockResolvedValue({ data: { id: 'new' }, error: null });
    const out = await createBrokerViewsApi(ORG, SPEC).save({
      reportKey: 'pipeline',
      name: 'Card',
      filters: { filters: { status: 'open' }, sort: null },
      metric: { col: 'deals', fn: 'count' },
      pinned: true,
    });
    expect(out).toEqual({ id: 'new' });
    expect(rpc).toHaveBeenCalledWith('broker_report_save_view', {
      p_org: ORG,
      p_report_key: 'pipeline',
      p_name: 'Card',
      p_filters: { filters: { status: 'open' }, sort: null },
      p_metric: { col: 'deals', fn: 'count' },
      p_pinned: true,
      p_id: null,
    });
  });

  it('remove and setDefault call the broker functions with the org', async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    const api = createBrokerViewsApi(ORG, SPEC);
    await api.remove('v1');
    await api.setDefault('pipeline', null);
    expect(rpc.mock.calls).toEqual([
      ['broker_report_delete_view', { p_org: ORG, p_id: 'v1' }],
      ['broker_report_set_default_view', { p_org: ORG, p_report_key: 'pipeline', p_id: null }],
    ]);
  });

  it('never calls an admin report_* saved-view function', async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    const api = createBrokerViewsApi(ORG, SPEC);
    await api.list('pipeline');
    await api.save({ reportKey: 'pipeline', name: 'x', filters: { filters: {}, sort: null }, metric: null, pinned: false });
    await api.remove('v1');
    await api.setDefault('pipeline', 'v1');
    const names = rpc.mock.calls.map((c) => c[0] as string);
    expect(names).toHaveLength(4);
    for (const name of names) expect(name).toMatch(/^broker_report_/);
  });

  it('a refusal rejects with the database error (the hook shows it)', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'Saved view not found' } });
    await expect(createBrokerViewsApi(ORG, SPEC).list('pipeline')).rejects.toEqual({ message: 'Saved view not found' });
  });
});

describe('parseBrokerViews', () => {
  it('skips rows without an id and never throws on junk', () => {
    expect(parseBrokerViews(null, SPEC)).toEqual([]);
    expect(parseBrokerViews([null, 1, 'x', [], { name: 'no id' }, { id: '' }], SPEC)).toEqual([]);
  });
});
