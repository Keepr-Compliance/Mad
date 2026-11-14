/**
 * Report controls are the design-system ones, not native form controls — BACKLOG-3513 PR-3c.
 *
 * The REAL SubmissionsReportFilters and ReportBackLink. Status, Agent and Sort are
 * the kit Dropdown (filter variant, as the admin report filter bars use it), the dates are the kit
 * DateRangePicker. Picking must push exactly the URL
 * the native controls pushed before: same values and params, "all" and "All agents" left out.
 *
 * BACKLOG-3513 PR-3h: Status and Agent are the kit Dropdown in multi mode (pill "Status (n)",
 * empty "All statuses" / "All agents", the kit's own clear X). Lists go in the URL as comma lists.
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
import { ReportBackLink, canGoBackInApp } from '@/components/reports/ReportBackLink';
import { DEFAULT_SUBMISSIONS_FILTERS, type SubmissionsReportFilters as Filters } from '@/lib/reports/datasets/submissions-filters';

// pii-allow-uuid: invented fixture ids below (whole block)
const AGENT_A = '00000000-0000-4000-8000-0000003513f1'; // pii-allow-uuid: invented fixture id
const AGENT_B = '00000000-0000-4000-8000-0000003513f2'; // pii-allow-uuid: invented fixture id
const AGENT_C = '00000000-0000-4000-8000-0000003513f3'; // pii-allow-uuid: invented fixture id
const AGENTS = [
  { id: AGENT_A, label: 'Agent Alpha' },
  { id: AGENT_B, label: 'Agent Bravo' },
];

function mount(filters: Partial<Filters> = {}, extra: Partial<React.ComponentProps<typeof SubmissionsReportFilters>> = {}) {
  return render(
    <SubmissionsReportFilters
      filters={{ ...DEFAULT_SUBMISSIONS_FILTERS, ...filters }}
      showAgent
      agents={AGENTS}
      {...extra}
    />
  );
}

/** The kit Dropdown trigger: a button opening an inline listbox, inside data-slot="dropdown". */
const EMPTY: Record<string, string> = { Status: 'All statuses', Agent: 'All agents' };
const control = (name: string) =>
  screen.getByRole('button', { name: new RegExp(`^(${name}\\b${EMPTY[name] ? `|${EMPTY[name]}$` : ''})`) });
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
    mount({ statuses: ['approved', 'rejected'], agents: [AGENT_B], sort: 'oldest', from: '2026-10-05', to: '2026-10-15' });
    expect(control('Status')).toHaveTextContent('Status (2)');
    expect(control('Agent')).toHaveTextContent('Agent (1)');
    expect(control('Sort')).toHaveTextContent('Oldest first');
    expect(screen.getByRole('button', { name: /^Date range/ })).not.toHaveTextContent('Pick dates');
  });

  it('defaults read All statuses, All agents and Newest first, and no dates', () => {
    mount();
    expect(control('Status')).toHaveTextContent('All statuses');
    expect(control('Agent')).toHaveTextContent('All agents');
    expect(control('Sort')).toHaveTextContent('Newest first');
    expect(screen.getByRole('button', { name: /^Date range/ })).toHaveTextContent('Pick dates');
    expect(screen.queryByRole('button', { name: 'Clear dates' })).toBeNull();
  });
});

