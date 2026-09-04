/**
 * What the account page shows, and whose account it can show. BACKLOG-3079.
 *
 * ---------------------------------------------------------------------------
 * "Sign in as A, request B's account data, assert refusal" — how that is met
 * ---------------------------------------------------------------------------
 * getAccountView() takes NO user id. There is no parameter a caller could point
 * at somebody else, so the refusal is not a check that could be forgotten — the
 * request is unrepresentable. What IS assertable, and asserted below, is that
 * every query it issues is filtered to the session's own id, and that the id it
 * uses comes from auth.getUser() rather than from anything a caller supplies.
 *
 * RLS is the second wall and the reason this is safe rather than merely tidy:
 * user_preferences is own-rows plus service_role with NO internal-role read
 * policy (verified 2026-09-04), so a wrong id here still returns nothing to an
 * ordinary session. Support reaches another user's row only through the scoped
 * service client an impersonation session produces — which is the flow the item
 * says is the only one.
 */

import { render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockCreateClient = jest.fn();
const mockGetDataClient = jest.fn();

jest.mock('@/lib/supabase/server', () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));
jest.mock('@/lib/impersonation-guards', () => ({
  getDataClient: () => mockGetDataClient(),
}));
jest.mock('@/components/providers/ImpersonationProvider', () => ({
  useImpersonation: () => ({ isImpersonating: false }),
}));
jest.mock('@/lib/actions/getActiveDevices', () => ({
  getActiveDevices: async () => ({ success: true, devices: [] }),
}));
jest.mock('@/lib/actions/signOutAllDevices', () => ({
  signOutAllDevices: async () => ({ success: true }),
}));

import AccountClient from '@/app/dashboard/account/AccountClient';
import {
  getAccountView,
  providerDisplayName,
} from '@/lib/account/getAccountView';
import {
  ACCOUNT_USER_ID,
  FULL_PREFERENCES,
  OTHER_USER_ID,
  SPARSE_PREFERENCES,
  makeAccount,
} from '../../../fixtures/account';
import { makeQuery, type TableResult } from '../../../fixtures/orgFeatures';

// ---------------------------------------------------------------------------
// A client that records which table was queried with which filter.
// ---------------------------------------------------------------------------

function recordingClient(tables: Record<string, TableResult>) {
  const calls: Array<{ table: string; eq: Array<[string, unknown]> }> = [];
  const from = jest.fn((table: string) => {
    const record = { table, eq: [] as Array<[string, unknown]> };
    calls.push(record);
    const q = makeQuery(tables[table] ?? { data: null, error: null });
    const originalEq = q.eq as jest.Mock;
    originalEq.mockImplementation((column: string, value: unknown) => {
      record.eq.push([column, value]);
      return q;
    });
    return q;
  });
  return { client: { from } as never, calls };
}

const USER_ROW = {
  id: ACCOUNT_USER_ID,
  email: 'alex.rivera@example.test',
  display_name: 'Alex Rivera',
  first_name: 'Alex',
  last_name: 'Rivera',
  oauth_provider: 'azure',
  created_at: '2026-01-15T10:00:00.000Z',
};

function stubFetch(opts: {
  authUserId?: string | null;
  impersonating?: boolean;
  targetUserId?: string;
  preferences?: TableResult;
  membership?: TableResult;
  organization?: TableResult;
}) {
  const rec = recordingClient({
    users: { data: USER_ROW, error: null },
    organization_members: opts.membership ?? {
      data: { role: 'agent', organization_id: 'org-1' },
      error: null,
    },
    organizations: opts.organization ?? {
      data: { name: 'Northwind Realty', retention_years: null },
      error: null,
    },
    user_preferences: opts.preferences ?? {
      data: { preferences: FULL_PREFERENCES, updated_at: '2026-08-30T12:00:00.000Z' },
      error: null,
    },
  });

  mockGetDataClient.mockResolvedValue({
    client: rec.client,
    impersonation: opts.impersonating ? { target_user_id: opts.targetUserId } : null,
    targetUserId: opts.impersonating ? (opts.targetUserId ?? null) : null,
    organizationId: opts.impersonating ? 'org-1' : null,
  });

  mockCreateClient.mockResolvedValue({
    auth: {
      getUser: jest.fn(async () => ({
        data: { user: opts.authUserId === null ? null : { id: opts.authUserId ?? ACCOUNT_USER_ID } },
      })),
    },
  });

  return rec;
}

