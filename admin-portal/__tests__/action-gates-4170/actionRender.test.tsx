// @vitest-environment jsdom

/**
 * BACKLOG-4170 PR4: each write action renders only with its flag.
 *   UserProfileCard canSuspend -> Suspend / Unsuspend
 *   LicenseCard canEdit -> Edit dialog
 *   BillingCreditsCard canAdjustCredits -> credit grant / claw back; canReinstate -> passed to SuspensionAction
 *   SuspensionAction canReinstate -> Reinstate button (the suspension banner shows either way)
 *   MembersTable canSuspend -> row Suspend item, header checkbox, row checkboxes, bulk Suspend
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('@/components/pwa/NavigationProgress', () => ({ startNavigationProgress: vi.fn() }));
vi.mock('@/lib/admin-queries', () => ({ suspendUser: vi.fn(), unsuspendUser: vi.fn() }));
vi.mock('@/lib/actions/changeMemberRole', () => ({ changeMemberRole: vi.fn() }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ rpc: vi.fn() }) }));
vi.mock('@/app/dashboard/users/[id]/components/SuspendDialog', () => ({
  SuspendDialog: ({ isSuspended }: { isSuspended: boolean }) => <button type="button">{isSuspended ? 'Unsuspend User' : 'Suspend User'}</button>,
}));
vi.mock('@/app/dashboard/users/[id]/components/EditLicenseDialog', () => ({
  EditLicenseDialog: () => <button type="button">Edit license</button>,
}));
vi.mock('@/app/dashboard/users/[id]/components/CreditGrantAction', () => ({
  CreditGrantAction: () => <button type="button">Grant credits</button>,
}));
const suspensionProps = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock('@/app/dashboard/users/[id]/components/SuspensionAction', async (orig) => {
  const real = (await orig()) as { SuspensionAction: (p: Record<string, unknown>) => unknown };
  return {
    SuspensionAction: (p: Record<string, unknown>) => { suspensionProps.push(p); return real.SuspensionAction(p); },
  };
});

import { UserProfileCard } from '@/app/dashboard/users/[id]/components/UserProfileCard';
import { LicenseCard } from '@/app/dashboard/users/[id]/components/LicenseCard';
import { BillingCreditsCard } from '@/app/dashboard/users/[id]/components/BillingCreditsCard';
import { SuspensionAction } from '@/app/dashboard/users/[id]/components/SuspensionAction';
import { MembersTable, type MemberRow } from '@/app/dashboard/organizations/[id]/components/MembersTable';
import type { BillingData } from '@/lib/billing-queries';
import type { SuspensionStatus } from '@/lib/suspension-queries';

afterEach(() => { cleanup(); suspensionProps.length = 0; });

const USER = { id: 'u1', email: 'agent@example.test', display_name: 'Avery Example', avatar_url: null, oauth_provider: 'google', status: 'active', subscription_tier: null, created_at: '2025-01-01T00:00:00Z', last_login_at: null };
const LICENSE = { id: 'l1', license_type: 'individual', license_key: 'KEY-1', status: 'active', max_devices: 2, expires_at: null, created_at: '2025-01-01T00:00:00Z' };
const BILLING: BillingData = {
  creditBalance: 3, ledger: [], unlocks: [], pricingTiers: [], quote: null, lifetimePaidUnlocks: 0,
  grossPaidCents: 0, grantsIssued: 0, paidUnlocksThisYear: 0, hasErrors: false, errorMessages: [],
};
const SUSPENDED: SuspensionStatus = { isSuspended: true, event: null, hasError: false };
const MEMBERS: MemberRow[] = [
  { user_id: 'user-1', display_name: 'Active member', email: 'pat@example.test', role: 'agent', license_status: 'active', joined_at: '2026-10-01T00:00:00.000Z', status: 'active' },
  { user_id: 'user-2', display_name: 'Suspended member', email: 'sam@example.test', role: 'agent', license_status: 'active', joined_at: '2026-10-01T00:00:00.000Z', status: 'suspended' },
];

describe('UserProfileCard suspend (users.suspend)', () => {
  it('absent without canSuspend', () => {
    render(<UserProfileCard user={USER} />);
    expect(screen.queryByRole('button', { name: /Suspend User/ })).toBeNull();
  });
  it('present with canSuspend', () => {
    render(<UserProfileCard user={USER} canSuspend />);
    expect(screen.getByRole('button', { name: /Suspend User/ })).toBeTruthy();
  });
});

describe('LicenseCard edit (licenses.edit)', () => {
  it('absent without canEdit', () => {
    render(<LicenseCard licenses={[LICENSE]} />);
    expect(screen.queryByRole('button', { name: 'Edit license' })).toBeNull();
    expect(screen.getByText('KEY-1')).toBeTruthy();
  });
  it('present with canEdit', () => {
    render(<LicenseCard licenses={[LICENSE]} canEdit />);
    expect(screen.getByRole('button', { name: 'Edit license' })).toBeTruthy();
  });
});

describe('BillingCreditsCard actions (credits.adjust, billing.suspend)', () => {
  it('no flags: no grant action, Reinstate hidden, suspension still shown', () => {
    render(<BillingCreditsCard data={BILLING} userId="u1" suspension={SUSPENDED} />);
    expect(screen.queryByRole('button', { name: 'Grant credits' })).toBeNull();
    expect(screen.getByText('Account suspended')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reinstate account' })).toBeNull();
    expect(suspensionProps.at(-1)?.canReinstate).toBe(false);
  });
  it('canAdjustCredits only: grant action shown, Reinstate hidden', () => {
    render(<BillingCreditsCard data={BILLING} userId="u1" suspension={SUSPENDED} canAdjustCredits />);
    expect(screen.getByRole('button', { name: 'Grant credits' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reinstate account' })).toBeNull();
  });
  it('canReinstate only: Reinstate shown, grant action hidden', () => {
    render(<BillingCreditsCard data={BILLING} userId="u1" suspension={SUSPENDED} canReinstate />);
    expect(screen.queryByRole('button', { name: 'Grant credits' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Reinstate account' })).toBeTruthy();
    expect(suspensionProps.at(-1)?.canReinstate).toBe(true);
  });
});

describe('SuspensionAction reinstate (billing.suspend)', () => {
  it('suspended, no canReinstate: banner without the button', () => {
    render(<SuspensionAction userId="u1" status={SUSPENDED} />);
    expect(screen.getByText('Account suspended')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reinstate account' })).toBeNull();
  });
  it('suspended, canReinstate: the button is shown', () => {
    render(<SuspensionAction userId="u1" status={SUSPENDED} canReinstate />);
    expect(screen.getByRole('button', { name: 'Reinstate account' })).toBeTruthy();
  });
});

function openMenu(i: number) {
  fireEvent.click(screen.getAllByRole('button', { name: 'Actions' })[i]);
}

describe('MembersTable suspend controls (users.suspend)', () => {
  it('canSuspend false: no row Suspend/Unsuspend item, no header checkbox, no row checkboxes', () => {
    render(<MembersTable members={MEMBERS} organizationId="org-1" />);
    expect(screen.queryByLabelText('Select all members')).toBeNull();
    expect(screen.queryByLabelText('Select Active member')).toBeNull();
    expect(screen.queryByLabelText('Select Suspended member')).toBeNull();
    openMenu(0);
    expect(screen.getByText('View User Detail')).toBeTruthy();
    expect(screen.queryByText('Suspend User')).toBeNull();
    cleanup();
    render(<MembersTable members={MEMBERS} organizationId="org-1" />);
    openMenu(1);
    expect(screen.queryByText('Unsuspend User')).toBeNull();
  });

  it('canSuspend true: row items, header checkbox, row checkboxes and the bulk bar are present', () => {
    render(<MembersTable members={MEMBERS} organizationId="org-1" canSuspend />);
    expect(screen.getByLabelText('Select all members')).toBeTruthy();
    expect(screen.getByLabelText('Select Active member')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Select Suspended member'));
    expect(screen.getByRole('button', { name: /Unsuspend \(1\)/ })).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Select Active member'));
    expect(screen.getByRole('button', { name: /^Suspend \(1\)/ })).toBeTruthy();
    openMenu(0);
    expect(screen.getByText('Suspend User')).toBeTruthy();
    cleanup();
    render(<MembersTable members={MEMBERS} organizationId="org-1" canSuspend />);
    openMenu(1);
    expect(screen.getByText('Unsuspend User')).toBeTruthy();
  });
});
