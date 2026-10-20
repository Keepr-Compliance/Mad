// @vitest-environment jsdom
/**
 * BACKLOG-4007 PR-2: inviting.
 *  - Organization page: Invite is off until the organization has a deal; it opens the dialog
 *    with the organization locked, Admin preselected for the first invite.
 *  - The dialog has no License Status field (organization page and Users page alike).
 *  - The Users page still sends an individual (no-organization) invite.
 *  - The server action no longer sends p_license_status.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const inviteCalls: Array<Record<string, unknown>> = [];
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('@/lib/actions/inviteUser', () => ({
  inviteUser: async (input: Record<string, unknown>) => {
    inviteCalls.push(input);
    return { success: true, inviteLink: input.organizationId ? 'https://app.example.test/invite/t' : null, emailSent: true, flow: input.organizationId ? 'org' : 'download' };
  },
}));
const orgQueries: string[] = [];
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: (t: string) => {
      orgQueries.push(t);
      return { select: () => ({ order: async () => ({ data: [{ id: 'org-a', name: 'Org A' }, { id: 'org-b', name: 'Org B' }] }) }) };
    },
  }),
}));

beforeEach(() => { inviteCalls.length = 0; orgQueries.length = 0; });
afterEach(cleanup);

function fill() {
  fireEvent.change(document.getElementById('invite-email')!, { target: { value: 'new.person@example.test' } });
  fireEvent.change(document.getElementById('invite-first-name')!, { target: { value: 'New' } });
  fireEvent.change(document.getElementById('invite-last-name')!, { target: { value: 'Person' } });
}

describe('OrgInviteButton gating', () => {
  const base = { organizationId: 'org-a', organizationName: 'Org A', canInvite: true, canViewBilling: true, hasDeal: true, showBillingCard: true, isFirstInvite: true };
  async function mount(p: Partial<typeof base>) {
    const { OrgInviteButton } = await import('@/app/dashboard/organizations/[id]/components/OrgInviteButton');
    return render(<OrgInviteButton {...base} {...p} />);
  }
  it('no users.edit: no button', async () => {
    const { container } = await mount({ canInvite: false });
    expect(container.innerHTML).toBe('');
  });
  it('Billing card hidden (billing dark, not a test org): no button, even with a deal and every permission', async () => {
    const { container } = await mount({ showBillingCard: false });
    expect(container.innerHTML).toBe('');
    expect(screen.queryByRole('button', { name: 'Invite' })).toBeNull();
    expect(screen.queryByText('Set up billing first.')).toBeNull();
  });
  it('Billing card hidden and no deal: no button and no "Set up billing first."', async () => {
    const { container } = await mount({ showBillingCard: false, hasDeal: false });
    expect(container.innerHTML).toBe('');
  });
  it('Billing card hidden because billing.view is missing (billing not read): no button', async () => {
    const { container } = await mount({ showBillingCard: false, canViewBilling: false, hasDeal: false });
    expect(container.innerHTML).toBe('');
  });
  it('no deal yet: disabled, "Set up billing first."', async () => {
    await mount({ hasDeal: false });
    expect((screen.getByRole('button', { name: 'Invite' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Set up billing first.')).toBeTruthy();
  });
  it('no billing.view: disabled, says why', async () => {
    await mount({ canViewBilling: false });
    expect((screen.getByRole('button', { name: 'Invite' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Needs billing access to check the deal.')).toBeTruthy();
  });
  it('deal exists: enabled; opens the dialog with the organization locked and Admin preselected', async () => {
    await mount({});
    const btn = screen.getByRole('button', { name: 'Invite' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    const locked = document.getElementById('invite-org-locked') as HTMLInputElement;
    expect(locked.value).toBe('Org A');
    expect(locked.readOnly).toBe(true);
    expect(screen.queryByPlaceholderText('Search organizations...')).toBeNull();
    expect(screen.queryByText('Change organization')).toBeNull();
    expect((document.getElementById('invite-role') as HTMLSelectElement).value).toBe('admin');
    expect(document.getElementById('invite-license-status')).toBeNull();
    expect(orgQueries).toHaveLength(0);
  });
  it('organization already has people: Agent preselected', async () => {
    await mount({ isFirstInvite: false });
    fireEvent.click(screen.getByRole('button', { name: 'Invite' }));
    expect((document.getElementById('invite-role') as HTMLSelectElement).value).toBe('agent');
  });
  it('locked submit sends the locked organization and no license status', async () => {
    await mount({});
    fireEvent.click(screen.getByRole('button', { name: 'Invite' }));
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Send Invitation' }));
    await waitFor(() => expect(inviteCalls).toHaveLength(1));
    expect(inviteCalls[0].organizationId).toBe('org-a');
    expect(inviteCalls[0].role).toBe('admin');
    expect('licenseStatus' in inviteCalls[0]).toBe(false);
  });
});

describe('Users page dialog (not locked)', () => {
  async function mount() {
    const { InviteUserDialog } = await import('@/app/dashboard/users/components/InviteUserDialog');
    render(<InviteUserDialog onClose={() => {}} onInvited={() => {}} />);
    await waitFor(() => expect(screen.getByPlaceholderText('Search organizations...')).toBeTruthy());
  }
  it('choosing an organization shows Role (Agent) and no License Status', async () => {
    await mount();
    fireEvent.change(screen.getByPlaceholderText('Search organizations...'), { target: { value: 'Org B' } });
    fireEvent.click(screen.getByRole('button', { name: 'Org B' }));
    expect((document.getElementById('invite-role') as HTMLSelectElement).value).toBe('agent');
    expect(screen.queryByText('License Status')).toBeNull();
    expect(document.getElementById('invite-license-status')).toBeNull();
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Send Invitation' }));
    await waitFor(() => expect(inviteCalls).toHaveLength(1));
    expect(inviteCalls[0].organizationId).toBe('org-b');
    expect('licenseStatus' in inviteCalls[0]).toBe(false);
  });
  it('no organization: individual invite still goes out (organizationId null)', async () => {
    await mount();
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Send Invitation' }));
    await waitFor(() => expect(inviteCalls).toHaveLength(1));
    expect(inviteCalls[0].organizationId).toBeNull();
    expect(await screen.findByText(/Download invitation sent/)).toBeTruthy();
  });
});
