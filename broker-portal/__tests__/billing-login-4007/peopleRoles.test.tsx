/**
 * BACKLOG-4007 PR-4 fix-up (founder e8571c1f): who may use People.
 *
 *   People (list, add / change / remove IT, office, MSP): admin, IT admin, broker.
 *   The billing contact and the billing-only login: admin and broker only (3855).
 *
 * One definition (lib/people-roles.ts) read by the /dashboard/people gate, the sidebar and the
 * server actions; the database rule (public._org_contact_caller and the billing checks in
 * org_contact_save / org_billing_login_set) is compared to it by reading the migration text.
 * Every role is enumerated, not sampled.
 */

import '@testing-library/jest-dom';
import { readFileSync } from 'fs';
import { join } from 'path';
import { render, screen, within } from '@testing-library/react';
import type { PortalAccess } from '@keepr/shared';

const mockGetPortalAccess = jest.fn();
const mockRpc = jest.fn();
const mockGate = jest.fn();
jest.mock('@/lib/auth/portalAccess', () => ({ getPortalAccess: (...a: unknown[]) => mockGetPortalAccess(...a) }));
jest.mock('@/lib/impersonation-guards', () => ({ blockWriteDuringImpersonation: async () => null }));
jest.mock('@/lib/auth/memberAccess', () => ({ requireActiveOrgRole: (...a: unknown[]) => mockGate(...a) }));
jest.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    rpc: mockRpc,
    auth: { getUser: async () => ({ data: { user: { id: 'u-1', email: 'member@example.test' } } }) },
  }),
}));
jest.mock('@/lib/email', () => ({ sendInviteEmail: jest.fn() }));
jest.mock('next/navigation', () => ({ usePathname: () => '/dashboard' }));

import { PEOPLE_BILLING_ROLES, PEOPLE_ROLES, mayEditBillingPeople, mayUsePeople } from '@/lib/people-roles';
import { checkPeopleAccess } from '@/lib/people-access';
import { Sidebar } from '@/components/layout/Sidebar';
import { listOrgContacts, removeOrgContact, saveOrgContact, setOrgBillingLogin } from '@/lib/actions/orgContacts';
import { OrgPeoplePanel, type OrgPeopleView } from '@keepr/ui';
import { PHONE_ERROR, formatBillingPhoneInput, isValidBillingPhone } from '@/lib/billing/phone';

const ORG = 'org-1';
const ALL_ROLES = ['admin', 'it_admin', 'broker', 'agent'] as const;
const PEOPLE = new Set(['admin', 'it_admin', 'broker']);
const BILLING = new Set(['admin', 'broker']);

beforeEach(() => jest.clearAllMocks());

describe('lib/people-roles.ts', () => {
  it.each(ALL_ROLES)('%s', (role) => {
    expect(mayUsePeople(role)).toBe(PEOPLE.has(role));
    expect(mayEditBillingPeople(role)).toBe(BILLING.has(role));
  });
  it('no role is not admitted', () => {
    expect(mayUsePeople(undefined)).toBe(false);
    expect(mayEditBillingPeople(null)).toBe(false);
  });
});

