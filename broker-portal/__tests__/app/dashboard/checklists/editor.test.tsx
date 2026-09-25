/**
 * Checklist template editor — BACKLOG-3474.
 *
 * Two layers:
 *   - the routes (/dashboard/checklists/[id] and /new): the real gate runs
 *     underneath (membership through the BACKLOG-3364 PostgREST emulator, the
 *     fail-closed feature check); the template read is org-scoped, so another
 *     organization's template id is a 404;
 *   - the editor itself: Save arms only on a real change, the grip reorders
 *     from the keyboard, the save sends the display order and the token it
 *     holds, and the token a save returns is the one the next save sends.
 *
 * The save action is mocked here (its own gate is proven in
 * __tests__/lib/actions/checklist-actions-gate.test.ts).
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderToStaticMarkup } from 'react-dom/server';
import '@testing-library/jest-dom';

const mockCreateClient = jest.fn();
const mockGetImpersonationSession = jest.fn();
const mockSave = jest.fn();
const mockReplace = jest.fn();
const mockRefresh = jest.fn();
const mockPush = jest.fn();

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
  useRouter: () => ({ replace: mockReplace, refresh: mockRefresh, push: mockPush }),
}));
jest.mock('@/lib/actions/checklists', () => ({
  saveChecklistTemplate: (...args: unknown[]) => mockSave(...args),
}));

import EditChecklistTemplatePage from '@/app/dashboard/checklists/[id]/page';
import NewChecklistTemplatePage from '@/app/dashboard/checklists/new/page';
import ChecklistEditorClient from '@/app/dashboard/checklists/ChecklistEditorClient';
import { CHECKLIST_FEATURE_KEY } from '@/lib/checklist-access';
import { SAVE_MESSAGES } from '@/lib/checklists/saveErrors';
import type { TemplateItemRow } from '@/lib/checklists/editorState';
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

/** Transcribed PostgREST text of a real checklist_templates.updated_at (pm_comments 6501344d). */
const TOKEN = '2026-09-24T18:57:37.552806+00:00';
/** pii-allow-uuid: invented fixture id */
const TEMPLATE_ID = '00000000-0000-4000-8000-0000003474a1';
/** pii-allow-uuid: invented fixture id */
const OTHER_TEMPLATE_ID = '00000000-0000-4000-8000-0000003474a2';
/** pii-allow-uuid: invented fixture id */
const OTHER_ORG_ID = '00000000-0000-4000-8000-0000003474ff';
/** pii-allow-uuid: invented fixture id, a user the viewer cannot read */
const GONE_USER_ID = '00000000-0000-4000-8000-0000003474ee';

const ITEMS: TemplateItemRow[] = [
  { id: 'item-a', title: 'Executed purchase contract', sort_order: 10, description: null, is_required: true, expected_document_type: 'contract' },
  { id: 'item-b', title: 'Inspection report', sort_order: 20, description: null, is_required: false, expected_document_type: null },
  { id: 'item-c', title: 'Closing disclosure', sort_order: 30, description: 'Final numbers', is_required: true, expected_document_type: 'closing' },
];

const templateRow = (id: string, organization_id: string): Row => ({
  id,
  organization_id,
  name: 'Residential purchase',
  description: null,
  created_at: TOKEN,
  created_by: null,
  updated_at: TOKEN,
  updated_by: null,
  archived_at: null,
  archived_by: null,
  checklist_template_items: ITEMS,
});

