/**
 * @jest-environment node
 *
 * BACKLOG-4007 PR-3: who is sent to the setup guide (lib/billing/setupState.ts).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { billingSetupPending, setupLanding } from '@/lib/billing/setupState';
import { SETUP_VIEW_ACTIVE, SETUP_VIEW_WAITING } from './fixtures';

const ORG = 'ORG-4007-L';
// The code under test only touches `rpc`; one cast here (not per call) gives it the
// narrow client type while keeping the jest.Mock visible for assertions.
type RpcClient = Pick<SupabaseClient, 'rpc'> & { rpc: jest.Mock };
const fakeClient = (impl: () => Promise<unknown>): RpcClient =>
  ({ rpc: jest.fn(impl) }) as unknown as RpcClient;
const client = (res: unknown) => fakeClient(async () => res);

describe('setupLanding / billingSetupPending', () => {
  it('a waiting deal sends a broker or admin to /dashboard/setup', async () => {
    for (const role of ['broker', 'admin']) {
      const c = client({ data: SETUP_VIEW_WAITING, error: null });
      expect(await setupLanding(c, { organizationId: ORG, role })).toBe('/dashboard/setup');
      expect(c.rpc).toHaveBeenCalledWith('broker_get_billing_setup', { p_org: ORG });
    }
  });

  it('an active deal, no deal, or a failed read -> null (keep the destination)', async () => {
    expect(await setupLanding(client({ data: SETUP_VIEW_ACTIVE, error: null }), { organizationId: ORG, role: 'admin' })).toBeNull();
    expect(await setupLanding(client({ data: { success: false, error: 'no_deal' }, error: null }), { organizationId: ORG, role: 'admin' })).toBeNull();
    expect(await setupLanding(client({ data: null, error: { code: '42501' } }), { organizationId: ORG, role: 'admin' })).toBeNull();
    const throwing = fakeClient(async () => { throw new Error('network'); });
    expect(await setupLanding(throwing, { organizationId: ORG, role: 'admin' })).toBeNull();
  });

  it('agents, IT admins and a license that is not active are never asked (the RPC refuses them)', async () => {
    for (const who of [
      { organizationId: ORG, role: 'agent' },
      { organizationId: ORG, role: 'it_admin' },
      { organizationId: ORG, role: 'admin', licenseStatus: 'unassigned' },
      { organizationId: ORG, role: 'admin', licenseStatus: null },
      { organizationId: null, role: 'admin' },
    ]) {
      const c = client({ data: SETUP_VIEW_WAITING, error: null });
      expect(await setupLanding(c, who)).toBeNull();
      expect(c.rpc).not.toHaveBeenCalled();
    }
  });

  it('billingSetupPending: full broker/admin only', async () => {
    const waiting = () => client({ data: SETUP_VIEW_WAITING, error: null });
    expect(await billingSetupPending(waiting(), { kind: 'full', role: 'admin', organizationId: ORG } as never)).toBe(true);
    expect(await billingSetupPending(waiting(), { kind: 'full', role: 'it_admin', organizationId: ORG } as never)).toBe(false);
    expect(await billingSetupPending(waiting(), { kind: 'floor', role: 'agent', organizationId: ORG, via: 'brokerage' } as never)).toBe(false);
    expect(await billingSetupPending(waiting(), null)).toBe(false);
  });
});
