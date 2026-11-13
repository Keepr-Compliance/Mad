/**
 * Report filters use the kit Select, not a native <select> — BACKLOG-3513 PR-3c.
 *
 * The REAL SubmissionsReportFilters and ReportSavedViews. Each filter must render the @keepr/ui
 * Select (Radix: a <button role="combobox"> with a listbox popup), and picking an option must push
 * exactly the URL the native select pushed before: same values, same params, "all" and "All
 * agents" left out of the URL.
 *
 * Radix needs pointer-capture and scrollIntoView under jsdom; the stubs are copied from
 * __tests__/people-sheet-4032/peopleSheet.test.tsx:25-29 (this portal's jest setup has none).
 * Agent ids and names are invented.
 */

import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

Object.assign(window.HTMLElement.prototype, {
  scrollIntoView: () => undefined,
  hasPointerCapture: () => false,
  releasePointerCapture: () => undefined,
});

jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ rpc: async () => ({ data: [], error: null }) }),
}));
const mockPush = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn(), refresh: jest.fn() }),
  usePathname: () => '/dashboard/reports/submissions',
  useSearchParams: () => new URLSearchParams(),
}));

import { SubmissionsReportFilters } from '@/components/reports/submissions/SubmissionsReportFilters';
import { ReportSavedViews } from '@/components/reports/ReportSavedViews';
import { SUBMISSIONS_REPORT, type ReportDefinition } from '@/lib/reports/registry';
import { DEFAULT_SUBMISSIONS_FILTERS, type SubmissionsReportFilters as Filters } from '@/lib/reports/datasets/submissions-filters';
import type { BrokerViewsApi } from '@/lib/reports/saved-views/broker-views-api';

// pii-allow-uuid: invented fixture ids below (whole block)
const AGENT_A = '00000000-0000-4000-8000-0000003513f1'; // pii-allow-uuid: invented fixture id
const AGENT_B = '00000000-0000-4000-8000-0000003513f2'; // pii-allow-uuid: invented fixture id
const AGENTS = [
  { id: AGENT_A, label: 'Agent Alpha' },
  { id: AGENT_B, label: 'Agent Bravo' },
];

function mount(filters: Partial<Filters> = {}, extra: Partial<React.ComponentProps<typeof SubmissionsReportFilters>> = {}) {
  return render(
    <SubmissionsReportFilters
      orgId="org-fixture-1"
      report={SUBMISSIONS_REPORT}
      filters={{ ...DEFAULT_SUBMISSIONS_FILTERS, ...filters }}
      showAgent
      agents={AGENTS}
      {...extra}
    />
  );
}

/** A kit (Radix) Select trigger: a button with role combobox that opens a listbox. */
function expectKitSelect(trigger: HTMLElement) {
  expect(trigger.tagName).toBe('BUTTON');
  expect(trigger).toHaveAttribute('role', 'combobox');
  expect(trigger).toHaveAttribute('aria-autocomplete', 'none');
}

