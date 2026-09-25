/**
 * Route audit — BACKLOG-3080 (C-audit).
 *
 * The floor is: the welcome dashboard, the person's own support tickets, and
 * My Account. EVERYTHING else must be refused on the server to a brokerage
 * agent and to the owner of a personal organization — by the page or action
 * itself, not by middleware. Pages are invoked directly here, so middleware is
 * not in the path; server actions never pass through middleware at all.
 *
 * Every refused entry is also run for a brokerage ADMIN, who must get through.
 * That is what shows the harness can tell admission from refusal.
 *
 * The emulator is the client behind `createClient`, `getDataClient` and the
 * service client, so every table read before a refusal is recorded.
 *
 * Set completeness: every page under app/dashboard and every export of every
 * 'use server' module is discovered from disk and must be classified below.
 * A new page or action nobody classified turns this file red.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, win32 } from 'path';
import {
  FIXTURE_BROKERAGE_ORG_ID,
  FIXTURE_INVITE_ID,
  FIXTURE_OTHER_USER_ID,
  FIXTURE_USER_ID,
  brokerageMembership,
  createPostgrestEmulator,
  pendingInvite,
  personalMembership,
  type Row,
} from '../helpers/postgrestEmulator';

const mockEmulator = createPostgrestEmulator();
const mockGetUser = jest.fn();
const mockRpc = jest.fn(async () => ({ data: null, error: null }));

jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(async () => ({
    auth: { getUser: mockGetUser, signOut: jest.fn(async () => ({ error: null })) },
    from: (table: string) => mockEmulator.from(table),
    rpc: mockRpc,
  })),
}));
jest.mock('@/lib/supabase/service', () => ({
  createServiceClient: jest.fn(() => ({
    from: (table: string) => mockEmulator.from(table),
    rpc: mockRpc,
  })),
}));
jest.mock('@/lib/impersonation', () => ({
  getImpersonationSession: jest.fn(async () => null),
}));
// Every fail-closed feature check is forced ON, so a refusal below can only be
// the role check. A feature check doing the refusing would hide a deleted gate.
jest.mock('@/lib/feature-gate', () => ({
  ...jest.requireActual('@/lib/feature-gate'),
  isFeatureEnabledFailClosed: jest.fn(async () => true),
}));
jest.mock('@/lib/email', () => ({
  sendInviteEmail: jest.fn(async () => ({ success: true, outcome: 'sent' })),
}));
jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  addBreadcrumb: jest.fn(),
}));
jest.mock('next/cache', () => ({ revalidatePath: jest.fn() }));
// Presentation only: these submission-detail components pull browser-only
// modules at import time. The gate under test runs before any of them.
jest.mock('@/components/submission/MessageList', () => ({ MessageList: () => null }));
jest.mock('@/components/submission/ReviewActions', () => ({ ReviewActions: () => null }));
jest.mock('@/components/submission/AttachmentList', () => ({ AttachmentList: () => null }));
jest.mock('@/components/submission/StatusHistory', () => ({ StatusHistory: () => null }));

class Redirect extends Error {
  constructor(public readonly to: string) {
    super('NEXT_REDIRECT');
  }
}
class NotFound extends Error {
  constructor() {
    super('NEXT_NOT_FOUND');
  }
}
jest.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Redirect(to);
  },
  notFound: () => {
    throw new NotFound();
  },
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A colleague in the same brokerage — the target of the user-admin actions. */
const TARGET_MEMBER_ID = '00000000-0000-4000-8000-000000308010'; // pii-allow-uuid: invented fixture id
const TARGET_MEMBER: Row = {
  id: TARGET_MEMBER_ID,
  user_id: FIXTURE_OTHER_USER_ID,
  role: 'agent',
  organization_id: FIXTURE_BROKERAGE_ORG_ID,
  license_status: 'active',
  invited_email: null,
  invited_by: null,
};
const INVITE = pendingInvite('invitee-3080@fixture.example.test', 'agent');
/** A checklist template in the brokerage, for the admitted-admin control only. */
const TEMPLATE_ID = '00000000-0000-4000-8000-000000308020'; // pii-allow-uuid: invented fixture id

const second = (row: Row): Row => ({ ...row, id: `${row.id as string}-second` });

