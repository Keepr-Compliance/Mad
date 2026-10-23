// @vitest-environment jsdom
/**
 * BACKLOG-4007: People's "Invite new person" moved into the People popup (@keepr/ui
 * OrgPeoplePanel), so InviteUserDialog has no People mode any more. The Users page invite with
 * a locked organization is unchanged (role select, inviteUser).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const mockInviteUser = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('@/lib/actions/inviteUser', () => ({ inviteUser: (...a: unknown[]) => mockInviteUser(...a) }));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'order']) chain[m] = () => chain;
    chain.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res);
    return { from: () => chain };
  },
}));

import { InviteUserDialog } from '@/app/dashboard/users/components/InviteUserDialog';
const ORG = { id: 'o1', name: 'Fixture Realty' };

const EMAIL_LABEL = 'Email Address';
function typeEmail(value: string) {
  fireEvent.change(screen.getByLabelText(EMAIL_LABEL), { target: { value } });
}

function fillNames() {
  typeEmail('pay@example.test');
  fireEvent.change(screen.getByLabelText('First Name'), { target: { value: 'Pat' } });
  fireEvent.change(screen.getByLabelText('Last Name'), { target: { value: 'Payer' } });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('InviteUserDialog with a locked organization', () => {
  it('without people: the role select and inviteUser, as before', async () => {
    mockInviteUser.mockResolvedValue({ success: true, inviteLink: 'https://portal.example.test/invite/x', emailSent: true, flow: 'org' });
    render(<InviteUserDialog lockedOrganization={ORG} onClose={vi.fn()} onInvited={vi.fn()} />);
    expect(screen.getByRole('combobox')).toBeTruthy();
    expect(screen.queryByLabelText(/Phone/)).toBeNull();
    fillNames();
    await act(async () => fireEvent.click(screen.getByText('Send Invitation')));
    expect(mockInviteUser).toHaveBeenCalledWith(expect.objectContaining({ email: 'pay@example.test', role: 'agent', organizationId: 'o1' }));
  });
});
