/**
 * BACKLOG-4007 PR-2: Create Organization asks for no seat count and no license status.
 * Seats are set once, on the deal; until then admin_create_organization's default (5) applies.
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

describe('Create Organization', () => {
  it('the form has no Max Seats and no Default License Status', async () => {
    const { CreateOrganizationDialog } = await import('@/app/dashboard/organizations/components/CreateOrganizationDialog');
    const html = renderToStaticMarkup(<CreateOrganizationDialog onClose={() => {}} onCreated={() => {}} />);
    expect(html).toContain('org-name');
    expect(html).not.toContain('org-max-seats');
    expect(html).not.toContain('Max Seats');
    expect(html).not.toContain('org-license-status');
    expect(html).not.toContain('Default License Status');
  });
  it('createOrganization sends only the name (the database default sets max_seats)', async () => {
    const { createOrganization } = await import('@/lib/admin-queries');
    const res = await createOrganization('Maple Street Realty');
    expect(res.error).toBeNull();
    expect(rpcCalls).toEqual([{ fn: 'admin_create_organization', args: { p_name: 'Maple Street Realty' } }]);
  });
});