const PERSONAS = {
  'brokerage agent': [brokerageMembership('agent')],
  'personal-org owner': [personalMembership()],
  '[agent, broker] (two brokerage rows)': [brokerageMembership('agent'), second(brokerageMembership('broker'))],
} as const;
const ADMIN = [brokerageMembership('admin')];

function given(memberships: readonly Row[]): void {
  mockGetUser.mockResolvedValue({
    data: { user: { id: FIXTURE_USER_ID, email: 'floor-fixture-3080@fixture.example.test', user_metadata: {} } },
  });
  mockEmulator.reset();
  mockEmulator.set({
    columnPresent: true,
    rows: {
      organization_members: [...memberships, TARGET_MEMBER, INVITE],
      checklist_templates: [
        {
          id: TEMPLATE_ID,
          organization_id: FIXTURE_BROKERAGE_ORG_ID,
          name: 'Fixture template',
          created_by: null,
          updated_by: null,
          archived_by: null,
          archived_at: null,
          updated_at: '2026-09-01T00:00:00Z',
          checklist_template_items: [],
        },
      ],
      transaction_submissions: [
        {
          id: 'sub-3080-audit',
          organization_id: FIXTURE_BROKERAGE_ORG_ID,
          submitted_by: FIXTURE_OTHER_USER_ID,
          status: 'submitted',
          property_address: 'Audit Fixture Street',
          created_at: '2026-09-01T00:00:00Z',
          // Integer counters (default 0 in public.transaction_submissions) the detail page prints.
          message_count: 0,
          attachment_count: 0,
        },
      ],
    },
  });
}

const tablesRead = () => Array.from(new Set(mockEmulator.state.selects.map((s) => s.table))).sort();

type Outcome =
  | { redirect: string }
  | { notFound: true }
  | { element: string }
  | { threw: string }
  | { returned: unknown };