function setupRoute(
  opts: { role?: string; features?: unknown; impersonating?: boolean; templates?: Row[]; users?: Row[] } = {}
) {
  const emu = createPostgrestEmulator({
    rows: {
      organization_members: [brokerageMembership(opts.role ?? 'broker')],
      checklist_templates: opts.templates ?? [templateRow(TEMPLATE_ID, FIXTURE_BROKERAGE_ORG_ID)],
      users: opts.users ?? [],
    },
  });
  const from = jest.fn((t: string) => emu.from(t));
  mockCreateClient.mockResolvedValue({
    auth: { getUser: async () => ({ data: { user: { id: FIXTURE_USER_ID } } }) },
    from,
    rpc: jest.fn(async () => ({ data: opts.features ?? FEATURE_ON, error: null })),
  });
  mockGetImpersonationSession.mockResolvedValue(opts.impersonating ? { session_id: 's', target_user_id: 't' } : null);
  return { emu, from };
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

function renderEditor(over: Partial<React.ComponentProps<typeof ChecklistEditorClient>> = {}) {
  return render(
    <ChecklistEditorClient
      templateId={TEMPLATE_ID}
      updatedAt={TOKEN}
      archived={false}
      template={{ name: 'Residential purchase', description: null }}
      items={ITEMS}
      {...over}
    />
  );
}

const saveButtons = () => screen.getAllByRole('button', { name: 'Save changes' });
const itemTitles = () => screen.getAllByLabelText('Item title').map((el) => (el as HTMLInputElement).value);

let errorSpy: jest.SpyInstance;
beforeEach(() => {
  mockCreateClient.mockReset();
  mockGetImpersonationSession.mockReset();
  mockSave.mockReset();
  mockReplace.mockReset();
  mockRefresh.mockReset();
  mockPush.mockReset();
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => errorSpy.mockRestore());

describe('/dashboard/checklists/[id] — refuses with 404', () => {
  it.each([
    ['with the feature off', { features: FEATURE_OFF }],
    ['for an agent', { role: 'agent' }],
    ['during impersonation', { role: 'admin', impersonating: true }],
  ] as const)('%s', async (_l, opts) => {
    setupRoute(opts);
    await expect(EditChecklistTemplatePage(params(TEMPLATE_ID))).rejects.toThrow(NOT_FOUND);
  });

  it("for another organization's template id", async () => {
    setupRoute({ templates: [templateRow(OTHER_TEMPLATE_ID, OTHER_ORG_ID)] });
    await expect(EditChecklistTemplatePage(params(OTHER_TEMPLATE_ID))).rejects.toThrow(NOT_FOUND);
  });

  it('for an id that is not a uuid, without reading templates', async () => {
    const { from } = setupRoute();
    await expect(EditChecklistTemplatePage(params('not-a-uuid'))).rejects.toThrow(NOT_FOUND);
    expect(from).not.toHaveBeenCalledWith('checklist_templates');
  });
});

describe('/dashboard/checklists/[id] — renders', () => {
  it('the stored items in sort order, and saves with the token it read, verbatim', async () => {
    setupRoute();
    mockSave.mockResolvedValue({ ok: true, id: TEMPLATE_ID, updatedAt: '2026-09-24T20:00:00.000001+00:00' });
    render(await EditChecklistTemplatePage(params(TEMPLATE_ID)));
    expect(itemTitles()).toEqual(['Executed purchase contract', 'Inspection report', 'Closing disclosure']);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Residential purchase v2' } });
    fireEvent.click(saveButtons()[0]);
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));
    expect(mockSave.mock.calls[0][0]).toMatchObject({ templateId: TEMPLATE_ID, expectedUpdatedAt: TOKEN });
  });
});

