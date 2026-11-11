// @vitest-environment jsdom

/**
 * BACKLOG-4186 PR D (SR delta review 2026-11-10): an action that changes released_version (publish
 * to everyone, make everyone's, undo everything) is followed by router.refresh(). The page re-runs
 * and hands a new state to the view. The result message must survive that, and the editor must
 * still start over on the new rules.
 *
 * Goes through the page itself: the SenderRulesView element (with whatever key the page gives it)
 * is taken from SenderRulesPage() before and after, and React reconciles one into the other, as
 * the App Router does on refresh. States are transcribed: STATE_MIXED -> revert_all answers
 * REVERT_RESULT (5) -> STATE_REVERTED, whose released v5 is the bundled default.
 */

import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CONTENT_V3, ORG_LIST, REVERT_RESULT, STATE_MIXED, STATE_REVERTED } from './fixtures-pr-c';
import { bundled } from './helpers';

const state = vi.hoisted(() => ({
  answers: {} as Record<string, unknown>,
  writes: [] as string[],
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

const rpc = async (fn: string) => {
  if (fn === 'report_my_access') return { data: 'owner', error: null };
  if (fn === 'has_permission') return { data: true, error: null };
  if (fn === 'sender_rule_set_revert_all') {
    state.writes.push(fn);
    return { data: REVERT_RESULT, error: null };
  }
  return { data: state.answers[fn] ?? null, error: null };
};

vi.mock('@/lib/supabase/server', () => ({
  getAuthenticatedUser: async () => ({
    user: { id: 'user-test' },
    supabase: { rpc, from: (t: string) => emptyQuery(t === 'internal_roles' ? { role_id: 'role-test' } : null) },
  }),
}));
// The view's writes go through the browser client.
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ rpc }) }));

import SenderRulesPage from '@/app/dashboard/ai/sender-rules/page';
import { SenderRulesView } from '@/app/dashboard/ai/sender-rules/SenderRulesView';

const copy = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** The SenderRulesView element exactly as the page built it, key included. */
async function pageView(): Promise<ReactElement> {
  const tree = await SenderRulesPage();
  const found: ReactElement[] = [];
  const walk = (n: ReactNode) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!isValidElement(n)) return;
    const el = n as ReactElement<{ children?: ReactNode }>;
    if (el.type === SenderRulesView) found.push(el);
    walk(el.props.children);
  };
  walk(tree);
  expect(found).toHaveLength(1);
  return found[0];
}

beforeEach(() => {
  state.writes = [];
  state.answers = {
    sender_rule_set_admin_state: copy(STATE_MIXED),
    sender_rule_set_admin_content: copy(CONTENT_V3),
    admin_list_organizations: copy(ORG_LIST),
  };
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the result survives the refresh that a new released version causes', () => {
  it('Undo everything: message next to the action and the banner stay; the editor is on v5', async () => {
    const { rerender } = render(await pageView());
    expect(screen.getByTestId('running-everyone').textContent).toMatch(/^Everyone: v3/);

    fireEvent.click(screen.getAllByRole('button', { name: 'Undo everything' })[0]);
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Undo everything' }));
    await screen.findByTestId('notice-at-history');
    expect(state.writes).toEqual(['sender_rule_set_revert_all']);

    // The refresh: the server now answers the reverted state, released v5 = the bundled default.
    state.answers.sender_rule_set_admin_state = copy(STATE_REVERTED);
    state.answers.sender_rule_set_admin_content = bundled();
    rerender(await pageView());

    expect(screen.getByTestId('running-everyone').textContent).toMatch(/^Everyone: v5/);
    expect(screen.getByTestId('notice-at-history').textContent).toBe('Every org is back on the default rules.');
    expect(screen.getByTestId('sender-rules-notice').textContent).toContain('Every org is back on the default rules.');
    // The editor still starts over on the new rules.
    expect(screen.getByTestId('rules-card').querySelector('p')?.textContent).toBe("Editing from everyone's rules (v5).");
  });
});
