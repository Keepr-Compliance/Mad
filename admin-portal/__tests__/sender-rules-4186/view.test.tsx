// @vitest-environment jsdom

/**
 * BACKLOG-4186 PR C: the page body. Rendered with a fake rpc client behind the real
 * createSenderRulesApi, so every assertion on a write is on the exact RPC call. Every state, content
 * and error is transcribed from keepr-test (fixtures.ts, fixtures-pr-c.ts).
 *
 * Controls: A3 promote, A4 promote only for a newer canary, A5 diff base, A8/A8c read-only, A9
 * undo, A10 release names the tests it ends, A11 no optimistic update, A13 version ignored, A14
 * numeric thresholds, A15 the stop-test sentence, A16 every org pickable, A17 org list failure,
 * A18 unreadable state.
 */

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nav = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: nav.refresh, push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/dashboard/ai/sender-rules',
  useSearchParams: () => new URLSearchParams(),
}));
// The view must use the injected api in these tests; reaching the real browser client is a bug.
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => {
    throw new Error('browser client used in a test');
  },
}));

import { SenderRulesView, STOP_TEST_WARNING } from '@/app/dashboard/ai/sender-rules/SenderRulesView';
import { createSenderRulesApi } from '@/lib/sender-rules/api';
import type { SenderRulesLoad } from '@/lib/sender-rules/load';
import { parseOrgList, type OrgListResult } from '@/lib/sender-rules/orgs';
import type { ReportAccess } from '@/lib/reports/report-access';
import type { SenderRuleSet, SenderRulesAdminState } from '@/lib/sender-rules/types';

import { ERRORS, ORG_A, ORG_B } from './fixtures';
import { CONTENT_V2_SAME_RULES, CONTENT_V3, CONTENT_V4, ORG_LIST, STATE_MIXED, STATE_READ_BY_VIEWER } from './fixtures-pr-c';
import { bundled, clone, fakeClient, type RpcCall } from './helpers';

const WRITE_LABELS = ['Publish to everyone', 'Publish to test org', "Make this everyone's", 'Stop test', 'Undo everything', 'Edit from this version'];

/** content(v) answers: v1 = the bundled seed, v2..v4 as captured. */
function contentFor(v: unknown): SenderRuleSet | null {
  if (v === 1) return bundled();
  if (v === 2) return clone(CONTENT_V2_SAME_RULES);
  if (v === 3) return clone(CONTENT_V3);
  if (v === 4) return clone(CONTENT_V4);
  return null;
}

function setup(opts: {
  access?: ReportAccess;
  load?: SenderRulesLoad;
  orgs?: OrgListResult | null;
  publish?: { data?: unknown; error?: (typeof ERRORS)[keyof typeof ERRORS] };
} = {}) {
  const access = opts.access ?? 'owner';
  const fake = fakeClient({
    sender_rule_set_admin_content: (args) => ({ data: contentFor(args?.p_version) }),
    sender_rule_set_publish: opts.publish ?? { data: 5 },
    sender_rule_set_pin: { data: '' },
    sender_rule_set_revert_all: { data: 5 },
  });
  const load: SenderRulesLoad = opts.load ?? { ok: true, state: clone(STATE_MIXED) as SenderRulesAdminState, released: clone(CONTENT_V3) };
  const orgs = opts.orgs === undefined ? (access === 'owner' ? parseOrgList(clone(ORG_LIST), null) : null) : opts.orgs;
  render(<SenderRulesView access={access} load={load} orgs={orgs} api={createSenderRulesApi(fake.client)} />);
  return fake;
}

const button = (name: string) => screen.queryAllByRole('button', { name });
const writeControls = () => WRITE_LABELS.flatMap((n) => button(n));
const writes = (calls: RpcCall[]) => calls.filter((c) => c.fn !== 'sender_rule_set_admin_content');

