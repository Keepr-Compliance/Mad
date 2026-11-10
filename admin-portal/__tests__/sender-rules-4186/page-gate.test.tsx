/**
 * BACKLOG-4186 PR C: the sender-rules page's own copies of the 4144 gate tests (G1, G2), plus what
 * the page reads and in which order (A8b: the org list is read for the owner only; A18: a state
 * that cannot be read reaches the view as a failure, with no write control).
 *
 * Founder ruling 2026-11-10: the page lives in the AI section (/dashboard/ai/sender-rules), not
 * under Reports, so __tests__/report-access-4144/gate.test.tsx (registry-driven) does not cover it.
 *
 * Behavioural, not a text guard: the page's default export is CALLED with the cookie client
 * stubbed, exactly as gate.test.tsx does. `report_my_access` answers only for the key the test
 * grants; `has_permission` always answers true. Read answers are transcribed (fixtures*.ts).
 */

import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { STATE_CANARY } from './fixtures';
import { CONTENT_V3, ORG_LIST, READ_REFUSED, STATE_MIXED } from './fixtures-pr-c';

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
  usePathname: () => '/dashboard/ai/sender-rules',
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
        // Unlisted functions answer [] (as in gate.test.tsx).
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
import SenderRulesPage from '@/app/dashboard/ai/sender-rules/page';
import ReportsIndexPage from '@/app/dashboard/reports/page';
import { ReportShareButton } from '@/components/reports/ReportShareButton';
import { SENDER_RULES_SHARE_ROLE_DESCRIPTIONS } from '@/lib/sender-rules/access';
import { SenderRulesView } from '@/app/dashboard/ai/sender-rules/SenderRulesView';
import type { SenderRulesViewProps } from '@/app/dashboard/ai/sender-rules/SenderRulesView';

const KEY = 'sender-rules';
const OTHER_KEYS = ['analytics', 'iphone-sync', 'google-messages-sync', 'email-precache', 'submissions', 'exports', 'support-sla', 'user-activity', 'funnel'];

async function callPage(): Promise<{ result?: ReactNode; error?: Error }> {
  try {
    return { result: await SenderRulesPage() };
  } catch (error) {
    return { error: error as Error };
  }
}

const fns = () => state.rpcCalls.map((c) => c.fn);
const accessCalls = () => state.rpcCalls.filter((c) => c.fn === 'report_my_access').map((c) => c.args);

/** The SenderRulesView element inside the page's tree. */
function viewProps(node: ReactNode): SenderRulesViewProps {
  const found: SenderRulesViewProps[] = [];
  const walk = (n: ReactNode) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!isValidElement(n)) return;
    const el = n as ReactElement<{ children?: ReactNode }>;
    if (el.type === SenderRulesView) found.push(el.props as unknown as SenderRulesViewProps);
    walk(el.props.children);
  };
  walk(node);
  expect(found).toHaveLength(1);
  return found[0];
}

/** A readable state: STATE_MIXED, released v3 = CONTENT_V3. */
function readable() {
  state.answers.sender_rule_set_admin_state = { data: JSON.parse(JSON.stringify(STATE_MIXED)) };
  state.answers.sender_rule_set_admin_content = { data: JSON.parse(JSON.stringify(CONTENT_V3)) };
  state.answers.admin_list_organizations = { data: JSON.parse(JSON.stringify(ORG_LIST)) };
}

