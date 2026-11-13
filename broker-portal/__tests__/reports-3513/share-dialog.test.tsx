/**
 * Shared report Share dialog — BACKLOG-3513 PR-3b.
 *
 * The REAL BrokerReportShareButton on the REAL kit SharingDialog, through the
 * REAL browser api (lib/reports/sharing/sharing-api.ts); only the browser
 * client's rpc is faked. Raw replies are transcribed from migration
 * 20261112200000:
 *  - broker_report_share_list: {owner {id, name, role, is_you}, general_access,
 *    row_scope, level, entries [{kind, id, name, detail, level}]}, entries
 *    ordered kind DESC (roles first); person detail = the raw role; a same-level
 *    admin + it_admin pair reads back as ONE {kind 'role', id 'admins'}.
 *  - broker_report_share_candidates: {people [...], roles [agent, broker, admins]};
 *    every active member of the org, the owner included; never an email.
 *  - broker_report_def_get: {id, organization_id, dataset_key, name, description,
 *    definition, row_scope, general_access, level, owner {name, is_you}, updated_at}.
 * Names and ids are invented.
 */

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';

// pii-allow-uuid: invented fixture ids below (whole block)
const DEF = '00000000-0000-4000-8000-0000003513b1'; // pii-allow-uuid: invented fixture id
const ORG = '00000000-0000-4000-8000-0000003513b0'; // pii-allow-uuid: invented fixture id
const OWNER = '00000000-0000-4000-8000-0000003513b2'; // pii-allow-uuid: invented fixture id
const BO = '00000000-0000-4000-8000-0000003513b3'; // pii-allow-uuid: invented fixture id
const CAL = '00000000-0000-4000-8000-0000003513b4'; // pii-allow-uuid: invented fixture id
const DEE = '00000000-0000-4000-8000-0000003513b5'; // pii-allow-uuid: invented fixture id
const ORG_NAME = 'Maple Realty';
const UPDATED_AT = '2026-11-12T10:00:00.123456+00:00';

type Rpc = (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
const mockRpc = jest.fn<ReturnType<Rpc>, Parameters<Rpc>>();
jest.mock('@/lib/supabase/client', () => ({ createClient: () => ({ rpc: mockRpc }) }));
const mockRefresh = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: mockRefresh }),
}));

import {
  BrokerReportShareButton,
  SHARE_DESCRIPTION,
  generalAccessOptions,
} from '@/components/reports/BrokerReportShareButton';
import { parseCandidates, parseShareState, reportSharingApi, type ReportLevel, type ReportSharingApi, type ShareState } from '@/lib/reports/sharing/sharing-api';

function shareList(level: ReportLevel, over: Record<string, unknown> = {}) {
  return {
    owner: { id: OWNER, name: 'Avery Quinn', role: 'broker', is_you: level === 'owner' },
    general_access: 'restricted',
    row_scope: 'all',
    level,
    entries: [
      { kind: 'role', id: 'admins', name: 'All admins', detail: null, level: 'viewer' },
      { kind: 'person', id: BO, name: 'Bo Larkspur', detail: 'agent', level: level === 'editor' ? 'editor' : 'viewer' },
    ],
    ...over,
  };
}

const CANDIDATES = {
  people: [
    { kind: 'person', id: OWNER, name: 'Avery Quinn', detail: 'Broker' },
    { kind: 'person', id: BO, name: 'Bo Larkspur', detail: 'Agent' },
    { kind: 'person', id: CAL, name: 'Cal Moreno', detail: 'Broker' },
    { kind: 'person', id: DEE, name: 'Dee Okafor', detail: 'IT Admin' },
  ],
  roles: [
    { kind: 'role', id: 'agent', name: 'All agents', detail: '3 people' },
    { kind: 'role', id: 'broker', name: 'All brokers', detail: '2 people' },
    { kind: 'role', id: 'admins', name: 'All admins', detail: '2 people' },
  ],
};

function defGet(level: ReportLevel) {
  return {
    id: DEF,
    organization_id: ORG,
    dataset_key: 'submissions',
    name: 'Q4 deals',
    description: null,
    definition: { filters: { status: 'approved' }, sort: null },
    row_scope: 'all',
    general_access: 'restricted',
    level,
    owner: { name: 'Avery Quinn', is_you: level === 'owner' },
    updated_at: UPDATED_AT,
  };
}

function given(level: ReportLevel, listOver: Record<string, unknown> = {}) {
  mockRpc.mockImplementation(async (name) => {
    if (name === 'broker_report_share_list') return { data: shareList(level, listOver), error: null };
    if (name === 'broker_report_share_candidates') return { data: CANDIDATES, error: null };
    if (name === 'broker_report_def_get') return { data: defGet(level), error: null };
    return { data: { success: true }, error: null };
  });
}