beforeEach(() => {
  nav.refresh.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('A8 / A8c: viewer and editor read only', () => {
  it('owner (positive control): every write control renders', () => {
    setup({ access: 'owner' });
    for (const n of WRITE_LABELS) expect(button(n).length, n).toBeGreaterThan(0);
    expect(screen.getAllByRole('combobox').length).toBeGreaterThan(0);
  });

  it.each(['viewer', 'editor'] as const)('%s: no write control, no input, View present', (access) => {
    setup({ access });
    expect(writeControls()).toEqual([]);
    expect(screen.queryAllByRole('textbox')).toEqual([]);
    expect(screen.queryAllByRole('combobox')).toEqual([]);
    expect(screen.queryByTestId('review-publish')).toBeNull();
    expect(button('View').length).toBe(STATE_MIXED.versions.length);
    // The rules themselves are shown.
    expect(within(screen.getByTestId('list-suppress.hosts')).getByText('promo.example.com')).toBeTruthy();
  });
});

describe('A18: state unreadable -> no write control', () => {
  it.each(['owner', 'viewer'] as const)('%s', (access) => {
    setup({ access, load: { ok: false, message: "You don't have access to these rules." }, orgs: null });
    expect(screen.getByTestId('sender-rules-unreadable').textContent).toContain('The sender rules could not be read.');
    expect(screen.getByTestId('sender-rules-unreadable').textContent).toContain("You don't have access to these rules.");
    expect(writeControls()).toEqual([]);
    expect(screen.queryAllByRole('textbox')).toEqual([]);
    expect(screen.queryByTestId('rules-card')).toBeNull();
  });
});

describe('Running now', () => {
  it('names everyone\'s version and each test', () => {
    setup({ access: 'viewer' });
    expect(screen.getByTestId('running-everyone').textContent).toMatch(/^Everyone: v3, published /);
    expect(screen.getByTestId(`pin-${ORG_A}`).textContent).toContain('Test Org A is testing v4 since');
    expect(screen.getByTestId(`pin-${ORG_B}`).textContent).toContain('Test Org B is testing v3 since');
  });

  // A4: org B is pinned AT the released version (captured); only A's newer canary can be promoted.
  it('A4: Make this everyone\'s only on a canary newer than everyone\'s', () => {
    setup();
    expect(within(screen.getByTestId(`pin-${ORG_A}`)).queryAllByRole('button', { name: "Make this everyone's" })).toHaveLength(1);
    expect(within(screen.getByTestId(`pin-${ORG_B}`)).queryAllByRole('button', { name: "Make this everyone's" })).toHaveLength(0);
    expect(within(screen.getByTestId(`pin-${ORG_B}`)).queryAllByRole('button', { name: 'Stop test' })).toHaveLength(1);
  });

  // A3: promote re-publishes the STORED v4, never the draft.
  it('A3: promote releases stored v4 even with a different draft', async () => {
    const fake = setup();
    fireEvent.change(screen.getByLabelText('Add to Domains'), { target: { value: 'other.example.com' } });
    fireEvent.click(within(screen.getByTestId('list-suppress.hosts')).getByRole('button', { name: 'Add' }));
    fireEvent.click(within(screen.getByTestId(`pin-${ORG_A}`)).getByRole('button', { name: "Make this everyone's" }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('Every org gets v4. Tests running on other orgs stop.');
    await waitFor(() => expect(dialog.textContent).toContain('Adds news.example.com to Hide mail from: Domains'));
    fireEvent.click(within(dialog).getByRole('button', { name: "Make this everyone's" }));
    await waitFor(() => expect(writes(fake.calls)).toHaveLength(1));
    expect(writes(fake.calls)[0].fn).toBe('sender_rule_set_publish');
    expect(writes(fake.calls)[0].wire).toEqual({ p_content: CONTENT_V4, p_pin_org: null });
  });

  // A15: the founder's sentence, verbatim; confirm ends that org's test only.
  it('A15: Stop test says the changes can still be published, then unpins that org', async () => {
    const fake = setup();
    fireEvent.click(within(screen.getByTestId(`pin-${ORG_B}`)).getByRole('button', { name: 'Stop test' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('The test stops. Its changes can still be published to everyone.')).toBeTruthy();
    expect(STOP_TEST_WARNING).toBe('The test stops. Its changes can still be published to everyone.');
    expect(writes(fake.calls)).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop test' }));
    await waitFor(() => expect(writes(fake.calls)).toHaveLength(1));
    expect(writes(fake.calls)[0]).toMatchObject({ fn: 'sender_rule_set_pin', wire: { p_org: ORG_B, p_version: null } });
    expect(nav.refresh).toHaveBeenCalledTimes(1);
  });
});

describe('Review and publish', () => {
  it('A13: a stored version with the same rules is "No changes" (version ignored)', async () => {
    setup();
    fireEvent.click(within(screen.getByTestId('version-2')).getByRole('button', { name: 'Edit from this version' }));
    await waitFor(() => expect(screen.getByTestId('rules-card').textContent).toContain('Editing from v2'));
    expect(screen.getByTestId('no-changes')).toBeTruthy();
    expect((button('Publish to everyone')[0] as HTMLButtonElement).disabled).toBe(true);
    expect((button('Publish to test org')[0] as HTMLButtonElement).disabled).toBe(true);
  });

  it('A5: Edit from v1 compares with everyone\'s v3, not with v1', async () => {
    setup();
    fireEvent.click(within(screen.getByTestId('version-1')).getByRole('button', { name: 'Edit from this version' }));
    await waitFor(() => expect(screen.getByTestId('rules-card').textContent).toContain('Editing from v1'));
    expect(screen.getByTestId('draft-changes').textContent).toContain('Removes promo.example.com from Hide mail from: Domains');
    expect((button('Publish to everyone')[0] as HTMLButtonElement).disabled).toBe(false);
  });

  it('A16 / A1: every org is pickable, test orgs first and badged; test publish needs an org', async () => {
    const fake = setup();
    fireEvent.change(screen.getByLabelText('Add to Domains'), { target: { value: 'other.example.com' } });
    fireEvent.click(within(screen.getByTestId('list-suppress.hosts')).getByRole('button', { name: 'Add' }));
    const pick = screen.getByLabelText('Test org') as HTMLSelectElement;
    expect([...pick.options].map((o) => o.textContent)).toEqual(['Pick an org', 'Test · Test Org B', 'Test Org A']);
    expect((button('Publish to test org')[0] as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(pick, { target: { value: ORG_A } });
    fireEvent.click(button('Publish to test org')[0]);
    await waitFor(() => expect(writes(fake.calls)).toHaveLength(1));
    const call = writes(fake.calls)[0];
    expect(call.fn).toBe('sender_rule_set_publish');
    expect(call.wire?.p_pin_org).toBe(ORG_A);
    expect((call.wire?.p_content as SenderRuleSet).suppress.hosts).toEqual(['promo.example.com', 'other.example.com']);
  });

  it('A17: an unreadable org list says so; no picker, no test publish', () => {
    setup({ orgs: { ok: false } });
    expect(screen.getByTestId('orgs-unreadable').textContent).toContain('The org list could not be read.');
    expect(screen.queryByLabelText('Test org')).toBeNull();
    expect(button('Publish to test org')).toEqual([]);
  });

  it('A10: the release confirm names the tests it ends', async () => {
    setup();
    fireEvent.click(within(screen.getByTestId('version-1')).getByRole('button', { name: 'Edit from this version' }));
    await waitFor(() => expect(screen.queryByTestId('draft-changes')).not.toBeNull());
    fireEvent.click(button('Publish to everyone')[0]);
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByTestId('release-stops-tests').textContent).toBe('Tests running on 2 org(s) stop.');
  });

  it('A10: no tests running -> no such line', async () => {
    setup({ load: { ok: true, state: clone(STATE_READ_BY_VIEWER) as SenderRulesAdminState, released: bundled() } });
    fireEvent.change(screen.getByLabelText('Add to Domains'), { target: { value: 'other.example.com' } });
    fireEvent.click(within(screen.getByTestId('list-suppress.hosts')).getByRole('button', { name: 'Add' }));
    fireEvent.click(button('Publish to everyone')[0]);
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).queryByTestId('release-stops-tests')).toBeNull();
  });

  // A11: a refused release changes nothing on the page but the notice, then re-reads the state.
  it('A11: a refused release shows the guard lines; Running now unchanged; state re-read', async () => {
    const fake = setup({ publish: { error: ERRORS.release_refused } });
    const before = screen.getByTestId('running-now').textContent;
    fireEvent.change(screen.getByLabelText('Add to Domains'), { target: { value: 'other.example.com' } });
    fireEvent.click(within(screen.getByTestId('list-suppress.hosts')).getByRole('button', { name: 'Add' }));
    fireEvent.click(button('Publish to everyone')[0]);
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Publish to everyone' }));
    const notice = await screen.findByTestId('sender-rules-notice');
    expect(notice.textContent).toContain('These changes must run on a test org first:');
    expect(notice.textContent).toContain('Bulk headers turns Live in Learn questions');
    expect(writes(fake.calls)).toHaveLength(1);
    expect(nav.refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('running-now').textContent).toBe(before);
  });

  it('A14: thresholds reach the RPC as numbers; 1.5 and 501 are refused inline', async () => {
    const fake = setup();
    const min = screen.getByLabelText('Minimum linked emails');
    fireEvent.change(min, { target: { value: '1.5' } });
    expect(screen.getByText('Enter a whole number.')).toBeTruthy();
    expect((button('Publish to everyone')[0] as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(min, { target: { value: '30' } });
    fireEvent.change(screen.getByLabelText('Report rows (max 500)'), { target: { value: '501' } });
    expect(screen.getByText('Must be at most 500.')).toBeTruthy();
    expect((button('Publish to everyone')[0] as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Report rows (max 500)'), { target: { value: '400' } });
    fireEvent.click(button('Publish to everyone')[0]);
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Publish to everyone' }));
    await waitFor(() => expect(writes(fake.calls)).toHaveLength(1));
    const t = (writes(fake.calls)[0].wire?.p_content as SenderRuleSet).thresholds;
    expect(t.minCensusLinkedEmails).toBe(30);
    expect(typeof t.minCensusLinkedEmails).toBe('number');
    expect(t.reportMaxRows).toBe(400);
  });

  it('Gmail Updates has no Live choice', () => {
    setup();
    const sel = screen.getByLabelText('Gmail Updates in Learn questions') as HTMLSelectElement;
    expect([...sel.options].map((o) => o.value)).toEqual(['off', 'measure']);
    const other = screen.getByLabelText('Bulk headers in Learn questions') as HTMLSelectElement;
    expect([...other.options].map((o) => o.value)).toEqual(['off', 'measure', 'live']);
  });

  it('list editor: pasted list trimmed and lowercased, invalid refused with a reason, duplicates ignored', () => {
    setup();
    const input = screen.getByLabelText('Add to Domains');
    fireEvent.change(input, { target: { value: ' News.Example.com, bad,promo.example.com ' } });
    fireEvent.click(within(screen.getByTestId('list-suppress.hosts')).getByRole('button', { name: 'Add' }));
    const list = screen.getByTestId('list-suppress.hosts');
    expect(within(list).getByRole('alert').textContent).toBe('bad is not a valid domain.');
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['promo.example.com', 'news.example.com']);
    expect(within(list).getByText('2 / 2000')).toBeTruthy();
    fireEvent.click(within(list).getByRole('button', { name: 'Remove news.example.com' }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
  });
});

describe('History', () => {
  it('rows name where each version ran; bundled marked', () => {
    setup({ access: 'viewer' });
    expect(screen.getByTestId('version-4').textContent).toContain('v4 · Test: Test Org A');
    expect(screen.getByTestId('version-3').textContent).toContain('v3 · Everyone');
    expect(screen.getByTestId('version-1').textContent).toContain('v1 · Everyone · Default (bundled)');
  });

  it('View (any access) shows the diff against everyone\'s rules', async () => {
    setup({ access: 'viewer' });
    fireEvent.click(within(screen.getByTestId('version-4')).getByRole('button', { name: 'View' }));
    const d = await screen.findByTestId('view-diff');
    await waitFor(() => expect(d.textContent).toContain('Adds news.example.com to Hide mail from: Domains'));
  });

  // A9: Undo everything is never one click.
  it('A9: the first click opens the confirm and calls nothing; Confirm calls revert_all once', async () => {
    const fake = setup();
    fireEvent.click(button('Undo everything')[0]);
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('Every org goes back to the default rules. Running tests stop. Apps pick this up within 6 hours.');
    expect(writes(fake.calls)).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Undo everything' }));
    await waitFor(() => expect(writes(fake.calls)).toHaveLength(1));
    expect(writes(fake.calls)[0]).toMatchObject({ fn: 'sender_rule_set_revert_all', args: undefined });
  });
});

// Founder QA 2026-11-10: the result shows next to the action, not only in the banner at the top.
describe('results next to the action', () => {
  const addDomain = () => {
    fireEvent.change(screen.getByLabelText('Add to Domains'), { target: { value: 'other.example.com' } });
    fireEvent.click(within(screen.getByTestId('list-suppress.hosts')).getByRole('button', { name: 'Add' }));
  };

  it('publish to test org: success shows in Review and publish', async () => {
    setup();
    addDomain();
    fireEvent.change(screen.getByLabelText('Test org'), { target: { value: ORG_A } });
    fireEvent.click(button('Publish to test org')[0]);
    const at = await screen.findByTestId('notice-at-publish-test');
    expect(at.textContent).toBe('Published to Test Org A for testing.');
    expect(within(screen.getByTestId('review-publish')).getByTestId('notice-at-publish-test')).toBe(at);
    expect(screen.getByTestId('sender-rules-notice').textContent).toContain('Published to Test Org A for testing.');
  });

  it('publish to everyone: a refusal shows in Review and publish and points at the details', async () => {
    setup({ publish: { error: ERRORS.release_refused } });
    addDomain();
    fireEvent.click(button('Publish to everyone')[0]);
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Publish to everyone' }));
    const at = await screen.findByTestId('notice-at-publish-everyone');
    expect(within(screen.getByTestId('review-publish')).getByTestId('notice-at-publish-everyone')).toBe(at);
    expect(at.textContent).toContain('These changes must run on a test org first:');
    expect(at.textContent).toContain('Details are at the top of the page.');
    // Shown as a failure, never in the success style.
    expect(at.className).toContain('text-red-600');
    expect(at.className).not.toContain('text-success');
  });

  it('a refused test publish: failure next to the action, and the Edit card base does not move', async () => {
    setup({ publish: { error: ERRORS.release_refused } });
    const before = screen.getByTestId('rules-card').querySelector('p')?.textContent;
    addDomain();
    fireEvent.change(screen.getByLabelText('Test org'), { target: { value: ORG_A } });
    fireEvent.click(button('Publish to test org')[0]);
    const at = await screen.findByTestId('notice-at-publish-test');
    expect(at.className).toContain('text-red-600');
    expect(at.textContent).not.toContain('Published to');
    expect(screen.getByTestId('rules-card').querySelector('p')?.textContent).toBe(before);
  });

  it('stop test: shows in Running now', async () => {
    setup();
    fireEvent.click(within(screen.getByTestId(`pin-${ORG_B}`)).getByRole('button', { name: 'Stop test' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Stop test' }));
    const at = await screen.findByTestId('notice-at-running');
    expect(within(screen.getByTestId('running-now')).getByTestId('notice-at-running')).toBe(at);
    expect(at.textContent).toBe('The test on Test Org B stopped.');
  });

  it("make everyone's: shows in Running now", async () => {
    setup();
    fireEvent.click(within(screen.getByTestId(`pin-${ORG_A}`)).getByRole('button', { name: "Make this everyone's" }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: "Make this everyone's" }));
    const at = await screen.findByTestId('notice-at-running');
    // promote re-publishes v4's content as a new version (the fake answers 5): the message names both.
    expect(at.textContent).toBe("v4's rules are now everyone's, as v5.");
  });

  it('undo everything: shows in History', async () => {
    setup();
    fireEvent.click(button('Undo everything')[0]);
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Undo everything' }));
    const at = await screen.findByTestId('notice-at-history');
    expect(within(screen.getByTestId('history')).getByTestId('notice-at-history')).toBe(at);
    expect(at.textContent).toBe('Every org is back on the default rules.');
  });
});

// Founder QA 2026-11-10: after a test publish the Edit card must not read like an unsaved draft.
describe('Edit card after a publish', () => {
  const description = () => screen.getByTestId('rules-card').querySelector('p')?.textContent;

  it('test publish: the card says it is editing the published version', async () => {
    setup();
    expect(description()).toBe("Editing from everyone's rules (v3).");
    fireEvent.change(screen.getByLabelText('Add to Domains'), { target: { value: 'other.example.com' } });
    fireEvent.click(within(screen.getByTestId('list-suppress.hosts')).getByRole('button', { name: 'Add' }));
    fireEvent.change(screen.getByLabelText('Test org'), { target: { value: ORG_A } });
    fireEvent.click(button('Publish to test org')[0]);
    await screen.findByTestId('notice-at-publish-test');
    // The fake publish answers version 5.
    expect(description()).toBe("Editing from v5. Changes are compared with everyone's rules (v3).");
  });

  it('a version tested on two orgs names both (not just the first)', async () => {
    const state = clone(STATE_MIXED) as SenderRulesAdminState;
    state.pins = state.pins.map((p) => ({ ...p, version: 4 }));
    setup({ load: { ok: true, state, released: clone(CONTENT_V3) } });
    fireEvent.click(within(screen.getByTestId('version-4')).getByRole('button', { name: 'Edit from this version' }));
    await waitFor(() =>
      expect(description()).toBe(
        "Editing from v4 (testing on Test Org A, Test Org B). Changes are compared with everyone's rules (v3).",
      ),
    );
  });

  it('a version under test is named with its org', async () => {
    setup();
    fireEvent.click(within(screen.getByTestId('version-4')).getByRole('button', { name: 'Edit from this version' }));
    await waitFor(() =>
      expect(description()).toBe("Editing from v4 (testing on Test Org A). Changes are compared with everyone's rules (v3)."),
    );
  });
});
