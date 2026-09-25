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
  useRouter: () => ({ refresh: jest.fn(), push: jest.fn(), replace: jest.fn() }),
}));
// The list's client actions are never invoked here; the module is 'use server'.
jest.mock('@/lib/actions/checklists', () => ({
  archiveChecklistTemplate: jest.fn(),
  restoreChecklistTemplate: jest.fn(),
}));

import ChecklistsPage from '@/app/dashboard/checklists/page';
import { CHECKLIST_EDITOR_ROLES, CHECKLIST_FEATURE_KEY } from '@/lib/checklist-access';
import { CHECKLIST_LIST_SELECT } from '@/lib/checklists/listRows';
import { AUDIT_USER_SELECT } from '@/lib/checklists/audit';
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
/** pii-allow-uuid: invented fixture id, a user the viewer cannot read */
const GONE_USER_ID = '00000000-0000-4000-8000-0000003474ee';

const DEFAULT_UPDATED_AT = '2026-09-24T18:57:37.552806+00:00';

/**
 * A checklist_templates row with its items embed, in the column set
 * CHECKLIST_LIST_SELECT names. The emulator does not project, so the row
 * carries organization_id for the `.eq` filter as the table does.
 */
const template = (id: string, organization_id: string, over: Partial<Row> = {}): Row => ({
  id,
  organization_id,
  name: `Template ${id}`,
  description: null,
  seed_key: null,
  archived_at: null,
  updated_at: DEFAULT_UPDATED_AT,
  updated_by: null,
  sort_order: 10,
  checklist_template_items: [{ is_required: true }, { is_required: false }],
  ...over,
});

/** Same recipe as formatAuditDateTime (lib/checklists/audit.ts), recomputed
 *  independently so this also catches a bug inside the formatter itself
 *  (BACKLOG-3474 PR 4 — the list shows date + time once mounted). */