async function run(fn: () => unknown): Promise<Outcome> {
  try {
    const value = await fn();
    if (value && typeof value === 'object' && '$$typeof' in (value as object)) {
      const type = (value as { type: unknown }).type;
      return { element: typeof type === 'function' ? type.name : String(type) };
    }
    return { returned: value };
  } catch (e) {
    if (e instanceof Redirect) return { redirect: e.to };
    if (e instanceof NotFound) return { notFound: true };
    return { threw: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

const idParams = (id: string) => ({ params: Promise.resolve({ id }) });

interface PageEntry {
  invoke: () => Promise<unknown>;
  /** The refusal every floor persona must get. */
  refused: Outcome;
}

const REFUSED_PAGES: Record<string, PageEntry> = {
  // The BROKER content of /dashboard is refused: a floor user gets the floor
  // view instead, and the submissions query never runs.
  'app/dashboard/page.tsx': {
    invoke: async () => (await import('@/app/dashboard/page')).default(),
    refused: { element: 'FloorDashboard' },
  },
  'app/dashboard/submissions/page.tsx': {
    invoke: async () =>
      (await import('@/app/dashboard/submissions/page')).default({ searchParams: Promise.resolve({}) }),
    refused: { redirect: '/dashboard' },
  },
  'app/dashboard/submissions/[id]/page.tsx': {
    invoke: async () => (await import('@/app/dashboard/submissions/[id]/page')).default(idParams('sub-3080-audit')),
    refused: { redirect: '/dashboard' },
  },
  'app/dashboard/users/page.tsx': {
    invoke: async () => (await import('@/app/dashboard/users/page')).default(),
    refused: { redirect: '/dashboard' },
  },
  'app/dashboard/users/[id]/page.tsx': {
    invoke: async () => (await import('@/app/dashboard/users/[id]/page')).default(idParams(TARGET_MEMBER_ID)),
    refused: { redirect: '/dashboard' },
  },
  'app/dashboard/settings/page.tsx': {
    invoke: async () => (await import('@/app/dashboard/settings/page')).default(),
    refused: { redirect: '/dashboard' },
  },
  'app/dashboard/settings/scim/page.tsx': {
    invoke: async () => (await import('@/app/dashboard/settings/scim/page')).default(),
    refused: { notFound: true },
  },
};

/** The floor: open to every portal user. Scoping of their data is covered elsewhere. */
const FLOOR_PAGES = [
  'app/dashboard/account/page.tsx',
  'app/dashboard/support/page.tsx',
  'app/dashboard/support/new/page.tsx',
  'app/dashboard/support/[id]/page.tsx',
];

/**
 * D4: these carry their own gate (lib/checklist-access.ts), unchanged here.
 * Refused today to every brokerage agent. The personal-org owner row is owned
 * by BACKLOG-3535 (#2716), which decides whether the owner may open them.
 */
const OWN_GATE_PAGES: Record<string, PageEntry> = {
  'app/dashboard/checklists/page.tsx': {
    invoke: async () => (await import('@/app/dashboard/checklists/page')).default(),
    refused: { notFound: true },
  },
  'app/dashboard/checklists/new/page.tsx': {
    invoke: async () => (await import('@/app/dashboard/checklists/new/page')).default(),
    refused: { notFound: true },
  },
  'app/dashboard/checklists/[id]/page.tsx': {
    invoke: async () => (await import('@/app/dashboard/checklists/[id]/page')).default(idParams(TEMPLATE_ID)),
    refused: { notFound: true },
  },
};
const OWN_GATE_PERSONAS = ['brokerage agent', '[agent, broker] (two brokerage rows)'] as const;

// ---------------------------------------------------------------------------
// Server actions
// ---------------------------------------------------------------------------

type ActionEntry = () => Promise<unknown>;
const act = <M, K extends keyof M>(load: () => Promise<M>, name: K, ...args: unknown[]): ActionEntry =>
  async () => ((await load())[name] as unknown as (...a: unknown[]) => unknown)(...args);

const users = () => import('@/lib/actions/bulkUpdateRole');
const scim = () => import('@/lib/actions/scim');
const checklists = () => import('@/lib/actions/checklists');

/** Everything above the floor. 6 user-admin + 11 in scim.ts + 3 checklist. */
const REFUSED_ACTIONS: Record<string, ActionEntry> = {
  'lib/actions/bulkUpdateRole.ts#bulkUpdateRole': act(users, 'bulkUpdateRole', {
    memberIds: [TARGET_MEMBER_ID],
    newRole: 'broker',
  }),
  'lib/actions/deactivateUser.ts#deactivateUser': act(() => import('@/lib/actions/deactivateUser'), 'deactivateUser', {
    memberId: TARGET_MEMBER_ID,
  }),
  'lib/actions/removeUser.ts#removeUser': act(() => import('@/lib/actions/removeUser'), 'removeUser', {
    memberId: TARGET_MEMBER_ID,
  }),
  'lib/actions/updateUserRole.ts#updateUserRole': act(() => import('@/lib/actions/updateUserRole'), 'updateUserRole', {
    memberId: TARGET_MEMBER_ID,
    newRole: 'broker',
  }),
  'lib/actions/inviteUser.ts#inviteUser': act(() => import('@/lib/actions/inviteUser'), 'inviteUser', {
    email: 'new-invitee-3080@fixture.example.test',
    role: 'agent',
    organizationId: FIXTURE_BROKERAGE_ORG_ID,
  }),
  'lib/actions/resendInvite.ts#resendInvite': act(() => import('@/lib/actions/resendInvite'), 'resendInvite', {
    memberId: FIXTURE_INVITE_ID,
    organizationId: FIXTURE_BROKERAGE_ORG_ID,
  }),
  'lib/actions/scim.ts#getScimFeatureStatus': act(scim, 'getScimFeatureStatus'),
  'lib/actions/scim.ts#generateScimToken': act(scim, 'generateScimToken', 'fixture'),
  'lib/actions/scim.ts#revokeScimToken': act(scim, 'revokeScimToken', 'token-3080'),
  'lib/actions/scim.ts#listScimTokens': act(scim, 'listScimTokens'),
  'lib/actions/scim.ts#getRetentionPolicy': act(scim, 'getRetentionPolicy'),
  'lib/actions/scim.ts#updateRetentionPolicy': act(scim, 'updateRetentionPolicy', 5),
  'lib/actions/scim.ts#getConsentStatus': act(scim, 'getConsentStatus'),
  'lib/actions/scim.ts#getJitFeatureStatus': act(scim, 'getJitFeatureStatus'),
  'lib/actions/scim.ts#getJitStatus': act(scim, 'getJitStatus'),
  'lib/actions/scim.ts#updateJitStatus': act(scim, 'updateJitStatus', true),
  'lib/actions/scim.ts#listScimSyncLogs': act(scim, 'listScimSyncLogs'),
  'lib/actions/checklists.ts#saveChecklistTemplate': act(checklists, 'saveChecklistTemplate', {}),
  'lib/actions/checklists.ts#archiveChecklistTemplate': act(checklists, 'archiveChecklistTemplate', 'tpl-3080'),
  'lib/actions/checklists.ts#restoreChecklistTemplate': act(checklists, 'restoreChecklistTemplate', 'tpl-3080'),
};

/**
 * The exact refusal each action gives a floor persona. Where the brokerage
 * agent (a member of the target's organization, refused on role) gets a
 * different message from a caller with no row there, both are listed.
 */
type Persona = keyof typeof PERSONAS;
const NOT_AUTHORIZED_THROW: Outcome = { threw: 'Not authorized' };
const byPersona = (agent: Outcome, others: Outcome): Record<Persona, Outcome> => ({
  'brokerage agent': agent,
  'personal-org owner': others,
  '[agent, broker] (two brokerage rows)': others,
});
const failed = (error: string): Outcome => ({ returned: { success: false, error } });
const CHECKLIST_REFUSED: Outcome = {
  returned: { ok: false, message: "You don't have permission to change checklist templates." },
};
const REFUSALS: Record<string, Outcome | Record<Persona, Outcome>> = {
  'lib/actions/bulkUpdateRole.ts#bulkUpdateRole': failed('Not authorized to update roles'),
  'lib/actions/deactivateUser.ts#deactivateUser': byPersona(
    failed('Not authorized to deactivate users'),
    failed('Not authorized')
  ),
  'lib/actions/removeUser.ts#removeUser': byPersona(failed('Not authorized to remove users'), failed('Not authorized')),
  'lib/actions/updateUserRole.ts#updateUserRole': byPersona(
    failed('Not authorized to change roles'),
    failed('Not authorized')
  ),
  'lib/actions/inviteUser.ts#inviteUser': failed('Not authorized to invite users'),
  'lib/actions/resendInvite.ts#resendInvite': { returned: { success: false, error: 'Not authorized' } },
  'lib/actions/scim.ts#getScimFeatureStatus': { returned: { enabled: false } },
  'lib/actions/scim.ts#generateScimToken': NOT_AUTHORIZED_THROW,
  'lib/actions/scim.ts#revokeScimToken': NOT_AUTHORIZED_THROW,
  'lib/actions/scim.ts#listScimTokens': NOT_AUTHORIZED_THROW,
  'lib/actions/scim.ts#getRetentionPolicy': NOT_AUTHORIZED_THROW,
  'lib/actions/scim.ts#updateRetentionPolicy': NOT_AUTHORIZED_THROW,
  'lib/actions/scim.ts#getConsentStatus': NOT_AUTHORIZED_THROW,
  'lib/actions/scim.ts#getJitFeatureStatus': { returned: { enabled: false } },
  'lib/actions/scim.ts#getJitStatus': NOT_AUTHORIZED_THROW,
  'lib/actions/scim.ts#updateJitStatus': NOT_AUTHORIZED_THROW,
  'lib/actions/scim.ts#listScimSyncLogs': NOT_AUTHORIZED_THROW,
  'lib/actions/checklists.ts#saveChecklistTemplate': {
    returned: { ok: false, reason: 'not_authorized', message: "You don't have permission to edit checklist templates." },
  },
  'lib/actions/checklists.ts#archiveChecklistTemplate': CHECKLIST_REFUSED,
  'lib/actions/checklists.ts#restoreChecklistTemplate': CHECKLIST_REFUSED,
};

function refusalFor(name: string, persona: Persona): Outcome {
  const r = REFUSALS[name];
  return persona in (r as object) ? (r as Record<Persona, Outcome>)[persona] : (r as Outcome);
}

/**
 * Tables an action may read before it refuses. organization_members always;
 * inviteUser also reads the caller's OWN users row (its self-invite check runs
 * before the role check).
 */
const READS_BEFORE_REFUSAL: Record<string, string[]> = {
  'lib/actions/inviteUser.ts#inviteUser': ['organization_members', 'users'],
};

/** Open to every signed-in person: their own devices, and the desktop sign-in flow. */
const FLOOR_ACTIONS = [
  'lib/actions/getActiveDevices.ts#getActiveDevices',
  'lib/actions/signOutAllDevices.ts#signOutAllDevices',
  'lib/actions/enforceSingleDesktopSession.ts#enforceSingleDesktopSession',
  'lib/actions/mintDesktopSession.ts#mintDesktopSession',
];

/**
 * R6: pre-existing, out of PR 1 scope, filed separately (BACKLOG-3543). It
 * performs no caller check of its own; it is NOT a floor action.
 */
const UNAUTHENTICATED_PREEXISTING_ACTIONS = ['lib/actions/createTokenClaim.ts#createTokenClaim'];

/** Helpers exported from a 'use server' file; the org-scoped callers above decide. */
const HELPER_ACTIONS = [
  'lib/actions/users.ts#getCurrentUserMembership',
  'lib/actions/users.ts#canManageMembers',
  'lib/actions/users.ts#hasMinimumRole',
  'lib/actions/users.ts#getAssignableRoles',
  'lib/actions/users.ts#canAssignRole',
  'lib/actions/users.ts#wouldRemoveLastAdmin',
  'lib/actions/users.ts#canPerformMemberAction',
];

/**
 * R2: `/setup/consent/callback` writes `organizations.graph_admin_consent_granted`
 * with no role check in TypeScript. The guard of record is RLS policy
 * `admins_can_modify_org` on `organizations` (read from production pg_policies
 * 2026-09-25): `id IN (SELECT organization_id FROM organization_members WHERE
 * user_id = auth.uid() AND role IN ('admin','it_admin'))`. PR 1 does not edit
 * this handler (D3 struck).
 */
const RLS_GUARDED_HANDLERS = ['app/setup/consent/callback/route.ts'];

// ---------------------------------------------------------------------------
// Discovery from disk (R3)
// ---------------------------------------------------------------------------

const ROOT = join(__dirname, '../..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === '__tests__') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** Separator-independent: every backslash becomes `/`, on whatever platform runs the test. */
function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * The one point where a discovered file becomes a classification key. Every
 * key is POSIX (`app/dashboard/...`), because the tables above are written that
 * way and Windows' `relative()` returns backslash-separated paths. `rel` is
 * injectable so the Windows shape can be exercised on any OS with `path.win32`.
 */
function repoKey(file: string, root: string = ROOT, rel: (from: string, to: string) => string = relative): string {
  return toPosix(rel(root, file));
}

function dashboardPageKeys(
  files: string[],
  root: string = ROOT,
  rel: (from: string, to: string) => string = relative
): string[] {
  return files
    .map((f) => repoKey(f, root, rel))
    .filter((k) => /\/page\.(tsx|ts|jsx|js)$/.test(k))
    .sort();
}

function discoverDashboardPages(): string[] {
  return dashboardPageKeys(walk(join(ROOT, 'app/dashboard')));
}

const DIRECTIVE = /^\s*(['"])use server\1\s*;?\s*$/;

/** Strip leading comments and blank lines; is the first statement 'use server'? */
function isUseServerModule(source: string): boolean {
  const body = source.replace(/^(\s*(\/\/[^\n]*\n|\/\*[\s\S]*?\*\/))*/, '');
  const firstLine = body.split('\n').find((l) => l.trim() !== '') ?? '';
  return DIRECTIVE.test(firstLine);
}

/** Runtime exports of a module: functions, consts/lets/vars, export lists, default. */
function runtimeExports(source: string): string[] {
  const names = new Set<string>();
  for (const m of source.matchAll(/^export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of source.matchAll(/^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of source.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const trimmed = part.trim();
      if (!trimmed || trimmed.startsWith('type ')) continue;
      const alias = trimmed.split(/\s+as\s+/).pop()!.trim();
      if (alias) names.add(alias);
    }
  }
  if (/^export\s+default\b/m.test(source)) names.add('default');
  return [...names];
}

/** Functions that declare 'use server' in their own body (function-level directive). */
function inlineServerFunctions(source: string): string[] {
  const names: string[] = [];
  const re =
    /(?:function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)[^{]*\{|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*async\s*\([^)]*\)\s*=>\s*\{)\s*(['"])use server\3/g;
  for (const m of source.matchAll(re)) names.push(m[1] ?? m[2]);
  return names;
}

function discoverServerActions(): string[] {
  const files = ['app', 'lib', 'components']
    .flatMap((d) => walk(join(ROOT, d)))
    .filter((f) => /\.(ts|tsx|js|jsx)$/.test(f));
  const found: string[] = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const rel = repoKey(file);
    if (isUseServerModule(source)) {
      for (const name of runtimeExports(source)) found.push(`${rel}#${name}`);
    }
    for (const name of inlineServerFunctions(source)) found.push(`${rel}#${name} (inline)`);
  }
  return found.sort();
}

describe('discovery can see what it claims to see', () => {
  it('keys Windows-shaped paths the same as POSIX ones', () => {
    const root = 'C:\\repo\\broker-portal';
    expect(
      dashboardPageKeys(
        [
          'C:\\repo\\broker-portal\\app\\dashboard\\page.tsx',
          'C:\\repo\\broker-portal\\app\\dashboard\\users\\[id]\\page.tsx',
          'C:\\repo\\broker-portal\\app\\dashboard\\layout.tsx',
        ],
        root,
        win32.relative
      )
    ).toEqual(['app/dashboard/page.tsx', 'app/dashboard/users/[id]/page.tsx']);
    expect(repoKey('C:\\repo\\broker-portal\\lib\\actions\\scim.ts', root, win32.relative)).toBe(
      'lib/actions/scim.ts'
    );
    expect(toPosix('app\\dashboard\\users\\[id]\\page.tsx')).toBe('app/dashboard/users/[id]/page.tsx');
    expect(toPosix('app/dashboard/page.tsx')).toBe('app/dashboard/page.tsx');
  });

  it('reads CRLF sources (Windows checkout) the same as LF', () => {
    expect(isUseServerModule(`/** c */\r\n'use server';\r\nexport async function a() {}\r\n`)).toBe(true);
    expect(isUseServerModule(`// c\r\n"use server"\r\nexport const b = 1;\r\n`)).toBe(true);
    expect(isUseServerModule(`import x from 'y';\r\n'use server';\r\n`)).toBe(false);
    expect(
      runtimeExports(`export async function a() {}\r\nexport const c = 1;\r\nexport { d, e as f };\r\nexport default 1;\r\n`).sort()
    ).toEqual(['a', 'c', 'd', 'default', 'f']);
    expect(inlineServerFunctions(`async function save(x) {\r\n  'use server';\r\n}`)).toEqual(['save']);
  });

  it('finds the root dashboard page and a dynamic route (the 13-vs-14 glob trap)', () => {
    const pages = discoverDashboardPages();
    expect(pages).toContain('app/dashboard/page.tsx');
    expect(pages).toContain('app/dashboard/users/[id]/page.tsx');
    expect(pages.length).toBe(14);
  });

  it('recognises both directive quote styles, every export form, and function-level directives', () => {
    expect(isUseServerModule(`/** c */\n"use server";\nexport async function a() {}`)).toBe(true);
    expect(isUseServerModule(`'use server'\nexport const b = 1;`)).toBe(true);
    expect(isUseServerModule(`import x from 'y';\n'use server';`)).toBe(false);
    expect(
      runtimeExports(
        `export async function a() {}\nexport function b() {}\nexport const c = async () => {};\nexport { d, e as f, type G };\nexport interface H {}\nexport type I = 1;\nexport default async function () {}`
      ).sort()
    ).toEqual(['a', 'b', 'c', 'd', 'default', 'f']);
    expect(inlineServerFunctions(`async function save(x) {\n  'use server';\n}`)).toEqual(['save']);
    expect(inlineServerFunctions(`const go = async () => { "use server"; }`)).toEqual(['go']);
  });

  it('finds the known action files', () => {
    const actions = discoverServerActions();
    expect(actions).toContain('lib/actions/bulkUpdateRole.ts#bulkUpdateRole');
    expect(actions).toContain('lib/actions/scim.ts#listScimSyncLogs');
    expect(actions.length).toBe(32);
  });
});

describe('set completeness', () => {
  it('every dashboard page is classified exactly once', () => {
    const classified = [...Object.keys(REFUSED_PAGES), ...FLOOR_PAGES, ...Object.keys(OWN_GATE_PAGES)];
    expect(new Set(classified).size).toBe(classified.length);
    expect(discoverDashboardPages()).toEqual([...classified].sort());
  });

  it('every server action is classified exactly once', () => {
    const classified = [
      ...Object.keys(REFUSED_ACTIONS),
      ...FLOOR_ACTIONS,
      ...UNAUTHENTICATED_PREEXISTING_ACTIONS,
      ...HELPER_ACTIONS,
    ];
    expect(new Set(classified).size).toBe(classified.length);
    expect(Object.keys(REFUSALS).sort()).toEqual(Object.keys(REFUSED_ACTIONS).sort());
    for (const name of Object.keys(READS_BEFORE_REFUSAL)) expect(REFUSED_ACTIONS).toHaveProperty([name]);
    expect(discoverServerActions()).toEqual([...classified].sort());
  });

  it('records the RLS-guarded handler, which PR 1 leaves unedited', () => {
    for (const rel of RLS_GUARDED_HANDLERS) {
      const source = readFileSync(join(ROOT, rel), 'utf8');
      expect(source).toContain(".from('organizations')");
      expect(source).toContain('graph_admin_consent_granted');
    }
  });
});

// ---------------------------------------------------------------------------
// Refusals, persona by persona, with an admitted admin beside each
// ---------------------------------------------------------------------------

const personaNames = Object.keys(PERSONAS) as (keyof typeof PERSONAS)[];

let quiet: jest.SpyInstance[] = [];
beforeEach(() => {
  jest.clearAllMocks();
  quiet = [
    jest.spyOn(console, 'error').mockImplementation(() => {}),
    jest.spyOn(console, 'warn').mockImplementation(() => {}),
    jest.spyOn(console, 'log').mockImplementation(() => {}),
  ];
});
afterEach(() => quiet.forEach((s) => s.mockRestore()));

describe('refused pages', () => {
  const cases = Object.entries(REFUSED_PAGES).flatMap(([page, entry]) =>
    personaNames.map((persona) => [page, persona, entry] as const)
  );

  it.each(cases)('%s refuses the %s before reading anything else', async (_page, persona, entry) => {
    given(PERSONAS[persona]);
    expect(await run(entry.invoke)).toEqual(entry.refused);
    expect(tablesRead()).toEqual(['organization_members']);
    expect(mockEmulator.state.writes).toEqual([]);
  });

  it.each(Object.entries(REFUSED_PAGES))('%s admits a brokerage admin', async (_page, entry) => {
    given(ADMIN);
    const outcome = await run(entry.invoke);
    expect(outcome).not.toEqual(entry.refused);
    expect(outcome).not.toHaveProperty('redirect');
    expect(outcome).not.toHaveProperty('threw');
  });

  it.each([
    'app/dashboard/page.tsx',
    'app/dashboard/submissions/page.tsx',
    'app/dashboard/submissions/[id]/page.tsx',
  ])('%s: the read log sees the admitted admin read transaction_submissions', async (page) => {
    given(ADMIN);
    await run(REFUSED_PAGES[page].invoke);
    expect(tablesRead()).toContain('transaction_submissions');
  });
});

describe('own-gate pages (D4)', () => {
  const cases = Object.entries(OWN_GATE_PAGES).flatMap(([page, entry]) =>
    OWN_GATE_PERSONAS.map((persona) => [page, persona, entry] as const)
  );

  it.each(cases)('%s refuses the %s', async (_page, persona, entry) => {
    given(PERSONAS[persona]);
    expect(await run(entry.invoke)).toEqual(entry.refused);
    expect(mockEmulator.state.writes).toEqual([]);
  });

  it.each(Object.entries(OWN_GATE_PAGES))('%s admits a brokerage admin', async (_page, entry) => {
    given(ADMIN);
    expect(await run(entry.invoke)).not.toEqual(entry.refused);
  });
});

describe('refused server actions', () => {
  const cases = Object.keys(REFUSED_ACTIONS).flatMap((name) =>
    personaNames.map((persona) => [name, persona] as const)
  );

  it.each(cases)('%s refuses the %s, and writes nothing', async (name, persona) => {
    given(PERSONAS[persona]);
    expect(await run(REFUSED_ACTIONS[name])).toEqual(refusalFor(name, persona));
    expect(mockEmulator.state.writes).toEqual([]);
    const allowed = READS_BEFORE_REFUSAL[name] ?? ['organization_members'];
    for (const table of tablesRead()) expect(allowed).toContain(table);
  });

  it.each(Object.keys(REFUSED_ACTIONS))('%s admits a brokerage admin', async (name) => {
    given(ADMIN);
    const outcome = await run(REFUSED_ACTIONS[name]);
    for (const persona of personaNames) expect(outcome).not.toEqual(refusalFor(name, persona));
  });
});
