/**
 * BACKLOG-4007 PR-4 fix-up (founder e8571c1f) and People v2 (founder R7): who may use People.
 *
 *   People (list; office contacts): admin, IT admin, broker.
 *   The billing contact: admin and broker only (3855).
 *   The IT contact and MSP (creates or promotes an IT admin): admin and IT admin (R7).
 *
 * One definition (lib/people-roles.ts) read by the /dashboard/settings gate, the sidebar and the
 * server actions; the database rule (public._org_people_caller and the gates in
 * org_contact_save / org_people_invite, migration 20261020200000) is compared to it by reading
 * the migration text. Every role is enumerated, not sampled.
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

import { PEOPLE_BILLING_ROLES, PEOPLE_IT_ROLES, PEOPLE_ROLES, mayEditBillingPeople, mayEditItPeople, mayUsePeople } from '@/lib/people-roles';
import { checkOrgSettingsAccess, seesOrgPolicy } from '@/lib/org-settings-access';
import { Sidebar } from '@/components/layout/Sidebar';
import { invitePerson, listOrgContacts, removeOrgContact, saveOrgContact } from '@/lib/actions/orgContacts';
import { OrgPeoplePanel, type OrgPeopleView } from '@keepr/ui';
import { PHONE_ERROR, formatBillingPhoneInput, isValidBillingPhone } from '@/lib/billing/phone';

const ORG = 'org-1';
const ALL_ROLES = ['admin', 'it_admin', 'broker', 'agent'] as const;
const PEOPLE = new Set(['admin', 'it_admin', 'broker']);
const BILLING = new Set(['admin', 'broker']);
const IT = new Set(['admin', 'it_admin']);

beforeEach(() => jest.clearAllMocks());

describe('lib/people-roles.ts', () => {
  it.each(ALL_ROLES)('%s', (role) => {
    expect(mayUsePeople(role)).toBe(PEOPLE.has(role));
    expect(mayEditBillingPeople(role)).toBe(BILLING.has(role));
    expect(mayEditItPeople(role)).toBe(IT.has(role));
  });
  it('no role is not admitted', () => {
    expect(mayUsePeople(undefined)).toBe(false);
    expect(mayEditBillingPeople(null)).toBe(false);
  });
});

describe('the database rule is the same set (migration 20261020200000)', () => {
  const sql = readFileSync(join(__dirname, '../../../supabase/migrations/20261020200000_backlog_4007_people_v2.sql'), 'utf8');
  const fn = (name: string) => sql.slice(sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`), sql.indexOf(`REVOKE`, sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`)));
  const kinds = (text: string): string[] => text.split(',').map((x) => x.trim().replace(/'/g, '')).filter((k) => k !== 'staff').sort();
  it('_org_people_caller admits exactly PEOPLE_ROLES, each with an active license', () => {
    const caller = fn('_org_people_caller');
    const m = caller.match(/m\.license_status = 'active' AND m\.role IN \(([^)]*)\)/);
    expect(m).not.toBeNull();
    expect(kinds(m![1])).toEqual([...PEOPLE_ROLES].sort());
  });
  it('the billing contact: PEOPLE_BILLING_ROLES; the IT contact / MSP: PEOPLE_IT_ROLES (save and invite)', () => {
    const save = fn('org_contact_save');
    const invite = fn('org_people_invite');
    const billingSave = save.match(/v_role = 'billing' AND v_caller NOT IN \(([^)]*)\)/);
    const itSave = save.match(/v_role IN \('it', 'msp'\) AND v_caller NOT IN \(([^)]*)\)/);
    const billingInvite = invite.match(/v_slot = 'billing' AND v_caller NOT IN \(([^)]*)\)/);
    const itInvite = invite.match(/v_slot IN \('it', 'msp'\) AND v_caller NOT IN \(([^)]*)\)/);
    for (const m of [billingSave, itSave, billingInvite, itInvite]) expect(m).not.toBeNull();
    expect(kinds(billingSave![1])).toEqual([...PEOPLE_BILLING_ROLES].sort());
    expect(kinds(billingInvite![1])).toEqual([...PEOPLE_BILLING_ROLES].sort());
    expect(kinds(itSave![1])).toEqual([...PEOPLE_IT_ROLES].sort());
    expect(kinds(itInvite![1])).toEqual([...PEOPLE_IT_ROLES].sort());
  });
});

describe('/dashboard/settings gate (checkOrgSettingsAccess)', () => {
  const full = (role: string): PortalAccess => ({ kind: 'full', role, organizationId: ORG } as PortalAccess);
  const portal = (role: string) => ({ access: full(role), user: { id: 'u-1' }, suspended: false, orgSuspended: false });
  it.each(ALL_ROLES)('%s with full access', async (role) => {
    mockGetPortalAccess.mockResolvedValue(portal(role));
    const r = await checkOrgSettingsAccess();
    expect(r.allowed).toBe(PEOPLE.has(role));
  });
  it('only admin and IT admin see the policy cards; a broker sees People only', () => {
    expect(ALL_ROLES.filter(seesOrgPolicy)).toEqual(['admin', 'it_admin']);
  });
  it('refused: floor access, a suspended account, a suspended brokerage, no session', async () => {
    mockGetPortalAccess.mockResolvedValueOnce({
      ...portal('admin'),
      access: { kind: 'floor', via: 'unlicensed', role: 'admin', organizationId: ORG },
    });
    expect((await checkOrgSettingsAccess()).allowed).toBe(false);
    mockGetPortalAccess.mockResolvedValueOnce({ ...portal('admin'), suspended: true });
    expect((await checkOrgSettingsAccess()).allowed).toBe(false);
    mockGetPortalAccess.mockResolvedValueOnce({ ...portal('broker'), orgSuspended: true });
    expect((await checkOrgSettingsAccess()).allowed).toBe(false);
    mockGetPortalAccess.mockResolvedValueOnce(null);
    expect((await checkOrgSettingsAccess()).allowed).toBe(false);
  });
  it('admits with the organization from the classifier', async () => {
    mockGetPortalAccess.mockResolvedValue(portal('broker'));
    expect(await checkOrgSettingsAccess()).toEqual({ allowed: true, userId: 'u-1', organizationId: ORG, role: 'broker' });
  });
});

describe('Sidebar: Org Settings (the People card lives there)', () => {
  const renderSidebar = (props: Partial<React.ComponentProps<typeof Sidebar>>) =>
    render(<Sidebar collapsed={false} onToggle={() => {}} isImpersonating={false} displayEmail="m@example.test" {...props} />);
  it.each(ALL_ROLES)('%s', (role) => {
    renderSidebar({ role, displayRole: role });
    const link = screen.queryByRole('link', { name: 'Org Settings' });
    if (PEOPLE.has(role)) expect(link).toHaveAttribute('href', '/dashboard/settings');
    else expect(link).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'People' })).not.toBeInTheDocument();
  });
  it('absent during a support session (broker), on the floor, and while suspended', () => {
    const { unmount } = renderSidebar({ role: 'broker', isImpersonating: true });
    expect(screen.queryByRole('link', { name: 'Org Settings' })).not.toBeInTheDocument();
    unmount();
    const b = renderSidebar({ role: 'broker', floorOnly: true });
    expect(screen.queryByRole('link', { name: 'Org Settings' })).not.toBeInTheDocument();
    b.unmount();
    renderSidebar({ role: 'broker', orgSuspended: true });
    expect(screen.queryByRole('link', { name: 'Org Settings' })).not.toBeInTheDocument();
  });
});

describe('People actions: the three role lists', () => {
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
    const it = IT.has(role);
    expect((await listOrgContacts(ORG)).ok).toBe(people);
    expect((await saveOrgContact(ORG, { role: 'office', member_id: 'm-1' })).ok).toBe(people);
    expect((await removeOrgContact(ORG, 'c-1')).ok).toBe(people);
    expect((await saveOrgContact(ORG, { role: 'billing', member_id: 'm-1', phone: '2025550123' })).ok).toBe(billing);
    expect((await saveOrgContact(ORG, { role: 'it', member_id: 'm-1' })).ok).toBe(it);
    const called = mockRpc.mock.calls.map((c) => c[0]);
    expect(called).toEqual([
      ...(people ? ['org_contacts_list', 'org_contact_save', 'org_contact_remove'] : []),
      ...(billing ? ['org_contact_save'] : []),
      ...(it ? ['org_contact_save'] : []),
    ]);
  });

  it('a broker cannot set the IT contact or invite an IT admin: no RPC (founder R7)', async () => {
    as('broker');
    expect(await saveOrgContact(ORG, { role: 'it', member_id: 'm-1' })).toEqual({ ok: false, error: 'not_authorized' });
    expect(await invitePerson(ORG, { slot: 'msp', email: 'it@example.test', firstName: '', lastName: '', phone: '' })).toEqual({
      ok: false,
      error: 'not_authorized',
    });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('an IT admin cannot set the billing contact: no RPC', async () => {
    as('it_admin');
    expect(await saveOrgContact(ORG, { role: 'billing', member_id: 'm-1', phone: '2025550123' })).toEqual({
      ok: false,
      error: 'not_authorized',
    });
    expect(await invitePerson(ORG, { slot: 'billing', email: 'p@example.test', firstName: '', lastName: '', phone: '2025550123' })).toEqual({
      ok: false,
      error: 'not_authorized',
    });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('the edit flags from the database reach the view', async () => {
    as('it_admin');
    mockRpc.mockResolvedValueOnce({
      data: { success: true, can_edit: true, can_edit_billing: false, can_edit_it: true, can_edit_phone: false, contacts: [], members: [] },
      error: null,
    });
    const r = await listOrgContacts(ORG);
    expect(r).toEqual({
      ok: true,
      view: { can_edit: true, can_edit_billing: false, can_edit_it: true, can_edit_phone: false, deal_status: undefined, contacts: [], members: [] },
    });
  });
});

describe('OrgPeoplePanel for an IT admin (can_edit_billing false)', () => {
  // Shape from org_contacts_list as an IT admin on keepr-test (People v2 control
  // C1_it_admin_sees_billing_phone_not_email): the billing row has its name, login and phone; email null.
  const VIEW: OrgPeopleView = {
    can_edit: true,
    can_edit_billing: false,
    deal_status: 'active',
    contacts: [
      { id: 'b1', role: 'billing', name: 'payer person', email: null, phone: '+12025550133', company_name: null, member_id: 'm-b1', login: 'billing_only', login_claimed: true },
    ],
    members: [],
  };
  const PHONE = { isValid: isValidBillingPhone, format: formatBillingPhoneInput, error: PHONE_ERROR };
  const actions = () => ({
    save: jest.fn(async () => ({ ok: true as const })),
    remove: jest.fn(async () => ({ ok: true as const })),
  });
  const row = (role: string) => document.querySelector(`[data-role="${role}"]`) as HTMLElement;

  it('the billing row has no buttons and says who can change it; IT, office and MSP can be added', () => {
    render(<OrgPeoplePanel view={VIEW} actions={actions()} phone={PHONE} onChanged={jest.fn()} />);
    expect(within(row('billing')).getByText('payer person')).toBeInTheDocument();
    expect(within(row('billing')).queryByRole('button')).not.toBeInTheDocument();
    expect(within(row('billing')).getByText('Only a broker or admin can change it.')).toBeInTheDocument();
    for (const r of ['it', 'office', 'msp']) expect(within(row(r)).getByText('Add person')).toBeInTheDocument();
  });

  it('a broker (can_edit_billing true) gets Change; no billing-only login buttons any more', () => {
    render(<OrgPeoplePanel view={{ ...VIEW, can_edit_billing: true }} actions={actions()} phone={PHONE} onChanged={jest.fn()} />);
    expect(within(row('billing')).getByText('Change')).toBeInTheDocument();
    expect(within(row('billing')).queryByText('Give billing-only login')).not.toBeInTheDocument();
  });
});
