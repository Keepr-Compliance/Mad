/**
 * BACKLOG-4007: People is a card on Org Settings again.
 *
 *   broker            -> /dashboard/settings renders ONLY the People card
 *   admin / IT admin  -> every policy card, plus People
 *   agent             -> redirected away
 *   /dashboard/people -> redirects to /dashboard/settings (next.config.mjs)
 *
 * The page runs against the real checkOrgSettingsAccess (portalAccess is stubbed at the edge).
 */

import React from 'react';
import { execFileSync } from 'child_process';
import path from 'path';

const mockGetPortalAccess = jest.fn();
jest.mock('@/lib/auth/portalAccess', () => ({ getPortalAccess: (...a: unknown[]) => mockGetPortalAccess(...a) }));
jest.mock('@/lib/impersonation', () => ({ getImpersonationSession: async () => null }));
jest.mock('@/lib/feature-gate', () => ({ isFeatureEnabledFailClosed: async () => false }));
jest.mock('@/lib/feature-availability', () => ({
  fetchFeatureBuildStates: async () => ({}),
  featureRenderPolicy: () => 'hidden',
  featureUnlockLabel: () => null,
  isFeatureBuilt: () => false,
}));
jest.mock('@/lib/billing/phone', () => ({
  PHONE_ERROR: 'x',
  formatBillingPhoneInput: (v: string) => v,
  isValidBillingPhone: () => true,
}));
jest.mock('@/lib/actions/orgContacts', () => ({
  listOrgContacts: async () => ({ ok: false }),
  removeOrgContact: jest.fn(),
  saveOrgContact: jest.fn(),
  setOrgBillingLogin: jest.fn(),
}));
const redirectTargets: string[] = [];
jest.mock('next/navigation', () => ({
  redirect: (to: string) => {
    redirectTargets.push(to);
    throw new Error('NEXT_REDIRECT');
  },
}));

import SettingsPage from '@/app/dashboard/settings/page';
import OrgSettingsClient from '@/app/dashboard/settings/OrgSettingsClient';
import { PeopleCard } from '@/components/settings/PeopleCard';

const ORG = 'org-1';
const as = (role: string) =>
  mockGetPortalAccess.mockResolvedValue({
    access: { kind: 'full', role, organizationId: ORG },
    user: { id: 'u-1' },
    suspended: false,
    orgSuspended: false,
  });

/** Every element type in a React element tree (server-component output, not rendered). */
function types(node: unknown, out: unknown[] = []): unknown[] {
  if (!React.isValidElement(node)) return out;
  out.push(node.type);
  React.Children.forEach((node.props as { children?: React.ReactNode }).children, (c) => types(c, out));
  return out;
}

beforeEach(() => {
  redirectTargets.length = 0;
  mockGetPortalAccess.mockReset();
});

describe('/dashboard/settings by role', () => {
  it('broker: People only, none of the policy client', async () => {
    as('broker');
    const el = await SettingsPage();
    const t = types(el);
    expect(t).toContain(PeopleCard);
    expect(t).not.toContain(OrgSettingsClient);
    expect(redirectTargets).toEqual([]);
  });

  it.each(['admin', 'it_admin'])('%s: the policy cards plus People', async (role) => {
    as(role);
    const el = await SettingsPage();
    expect(el.type).toBe(OrgSettingsClient);
    expect(el.props.peopleOrganizationId).toBe(ORG);
  });

  it('agent: redirected away', async () => {
    as('agent');
    await expect(SettingsPage()).rejects.toThrow('NEXT_REDIRECT');
    expect(redirectTargets).toEqual(['/dashboard']);
  });

  it('billing-only login (floor access): redirected away', async () => {
    mockGetPortalAccess.mockResolvedValue({
      access: { kind: 'floor', via: 'billing_only', role: 'agent', organizationId: ORG },
      user: { id: 'u-1' },
      suspended: false,
      orgSuspended: false,
    });
    await expect(SettingsPage()).rejects.toThrow('NEXT_REDIRECT');
    expect(redirectTargets).toEqual(['/dashboard']);
  });
});

describe('/dashboard/people', () => {
  it('redirects to /dashboard/settings', () => {
    // Jest cannot load an .mjs config, so read the real one with node and parse its redirects().
    const script =
      "import('./next.config.mjs').then(async m=>{const c=typeof m.default==='function'?await m.default('phase-production-build',{defaultConfig:{}}):m.default;console.log(JSON.stringify(await c.redirects()))})";
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: path.join(__dirname, '../../../..'),
      encoding: 'utf8',
    });
    const rules = JSON.parse(out.trim().split('\n').pop() as string) as { source: string; destination: string }[];
    expect(rules).toContainEqual(expect.objectContaining({ source: '/dashboard/people', destination: '/dashboard/settings' }));
  });
});