beforeEach(() => {
  state.access = {};
  state.accessError = false;
  state.answers = {};
  state.rpcCalls = [];
  state.tables = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('G1 the page asks report_my_access for sender-rules and opens with it', () => {
  it.each(['viewer', 'editor', 'owner'])('%s', async (access) => {
    state.access = { [KEY]: access };
    const { result, error } = await callPage();
    expect(error?.message).not.toBe('NOT_FOUND');
    expect(accessCalls()).toEqual([{ p_key: KEY }]);
    expect(fns()).not.toContain('has_permission');
    expect(isValidElement(result)).toBe(true);
    const el = result as ReactElement<{ reportKey: string; access: string }>;
    expect(el.type).toBe(ReportAccessProvider);
    expect(el.props).toMatchObject({ reportKey: KEY, access });
  });
});

describe('G2 no access is a 404, not a redirect, and reads nothing', () => {
  it('no grant', async () => {
    readable();
    const { error } = await callPage();
    expect(error?.message).toBe('NOT_FOUND');
    expect(state.tables).toEqual(['internal_roles']);
    expect(fns()).toEqual(['report_my_access']);
  });

  it('access to every OTHER report only', async () => {
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

describe('what the page reads, in order', () => {
  it('owner: gate, state, released content, then the org list', async () => {
    readable();
    state.access = { [KEY]: 'owner' };
    const { result } = await callPage();
    expect(fns()).toEqual(['report_my_access', 'sender_rule_set_admin_state', 'sender_rule_set_admin_content', 'admin_list_organizations']);
    expect(state.rpcCalls[2].args).toEqual({ p_version: 3 });
    const p = viewProps(result);
    expect(p.access).toBe('owner');
    expect(p.load).toMatchObject({ ok: true, released: CONTENT_V3 });
    expect(p.orgs).toMatchObject({ ok: true });
    // The share dialog gets this page's role lines (editor = viewer here).
    const share: Record<string, unknown>[] = [];
    const walk = (n: ReactNode): void => {
      if (Array.isArray(n)) return n.forEach(walk);
      if (!isValidElement(n)) return;
      const el = n as ReactElement<{ children?: ReactNode }>;
      if (el.type === ReportShareButton) share.push(el.props as Record<string, unknown>);
      walk(el.props.children);
    };
    walk(result);
    expect(share).toEqual([{ roleDescriptions: SENDER_RULES_SHARE_ROLE_DESCRIPTIONS }]);
  });

  // A8b: the org list reaches owners only (it names personal orgs).
  it.each(['viewer', 'editor'])('A8b %s: no org list is read', async (access) => {
    readable();
    state.access = { [KEY]: access };
    const { result } = await callPage();
    expect(fns()).toEqual(['report_my_access', 'sender_rule_set_admin_state', 'sender_rule_set_admin_content']);
    expect(viewProps(result).orgs).toBeNull();
  });

  // A18: an unreadable state reaches the view as a failure (and reads nothing more).
  it.each([
    ['answers [] (as an unknown function would)', { data: [] }],
    ['is refused (42501)', { error: READ_REFUSED }],
    ['is an older shape', { data: { ...STATE_CANARY, pins: undefined } }],
  ])('A18 owner, state %s: load fails, no org list read', async (_n, answer) => {
    readable();
    state.answers.sender_rule_set_admin_state = answer;
    state.access = { [KEY]: 'owner' };
    const { result } = await callPage();
    expect(fns()).toEqual(['report_my_access', 'sender_rule_set_admin_state']);
    const p = viewProps(result);
    expect(p.load.ok).toBe(false);
    expect(p.orgs).toBeNull();
  });

  it('A18 owner, released content missing: load fails', async () => {
    readable();
    state.answers.sender_rule_set_admin_content = { data: null };
    state.access = { [KEY]: 'owner' };
    const p = viewProps((await callPage()).result);
    expect(p.load).toEqual({ ok: false, message: 'Version 3 could not be read.' });
  });

  it('a 42501 on the read is worded as a read', async () => {
    readable();
    state.answers.sender_rule_set_admin_state = { error: READ_REFUSED };
    state.access = { [KEY]: 'viewer' };
    const p = viewProps((await callPage()).result);
    expect(p.load).toEqual({ ok: false, message: "You don't have access to these rules." });
  });

  it('owner, org list refused ({success:false}): a failure, never an empty list', async () => {
    readable();
    state.answers.admin_list_organizations = { data: { success: false, error: 'not_authorized' } };
    state.access = { [KEY]: 'owner' };
    expect(viewProps((await callPage()).result).orgs).toEqual({ ok: false });
  });
});

// Coordinator ruling 2026-11-10: the Reports index counts Reports-registry keys only, so a
// sender-rules-only grant is a 404 there, not an empty index.
describe('Reports index and a sender-rules grant', () => {
  async function callIndex() {
    try {
      return { result: (await ReportsIndexPage({ searchParams: Promise.resolve({}) })) as ReactElement<{ reports: { slug: string }[] }> };
    } catch (error) {
      return { error: error as Error };
    }
  }

  it('sender-rules only: 404', async () => {
    state.answers.report_list_my_reports = { data: [{ report_key: KEY, access: 'viewer' }] };
    expect((await callIndex()).error?.message).toBe('NOT_FOUND');
  });

  it('sender-rules plus funnel: lists funnel only', async () => {
    state.answers.report_list_my_reports = {
      data: [
        { report_key: 'funnel', access: 'viewer' },
        { report_key: KEY, access: 'owner' },
      ],
    };
    expect((await callIndex()).result!.props.reports.map((r) => r.slug)).toEqual(['funnel']);
  });
});