beforeEach(() => {
  mockCreateClient.mockReset();
  mockGetDataClient.mockReset();
});

// ---------------------------------------------------------------------------
// Whose account
// ---------------------------------------------------------------------------

describe('getAccountView — subject derivation', () => {
  it('takes no arguments at all', () => {
    // The function's arity IS the access-control argument: there is no id a
    // caller could pass to ask for somebody else's account.
    expect(getAccountView.length).toBe(0);
  });

  it('filters every read to the signed-in id', async () => {
    const rec = stubFetch({ authUserId: ACCOUNT_USER_ID });
    await getAccountView();

    const users = rec.calls.find((c) => c.table === 'users');
    const prefs = rec.calls.find((c) => c.table === 'user_preferences');
    const members = rec.calls.find((c) => c.table === 'organization_members');

    expect(users?.eq).toEqual([['id', ACCOUNT_USER_ID]]);
    expect(prefs?.eq).toEqual([['user_id', ACCOUNT_USER_ID]]);
    expect(members?.eq).toEqual([['user_id', ACCOUNT_USER_ID]]);
  });

  it('never queries another user id, even one present in the fixture', async () => {
    const rec = stubFetch({ authUserId: ACCOUNT_USER_ID });
    await getAccountView();
    const everyFilterValue = rec.calls.flatMap((c) => c.eq.map(([, v]) => v));
    expect(everyFilterValue).not.toContain(OTHER_USER_ID);
  });

  it('returns nothing when there is no session and no impersonation', async () => {
    stubFetch({ authUserId: null });
    await expect(getAccountView()).resolves.toBeNull();
  });

  it('uses the impersonation target, not the admin, during a support session', async () => {
    const rec = stubFetch({
      authUserId: ACCOUNT_USER_ID,
      impersonating: true,
      targetUserId: OTHER_USER_ID,
    });
    const view = await getAccountView();

    expect(view?.identity.userId).toBe(OTHER_USER_ID);
    expect(view?.isImpersonating).toBe(true);
    const prefs = rec.calls.find((c) => c.table === 'user_preferences');
    expect(prefs?.eq).toEqual([['user_id', OTHER_USER_ID]]);
  });

  it('does not consult auth.getUser during a support session', async () => {
    // A support session has no authenticated user; reading one would either
    // throw or silently substitute the admin's own account.
    stubFetch({ authUserId: ACCOUNT_USER_ID, impersonating: true, targetUserId: OTHER_USER_ID });
    await getAccountView();
    expect(mockCreateClient).not.toHaveBeenCalled();
  });
});

describe('getAccountView — the three preference states the item names', () => {
  it('a full blob comes back whole', async () => {
    stubFetch({ authUserId: ACCOUNT_USER_ID });
    const view = await getAccountView();
    expect(view?.preferences).toEqual(FULL_PREFERENCES);
  });

  it('a sparse blob comes back as stored', async () => {
    stubFetch({
      authUserId: ACCOUNT_USER_ID,
      preferences: { data: { preferences: SPARSE_PREFERENCES, updated_at: null }, error: null },
    });
    const view = await getAccountView();
    expect(view?.preferences).toEqual(SPARSE_PREFERENCES);
  });

  it('NO ROW is null, and is not confused with an empty blob', async () => {
    stubFetch({ authUserId: ACCOUNT_USER_ID, preferences: { data: null, error: null } });
    const view = await getAccountView();
    expect(view?.preferences).toBeNull();
  });

  it('a row holding an empty blob is {} — a different state, and stays different', async () => {
    stubFetch({
      authUserId: ACCOUNT_USER_ID,
      preferences: { data: { preferences: {}, updated_at: null }, error: null },
    });
    const view = await getAccountView();
    expect(view?.preferences).toEqual({});
    expect(view?.preferences).not.toBeNull();
  });

  it('survives a user with no organization membership', async () => {
    stubFetch({ authUserId: ACCOUNT_USER_ID, membership: { data: null, error: null } });
    const view = await getAccountView();
    expect(view?.identity.role).toBeNull();
    expect(view?.identity.organizationName).toBeNull();
    expect(view?.orgRetentionYears).toBeNull();
  });
});

