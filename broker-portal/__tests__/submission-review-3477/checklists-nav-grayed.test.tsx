/**
 * Grayed Checklists sidebar entry — BACKLOG-3477 (ruling 9af9ffbd on b152ee0a).
 *
 * getChecklistNavPolicy runs for real; only its three inputs are stubbed:
 *   - isChecklistEditorEnabled's database answer (can_edit_checklist_templates),
 *     via the Supabase client;
 *   - feature_definitions.is_built, via the same client (live today: false for
 *     transaction_checklists, so the grayed state is inert until it flips);
 *   - whether the caller is a full-portal user (the layout passes
 *     classifyPortalAccess's kind).
 */

import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

let mockCanEdit = false;
let mockIsBuilt: boolean | null = true;
jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'u-1' } } }) },
    from: (table: string) => {
      if (table === 'organization_members') {
        const rows = [{ role: 'admin', organization_id: 'org-1', organizations: { id: 'org-1', personal_owner_user_id: null } }];
        const chain = { select: () => chain, eq: () => chain, order: () => chain, then: (f: (r: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(f) };
        return chain;
      }
      // feature_definitions
      return {
        select: async () => ({
          data: mockIsBuilt === null ? null : [{ key: 'transaction_checklists', is_built: mockIsBuilt }],
          error: mockIsBuilt === null ? { message: 'unreadable' } : null,
        }),
      };
    },
    rpc: async () => ({ data: mockCanEdit, error: null }),
  })),
}));
jest.mock('@/lib/impersonation', () => ({ getImpersonationSession: jest.fn(async () => null) }));
jest.mock('next/navigation', () => ({ usePathname: () => '/dashboard' }));

import { getChecklistNavPolicy } from '@/lib/checklist-access';
import { Sidebar } from '@/components/layout/Sidebar';
import { DEFAULT_UNLOCK_LABEL } from '@/lib/feature-availability';

let quiet: jest.SpyInstance;
beforeEach(() => {
  mockCanEdit = false;
  mockIsBuilt = true;
  quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => quiet.mockRestore());

describe('getChecklistNavPolicy', () => {
  it('enabled when the route gate admits', async () => {
    mockCanEdit = true;
    expect(await getChecklistNavPolicy({ isImpersonating: false, isFullPortalUser: true })).toBe('enabled');
  });

  it('grayed for a full-portal user whose plan lacks the (built) feature', async () => {
    expect(await getChecklistNavPolicy({ isImpersonating: false, isFullPortalUser: true })).toBe('grayed');
  });

  it('hidden for a floor user (agent), even with the feature built', async () => {
    expect(await getChecklistNavPolicy({ isImpersonating: false, isFullPortalUser: false })).toBe('hidden');
  });

  it('hidden while the feature is unbuilt, or its build state unreadable', async () => {
    mockIsBuilt = false;
    expect(await getChecklistNavPolicy({ isImpersonating: false, isFullPortalUser: true })).toBe('hidden');
    mockIsBuilt = null;
    expect(await getChecklistNavPolicy({ isImpersonating: false, isFullPortalUser: true })).toBe('hidden');
  });

  it('hidden during impersonation', async () => {
    mockCanEdit = true;
    expect(await getChecklistNavPolicy({ isImpersonating: true, isFullPortalUser: true })).toBe('hidden');
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
