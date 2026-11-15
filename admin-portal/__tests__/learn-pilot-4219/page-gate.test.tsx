/**
 * BACKLOG-4219 PR3: the Learn pilot page's own copies of the 4144 gate tests (A1 G1, G2), what it
 * reads (A1b: any failed or misshapen read is "could not be read", never an empty list), and what
 * it hands to the client view (A6: no org id, no canary-org id; the user id is the only id).
 *
 * Behavioural: the page's default export is CALLED with the cookie client stubbed, as the 4186
 * page-gate test does. `report_my_access` answers only for the key the test grants. The list answer
 * is transcribed (fixtures.ts).
 */

import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ADMIN_LIST, LIST_MISSING, LIST_REFUSED, ORG_OTHER, ORG_X, ORG_Z, USER_10, USER_13, USER_6, clone } from './fixtures';

const state = vi.hoisted(() => ({
  access: {} as Record<string, string>,
  accessError: false,
  answers: {} as Record<string, { data?: unknown; error?: unknown }>,
  rpcCalls: [] as { fn: string; args: unknown }[],
  tables: [] as string[],
}));

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard/ai/learn-pilot',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));

/** Any chain of query-builder calls; awaiting it reads an empty, successful result. */
function emptyQuery(single: unknown = null): unknown {
  const result = { data: [], error: null, count: 0 };
  const proxy: unknown = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(result);
      if (prop === 'single' || prop === 'maybeSingle') return async () => ({ data: single, error: null });
      return () => proxy;
    },
    apply: () => proxy,
  });
  return proxy;
}

vi.mock('@/lib/supabase/server', () => ({
  getAuthenticatedUser: async () => ({
    user: { id: 'user-test' },
    supabase: {
      rpc: async (fn: string, args?: Record<string, unknown>) => {
        state.rpcCalls.push({ fn, args });
        if (fn === 'report_my_access') {
          if (state.accessError) return { data: null, error: { code: 'PGRST202', message: 'no such function' } };
          return { data: state.access[String(args?.p_key)] ?? null, error: null };
        }
        if (fn === 'has_permission') return { data: true, error: null };
        const a = state.answers[fn];
        return a ? { data: a.data ?? null, error: a.error ?? null } : { data: [], error: null };
      },
      from: (table: string) => {
        state.tables.push(table);
        return emptyQuery(table === 'internal_roles' ? { role_id: 'role-test' } : null);
      },
    },
  }),
}));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ rpc: async () => ({ data: [], error: null }) }) }));

import { ReportAccessProvider } from '@/lib/reports/report-access-context';
import LearnPilotPage from '@/app/dashboard/ai/learn-pilot/page';
import { ReportShareButton } from '@/components/reports/ReportShareButton';
import { LEARN_PILOT_SHARE_ROLE_DESCRIPTIONS } from '@/lib/learn-pilot/access';
import { READ_FAILED_MESSAGE } from '@/lib/learn-pilot/parse';
import { LearnPilotView, type LearnPilotViewProps } from '@/app/dashboard/ai/learn-pilot/LearnPilotView';

const KEY = 'learn-pilot';
const OTHER_KEYS = ['sender-rules', 'analytics', 'iphone-sync', 'google-messages-sync', 'email-precache', 'submissions', 'exports', 'support-sla', 'user-activity', 'funnel'];
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

async function callPage(): Promise<{ result?: ReactNode; error?: Error }> {
  try {
    return { result: await LearnPilotPage() };
  } catch (error) {
    return { error: error as Error };
  }
}

const fns = () => state.rpcCalls.map((c) => c.fn);
const accessCalls = () => state.rpcCalls.filter((c) => c.fn === 'report_my_access').map((c) => c.args);

/** Every element of one type inside the page's tree. */
function propsOf<P>(node: ReactNode, type: unknown): P[] {
  const found: P[] = [];
  const walk = (n: ReactNode) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!isValidElement(n)) return;
    const el = n as ReactElement<{ children?: ReactNode }>;
    if (el.type === type) found.push(el.props as unknown as P);
    walk(el.props.children);
  };
  walk(node);
  return found;
}
function viewProps(node: ReactNode): LearnPilotViewProps {
  const found = propsOf<LearnPilotViewProps>(node, LearnPilotView);
  expect(found).toHaveLength(1);
  return found[0];
}

