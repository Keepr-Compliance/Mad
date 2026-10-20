/**
 * BACKLOG-4007 PR-4 (staff): People on the organization page.
 *  - The card sits next to the Billing card and follows its gate (billing.view, and billing live
 *    or a test organization). Same harness as members-invite-4022 (real page, fake Supabase).
 *  - The actions forward only the documented keys with the staffer's own client; the database
 *    checks billing.view / billing.manage (supabase/tests/backlog-4007-pr4).
 *  - A created billing-only login is emailed through the broker portal with billingOnly: true.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({ redirect: vi.fn(), notFound: vi.fn(), useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('next/link', () => ({ default: () => null }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@keepr/design-system', () => ({
  Card: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Button: ({ children, disabled }: { children: ReactNode; disabled?: boolean }) => <button disabled={disabled}>{children}</button>,
}));
vi.mock('@/app/dashboard/users/components/InviteUserDialog', () => ({ InviteUserDialog: () => null }));
vi.mock('@/app/dashboard/organizations/[id]/components/MembersTable', () => ({ MembersTable: () => null }));
vi.mock('@/app/dashboard/organizations/[id]/components/PendingInvitationsTable', () => ({ PendingInvitationsTable: () => null }));
vi.mock('@/app/dashboard/organizations/[id]/components/PlanAssignment', () => ({ PlanAssignment: () => null }));
vi.mock('@/app/dashboard/organizations/[id]/components/BrokerageBillingCard', () => ({ BrokerageBillingCard: () => <div>BILLING-CARD</div> }));
vi.mock('@/app/dashboard/organizations/[id]/components/OrgPeopleCard', () => ({ OrgPeopleCard: () => <div>PEOPLE-CARD</div> }));

const state: { perms: Record<string, boolean>; isTest: boolean; live: boolean } = { perms: {}, isTest: true, live: false };
const mockRpc = vi.fn();

function table(name: string) {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'order', 'single', 'not', 'is']) chain[m] = () => chain;
  chain.then = (res: (v: unknown) => unknown) => {
    let data: unknown = [];
    if (name === 'internal_roles') data = { role_id: 'r1' };
    if (name === 'organizations') data = { id: 'o1', name: 'Org', slug: 'org', max_seats: 5, created_at: '2026-01-01', organization_plans: [] };
    return Promise.resolve({ data, error: null }).then(res);
  };
  return chain;
}

vi.mock('@/lib/supabase/server', () => ({
  getAuthenticatedUser: async () => ({
    user: { id: 'staff-1', email: 'staff@example.test', user_metadata: { first_name: 'Staff', last_name: 'Person' } },
    supabase: {
      from: (n: string) => table(n),
      rpc: async (fn: string, args: Record<string, unknown>) => {
        if (fn === 'has_permission') return { data: state.perms[args.required_permission as string] ?? false };
        if (fn === 'admin_get_org_billing') {
          return {
            data: {
              billing_live: state.live, is_test: state.isTest, list_price_cents: 2499, cap_pct: 20, can_manage: true,
              can_approve: false, can_suspend: true, assigned_seats: 0, deal: null, seat_line: null, stripe: null,
              account_managers: [], log: [],
            },
          };
        }
        return mockRpc(fn, args);
      },
    },
  }),
}));

async function pageHtml(): Promise<string> {
  const { default: Page } = await import('@/app/dashboard/organizations/[id]/page');
  return renderToStaticMarkup((await Page({ params: Promise.resolve({ id: 'o1' }) })) as React.ReactElement);
}

describe('organization page People card', () => {
  beforeEach(() => {
    state.perms = { 'organizations.view': true, 'billing.view': true, 'users.edit': true };
    state.isTest = true;
    state.live = false;
  });

  it('shown with the Billing card', async () => {
    const html = await pageHtml();
    expect(html).toContain('BILLING-CARD');
    expect(html).toContain('PEOPLE-CARD');
  });

  it.each([
    ['no billing.view', () => (state.perms['billing.view'] = false)],
    ['billing off and not a test organization', () => (state.isTest = false)],
  ])('hidden with the Billing card: %s', async (_n, set) => {
    set();
    const html = await pageHtml();
    expect(html).not.toContain('BILLING-CARD');
    expect(html).not.toContain('PEOPLE-CARD');
  });
});

describe('staff People actions', () => {
  const fetchSpy = vi.fn();
  beforeEach(() => {
    mockRpc.mockReset();
    fetchSpy.mockReset();
    vi.stubGlobal('fetch', fetchSpy);
    process.env.BROKER_PORTAL_URL = 'https://broker.example.test';
    process.env.INTERNAL_API_SECRET = 'fixture-secret';
  });
  afterEach(() => vi.unstubAllGlobals());

  it('save forwards only the documented keys', async () => {
    const { saveOrgContactAction } = await import('@/lib/actions/orgContacts');
    mockRpc.mockResolvedValue({ data: { success: true }, error: null });
    const r = await saveOrgContactAction('o1', { role: 'office', user_id: 'u-9', seats: 3 } as never);
    expect(r).toEqual({ ok: true });
    expect(mockRpc).toHaveBeenCalledWith('org_contact_save', { p_org: 'o1', p_contact: { role: 'office', phone: '', company_name: '', user_id: 'u-9' } });
  });

  it('a created billing-only login is emailed as billing-only through the broker portal', async () => {
    const { setOrgBillingLoginAction } = await import('@/lib/actions/orgContacts');
    mockRpc.mockResolvedValue({
      data: { name: 'Payer Person', email: 'payer@example.test', token: 'c'.repeat(64), success: true, org_name: 'Org' },
      error: null,
    });
    fetchSpy.mockResolvedValue({ json: async () => ({ success: true }) });
    const r = await setOrgBillingLoginAction('o1', true);
    expect(mockRpc).toHaveBeenCalledWith('org_billing_login_set', { p_org: 'o1', p_enable: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://broker.example.test/api/email/send-invite');
    expect(JSON.parse(init.body)).toMatchObject({ recipientEmail: 'payer@example.test', billingOnly: true, role: 'Billing only', inviterName: 'Staff Person' });
    expect(r).toEqual({ ok: true, note: 'We emailed the billing contact an invitation to their billing-only login.' });
  });

  it('a refusal is passed through and nothing is emailed; 42501 reads not_authorized', async () => {
    const { setOrgBillingLoginAction, listOrgContactsAction } = await import('@/lib/actions/orgContacts');
    mockRpc.mockResolvedValueOnce({ data: { success: false, error: 'already_member' }, error: null });
    expect(await setOrgBillingLoginAction('o1', true)).toEqual({ ok: false, error: 'already_member' });
    expect(fetchSpy).not.toHaveBeenCalled();
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: '42501' } });
    expect(await listOrgContactsAction('o1')).toBeNull();
  });
});