// BACKLOG-3474 PR 3: created / last edited / archived, who and when.
// PR 4: the editor header shows time too, once mounted in the browser (the
// mounted gate — ChecklistEditorClient.tsx — is what makes this safe: the
// server can't know the viewer's timezone, so it renders date-only first and
// switches to date+time on mount; RTL's render() flushes that effect, so
// these assertions see the final, timed state).
//
// jest.config.js pins process.env.TZ to a non-UTC zone (America/Los_Angeles)
// so this proves a real local-time conversion happened, not just "some time
// string is present" — if CI's default TZ (UTC) were left in place, a
// regression that hardcoded `timeZone: 'UTC'` in the formatter could slip
// through undetected. It MUST be set in jest.config.js, not in a test file's
// beforeAll — a process.env.TZ assignment inside the test file has no
// effect: verified empirically (it silently fell back to the host machine's
// real timezone), but the mechanism inside jest is NOT traced — a plausible
// cause is that each test file runs against its own copy of process.env
// rather than the real one; caught in SR review of this PR.
describe('/dashboard/checklists/[id] — audit line', () => {
  const audit = () => screen.getByTestId('checklist-audit').textContent;

  /** Same recipe as formatAuditDateTime (lib/checklists/audit.ts), recomputed
   *  independently here rather than imported, so this test also catches a
   *  bug inside the formatter itself, not only a wiring bug. */
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

  it('names a resolvable user, shows "a former member" for one that is not, and never an id', async () => {
    const editedAt = '2026-09-24T22:08:43.723274+00:00';
    const archivedAt = '2026-09-24T22:10:00.000001+00:00';
    setupRoute({
      templates: [
        {
          ...templateRow(TEMPLATE_ID, FIXTURE_BROKERAGE_ORG_ID),
          created_by: FIXTURE_USER_ID,
          updated_by: GONE_USER_ID,
          updated_at: editedAt,
          archived_at: archivedAt,
          archived_by: FIXTURE_USER_ID,
        },
      ],
      users: [{ id: FIXTURE_USER_ID, email: 'broker@example.test', display_name: null, first_name: 'Jane', last_name: 'Doe' }],
    });
    render(await EditChecklistTemplatePage(params(TEMPLATE_ID)));
    expect(audit()).toBe(
      `Created ${dt(TOKEN)} by Jane Doe · Last edited ${dt(editedAt)} by a former member · Archived ${dt(archivedAt)} by Jane Doe`
    );
    expect(document.body.textContent).not.toContain(GONE_USER_ID);
    expect(document.body.textContent).not.toContain(FIXTURE_USER_ID);
  });

  it('shows dates and times alone when no one is recorded (seeded, or not edited since the columns existed)', async () => {
    setupRoute();
    render(await EditChecklistTemplatePage(params(TEMPLATE_ID)));
    expect(audit()).toBe(`Created ${dt(TOKEN)} · Last edited ${dt(TOKEN)}`);
  });

  // Pins the mount gate itself: renderToStaticMarkup never runs effects, so
  // this is exactly what the server sends before the browser mounts. If the
  // `mounted` state were ever initialized to true (or the gate removed), the
  // server markup would already contain a time computed in the SERVER's
  // timezone (UTC on Vercel) — the bug the mount gate exists to prevent.
  it('renders date-only server-side, before the mount effect can run', () => {
    const html = renderToStaticMarkup(
      <ChecklistEditorClient
        templateId={TEMPLATE_ID}
        updatedAt={TOKEN}
        archived={false}
        template={{ name: 'Residential purchase', description: null }}
        items={ITEMS}
        audit={{ created: { at: TOKEN, by: 'Jane Doe' }, edited: { at: TOKEN, by: 'Jane Doe' }, archived: null }}
      />
    );
    expect(html).toContain('Created Sep 24, 2026 by Jane Doe');
    expect(html).not.toContain(dt(TOKEN));
  });
});

describe('/dashboard/checklists/new', () => {
  it('404s when refused', async () => {
    setupRoute({ features: FEATURE_OFF });
    await expect(NewChecklistTemplatePage()).rejects.toThrow(NOT_FOUND);
  });

  it('opens empty with one blank item and Save disarmed', async () => {
    setupRoute();
    render(await NewChecklistTemplatePage());
    expect(screen.getByRole('heading', { name: 'New template' })).toBeInTheDocument();
    expect(itemTitles()).toEqual(['']);
    saveButtons().forEach((b) => expect(b).toBeDisabled());
  });
});

describe('editor — Save arms only on a real change', () => {
  it('is disabled until something changes, and again when the change is undone', () => {
    renderEditor();
    saveButtons().forEach((b) => expect(b).toBeDisabled());
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();

    const name = screen.getByLabelText('Name');
    fireEvent.change(name, { target: { value: 'Residential purchase (2026)' } });
    saveButtons().forEach((b) => expect(b).toBeEnabled());
    expect(screen.getAllByText('Unsaved changes').length).toBeGreaterThan(0);

    fireEvent.change(name, { target: { value: 'Residential purchase' } });
    saveButtons().forEach((b) => expect(b).toBeDisabled());
  });

  it('a Required switch arms it', () => {
    renderEditor();
    const sw = screen.getByRole('switch', { name: 'Required: Inspection report' });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(sw);
    expect(sw).toHaveAttribute('aria-checked', 'true');
    saveButtons().forEach((b) => expect(b).toBeEnabled());
  });
});

describe('editor — keyboard reorder', () => {
  it('ArrowDown / ArrowUp on the grip move the item and arm Save', () => {
    renderEditor();
    const grip = screen.getByRole('button', { name: /^Reorder Executed purchase contract/ });
    fireEvent.keyDown(grip, { key: 'ArrowDown' });
    expect(itemTitles()).toEqual(['Inspection report', 'Executed purchase contract', 'Closing disclosure']);
    saveButtons().forEach((b) => expect(b).toBeEnabled());
    fireEvent.keyDown(screen.getByRole('button', { name: /^Reorder Executed purchase contract/ }), { key: 'ArrowUp' });
    expect(itemTitles()).toEqual(['Executed purchase contract', 'Inspection report', 'Closing disclosure']);
    saveButtons().forEach((b) => expect(b).toBeDisabled());
  });

  it('the save sends items in the displayed order', async () => {
    mockSave.mockResolvedValue({ ok: true, id: TEMPLATE_ID, updatedAt: '2026-09-24T20:00:00.000001+00:00' });
    renderEditor();
    fireEvent.keyDown(screen.getByRole('button', { name: /^Reorder Closing disclosure/ }), { key: 'ArrowUp' });
    fireEvent.click(saveButtons()[0]);
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));
    const sent = mockSave.mock.calls[0][0].payload.items.map((i: { id?: string }) => i.id);
    expect(sent).toEqual(['item-a', 'item-c', 'item-b']);
  });
});