describe('the database rule is the same set (migration 20261020180000)', () => {
  const sql = readFileSync(
    join(__dirname, '../../../supabase/migrations/20261020180000_backlog_4007_pr4_contacts_billing_login.sql'),
    'utf8'
  );
  const caller = sql.slice(
    sql.indexOf('CREATE OR REPLACE FUNCTION public._org_contact_caller'),
    sql.indexOf('REVOKE EXECUTE ON FUNCTION public._org_contact_caller')
  );
  const rolesOf = (kind: string): string[] => {
    const re = new RegExp(`m\\.role (?:IN \\(([^)]*)\\)|= ('[a-z_]+'))\\) THEN '${kind}'`);
    const m = caller.match(re);
    if (!m) throw new Error(`no ${kind} branch in _org_contact_caller`);
    return (m[1] ?? m[2]).split(',').map((x) => x.trim().replace(/'/g, '')).sort();
  };
  it("the 'broker' kind is PEOPLE_BILLING_ROLES; 'broker' + 'it_admin' is PEOPLE_ROLES", () => {
    expect(rolesOf('broker')).toEqual([...PEOPLE_BILLING_ROLES].sort());
    expect([...rolesOf('broker'), ...rolesOf('it_admin')].sort()).toEqual([...PEOPLE_ROLES].sort());
  });
  it("the billing contact and the billing-only login admit only the 'staff' and 'broker' kinds", () => {
    expect(sql).toContain("IF v_role = 'billing' AND v_caller NOT IN ('staff', 'broker') THEN");
    expect(sql).toContain("IF v_caller IS NULL OR v_caller NOT IN ('staff', 'broker') THEN");
  });
});

describe('/dashboard/people gate (checkPeopleAccess)', () => {
  const full = (role: string): PortalAccess => ({ kind: 'full', role, organizationId: ORG } as PortalAccess);
  it.each(ALL_ROLES)('%s with full access', async (role) => {
    mockGetPortalAccess.mockResolvedValue({ access: full(role), suspended: false, orgSuspended: false });
    const r = await checkPeopleAccess();
    expect(r.allowed).toBe(PEOPLE.has(role));
  });
  it('refused: floor access, a suspended account, a suspended brokerage, no session', async () => {
    mockGetPortalAccess.mockResolvedValueOnce({
      access: { kind: 'floor', via: 'unlicensed', role: 'admin', organizationId: ORG },
      suspended: false,
      orgSuspended: false,
    });
    expect((await checkPeopleAccess()).allowed).toBe(false);
    mockGetPortalAccess.mockResolvedValueOnce({ access: full('admin'), suspended: true, orgSuspended: false });
    expect((await checkPeopleAccess()).allowed).toBe(false);
    mockGetPortalAccess.mockResolvedValueOnce({ access: full('broker'), suspended: false, orgSuspended: true });
    expect((await checkPeopleAccess()).allowed).toBe(false);
    mockGetPortalAccess.mockResolvedValueOnce(null);
    expect((await checkPeopleAccess()).allowed).toBe(false);
  });
  it('admits with the organization from the classifier', async () => {
    mockGetPortalAccess.mockResolvedValue({ access: full('broker'), suspended: false, orgSuspended: false });
    expect(await checkPeopleAccess()).toEqual({ allowed: true, organizationId: ORG, role: 'broker' });
  });
});

describe('Sidebar: People', () => {
  const renderSidebar = (props: Partial<React.ComponentProps<typeof Sidebar>>) =>
    render(<Sidebar collapsed={false} onToggle={() => {}} isImpersonating={false} displayEmail="m@example.test" {...props} />);
  it.each(ALL_ROLES)('%s', (role) => {
    renderSidebar({ role, displayRole: role });
    const link = screen.queryByRole('link', { name: 'People' });
    if (PEOPLE.has(role)) expect(link).toHaveAttribute('href', '/dashboard/people');
    else expect(link).not.toBeInTheDocument();
  });
  it('a broker sees People but not Org Settings', () => {
    renderSidebar({ role: 'broker', displayRole: 'broker' });
    expect(screen.getByRole('link', { name: 'People' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Org Settings' })).not.toBeInTheDocument();
  });
  it('absent during a support session, on the floor, and while suspended', () => {
    const { unmount } = renderSidebar({ role: 'admin', isImpersonating: true });
    expect(screen.queryByRole('link', { name: 'People' })).not.toBeInTheDocument();
    unmount();
    const b = renderSidebar({ role: 'admin', floorOnly: true });
    expect(screen.queryByRole('link', { name: 'People' })).not.toBeInTheDocument();
    b.unmount();
    renderSidebar({ role: 'admin', orgSuspended: true });
    expect(screen.queryByRole('link', { name: 'People' })).not.toBeInTheDocument();
  });
});

describe('People actions: the two role lists', () => {
  /** The real requireActiveOrgRole answer for a caller holding `role`. */
  const as = (role: string) =>
    mockGate.mockImplementation(async (_c: unknown, _u: string, _o: string, roles: readonly string[]) =>
      roles.includes(role) ? { ok: true, role } : { ok: false, reason: 'role' }
    );
  beforeEach(() => mockRpc.mockResolvedValue({ data: { success: true, can_edit: true, contacts: [], members: [] }, error: null }));

  it.each(ALL_ROLES)('%s', async (role) => {
    as(role);
    const people = PEOPLE.has(role);
    const billing = BILLING.has(role);
    expect((await listOrgContacts(ORG)).ok).toBe(people);
    expect((await saveOrgContact(ORG, { role: 'it', name: 'IT Desk', email: 'it@example.test' })).ok).toBe(people);
    expect((await removeOrgContact(ORG, 'c-1')).ok).toBe(people);
    expect((await saveOrgContact(ORG, { role: 'billing', name: 'Payer', email: 'pay@example.test', phone: '2025550123' })).ok).toBe(billing);
    expect((await setOrgBillingLogin(ORG, false)).ok).toBe(billing);
    const called = mockRpc.mock.calls.map((c) => c[0]);
    expect(called).toEqual([
      ...(people ? ['org_contacts_list', 'org_contact_save', 'org_contact_remove'] : []),
      ...(billing ? ['org_contact_save', 'org_billing_login_set'] : []),
    ]);
  });

  it('a broker adds an IT contact', async () => {
    as('broker');
    expect(await saveOrgContact(ORG, { role: 'it', name: 'IT Desk', email: 'it@example.test' })).toEqual({ ok: true });
    expect(mockRpc).toHaveBeenCalledWith('org_contact_save', {
      p_org: ORG,
      p_contact: { role: 'it', name: 'IT Desk', email: 'it@example.test', phone: '', company_name: '' },
    });
  });

  it('an IT admin cannot set the billing contact or the billing-only login: no RPC', async () => {
    as('it_admin');
    expect(await saveOrgContact(ORG, { role: 'billing', name: 'P', email: 'p@example.test', phone: '2025550123' })).toEqual({
      ok: false,
      error: 'not_authorized',
    });
    expect(await setOrgBillingLogin(ORG, true)).toEqual({ ok: false, error: 'not_authorized' });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('can_edit_billing from the database reaches the view', async () => {
    as('it_admin');
    mockRpc.mockResolvedValueOnce({ data: { success: true, can_edit: true, can_edit_billing: false, contacts: [], members: [] }, error: null });
    const r = await listOrgContacts(ORG);
    expect(r).toEqual({ ok: true, view: { can_edit: true, can_edit_billing: false, deal_status: undefined, contacts: [], members: [] } });
  });
});

describe('OrgPeoplePanel for an IT admin (can_edit_billing false)', () => {
  // Shape from org_contacts_list as an IT admin on keepr-test (C_M_it_admin_list_billing_without_details):
  // the billing row has its name and login, email and phone null.
  const VIEW: OrgPeopleView = {
    can_edit: true,
    can_edit_billing: false,
    deal_status: 'active',
    contacts: [
      { id: 'b1', role: 'billing', name: 'Payer Person', email: null, phone: null, company_name: null, member_id: null, login: null, login_claimed: false },
    ],
    members: [],
  };
  const PHONE = { isValid: isValidBillingPhone, format: formatBillingPhoneInput, error: PHONE_ERROR };
  const actions = () => ({
    save: jest.fn(async () => ({ ok: true as const })),
    remove: jest.fn(async () => ({ ok: true as const })),
    setBillingLogin: jest.fn(async () => ({ ok: true as const })),
  });
  const row = (role: string) => document.querySelector(`[data-role="${role}"]`) as HTMLElement;

  it('the billing row has no buttons and says who can change it; IT, office and MSP can be added', () => {
    render(<OrgPeoplePanel view={VIEW} actions={actions()} phone={PHONE} onChanged={jest.fn()} />);
    expect(within(row('billing')).getByText('Payer Person')).toBeInTheDocument();
    expect(within(row('billing')).queryByRole('button')).not.toBeInTheDocument();
    expect(within(row('billing')).getByText('Only a broker or admin can change it.')).toBeInTheDocument();
    for (const r of ['it', 'office', 'msp']) expect(within(row(r)).getByText('Add person')).toBeInTheDocument();
  });

  it('a broker (can_edit_billing true) gets Change and Give billing-only login', () => {
    render(<OrgPeoplePanel view={{ ...VIEW, can_edit_billing: true }} actions={actions()} phone={PHONE} onChanged={jest.fn()} />);
    expect(within(row('billing')).getByText('Change')).toBeInTheDocument();
    expect(within(row('billing')).getByText('Give billing-only login')).toBeInTheDocument();
  });
});
