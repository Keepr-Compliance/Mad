/**
 * /dashboard/checklists route gate — BACKLOG-3474.
 *
 * The real gate (lib/checklist-access.ts) runs underneath; only the Supabase
 * client and the impersonation reader are stand-ins. checklist_templates is
 * served by the BACKLOG-3364 PostgREST emulator, which applies `.eq` as a real
 * filter — so a list read that forgets the org scope sees the other org's row.
 *
 * Feature payloads are DERIVED (see checklist-access.test.ts).
 */

import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockCreateClient = jest.fn();
const mockGetImpersonationSession = jest.fn();

jest.mock('@/lib/supabase/server', () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));
jest.mock('@/lib/impersonation', () => ({
  getImpersonationSession: () => mockGetImpersonationSession(),
}));

const NOT_FOUND = 'NEXT_NOT_FOUND';
jest.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error(NOT_FOUND);
  },
}));

import ChecklistsPage from '@/app/dashboard/checklists/page';
import { CHECKLIST_FEATURE_KEY } from '@/lib/checklist-access';
import { ORG_WITHOUT_PLAN_FEATURES, withFeature } from '../../../fixtures/orgFeatures';
import {
  FIXTURE_BROKERAGE_ORG_ID,
  FIXTURE_USER_ID,
  brokerageMembership,
  createPostgrestEmulator,
  type Row,
} from '../../../helpers/postgrestEmulator';

const FEATURE_ON = withFeature(ORG_WITHOUT_PLAN_FEATURES, CHECKLIST_FEATURE_KEY, true);
const FEATURE_OFF = withFeature(ORG_WITHOUT_PLAN_FEATURES, CHECKLIST_FEATURE_KEY, false);

/** pii-allow-uuid: invented fixture id */
const OTHER_ORG_ID = '00000000-0000-4000-8000-0000003474ff';

const template = (id: string, organization_id: string): Row => ({ id, organization_id });

interface Setup {
  role?: string;
  features?: unknown;
  templates?: Row[];
  impersonating?: boolean;
  templatesError?: boolean;
}

function setup(opts: Setup = {}) {
  const emu = createPostgrestEmulator({
    rows: {
      organization_members: [brokerageMembership(opts.role ?? 'broker')],
      checklist_templates: opts.templates ?? [],
    },
  });
  const from = jest.fn((t: string) => {
    if (t === 'checklist_templates' && opts.templatesError) {
      const chain = {
        select: () => chain,
        eq: () => chain,
        then: (res: (v: unknown) => unknown) =>
          Promise.resolve({ data: null, error: { message: 'boom' } }).then(res),
      };
      return chain;
    }
    return emu.from(t);
  });
  mockCreateClient.mockResolvedValue({
    auth: { getUser: async () => ({ data: { user: { id: FIXTURE_USER_ID } } }) },
    from,
    rpc: jest.fn(async () => ({ data: opts.features ?? FEATURE_ON, error: null })),
  });
  mockGetImpersonationSession.mockResolvedValue(
    opts.impersonating ? { session_id: 's', target_user_id: 't' } : null
  );
  return { emu, from };
}

let errorSpy: jest.SpyInstance;
beforeEach(() => {
  mockCreateClient.mockReset();
  mockGetImpersonationSession.mockReset();
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => errorSpy.mockRestore());

describe('/dashboard/checklists — refuses with 404', () => {
  it('when the feature is off', async () => {
    const { from } = setup({ features: FEATURE_OFF });
    await expect(ChecklistsPage()).rejects.toThrow(NOT_FOUND);
    expect(from).not.toHaveBeenCalledWith('checklist_templates');
  });

  it('for an agent', async () => {
    setup({ role: 'agent' });
    await expect(ChecklistsPage()).rejects.toThrow(NOT_FOUND);
  });

  // A10: editor-role user with the feature on, inside a support session.
  it('during impersonation, even for an editor with a live session [A10]', async () => {
    const { from } = setup({ role: 'admin', impersonating: true });
    await expect(ChecklistsPage()).rejects.toThrow(NOT_FOUND);
    expect(from).not.toHaveBeenCalled();
  });
});

describe('/dashboard/checklists — renders', () => {
  it.each(['broker', 'admin', 'it_admin'])('the empty state for a %s with no templates', async (role) => {
    setup({ role });
    render(await ChecklistsPage());
    expect(screen.getByRole('heading', { name: 'Checklists' })).toBeInTheDocument();
    expect(screen.getByText('No checklist templates yet')).toBeInTheDocument();
    expect(
      screen.getByText(/A template is the list of items an agent ticks off on a transaction/)
    ).toBeInTheDocument();
    // No dead button in this cut.
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  // A13: one row in the caller's org, one in another org.
  it("counts only the caller's organization's templates [A13]", async () => {
    const { emu } = setup({
      templates: [template('t1', FIXTURE_BROKERAGE_ORG_ID), template('t2', OTHER_ORG_ID)],
    });
    render(await ChecklistsPage());
    expect(screen.getByText('1 template')).toBeInTheDocument();
    expect(screen.queryByText('No checklist templates yet')).not.toBeInTheDocument();
    expect(emu.state.selects).toContainEqual({ table: 'checklist_templates', columns: 'id' });
  });

  it('does not claim "no templates" when the read fails', async () => {
    setup({ templatesError: true });
    render(await ChecklistsPage());
    expect(screen.getByRole('alert')).toHaveTextContent('could not be loaded');
    expect(screen.queryByText('No checklist templates yet')).not.toBeInTheDocument();
  });
});
