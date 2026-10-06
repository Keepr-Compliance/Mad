/**
 * Grayed Checklists sidebar entry — BACKLOG-3477 (ruling 9af9ffbd on b152ee0a).
 *
 * getChecklistNavPolicy (lib/checklist-nav.ts) runs for real. Its inputs:
 *   - editorEnabled: the route gate's answer, passed in by the layout;
 *   - feature_definitions.is_built, read through the Supabase client (live
 *     2026-09-27: false for transaction_checklists, so the grayed state is
 *     inert until it flips);
 *   - isFullPortalUser: classifyPortalAccess kind === 'full'.
 */

import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

let mockIsBuilt: boolean | null = true;
jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(async () => ({
    from: () => ({
      select: async () => ({
        data: mockIsBuilt === null ? null : [{ key: 'transaction_checklists', is_built: mockIsBuilt }],
        error: mockIsBuilt === null ? { message: 'unreadable' } : null,
      }),
    }),
  })),
}));
jest.mock('@/lib/impersonation', () => ({ getImpersonationSession: jest.fn(async () => null) }));
jest.mock('next/navigation', () => ({ usePathname: () => '/dashboard' }));

import { getChecklistNavPolicy } from '@/lib/checklist-nav';
import { Sidebar } from '@/components/layout/Sidebar';
import { DEFAULT_UNLOCK_LABEL } from '@/lib/feature-availability';

let quiet: jest.SpyInstance;
beforeEach(() => {
  mockIsBuilt = true;
  quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => quiet.mockRestore());

const base = { editorEnabled: false, isImpersonating: false, isFullPortalUser: true };

describe('getChecklistNavPolicy', () => {
  it('enabled when the route gate admits', async () => {
    expect(await getChecklistNavPolicy({ ...base, editorEnabled: true })).toBe('enabled');
  });

  it('grayed for a full-portal user whose plan lacks the (built) feature', async () => {
    expect(await getChecklistNavPolicy(base)).toBe('grayed');
  });

  it('hidden for a floor user (agent), even with the feature built', async () => {
    expect(await getChecklistNavPolicy({ ...base, isFullPortalUser: false })).toBe('hidden');
  });

  it('hidden while the feature is unbuilt, or its build state unreadable', async () => {
    mockIsBuilt = false;
    expect(await getChecklistNavPolicy(base)).toBe('hidden');
    mockIsBuilt = null;
    expect(await getChecklistNavPolicy(base)).toBe('hidden');
  });

  it('hidden during impersonation', async () => {
    expect(await getChecklistNavPolicy({ ...base, editorEnabled: true, isImpersonating: true })).toBe('hidden');
  });
});

describe('Sidebar grayed entry', () => {
  const renderSidebar = (props: Partial<React.ComponentProps<typeof Sidebar>>) =>
    render(<Sidebar collapsed={false} onToggle={() => {}} isImpersonating={false} displayEmail="m@example.test" {...props} />);

  it.each(['admin', 'it_admin', 'broker'])('%s sees Checklists grayed, not as a link, with one neutral line', (role) => {
    renderSidebar({ role, displayRole: role, checklistsUnavailableLabel: DEFAULT_UNLOCK_LABEL });
    expect(screen.queryByRole('link', { name: 'Checklists' })).not.toBeInTheDocument();
    const grayed = screen.getByTestId('checklists-nav-grayed');
    expect(grayed).toHaveAttribute('aria-disabled', 'true');
    expect(grayed).toHaveTextContent('Checklists');
    expect(grayed).toHaveTextContent(DEFAULT_UNLOCK_LABEL);
    expect(grayed.textContent).not.toMatch(/\$|price|upgrade/i);
  });

  it('is absent during impersonation', () => {
    renderSidebar({ role: 'admin', isImpersonating: true, checklistsUnavailableLabel: DEFAULT_UNLOCK_LABEL });
    expect(screen.queryByTestId('checklists-nav-grayed')).not.toBeInTheDocument();
  });

  it('is absent on the floor', () => {
    renderSidebar({ role: 'agent', floorOnly: true, checklistsUnavailableLabel: DEFAULT_UNLOCK_LABEL });
    expect(screen.queryByTestId('checklists-nav-grayed')).not.toBeInTheDocument();
  });

  it('a real link wins when the entry is enabled', () => {
    renderSidebar({ role: 'admin', displayRole: 'admin', showChecklists: true, checklistsUnavailableLabel: DEFAULT_UNLOCK_LABEL });
    expect(screen.getByRole('link', { name: 'Checklists' })).toHaveAttribute('href', '/dashboard/checklists');
    expect(screen.queryByTestId('checklists-nav-grayed')).not.toBeInTheDocument();
  });
});
