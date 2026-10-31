// @vitest-environment jsdom
/**
 * BACKLOG-4021: the Plan Assignment card shows the current plan only; "Change plan" (top right)
 * reveals the dropdown, Update Plan and Cancel. Hidden entirely for staff without plans.manage.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('next/link', () => ({ default: ({ children }: { children: unknown }) => <a>{children as never}</a> }));
vi.mock('@keepr/ui', () => ({ ConfirmationDialog: () => null }));
vi.mock('@/lib/admin-queries', () => ({
  assignOrgPlan: vi.fn(),
  getOrgPlan: async () => ({
    data: { plan_id: 'p1', assigned_at: '2026-03-01T00:00:00Z', plans: { id: 'p1', name: 'Invented Team Plan', tier: 'team' } },
    error: null,
  }),
  getActivePlansForOrgs: async () => ({
    data: [
      { id: 'p1', name: 'Invented Team Plan', tier: 'team' },
      { id: 'p2', name: 'Invented Enterprise Plan', tier: 'enterprise' },
    ],
    error: null,
  }),
}));

import { PlanAssignment } from '@/app/dashboard/organizations/[id]/components/PlanAssignment';

afterEach(cleanup);

async function mount(canManage: boolean) {
  render(<PlanAssignment organizationId="o1" canManage={canManage} />);
  await screen.findByText(/Current: Invented Team Plan/);
}

describe('PlanAssignment (BACKLOG-4021)', () => {
  it('collapsed by default: plan shown, no dropdown, no Update Plan', async () => {
    await mount(true);
    expect(screen.getByRole('button', { name: 'Change plan' })).toBeTruthy();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Update Plan' })).toBeNull();
  });
  it('Change plan reveals dropdown, Update Plan and Cancel; Cancel collapses and resets', async () => {
    await mount(true);
    fireEvent.click(screen.getByRole('button', { name: 'Change plan' }));
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(screen.getByRole('button', { name: 'Update Plan' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Change plan' })).toBeNull();
    fireEvent.change(select, { target: { value: 'p2' } });
    expect(select.value).toBe('p2');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('combobox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Change plan' }));
    await waitFor(() => expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('p1'));
  });
  it('without plans.manage: no Change plan button, no dropdown', async () => {
    await mount(false);
    expect(screen.queryByRole('button', { name: 'Change plan' })).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
  });
});
