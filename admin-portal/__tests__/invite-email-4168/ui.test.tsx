// @vitest-environment jsdom
/**
 * BACKLOG-4168 PR 3 - the UI shows a failed invite email. Response shapes are those of
 * app/api/internal-users/resend-invite (502 {error}) and invite (200 {success, emailSent:false}).
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/providers/PermissionsProvider', () => ({
  usePermissions: () => ({ hasPermission: () => true }),
}));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ rpc: async () => ({ data: null, error: null }), from: () => ({}) }) }));

import { InternalUsersTable } from '@/app/dashboard/settings/components/InternalUsersTable';
import { AddInternalUserForm } from '@/app/dashboard/settings/components/AddInternalUserForm';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const ROLE = { id: 'support-agent', name: 'low', slug: 'support-agent', description: null, is_system: false, created_at: '2026-01-01T00:00:00Z', permission_keys: [] };

describe('resend failure', () => {
  it('shows "Invite email could not be sent"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Invite email could not be sent' }), { status: 502 })));
    render(
      <InternalUsersTable
        users={[]}
        currentUserId="me"
        onRemoveClick={vi.fn()}
        onBulkRemoveClick={vi.fn()}
        roles={[ROLE] as never}
        grantableRoleIds={new Set(['support-agent'])}
        onRoleChange={vi.fn()}
        pendingInvitations={[{ id: 'inv-1', email: 'inv-1@example.test', role_id: 'support-agent', role_name: 'low', role_slug: 'support-agent', created_at: '2026-01-01T00:00:00Z' } as never]}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /resend/i }));
    expect(await screen.findByText('Invite email could not be sent')).toBeTruthy();
  });
});

describe('invite with emailSent false', () => {
  async function submit(emailSent: boolean, pending = true) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true, outcome: pending ? 'invited' : 'assigned', ...(pending ? { pending: true } : {}), emailSent }), { status: 200 })));
    render(<AddInternalUserForm onSuccess={vi.fn()} roles={[ROLE] as never} />);
    fireEvent.click(screen.getByRole('button', { name: /add user/i }));
    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'person@example.test' } });
    fireEvent.submit(screen.getByLabelText('Email address').closest('form')!);
    await waitFor(() => expect(screen.getByText(pending ? /Invitation created/ : /Successfully added/)).toBeTruthy());
  }

  it('shows a warning that the email was not sent', async () => {
    await submit(false);
    expect(screen.getByRole('alert').textContent).toMatch(/invite email could not be sent/i);
  });

  it('pending invitation: the warning points to Resend', async () => {
    await submit(false, true);
    expect(screen.getByRole('alert').textContent).toMatch(/Resend/);
  });

  it('assigned account: no Resend hint, says they can sign in', async () => {
    await submit(false, false);
    const text = screen.getByRole('alert').textContent ?? '';
    expect(text).not.toMatch(/Resend/);
    expect(text).toMatch(/sign in at the admin portal/);
  });

  it('shows no warning when the email was sent', async () => {
    await submit(true);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
