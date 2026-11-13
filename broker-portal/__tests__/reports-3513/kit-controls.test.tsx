/**
 * Report controls are the design-system ones, not native form controls — BACKLOG-3513 PR-3c.
 *
 * The REAL SubmissionsReportFilters, ReportSavedViews and ReportBackLink. Status, Agent and Sort are
 * the kit Dropdown (filter variant, as the admin report filter bars use it), the dates are the kit
 * DateRangePicker, the card column picker is the kit Dropdown. Picking must push exactly the URL
 * the native controls pushed before: same values and params, "all" and "All agents" left out.
 *
 * Pointer-capture / scrollIntoView stubs copied from __tests__/people-sheet-4032/peopleSheet.test.tsx:25-29.
 * Agent ids and names are invented.
 */

import '@testing-library/jest-dom';
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
const mockBack = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, back: mockBack, replace: jest.fn(), refresh: jest.fn() }),
  usePathname: () => '/dashboard/reports/submissions',
  useSearchParams: () => new URLSearchParams(),
}));

import { SubmissionsReportFilters } from '@/components/reports/submissions/SubmissionsReportFilters';
import { ReportSavedViews } from '@/components/reports/ReportSavedViews';
import { ReportBackLink, canGoBackInApp } from '@/components/reports/ReportBackLink';
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

/** The kit Dropdown trigger: a button opening an inline listbox, inside data-slot="dropdown". */
const control = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}\\b`) });
function expectKitDropdown(trigger: HTMLElement) {
  expect(trigger.tagName).toBe('BUTTON');
  expect(trigger).toHaveAttribute('aria-haspopup', 'listbox');
  expect(trigger.closest('[data-slot="dropdown"]')).not.toBeNull();
}

async function pick(name: string, option: string | RegExp) {
  const user = userEvent.setup();
  await user.click(control(name));
  await user.click(await screen.findByRole('option', { name: option }));
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

describe('the report filters render the kit controls', () => {
  it.each([['Status'], ['Agent'], ['Sort']])('%s is the kit Dropdown, not a native select', (name) => {
    const { container } = mount();
    expectKitDropdown(control(name));
    expect(container.querySelector('select')).toBeNull();
  });

  it('the dates are the kit DateRangePicker, not native date inputs', () => {
    const { container } = mount();
    expect(screen.getByRole('button', { name: /^Date range/ })).toHaveAttribute('aria-haspopup', 'dialog');
    expect(container.querySelector('input[type="date"]')).toBeNull();
    expect(container.querySelector('input, select')).toBeNull();
  });

  it('the triggers show the current values', () => {
    mount({ status: 'approved', agent: AGENT_B, sort: 'oldest', from: '2026-10-05', to: '2026-10-15' });
    expect(control('Status')).toHaveTextContent('Approved');
    expect(control('Agent')).toHaveTextContent('Agent Bravo');
    expect(control('Sort')).toHaveTextContent('Oldest first');
    expect(screen.getByRole('button', { name: /^Date range/ })).not.toHaveTextContent('Pick dates');
  });

  it('defaults read All, All agents and Newest first, and no dates', () => {
    mount();
    expect(control('Status')).toHaveTextContent('All');
    expect(control('Agent')).toHaveTextContent('All agents');
    expect(control('Sort')).toHaveTextContent('Newest first');
    expect(screen.getByRole('button', { name: /^Date range/ })).toHaveTextContent('Pick dates');
    expect(screen.queryByRole('button', { name: 'Clear dates' })).toBeNull();
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

  it('a date range applied in the calendar -> ?from=&to=', () => {
    mount({ from: '2026-10-05', to: '2026-10-15' });
    fireEvent.click(screen.getByRole('button', { name: /^Date range/ }));
    fireEvent.click(screen.getByRole('gridcell', { name: 'Thursday, October 1, 2026' }));
    fireEvent.click(screen.getByRole('gridcell', { name: 'Tuesday, October 20, 2026' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(mockPush).toHaveBeenCalledWith('/dashboard/reports/submissions?from=2026-10-01&to=2026-10-20');
  });

  it('Clear dates removes both dates and keeps the rest', () => {
    mount({ from: '2026-10-05', to: '2026-10-15', status: 'approved' });
    fireEvent.click(screen.getByRole('button', { name: 'Clear dates' }));
    expect(mockPush).toHaveBeenCalledWith('/dashboard/reports/submissions?status=approved');
  });

  it('on a shared report the URL keeps its path and status (explicit)', async () => {
    mount({}, { basePath: '/dashboard/reports/d/abc', explicit: true });
    await pick('Sort', 'Oldest first');
    expect(mockPush).toHaveBeenCalledWith('/dashboard/reports/d/abc?status=all&sort=oldest');
  });

  it('an agent caller has no Agent control', () => {
    mount({}, { showAgent: false });
    expect(screen.queryByRole('button', { name: /^Agent\b/ })).toBeNull();
    expect(control('Status')).toBeInTheDocument();
    expect(control('Sort')).toBeInTheDocument();
  });
});

describe('Back (founder: the previous page in this tab, else the Reports index)', () => {
  const ORIGIN = window.location.origin;
  function setHistory(length: number, referrer: string) {
    Object.defineProperty(window.history, 'length', { configurable: true, get: () => length });
    Object.defineProperty(document, 'referrer', { configurable: true, get: () => referrer });
  }

  it('reads "Back" and links to the Reports index', () => {
    render(<ReportBackLink />);
    const link = screen.getByRole('link', { name: 'Back' });
    expect(link).toHaveAttribute('href', '/dashboard/reports');
  });

  it('came from a portal page in this tab: goes back in history', () => {
    setHistory(3, `${ORIGIN}/dashboard/reports`);
    render(<ReportBackLink />);
    const notPrevented = fireEvent.click(screen.getByRole('link', { name: 'Back' }));
    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(notPrevented).toBe(false);
  });

  it('a new tab or a direct link: no history back, the link goes to the Reports index', () => {
    setHistory(1, '');
    render(<ReportBackLink />);
    const notPrevented = fireEvent.click(screen.getByRole('link', { name: 'Back' }));
    expect(mockBack).not.toHaveBeenCalled();
    expect(notPrevented).toBe(true);
  });

  it('the rule itself', () => {
    expect(canGoBackInApp({ historyLength: 2, referrer: 'https://app.example.test/dashboard', origin: 'https://app.example.test' })).toBe(true);
    expect(canGoBackInApp({ historyLength: 1, referrer: 'https://app.example.test/dashboard', origin: 'https://app.example.test' })).toBe(false);
    expect(canGoBackInApp({ historyLength: 4, referrer: 'https://mail.example.test/inbox', origin: 'https://app.example.test' })).toBe(false);
    expect(canGoBackInApp({ historyLength: 4, referrer: '', origin: 'https://app.example.test' })).toBe(false);
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