describe('providerDisplayName', () => {
  it.each([
    ['google', 'Google'],
    ['microsoft', 'Microsoft'],
    ['azure', 'Microsoft'],
    ['email', 'Email'],
  ])('%s -> %s', (raw, shown) => {
    expect(providerDisplayName(raw)).toBe(shown);
  });

  it('maps azure, which is what production actually stores', () => {
    // users.oauth_provider holds azure / google / email across all 23 rows
    // (2026-09-04). "microsoft" never appears, so the desktop's map never
    // matches and its Account panel prints the raw slug "azure".
    expect(providerDisplayName('azure')).toBe('Microsoft');
    expect(providerDisplayName('azure')).not.toBe('azure');
  });

  it('falls through to the raw value for a provider added later', () => {
    expect(providerDisplayName('okta')).toBe('okta');
  });

  it('is nothing when no provider is recorded', () => {
    expect(providerDisplayName(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// What the page renders
// ---------------------------------------------------------------------------

describe('AccountClient — account card', () => {
  it('names the person, their email and their sign-in provider', () => {
    render(<AccountClient account={makeAccount()} />);
    expect(screen.getByText('Alex Rivera')).toBeInTheDocument();
    expect(screen.getByText('alex.rivera@example.test')).toBeInTheDocument();
    expect(screen.getByText('Signed in with Microsoft')).toBeInTheDocument();
  });

  it('shows role, organization and user id', () => {
    render(<AccountClient account={makeAccount()} />);
    expect(screen.getByText('Agent')).toBeInTheDocument();
    expect(screen.getByText('Northwind Realty')).toBeInTheDocument();
    expect(screen.getByText(ACCOUNT_USER_ID)).toBeInTheDocument();
  });

  it('formats a two-word role readably', () => {
    render(<AccountClient account={makeAccount({
      identity: { ...makeAccount().identity, role: 'it_admin' },
    })} />);
    expect(screen.getByText('It Admin')).toBeInTheDocument();
  });

  it('omits rows it has no value for rather than printing blanks', () => {
    render(<AccountClient account={makeAccount({
      identity: {
        ...makeAccount().identity,
        role: null,
        organizationName: null,
        authProvider: null,
        createdAt: null,
      },
    })} />);
    expect(screen.queryByText('Role')).not.toBeInTheDocument();
    expect(screen.queryByText('Organization')).not.toBeInTheDocument();
    expect(screen.queryByText('Member Since')).not.toBeInTheDocument();
    expect(screen.queryByText(/Signed in with/)).not.toBeInTheDocument();
  });
});

describe('AccountClient — saved settings', () => {
  it('renders labelled settings, not raw JSON', () => {
    render(<AccountClient account={makeAccount()} />);
    expect(screen.getByText('Auto-Sync on Startup')).toBeInTheDocument();
    expect(screen.getByText('iPhone Sync (USB)')).toBeInTheDocument();
    expect(screen.queryByText(/contactSources/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\{/)).not.toBeInTheDocument();
  });

  it('groups them under the desktop section headings', () => {
    render(<AccountClient account={makeAccount()} />);
    for (const heading of ['General', 'Messages', 'iPhone Sync', 'Contacts']) {
      expect(screen.getByText(heading)).toBeInTheDocument();
    }
  });

  it('shows no Setup section and no onboarding restart markers', () => {
    // The founder's report was about RENDERED TEXT, so it is asserted here on
    // the rendered page and not only on the resolver. FULL_PREFERENCES stores
    // both markers, with resumeStep null — the "Not set" row that was seen.
    render(<AccountClient account={makeAccount()} />);
    expect(screen.queryByText('Setup')).not.toBeInTheDocument();
    expect(screen.queryByText(/Onboarding/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Onboarding resume point')).not.toBeInTheDocument();
    expect(screen.queryByText('Onboarding resume saved')).not.toBeInTheDocument();
    // And not one heading lower, either.
    expect(screen.queryByText('Other settings')).not.toBeInTheDocument();
  });

  it('keeps the phone answer, under Contacts', () => {
    render(<AccountClient account={makeAccount()} />);
    expect(screen.getByText('Phone')).toBeInTheDocument();
    expect(screen.getByText('Android')).toBeInTheDocument();
    expect(screen.getByText('Contacts')).toBeInTheDocument();
  });

  it('says where they are changed', () => {
    render(<AccountClient account={makeAccount()} />);
    expect(screen.getByText(/Changed in the desktop app/)).toBeInTheDocument();
  });

  it('offers no way to edit them', () => {
    render(<AccountClient account={makeAccount()} />);
    // Sign Out All Devices is the only button this page should have.
    const buttons = screen.getAllByRole('button').map((b) => b.textContent);
    expect(buttons).toEqual(['Sign Out All Devices']);
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
    expect(screen.queryAllByRole('combobox')).toHaveLength(0);
    expect(screen.queryAllByRole('switch')).toHaveLength(0);
  });

  it('shows an unmapped key under Other settings rather than dropping it', () => {
    render(
      <AccountClient
        account={makeAccount({
          preferences: { ...SPARSE_PREFERENCES, brandNewFeature: { someToggle: true } },
        })}
      />
    );
    expect(screen.getByText('Other settings')).toBeInTheDocument();
    expect(screen.getByText('Brand New Feature › Some Toggle')).toBeInTheDocument();
  });

  it('renders the sparse case the item names', () => {
    render(<AccountClient account={makeAccount({ preferences: SPARSE_PREFERENCES })} />);
    expect(screen.getByText('Phone')).toBeInTheDocument();
    expect(screen.getByText('iPhone')).toBeInTheDocument();
    expect(screen.getByText('macOS Contacts')).toBeInTheDocument();
  });

  it('renders an empty state for a person with NO preferences row, and does not crash', () => {
    render(<AccountClient account={makeAccount({ preferences: null, preferencesUpdatedAt: null })} />);
    expect(
      screen.getByText(/They appear here once you have used the desktop app/)
    ).toBeInTheDocument();
  });

  it('renders a different empty state for a row holding nothing', () => {
    render(<AccountClient account={makeAccount({ preferences: {} })} />);
    expect(screen.getByText(/Everything is on its default/)).toBeInTheDocument();
  });

  it('renders at all when the whole view is null', () => {
    render(<AccountClient account={null} />);
    expect(screen.getByText('My Account')).toBeInTheDocument();
    expect(
      screen.getByText(/They appear here once you have used the desktop app/)
    ).toBeInTheDocument();
  });
});

describe('AccountClient — the brokerage retention policy', () => {
  /** The label/value row itself. "1 year" is ALSO how a 12-month email cache
   *  renders, so an unscoped query would match the wrong element and pass
   *  whether or not the pluralisation is right. */
  const retentionRow = () => screen.getByText('Retain emails for').parentElement!;

  it('is absent when the person has no organization', () => {
    render(<AccountClient account={makeAccount({ orgRetentionYears: null })} />);
    expect(screen.queryByText('Email Retention Policy')).not.toBeInTheDocument();
  });

  it('names the org value when one is set', () => {
    render(<AccountClient account={makeAccount({ orgRetentionYears: 7 })} />);
    expect(screen.getByText('Email Retention Policy')).toBeInTheDocument();
    expect(screen.getByText('Set by your brokerage')).toBeInTheDocument();
    expect(retentionRow().textContent).toContain('7 years');
  });

  it('does not claim it overrides the desktop setting', () => {
    // No desktop code reads organizations.retention_years — the column appears
    // in the desktop tree only as a type field (shared/types/submissions.ts).
    // Repeating the org page's override claim here would be a promise this
    // codebase cannot keep. Filed on the item.
    render(<AccountClient account={makeAccount({ orgRetentionYears: 7 })} />);
    expect(screen.queryByText(/override/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/locked/i)).not.toBeInTheDocument();
  });

  it('does not pluralise a single year', () => {
    // Scoped to the retention card: "1 year" is also how a 12-month email
    // cache renders, so an unscoped query would match the wrong element and
    // pass whether or not the pluralisation is right.
    render(<AccountClient account={makeAccount({ orgRetentionYears: 1 })} />);
    expect(within(retentionRow()).getByText('1 year')).toBeInTheDocument();
    expect(within(retentionRow()).queryByText('1 years')).not.toBeInTheDocument();
  });
});