describe('editor — the token', () => {
  it('the second save sends the token the first save returned [A3]', async () => {
    mockSave
      .mockResolvedValueOnce({ ok: true, id: TEMPLATE_ID, updatedAt: '2026-09-24T20:00:00.000001+00:00' })
      .mockResolvedValueOnce({ ok: true, id: TEMPLATE_ID, updatedAt: '2026-09-24T20:00:05.000002+00:00' });
    renderEditor();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'First edit' } });
    fireEvent.click(saveButtons()[0]);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Saved.'));
    saveButtons().forEach((b) => expect(b).toBeDisabled());

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Second edit' } });
    fireEvent.click(saveButtons()[0]);
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(2));
    expect(mockSave.mock.calls[0][0].expectedUpdatedAt).toBe(TOKEN);
    expect(mockSave.mock.calls[1][0].expectedUpdatedAt).toBe('2026-09-24T20:00:00.000001+00:00');
  });

  it('shows the stale message and keeps the edits when the template changed elsewhere', async () => {
    mockSave.mockResolvedValue({ ok: false, reason: 'stale', message: SAVE_MESSAGES.stale });
    renderEditor();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Mine' } });
    fireEvent.click(saveButtons()[0]);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(SAVE_MESSAGES.stale));
    expect(screen.getByLabelText('Name')).toHaveValue('Mine');
    saveButtons().forEach((b) => expect(b).toBeEnabled());
  });
});

describe('editor — validation and create', () => {
  it('a blank item title is reported and nothing is sent', async () => {
    renderEditor();
    fireEvent.change(screen.getAllByLabelText('Item title')[1], { target: { value: '   ' } });
    fireEvent.click(saveButtons()[0]);
    expect(await screen.findByText('Give the item a title.')).toBeInTheDocument();
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('remove and add item change the list', () => {
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Inspection report' }));
    expect(itemTitles()).toEqual(['Executed purchase contract', 'Closing disclosure']);
    fireEvent.click(screen.getByRole('button', { name: 'Add item' }));
    expect(itemTitles()).toEqual(['Executed purchase contract', 'Closing disclosure', '']);
    expect(screen.getByText('3 items · 2 required')).toBeInTheDocument();
  });

  // BACKLOG-3474 PR 3: focus used to stay on "Add item", so typing went nowhere
  // and every space pressed the button again (an empty row each time).
  it('Add item puts focus in the new row\'s title, and typing a title with spaces adds no rows', async () => {
    const user = userEvent.setup();
    renderEditor();
    await user.click(screen.getByRole('button', { name: 'Add item' }));
    const titles = screen.getAllByLabelText('Item title');
    expect(titles).toHaveLength(4);
    expect(titles[3]).toHaveFocus();
    await user.keyboard('Item B inspection report');
    expect(itemTitles()).toEqual(['Executed purchase contract', 'Inspection report', 'Closing disclosure', 'Item B inspection report']);
    expect(screen.getAllByTestId('checklist-item-row')).toHaveLength(4);
  });

  it('a new template saves with no id and no token, then opens the saved template', async () => {
    mockSave.mockResolvedValue({ ok: true, id: TEMPLATE_ID, updatedAt: TOKEN });
    renderEditor({ templateId: null, updatedAt: null, template: null, items: [] });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Land / lot' } });
    fireEvent.change(screen.getAllByLabelText('Item title')[0], { target: { value: 'Survey' } });
    fireEvent.click(saveButtons()[0]);
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith(`/dashboard/checklists/${TEMPLATE_ID}`));
    expect(mockSave.mock.calls[0][0]).toMatchObject({
      templateId: null,
      expectedUpdatedAt: null,
      payload: { name: 'Land / lot', items: [{ title: 'Survey', is_required: false, expected_document_type: null }] },
    });
    expect(within(document.body).queryByRole('alert')).not.toBeInTheDocument();
  });
});