async function pick(name: string, option: string | RegExp) {
  const user = userEvent.setup();
  await user.click(screen.getByRole('combobox', { name }));
  await user.click(await screen.findByRole('option', { name: option }));
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

describe('the report filters render the kit Select', () => {
  it.each([['Status'], ['Agent'], ['Sort']])('%s is a kit Select (role combobox, not a native select)', (name) => {
    const { container } = mount();
    expectKitSelect(screen.getByRole('combobox', { name }));
    expect(container.querySelector('select')).toBeNull();
  });

  it('the date filters stay date inputs (no kit single-date control)', () => {
    mount();
    expect(screen.getByLabelText('From')).toHaveAttribute('type', 'date');
    expect(screen.getByLabelText('To')).toHaveAttribute('type', 'date');
  });

  it('the triggers show the current values', () => {
    mount({ status: 'approved', agent: AGENT_B, sort: 'oldest' });
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveTextContent('Approved');
    expect(screen.getByRole('combobox', { name: 'Agent' })).toHaveTextContent('Agent Bravo');
    expect(screen.getByRole('combobox', { name: 'Sort' })).toHaveTextContent('Oldest first');
  });

  it('defaults read All, All agents and Newest first', () => {
    mount();
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveTextContent('All');
    expect(screen.getByRole('combobox', { name: 'Agent' })).toHaveTextContent('All agents');
    expect(screen.getByRole('combobox', { name: 'Sort' })).toHaveTextContent('Newest first');
  });
});

describe('picking pushes the same URL as before', () => {
  it('Status -> ?status=<value>, page reset', async () => {
    mount({ page: 3 });
    await pick('Status', 'Approved');
    expect(mockPush).toHaveBeenCalledWith('/dashboard/reports/submissions?status=approved');
  });

  it('Status back to All leaves status out of the URL', async () => {
    mount({ status: 'approved' });
    await pick('Status', /^All$/);
    expect(mockPush).toHaveBeenCalledWith('/dashboard/reports/submissions');
  });

  it('Agent -> ?agent=<id>', async () => {
    mount();
    await pick('Agent', 'Agent Alpha');
    expect(mockPush).toHaveBeenCalledWith(`/dashboard/reports/submissions?agent=${AGENT_A}`);
  });

  it('All agents clears the agent filter (no sentinel in the URL)', async () => {
    mount({ agent: AGENT_A, status: 'approved' });
    await pick('Agent', 'All agents');
    expect(mockPush).toHaveBeenCalledWith('/dashboard/reports/submissions?status=approved');
    expect(mockPush.mock.calls[0][0]).not.toMatch(/__all__|agent=/);
  });

  it('Sort -> ?sort=<key>', async () => {
    mount();
    await pick('Sort', 'Price low to high');
    expect(mockPush).toHaveBeenCalledWith('/dashboard/reports/submissions?sort=price_asc');
  });

  it('on a shared report the URL keeps its path and status (explicit)', async () => {
    mount({}, { basePath: '/dashboard/reports/d/abc', explicit: true });
    await pick('Sort', 'Oldest first');
    expect(mockPush).toHaveBeenCalledWith('/dashboard/reports/d/abc?status=all&sort=oldest');
  });

  it('an agent caller has no Agent control', () => {
    mount({}, { showAgent: false });
    expect(screen.queryByRole('combobox', { name: 'Agent' })).toBeNull();
    expect(screen.getAllByRole('combobox').map((c) => c.getAttribute('aria-label'))).toEqual(['Status', 'Sort']);
  });
});

describe('saved views: the card column picker is the kit Dropdown (inside the Views panel)', () => {
  const REPORT: ReportDefinition = {
    slug: 'fixture-pipeline',
    title: 'Fixture pipeline',
    description: 'Test-only report',
    source: 'fixture',
    access: { roles: ['broker'], agentScoped: true },
    savedView: { filterKeys: ['status'], sortKeys: ['price'], metricColumns: ['deals', 'price'] },
  };

  it('is the kit Dropdown, the panel stays open while picking, and the picked column is the one saved', async () => {
    const api = {
      list: jest.fn().mockResolvedValue([]),
      save: jest.fn().mockResolvedValue({ id: 'new' }),
      remove: jest.fn().mockResolvedValue(undefined),
      setDefault: jest.fn().mockResolvedValue(undefined),
    } satisfies BrokerViewsApi;
    const user = userEvent.setup();
    const { container } = render(
      <ReportSavedViews orgId="org-fixture-1" report={REPORT} current={{ filters: {}, sort: null }} onApply={jest.fn()} api={api} />
    );
    await waitFor(() => expect(api.list).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: /^Views/ }));
    await user.click(await screen.findByText('Save current view as a card'));
    const trigger = screen.getByRole('button', { name: /^Card counts/ });
    expect(trigger).toHaveAttribute('aria-haspopup', 'listbox');
    expect(container.ownerDocument.querySelector('select')).toBeNull();
    expect(trigger).toHaveTextContent('deals');
    await user.click(trigger);
    await user.click(await screen.findByRole('option', { name: 'price' }));
    expect(screen.getByRole('button', { name: /^Card counts/ })).toHaveTextContent('price');
    await user.type(screen.getByLabelText('View name'), 'Mine');
    await user.click(screen.getByRole('button', { name: /Save and pin/ }));
    await waitFor(() => expect(api.save).toHaveBeenCalled());
    expect(api.save.mock.calls[0][0]).toMatchObject({ pinned: true, metric: { col: 'price', fn: 'count' } });
  });
});
