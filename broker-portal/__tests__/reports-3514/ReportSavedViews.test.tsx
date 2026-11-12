/**
 * ReportSavedViews (BACKLOG-3514) against a FIXTURE registry entry. The api is
 * a fake with the real method names.
 */

jest.mock('@/lib/supabase/client', () => ({
  createClient: () => {
    throw new Error('the component test must not reach the Supabase client');
  },
}));

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ReportSavedViews, MAX_PINNED } from '@/components/reports/ReportSavedViews';
import { REPORT_REGISTRY, type ReportDefinition } from '@/lib/reports/registry';
import type { BrokerSavedView, BrokerViewsApi } from '@/lib/reports/saved-views/broker-views-api';
import type { DegradedView, ViewState } from '@/lib/reports/saved-views/degrade';

const FIXTURE_REPORT: ReportDefinition = {
  slug: 'fixture-pipeline',
  title: 'Fixture pipeline',
  description: 'Test-only report',
  source: 'fixture',
  access: { roles: ['broker'], agentScoped: true },
  savedView: { filterKeys: ['status'], sortKeys: ['price'], metricColumns: ['deals', 'price'] },
};

function view(over: Partial<BrokerSavedView> & { id: string; name: string }): BrokerSavedView {
  return { pinned: false, isDefault: false, filters: {}, sort: null, metric: null, dropped: [], ...over };
}

function fakeApi(rows: BrokerSavedView[]) {
  return {
    list: jest.fn().mockResolvedValue(rows),
    save: jest.fn().mockResolvedValue({ id: 'new' }),
    remove: jest.fn().mockResolvedValue(undefined),
    setDefault: jest.fn().mockResolvedValue(undefined),
  } satisfies BrokerViewsApi;
}

const CURRENT: ViewState = { filters: { status: 'open' }, sort: { key: 'price', direction: 'asc' } };

function mount(api: BrokerViewsApi, report: ReportDefinition = FIXTURE_REPORT, onApply = jest.fn()) {
  render(<ReportSavedViews orgId="org-fixture-1" report={report} current={CURRENT} onApply={onApply} api={api} />);
  return { onApply };
}

const openPanel = () => fireEvent.click(screen.getByRole('button', { name: /^Views/ }));

beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

// BACKLOG-3513 PR-3a registered the first production report. The tests below
// still run against FIXTURE_REPORT.
it('the one production report is Submissions, with saved views and no pinned cards', () => {
  expect(REPORT_REGISTRY.map((r) => r.slug)).toEqual(['submissions']);
  expect(REPORT_REGISTRY[0].savedView?.metricColumns).toEqual([]);
});

it('renders nothing for a report without a savedView spec', () => {
  const api = fakeApi([]);
  const { savedView: _omit, ...plain } = FIXTURE_REPORT;
  const { container } = render(
    <ReportSavedViews orgId="o" report={plain} current={CURRENT} onApply={jest.fn()} api={api} />
  );
  expect(container).toBeEmptyDOMElement();
  expect(api.list).not.toHaveBeenCalled();
});

it('lists the caller views; personal only: no Share button', async () => {
  const api = fakeApi([view({ id: 'v1', name: 'Open deals' })]);
  mount(api);
  await waitFor(() => expect(api.list).toHaveBeenCalledWith('fixture-pipeline'));
  openPanel();
  expect(await screen.findByText('Open deals')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^Share / })).toBeNull();
});

it('applying a view with removed keys hands the page only known keys and shows a notice', async () => {
  const stale = view({ id: 'v1', name: 'Old view', filters: { status: 'open' }, dropped: ['filter removedColumn'] });
  const api = fakeApi([stale]);
  const { onApply } = mount(api);
  openPanel();
  fireEvent.click(await screen.findByText('Old view'));
  expect(onApply).toHaveBeenCalledTimes(1);
  const applied = onApply.mock.calls[0][0] as DegradedView;
  expect(applied.filters).toEqual({ status: 'open' });
  expect(applied.filters).not.toHaveProperty('removedColumn');
  expect(screen.getByTestId('saved-view-dropped-notice')).toHaveTextContent('removedColumn');
});

it('the default view opens with the report, once', async () => {
  const api = fakeApi([view({ id: 'v1', name: 'A' }), view({ id: 'v2', name: 'B', isDefault: true, filters: { status: 'won' } })]);
  const { onApply } = mount(api);
  await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
  expect((onApply.mock.calls[0][0] as DegradedView).filters).toEqual({ status: 'won' });
});

it('save current view sends the page state limited to the spec, unpinned, with a metric', async () => {
  const api = fakeApi([]);
  mount(api);
  await waitFor(() => expect(api.list).toHaveBeenCalled());
  openPanel();
  fireEvent.click(await screen.findByText('Save current view'));
  fireEvent.change(screen.getByLabelText('View name'), { target: { value: 'Mine' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Save view/ }));
  });
  expect(api.save).toHaveBeenCalledWith({
    reportKey: 'fixture-pipeline',
    name: 'Mine',
    filters: { filters: { status: 'open' }, sort: { key: 'price', direction: 'asc' } },
    metric: { col: 'deals', fn: 'count' },
    pinned: false,
  });
});

it('pinning a view saves it pinned with a metric; the cap is the kit max', async () => {
  const api = fakeApi([view({ id: 'v1', name: 'Card me' })]);
  mount(api);
  openPanel();
  await screen.findByText('Card me');
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Pin Card me as a card' }));
  });
  expect(api.save).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'v1', pinned: true, metric: { col: 'deals', fn: 'count' } })
  );
  expect(MAX_PINNED).toBe(5);
});

it('a refused write shows the database sentence', async () => {
  const api = fakeApi([view({ id: 'v1', name: 'Card me' })]);
  api.save.mockRejectedValue({ message: 'At most 5 pinned cards per report. Unpin one first.' });
  mount(api);
  openPanel();
  await screen.findByText('Card me');
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Pin Card me as a card' }));
  });
  expect(await screen.findByText(/At most 5 pinned cards/)).toBeInTheDocument();
});

it('make default calls setDefault with the report key and the view id', async () => {
  const api = fakeApi([view({ id: 'v1', name: 'Defaultable' })]);
  mount(api);
  openPanel();
  await screen.findByText('Defaultable');
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Make Defaultable the default' }));
  });
  expect(api.setDefault).toHaveBeenCalledWith('fixture-pipeline', 'v1');
});