describe('picking pushes the same URL as before', () => {
  it('Status -> ?status=<value>, page reset, no scroll jump', async () => {
    mount({ page: 3 });
    await pick('Status', 'Approved');
    expect(mockPush).toHaveBeenCalledWith('/dashboard/reports/submissions?status=approved', { scroll: false });
  });

  it('Agent -> ?agent=<id>', async () => {
    mount();
    await pick('Agent', 'Agent Alpha');
    expect(mockPush).toHaveBeenCalledWith(`/dashboard/reports/submissions?agent=${AGENT_A}`, { scroll: false });
  });

  it('no sentinel option: Status has no "All" row, Agent no "All agents" row', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(control('Status'));
    expect(screen.queryByRole('option', { name: /^All$/ })).toBeNull();
    await user.click(control('Status'));
    await user.click(control('Agent'));
    expect(screen.queryByRole('option', { name: 'All agents' })).toBeNull();
    expect(screen.getAllByRole('option')).toHaveLength(2);
  });

  // e. The clear X is the kit's own button (onClear). Mutation (run): drop onClear -> no X, red.
  it('e. the Status clear X pushes the URL without status and keeps the rest', async () => {
    const user = userEvent.setup();
    mount({ statuses: ['approved', 'rejected'], agents: [AGENT_A] });
    await user.click(screen.getByRole('button', { name: 'Clear Status filter' }));
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush.mock.calls[0][0]).toBe(`/dashboard/reports/submissions?agent=${AGENT_A}`);
  });

  it('e. the Agent clear X pushes the URL without agent', async () => {
    const user = userEvent.setup();
    mount({ statuses: ['approved'], agents: [AGENT_A, AGENT_B] });
    await user.click(screen.getByRole('button', { name: 'Clear Agent filter' }));
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush.mock.calls[0][0]).toBe('/dashboard/reports/submissions?status=approved');
  });

  it('no clear X when nothing is picked', () => {
    mount();
    expect(screen.queryByRole('button', { name: /^Clear (Status|Agent) filter$/ })).toBeNull();
  });

  // f / SR-3. `filters` is a server prop and stays stale until the new page arrives; the router is
  // mocked, so nothing re-renders with new props here. Two quick toggles must still push both.
  // Against the naive version (value={filters.statuses}) the second push is ?status=rejected: red (run).
  it('f. toggling Approved then Rejected with no re-render pushes both', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(control('Status'));
    await user.click(screen.getByRole('option', { name: 'Approved' }));
    await user.click(screen.getByRole('option', { name: 'Rejected' }));
    expect(mockPush).toHaveBeenCalledTimes(2);
    expect(mockPush.mock.calls[1][0]).toBe('/dashboard/reports/submissions?status=approved%2Crejected');
    expect(control('Status')).toHaveTextContent('Status (2)');
    // the panel stays open across the toggles
    expect(screen.getByRole('option', { name: 'Approved' })).toHaveAttribute('aria-selected', 'true');
  });

  it('f. two agents toggled with no re-render push both, sorted', async () => {
    const user = userEvent.setup();
    // three agents, so picking two is not "every agent" (SR-4 below)
    mount({}, { agents: [...AGENTS, { id: AGENT_C, label: 'Agent Charlie' }] });
    await user.click(control('Agent'));
    await user.click(screen.getByRole('option', { name: 'Agent Bravo' }));
    await user.click(screen.getByRole('option', { name: 'Agent Alpha' }));
    expect(mockPush.mock.calls[1][0]).toBe(`/dashboard/reports/submissions?agent=${AGENT_A}%2C${AGENT_B}`);
  });

  it('the local selection starts over when the server props change', async () => {
    const user = userEvent.setup();
    const { rerender } = mount();
    await user.click(control('Status'));
    await user.click(screen.getByRole('option', { name: 'Approved' }));
    rerender(<SubmissionsReportFilters filters={{ ...DEFAULT_SUBMISSIONS_FILTERS, statuses: ['rejected'] }} showAgent agents={AGENTS} />);
    expect(control('Status')).toHaveTextContent('Status (1)');
    expect(screen.getByRole('option', { name: 'Rejected' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('option', { name: 'Approved' })).toHaveAttribute('aria-selected', 'false');
  });

  // SR-4. Select all = no filter (statuses and agents), so the 50-agent URL cap never cuts a selection of everyone.
  // Past the 50-agent URL cap, Select all is no agent filter (else the URL would cut the list).
  it('SR-4: Select all of more than 50 agents pushes no agent param', async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 60 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, // pii-allow-uuid: invented fixture ids
      label: `Agent ${String(i).padStart(2, '0')}`,
    }));
    mount({ statuses: ['approved'] }, { agents: many });
    await user.click(control('Agent'));
    await user.click(screen.getByRole('button', { name: 'Select all' }));
    expect(mockPush.mock.calls[0][0]).toBe('/dashboard/reports/submissions?status=approved');
  });

  // SR fix-up 1 (founder QA: the tick looked dead). Mutation (run): the unconditional
  // "every agent -> []" rule -> red.
  it('a small org: Select all keeps both agents ticked and pushes both', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(control('Agent'));
    await user.click(screen.getByRole('button', { name: 'Select all' }));
    expect(mockPush.mock.calls[0][0]).toBe(`/dashboard/reports/submissions?agent=${AGENT_A}%2C${AGENT_B}`);
    expect(control('Agent')).toHaveTextContent('Agent (2)');
    for (const name of ['Agent Alpha', 'Agent Bravo']) expect(screen.getByRole('option', { name })).toHaveAttribute('aria-selected', 'true');
  });

  it('a one-agent org: ticking the only agent keeps it ticked', async () => {
    const user = userEvent.setup();
    mount({}, { agents: [AGENTS[0]] });
    await user.click(control('Agent'));
    await user.click(screen.getByRole('option', { name: 'Agent Alpha' }));
    expect(mockPush.mock.calls[0][0]).toBe(`/dashboard/reports/submissions?agent=${AGENT_A}`);
    expect(control('Agent')).toHaveTextContent('Agent (1)');
    expect(screen.getByRole('option', { name: 'Agent Alpha' })).toHaveAttribute('aria-selected', 'true');
  });

  // SR fix-up 2. Toggle A, toggle B, then A's server response arrives (the only re-render), then a
  // third toggle: B must survive. Mutation (run): reset the local value on any prop change -> red.
  it('A, B, then A response, then a third toggle: nothing is dropped', async () => {
    const user = userEvent.setup();
    const { rerender } = mount();
    await user.click(control('Status'));
    await user.click(screen.getByRole('option', { name: 'Approved' }));
    await user.click(screen.getByRole('option', { name: 'Rejected' }));
    rerender(<SubmissionsReportFilters filters={{ ...DEFAULT_SUBMISSIONS_FILTERS, statuses: ['approved'] }} showAgent agents={AGENTS} />);
    expect(control('Status')).toHaveTextContent('Status (2)');
    expect(screen.getByRole('option', { name: 'Rejected' })).toHaveAttribute('aria-selected', 'true');
    await user.click(screen.getByRole('option', { name: 'New' }));
    expect(mockPush).toHaveBeenCalledTimes(3);
    expect(mockPush.mock.calls[2][0]).toBe('/dashboard/reports/submissions?status=new%2Capproved%2Crejected');
  });

  it('once the server catches up, a later server change (back, another control) shows', async () => {
    const user = userEvent.setup();
    const { rerender } = mount();
    const props = (statuses: string[]) => (
      <SubmissionsReportFilters filters={{ ...DEFAULT_SUBMISSIONS_FILTERS, statuses }} showAgent agents={AGENTS} />
    );
    await user.click(control('Status'));
    await user.click(screen.getByRole('option', { name: 'Approved' }));
    rerender(props(['approved']));
    rerender(props([]));
    expect(control('Status')).toHaveTextContent('All statuses');
  });

  it('SR-4: Select all statuses pushes no status param', async () => {
    const user = userEvent.setup();
    mount({ agents: [AGENT_A] });
    await user.click(control('Status'));
    await user.click(screen.getByRole('button', { name: 'Select all' }));
    expect(mockPush.mock.calls[0][0]).toBe(`/dashboard/reports/submissions?agent=${AGENT_A}`);
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

  // SR R1 (pm_comments 01d1cf6b): a button must not blend into the background (founder rule, PR-3d README).
  it('Clear dates is a bordered secondary button, not ghost', () => {
    mount({ from: '2026-10-05', to: '2026-10-15' });
    const cls = screen.getByRole('button', { name: 'Clear dates' }).className;
    expect(cls).toMatch(/\bborder\b/);
    expect(cls).toMatch(/\bborder-input\b/);
    expect(cls).toMatch(/\bbg-background\b/);
  });

  it('no ghost, link or transparent button anywhere in the broker reports UI', () => {
    const { readdirSync, readFileSync, statSync } = jest.requireActual<typeof import('fs')>('fs');
    const { join } = jest.requireActual<typeof import('path')>('path');
    const portal = join(__dirname, '..', '..');
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : /\.tsx$/.test(n) ? [join(dir, n)] : []));
    const files = [...walk(join(portal, 'components', 'reports')), ...walk(join(portal, 'app', 'dashboard', 'reports'))];
    expect(files.length).toBeGreaterThan(5);
    const offenders = files.filter((f) => /variant=["'{]+(ghost|link)\b|bg-transparent/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('Clear dates removes both dates and keeps the rest', () => {
    mount({ from: '2026-10-05', to: '2026-10-15', statuses: ['approved'] });
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