const shareButton = () => screen.queryByRole('button', { name: 'Share Q4 deals' });
const writes = () => mockRpc.mock.calls.filter(([n]) => !/_(list|candidates|get)$/.test(n));

async function openAs(level: ReportLevel, listOver: Record<string, unknown> = {}, api?: ReportSharingApi) {
  given(level, listOver);
  render(<BrokerReportShareButton defId={DEF} name="Q4 deals" orgName={ORG_NAME} level={level} {...(api ? { api } : {})} />);
  fireEvent.click(shareButton()!);
  const dialog = await screen.findByRole('dialog', { name: 'Share “Q4 deals”' });
  await waitFor(() => expect(dialog.querySelector('[data-slot="sharing-owner"]')).toBeTruthy());
  // The definition read enables the row-scope radios.
  await waitFor(() => expect(within(dialog).getByRole('radio', { name: 'Only their own Applies to people with Can view.' })).toBeEnabled());
  return dialog;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

describe('U1 who sees Share', () => {
  it.each([['viewer' as const], [null]])('level %s: no Share button', (level) => {
    given('viewer');
    render(<BrokerReportShareButton defId={DEF} name="Q4 deals" orgName={ORG_NAME} level={level} />);
    expect(shareButton()).toBeNull();
  });

  it.each([['owner' as const], ['editor' as const]])('level %s: Share', (level) => {
    given(level);
    render(<BrokerReportShareButton defId={DEF} name="Q4 deals" orgName={ORG_NAME} level={level} />);
    expect(shareButton()).toBeInTheDocument();
  });
});

describe('U2 Make owner is for the owner only', () => {
  it('owner: a person row offers "Make owner…", and the confirm calls broker_report_transfer', async () => {
    const dialog = await openAs('owner');
    fireEvent.click(within(dialog).getByRole('button', { name: /^Access for Bo Larkspur: / }));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: /^Make owner/ }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Make Bo Larkspur the owner' })).getByRole('button', { name: 'Make owner' }));
    await waitFor(() => expect(writes()).toEqual([['broker_report_transfer', { p_def: DEF, p_new_owner: BO }]]));
  });

  it('editor: no "Make owner…" on any row', async () => {
    const dialog = await openAs('editor');
    fireEvent.click(within(dialog).getByRole('button', { name: /^Access for Bo Larkspur: / }));
    expect(within(screen.getByRole('menu')).queryByRole('menuitem', { name: /Make owner/ })).toBeNull();
    expect(within(screen.getByRole('menu')).getByRole('menuitem', { name: /^Remove access$/ })).toBeInTheDocument();
  });

  it('after the owner hands the report over, the next read says editor and Make owner is gone', async () => {
    const dialog = await openAs('owner');
    given('editor');
    fireEvent.click(within(dialog).getByRole('button', { name: /^Access for Bo Larkspur: / }));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: /^Make owner/ }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Make Bo Larkspur the owner' })).getByRole('button', { name: 'Make owner' }));
    await waitFor(() => expect(mockRpc.mock.calls.filter(([n]) => n === 'broker_report_share_list')).toHaveLength(2));
    await waitFor(() => expect(dialog.querySelector('[data-slot="sharing-owner"]')).toHaveTextContent('Avery Quinn'));
    fireEvent.click(within(dialog).getByRole('button', { name: /^Access for Bo Larkspur: / }));
    expect(within(screen.getByRole('menu')).queryByRole('menuitem', { name: /Make owner/ })).toBeNull();
  });
});

describe('U4 row scope: default all, and editors may change it (founder V7a)', () => {
  it('"All rows they can already see" is checked by default', async () => {
    const dialog = await openAs('owner');
    expect(within(dialog).getByRole('radio', { name: 'All rows they can already see' })).toBeChecked();
    expect(within(dialog).getByText('What each person sees')).toBeInTheDocument();
  });

  it('an editor changes it: one broker_report_def_update with every stored field and the read updated_at', async () => {
    const dialog = await openAs('editor');
    const own = within(dialog).getByRole('radio', { name: 'Only their own Applies to people with Can view.' });
    expect(own).toBeEnabled();
    fireEvent.click(own);
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual([
      'broker_report_def_update',
      {
        p_def: DEF,
        p_name: 'Q4 deals',
        p_description: null,
        p_definition: { filters: { status: 'approved' }, sort: null },
        p_row_scope: 'own',
        p_expected_updated_at: UPDATED_AT,
      },
    ]);
  });

  it('a stored "own" reads back checked', async () => {
    const dialog = await openAs('editor', { row_scope: 'own' });
    expect(within(dialog).getByRole('radio', { name: 'Only their own Applies to people with Can view.' })).toBeChecked();
  });
});

