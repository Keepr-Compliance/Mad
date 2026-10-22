// @vitest-environment jsdom
/**
 * BACKLOG-4007 PR-2 fix-up: Create Organization submit, end to end through the dialog.
 *  - billing off: the Max Seats value the user typed reaches admin_create_organization.
 *  - billing live: no Max Seats field, no p_max_seats key.
 *  - OrganizationsTable hands billingLive to the dialog.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('@/components/pwa/NavigationProgress', () => ({ startNavigationProgress: () => {} }));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'neq']) chain[m] = () => chain;
    chain.order = async () => ({ data: [], error: null });
    return {
      from: () => chain,
      rpc: async (fn: string, args: Record<string, unknown>) => {
        rpcCalls.push({ fn, args });
        return { data: { success: true, id: 'org-new', slug: 'org-new' }, error: null };
      },
    };
  },
}));

beforeEach(() => { rpcCalls.length = 0; });
afterEach(cleanup);

async function mountDialog(billingLive: boolean) {
  const { CreateOrganizationDialog } = await import('@/app/dashboard/organizations/components/CreateOrganizationDialog');
  const onCreated = vi.fn();
  render(<CreateOrganizationDialog onClose={() => {}} onCreated={onCreated} billingLive={billingLive} />);
  return onCreated;
}

describe('Create Organization submit', () => {
  it('billing off: typed Max Seats is sent as p_max_seats', async () => {
    const onCreated = await mountDialog(false);
    fireEvent.change(document.getElementById('org-name')!, { target: { value: 'Maple Street Realty' } });
    fireEvent.change(document.getElementById('org-max-seats')!, { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Organization' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(rpcCalls).toEqual([{ fn: 'admin_create_organization', args: { p_name: 'Maple Street Realty', p_max_seats: 12 } }]);
  });
  it('billing off, seats untouched: the default 5 is sent', async () => {
    const onCreated = await mountDialog(false);
    fireEvent.change(document.getElementById('org-name')!, { target: { value: 'Maple Street Realty' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Organization' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(rpcCalls).toEqual([{ fn: 'admin_create_organization', args: { p_name: 'Maple Street Realty', p_max_seats: 5 } }]);
  });
  it('billing live: no Max Seats field and no p_max_seats', async () => {
    const onCreated = await mountDialog(true);
    expect(document.getElementById('org-max-seats')).toBeNull();
    fireEvent.change(document.getElementById('org-name')!, { target: { value: 'Maple Street Realty' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Organization' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(rpcCalls).toEqual([{ fn: 'admin_create_organization', args: { p_name: 'Maple Street Realty' } }]);
  });
});

describe('OrganizationsTable passes billingLive to the dialog', () => {
  async function openFromTable(billingLive: boolean) {
    const { OrganizationsTable } = await import('@/app/dashboard/organizations/components/OrganizationsTable');
    render(<OrganizationsTable canEdit billingLive={billingLive} organizations={[{ id: 'org-1', name: 'Invented Brokerage Group', slug: 'invented', plan_name: null, plan_tier: null, created_at: null, member_count: 1 }]} />);
    fireEvent.click(screen.getByRole('button', { name: /Create Organization/ }));
    await screen.findByLabelText('Organization Name');
  }
  it('billing off: Max Seats in the dialog', async () => {
    await openFromTable(false);
    expect(document.getElementById('org-max-seats')).not.toBeNull();
  });
  it('billing live: no Max Seats in the dialog', async () => {
    await openFromTable(true);
    expect(document.getElementById('org-max-seats')).toBeNull();
  });
});
