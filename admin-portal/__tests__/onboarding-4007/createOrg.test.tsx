/**
 * BACKLOG-4007 PR-2: Create Organization asks for no license status. Max Seats is asked and
 * sent only while brokerage billing is off (founder 52d946a2, option A); once billing is live
 * seats are set on the deal and admin_create_organization's default (5) applies until then.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return { data: { success: true, id: 'org-new', slug: 'org-new' }, error: null };
    },
  }),
}));

beforeEach(() => { rpcCalls.length = 0; });

async function markup(billingLive: boolean) {
  const { CreateOrganizationDialog } = await import('@/app/dashboard/organizations/components/CreateOrganizationDialog');
  return renderToStaticMarkup(<CreateOrganizationDialog onClose={() => {}} onCreated={() => {}} billingLive={billingLive} />);
}

describe('Create Organization form', () => {
  it('billing off: Max Seats is shown (default 5), no Default License Status', async () => {
    const html = await markup(false);
    expect(html).toContain('org-name');
    expect(html).toContain('id="org-max-seats"');
    expect(html).toContain('Max Seats');
    expect(html).toMatch(/id="org-max-seats"[^>]*value="5"|value="5"[^>]*id="org-max-seats"/);
    expect(html).not.toContain('org-license-status');
    expect(html).not.toContain('Default License Status');
  });
  it('billing live: no Max Seats and no Default License Status', async () => {
    const html = await markup(true);
    expect(html).toContain('org-name');
    expect(html).not.toContain('org-max-seats');
    expect(html).not.toContain('Max Seats');
    expect(html).not.toContain('org-license-status');
    expect(html).not.toContain('Default License Status');
  });
});

describe('createOrganization', () => {
  it('with a seat count: sends p_max_seats exactly as given (pre-4007 call shape)', async () => {
    const { createOrganization } = await import('@/lib/admin-queries');
    const res = await createOrganization('Maple Street Realty', 12);
    expect(res.error).toBeNull();
    expect(rpcCalls).toEqual([{ fn: 'admin_create_organization', args: { p_name: 'Maple Street Realty', p_max_seats: 12 } }]);
  });
  it('without a seat count: sends only the name (the database default sets max_seats)', async () => {
    const { createOrganization } = await import('@/lib/admin-queries');
    const res = await createOrganization('Maple Street Realty');
    expect(res.error).toBeNull();
    expect(rpcCalls).toEqual([{ fn: 'admin_create_organization', args: { p_name: 'Maple Street Realty' } }]);
  });
});

describe('billingLiveForNewOrg', () => {
  it('reads the switch; anything but a clean true is off', async () => {
    const { billingLiveForNewOrg } = await import('@/lib/billing/dealRules');
    expect(billingLiveForNewOrg({ data: true, error: null })).toBe(true);
    expect(billingLiveForNewOrg({ data: false, error: null })).toBe(false);
    expect(billingLiveForNewOrg({ data: null, error: { message: 'function not found' } })).toBe(false);
    expect(billingLiveForNewOrg({ data: true, error: { message: 'x' } })).toBe(false);
    expect(billingLiveForNewOrg({ data: 'true', error: null })).toBe(false);
  });
});