describe('targets: people and three roles; "All admins" is one entry', () => {
  it('the picker offers exactly All agents, All brokers, All admins as roles, never the owner', async () => {
    const dialog = await openAs('owner', { entries: [] });
    fireEvent.keyDown(within(dialog).getByRole('combobox', { name: 'Add people or roles' }), { key: 'ArrowDown' });
    const options = screen.getAllByRole('option').map((o) => o.textContent ?? '');
    expect(options.filter((t) => /^Role:/.test(t))).toEqual([
      expect.stringMatching(/^Role: All agents/),
      expect.stringMatching(/^Role: All brokers/),
      expect.stringMatching(/^Role: All admins/),
    ]);
    expect(options.filter((t) => /admin/i.test(t) && /^Role:/.test(t))).toHaveLength(1);
    expect(options.some((t) => t.includes('Avery Quinn'))).toBe(false);
  });

  it('a shared-with-admins report lists one "All admins" row', async () => {
    const dialog = await openAs('owner');
    const rows = within(dialog).getAllByRole('button', { name: /^Access for / }).map((b) => b.getAttribute('aria-label'));
    expect(rows.filter((r) => /admins/i.test(r ?? ''))).toEqual(['Access for role All admins: Can view']);
  });

  it('U3 two people and one role picked -> ONE broker_report_share_set with all three principals', async () => {
    const dialog = await openAs('owner', { entries: [] });
    const field = within(dialog).getByRole('combobox', { name: 'Add people or roles' });
    await waitFor(() => expect(field).toBeEnabled());
    fireEvent.change(field, { target: { value: 'Bo' } });
    fireEvent.click(screen.getByRole('option', { name: /Bo Larkspur/ }));
    fireEvent.change(field, { target: { value: 'Cal' } });
    fireEvent.click(screen.getByRole('option', { name: /Cal Moreno/ }));
    fireEvent.change(field, { target: { value: 'admins' } });
    fireEvent.click(screen.getByRole('option', { name: /All admins/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Share' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual([
      'broker_report_share_set',
      {
        p_def: DEF,
        p_principals: [
          { kind: 'person', id: BO },
          { kind: 'person', id: CAL },
          { kind: 'role', id: 'admins' },
        ],
        p_level: 'viewer',
      },
    ]);
    for (let i = 0; i < 10; i++) await act(async () => await Promise.resolve());
    expect(writes()).toHaveLength(1);
  });

  it('removing the admins role sends kind role, id admins', async () => {
    const dialog = await openAs('owner');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Access for role All admins: Can view' }));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: /^Remove access$/ }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Remove access for Role: All admins' })).getByRole('button', { name: 'Remove access' }));
    await waitFor(() => expect(writes()).toEqual([['broker_report_share_remove', { p_def: DEF, p_kind: 'role', p_id: 'admins' }]]));
  });
});

describe('no emails anywhere', () => {
  it('the add field reads "Name or role", and the dialog shows no address and no "email"', async () => {
    const dialog = await openAs('owner');
    expect(within(dialog).getByRole('combobox', { name: 'Add people or roles' })).toHaveAttribute('placeholder', 'Name or role');
    fireEvent.keyDown(within(dialog).getByRole('combobox', { name: 'Add people or roles' }), { key: 'ArrowDown' });
    const text = `${dialog.textContent ?? ''} ${screen.getAllByRole('option').map((o) => o.textContent).join(' ')}`;
    expect(text).not.toMatch(/@/);
    expect(text).not.toMatch(/e-?mail/i);
  });

  // Not a producer shape: the migration never sends an email. This pins that the mapper passes only the
  // kit's keys, so an address added to a reply later could not reach the dialog.
  it('the parsers keep only the kit keys: an email key in a reply never reaches a row', () => {
    const withEmail = (r: Record<string, unknown>) => ({ ...r, email: 'bo@example.test' });
    const picked = parseCandidates({ people: CANDIDATES.people.map(withEmail), roles: CANDIDATES.roles });
    const listed = parseShareState({ ...shareList('owner'), entries: shareList('owner').entries.map(withEmail) }).entries;
    for (const row of [...picked, ...listed]) {
      expect(Object.keys(row).every((k) => ['id', 'kind', 'name', 'detail', 'level'].includes(k))).toBe(true);
      expect(JSON.stringify(row)).not.toMatch(/@/);
    }
  });

  it('person rows read the role label, not the raw role', async () => {
    const dialog = await openAs('owner');
    expect(within(dialog).getByText('Agent')).toBeInTheDocument();
    expect(within(dialog).queryByText('agent')).toBeNull();
  });
});