function dt(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

interface Setup {
  role?: string;
  features?: unknown;
  templates?: Row[];
  impersonating?: boolean;
  templatesError?: boolean;
  users?: Row[];
}

function setup(opts: Setup = {}) {
  const emu = createPostgrestEmulator({
    rows: {
      organization_members: [brokerageMembership(opts.role ?? 'broker')],
      checklist_templates: opts.templates ?? [],
      users: opts.users ?? [],
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
  it.each([...CHECKLIST_EDITOR_ROLES])('the empty state for a %s with no templates', async (role) => {
    setup({ role });
    render(await ChecklistsPage());
    expect(screen.getByRole('heading', { name: 'Checklists' })).toBeInTheDocument();
    expect(screen.getByText('No checklist templates yet')).toBeInTheDocument();
    expect(
      screen.getByText(/A template is the list of items an agent ticks off on a transaction/)
    ).toBeInTheDocument();
    // The one way forward from an empty list.
    expect(screen.getByRole('link', { name: 'New template' })).toHaveAttribute('href', '/dashboard/checklists/new');
  });

  // A13: one row in the caller's org, one in another org.
  it("lists only the caller's organization's templates [A13]", async () => {
    const { emu } = setup({
      templates: [template('t1', FIXTURE_BROKERAGE_ORG_ID), template('t2', OTHER_ORG_ID)],
    });
    render(await ChecklistsPage());
    expect(screen.getByRole('link', { name: 'Template t1' })).toHaveAttribute('href', '/dashboard/checklists/t1');
    expect(screen.queryByText('Template t2')).not.toBeInTheDocument();
    expect(screen.getByText('Showing 1 template · 1 active')).toBeInTheDocument();
    expect(emu.state.selects).toContainEqual({ table: 'checklist_templates', columns: CHECKLIST_LIST_SELECT });
  });

  it('shows item and required counts, Seeded only for seeded rows, and Archived with Restore', async () => {
    setup({
      templates: [
        template('a', FIXTURE_BROKERAGE_ORG_ID, { name: 'Seeded one', seed_key: 'residential', sort_order: 10 }),
        template('b', FIXTURE_BROKERAGE_ORG_ID, {
          name: 'Old one',
          archived_at: '2026-09-01T00:00:00+00:00',
          sort_order: 5,
          checklist_template_items: [{ is_required: true }, { is_required: true }, { is_required: false }],
        }),
        template('c', FIXTURE_BROKERAGE_ORG_ID, { name: 'Own one', sort_order: 20, checklist_template_items: [] }),
      ],
    });
    render(await ChecklistsPage());
    const rows = screen.getAllByTestId('checklist-row');
    // Active first (by sort_order), archived last even with a lower sort_order.
    expect(rows.map((r) => r.querySelector('a')?.textContent)).toEqual(['Seeded one', 'Own one', 'Old one']);
    const cells = (r: HTMLElement) => [...r.querySelectorAll('td')].map((td) => td.textContent);
    expect(cells(rows[0]).slice(1, 3)).toEqual(['2', '1']);
    expect(cells(rows[1]).slice(1, 3)).toEqual(['0', '0']);
    expect(cells(rows[2]).slice(1, 3)).toEqual(['3', '2']);
    expect(rows[0]).toHaveTextContent('Seeded');
    expect(rows[1]).not.toHaveTextContent('Seeded');
    expect(rows[2]).toHaveTextContent('Archived');
    expect(screen.getByRole('button', { name: 'Restore Old one' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Archive Seeded one' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archive Old one' })).not.toBeInTheDocument();
    expect(screen.getByText('Showing 3 templates · 2 active')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'New template' })).toBeInTheDocument();
  });

  // BACKLOG-3474 PR 3: who last edited each template. The users row is in the
  // column set AUDIT_USER_SELECT names (public.users: id, email, display_name,
  // first_name, last_name); values are invented.
  // jest.config.js pins process.env.TZ to a non-UTC zone for the whole suite
  // (a per-test assignment here would have no effect — see editor.test.tsx),
  // so this proves a real local-time conversion happened, not just "some
  // time string is present".
  it('names the last editor, "a former member" for an unresolvable one, and no one for a null updated_by', async () => {
    const { emu } = setup({
      templates: [
        template('a', FIXTURE_BROKERAGE_ORG_ID, { name: 'Edited by a member', sort_order: 10, updated_by: FIXTURE_USER_ID }),
        template('b', FIXTURE_BROKERAGE_ORG_ID, { name: 'Edited by someone gone', sort_order: 20, updated_by: GONE_USER_ID }),
        template('c', FIXTURE_BROKERAGE_ORG_ID, { name: 'Never edited', sort_order: 30 }),
      ],
      users: [{ id: FIXTURE_USER_ID, email: 'broker@example.test', display_name: 'Jane Doe', first_name: 'Jane', last_name: 'Doe' }],
    });
    render(await ChecklistsPage());
    const rows = screen.getAllByTestId('checklist-row');
    const lastEdited = (r: HTMLElement) => r.querySelectorAll('td')[3].textContent;
    const editedAt = dt(DEFAULT_UPDATED_AT);
    expect(lastEdited(rows[0])).toBe(`${editedAt}by Jane Doe`);
    expect(lastEdited(rows[1])).toBe(`${editedAt}by a former member`);
    expect(lastEdited(rows[2])).toBe(editedAt);
    expect(document.body.textContent).not.toContain(GONE_USER_ID);
    expect(document.body.textContent).not.toContain(FIXTURE_USER_ID);
    expect(emu.state.selects).toContainEqual({ table: 'users', columns: AUDIT_USER_SELECT });
  });

  it('does not claim "no templates" when the read fails', async () => {
    setup({ templatesError: true });
    render(await ChecklistsPage());
    expect(screen.getByRole('alert')).toHaveTextContent('could not be loaded');
    expect(screen.queryByText('No checklist templates yet')).not.toBeInTheDocument();
  });
});