const readable = () => {
  state.answers.learn_pilot_report_admin_list = { data: clone(ADMIN_LIST) };
};

beforeEach(() => {
  state.access = {};
  state.accessError = false;
  state.answers = {};
  state.rpcCalls = [];
  state.tables = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('A1 G1 the page asks report_my_access for learn-pilot and opens with it', () => {
  it.each(['viewer', 'editor', 'owner'])('%s', async (access) => {
    readable();
    state.access = { [KEY]: access };
    const { result, error } = await callPage();
    expect(error?.message).not.toBe('NOT_FOUND');
    expect(accessCalls()).toEqual([{ p_key: KEY }]);
    expect(fns()).toEqual(['report_my_access', 'learn_pilot_report_admin_list']);
    expect(isValidElement(result)).toBe(true);
    const el = result as ReactElement<{ reportKey: string; access: string }>;
    expect(el.type).toBe(ReportAccessProvider);
    expect(el.props).toMatchObject({ reportKey: KEY, access });
    expect(propsOf(result, ReportShareButton)).toEqual([{ roleDescriptions: LEARN_PILOT_SHARE_ROLE_DESCRIPTIONS }]);
    expect(viewProps(result).model.ok).toBe(true);
  });
});

describe('A1 G2 no access is a 404, not a redirect, and reads nothing', () => {
  it('no grant', async () => {
    readable();
    const { error } = await callPage();
    expect(error?.message).toBe('NOT_FOUND');
    expect(state.tables).toEqual(['internal_roles']);
    expect(fns()).toEqual(['report_my_access']);
  });

  it('access to every OTHER report only, sender-rules included', async () => {
    readable();
    state.access = Object.fromEntries(OTHER_KEYS.map((s) => [s, 'owner']));
    const { error } = await callPage();
    expect(error?.message).toBe('NOT_FOUND');
    expect(fns()).toEqual(['report_my_access']);
  });

  it('an unreadable answer (function missing) is a 404 too', async () => {
    readable();
    state.accessError = true;
    const { error } = await callPage();
    expect(error?.message).toBe('NOT_FOUND');
    expect(fns()).toEqual(['report_my_access']);
  });
});

describe('A1b a list that cannot be read is a failure, never an empty list', () => {
  it.each([
    ['refused (42501)', { error: LIST_REFUSED }],
    ['function missing (PGRST202)', { error: LIST_MISSING }],
    ['answers [] (wrong shape)', { data: [] }],
    ['answers null', { data: null }],
    ['rows without truncated', { data: { rows: [] } }],
    ['a row without its report', { data: { truncated: false, rows: [{ ...clone(ADMIN_LIST.rows[0]), report: null }] } }],
  ])('%s', async (_n, answer) => {
    state.access = { [KEY]: 'owner' };
    state.answers.learn_pilot_report_admin_list = answer;
    const p = viewProps((await callPage()).result);
    expect(p.model).toEqual({ ok: false, message: READ_FAILED_MESSAGE });
  });

  it('a readable empty list is ok and empty (the control for the cases above)', async () => {
    state.access = { [KEY]: 'viewer' };
    state.answers.learn_pilot_report_admin_list = { data: { rows: [], truncated: false } };
    expect(viewProps((await callPage()).result).model).toEqual({ ok: true, truncated: false, orgs: [] });
  });
});

describe('A6 what reaches the client view', () => {
  it('the only ids in the props are the pilot users ids; no org or canary-org id, no raw rows', async () => {
    readable();
    state.access = { [KEY]: 'owner' };
    const props = viewProps((await callPage()).result);
    const json = JSON.stringify(props);
    expect(new Set(json.match(UUID))).toEqual(new Set([USER_6, USER_10, USER_13]));
    for (const id of [ORG_X, ORG_Z, ORG_OTHER]) expect(json).not.toContain(id);
    for (const k of ['org_id', 'version_canary_org', 'published_by', 'pinned_by', 'report']) expect(json).not.toContain(`"${k}"`);
  });
});