describe('owner row', () => {
  it('shows the owner with their role; the viewer of the dialog reads (You)', async () => {
    const dialog = await openAs('owner');
    const owner = dialog.querySelector('[data-slot="sharing-owner"]')!;
    expect(owner).toHaveTextContent('Avery Quinn (You)');
    expect(owner).toHaveTextContent('Broker');
    expect(owner).toHaveTextContent('Owner');
  });

  it('a deactivated owner stays owner and reads Deactivated', async () => {
    const dialog = await openAs('editor', { owner: { id: OWNER, name: 'Avery Quinn', role: null, is_you: false } });
    const owner = dialog.querySelector('[data-slot="sharing-owner"]')!;
    expect(owner).toHaveTextContent('Avery Quinn');
    expect(owner).toHaveTextContent('Deactivated');
    expect(owner).toHaveTextContent('Owner');
  });
});

describe('general access', () => {
  it('"Everyone in <org>" carries the fixed description while selected', async () => {
    const dialog = await openAs('owner', { general_access: 'organization' });
    expect(within(dialog).getByText('Anyone in Maple Realty can view it. Agents see only their own rows.')).toBeInTheDocument();
    expect(generalAccessOptions(ORG_NAME)).toEqual([
      { value: 'restricted', label: 'Only people added' },
      {
        value: 'organization',
        label: 'Everyone in Maple Realty',
        description: 'Anyone in Maple Realty can view it. Agents see only their own rows.',
      },
    ]);
  });

  it('the copy under the title is short and fixed', async () => {
    const dialog = await openAs('owner');
    expect(within(dialog).getByText(SHARE_DESCRIPTION)).toBeInTheDocument();
    expect(SHARE_DESCRIPTION).toBe('People you add can open this report.');
  });
});

// Copied from admin-portal __tests__/report-access-4144/share-button.test.tsx H5 (SR R1, pm_comments cb3517d7).
describe('U5 the latest read wins', () => {
  function deferred<T>() {
    let resolve: (v: T) => void = () => undefined;
    const promise = new Promise<T>((res) => (resolve = res));
    return { promise, resolve };
  }

  it('change Cal (re-read 1 held), remove Bo (re-read 2 held), re-read 2 lands, then the older re-read 1: Bo stays gone', async () => {
    const base = (entries: ShareState['entries']): ShareState => ({
      owner: { id: OWNER, name: 'Avery Quinn', role: 'broker', isYou: true },
      generalAccess: 'restricted',
      rowScope: 'all',
      level: 'owner',
      entries,
    });
    const boE = { kind: 'person' as const, id: BO, name: 'Bo Larkspur', level: 'viewer' as const };
    const calE = { kind: 'person' as const, id: CAL, name: 'Cal Moreno', level: 'viewer' as const };
    const r1 = deferred<ShareState>();
    const r2 = deferred<ShareState>();
    const answers = [Promise.resolve(base([boE, calE])), r1.promise, r2.promise];
    const api: ReportSharingApi = {
      ...reportSharingApi,
      state: jest.fn(() => answers.shift() ?? new Promise<ShareState>(() => undefined)),
      candidates: jest.fn(async () => []),
      definition: jest.fn(async () => null),
      share: jest.fn(async () => {}),
      remove: jest.fn(async () => {}),
    };
    render(<BrokerReportShareButton defId={DEF} name="Q4 deals" orgName={ORG_NAME} level="owner" api={api} />);
    fireEvent.click(shareButton()!);
    const dialog = await screen.findByRole('dialog', { name: 'Share “Q4 deals”' });
    const bo = () => within(dialog).queryByRole('button', { name: /^Access for Bo Larkspur: / });
    const cal = () => within(dialog).queryByRole('button', { name: /^Access for Cal Moreno: / });
    await waitFor(() => expect(bo()).toBeTruthy());
    fireEvent.click(cal()!);
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitemradio', { name: /^Can edit/ }));
    await waitFor(() => expect(api.state).toHaveBeenCalledTimes(2));
    fireEvent.click(bo()!);
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: /^Remove access$/ }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Remove access for Bo Larkspur' })).getByRole('button', { name: 'Remove access' }));
    await waitFor(() => expect(api.state).toHaveBeenCalledTimes(3));
    expect(bo()).toBeNull();
    await act(async () => r2.resolve(base([{ ...calE, level: 'editor' }])));
    expect(bo()).toBeNull();
    await act(async () => r1.resolve(base([boE, calE])));
    expect(bo()).toBeNull();
    expect(cal()!.getAttribute('aria-label')).toBe('Access for Cal Moreno: Can edit');
    expect(api.remove).toHaveBeenCalledTimes(1);
  });
});
