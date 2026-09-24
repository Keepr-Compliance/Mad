/**
 * The dashboard layout hands the Sidebar the gate's answer — BACKLOG-3474 (A11).
 *
 * The Checklists entry must agree with the route: the layout derives
 * `showChecklists` from isChecklistEditorEnabled() (lib/checklist-access.ts),
 * the same helper the route uses, never from the role alone. An admin whose org
 * has the feature off must not see the entry.
 */

const mockGetUser = jest.fn();
const mockMaybeSingle = jest.fn();
const mockGetImpersonationSession = jest.fn();
const mockIsChecklistEditorEnabled = jest.fn();

jest.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: () => mockGetUser() },
    from: () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: () => mockMaybeSingle(),
      };
      return chain;
    },
  }),
}));
jest.mock('@/lib/impersonation', () => ({
  getImpersonationSession: () => mockGetImpersonationSession(),
}));
jest.mock('@/lib/checklist-access', () => ({
  isChecklistEditorEnabled: () => mockIsChecklistEditorEnabled(),
}));
jest.mock('next/navigation', () => ({
  redirect: () => {
    throw new Error('NEXT_REDIRECT');
  },
}));

import DashboardLayout from '@/app/dashboard/layout';
import { DashboardShell } from '@/components/layout/DashboardShell';

async function shellProps(): Promise<Record<string, unknown>> {
  const element = await DashboardLayout({ children: null });
  expect(element.type).toBe(DashboardShell);
  return element.props as Record<string, unknown>;
}

beforeEach(() => {
  jest.resetAllMocks();
  mockGetUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'admin@example.test' } } });
  mockMaybeSingle.mockResolvedValue({ data: { role: 'admin' }, error: null });
  mockGetImpersonationSession.mockResolvedValue(null);
});

describe('DashboardLayout — showChecklists', () => {
  it('is false for an admin when the gate refuses (feature off) [A11]', async () => {
    mockIsChecklistEditorEnabled.mockResolvedValue(false);
    const props = await shellProps();
    expect(props.showChecklists).toBe(false);
    expect(mockIsChecklistEditorEnabled).toHaveBeenCalledTimes(1);
  });

  it('is true when the gate allows', async () => {
    mockIsChecklistEditorEnabled.mockResolvedValue(true);
    expect((await shellProps()).showChecklists).toBe(true);
  });

  it('is false during impersonation without asking the gate', async () => {
    mockGetImpersonationSession.mockResolvedValue({ target_email: 't@example.test', target_name: 'T' });
    mockIsChecklistEditorEnabled.mockResolvedValue(true);
    expect((await shellProps()).showChecklists).toBe(false);
    expect(mockIsChecklistEditorEnabled).not.toHaveBeenCalled();
  });
});
