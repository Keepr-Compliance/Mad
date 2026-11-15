// @vitest-environment jsdom

/**
 * BACKLOG-4212 PR4: the optional threshold `userSuppressMinAnswers` on the sender rules page.
 *
 * Contents are the keepr-test captures from sender-rules-4186 (CONTENT_V3 released, CONTENT_V4 on
 * the canary). The "with the key" variants add `userSuppressMinAnswers` to those captures; no set
 * carrying the key has been published yet, so there is none to transcribe. The SQL accepts the key
 * as an integer 0-20 (migration 20261116100000, corpus supabase/tests/backlog-4175/corpus.json).
 *
 * Controls:
 *  - removing the key from OPTIONAL_THRESHOLD_KEYS reddens the field and diff tests;
 *  - dropping the guard term from canPublish reddens the publish-guard tests.
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
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => {
    throw new Error('browser client used in a test');
  },
}));

import { OLD_APP_CONFIRM, OLD_APP_WARNING, SenderRulesView } from '@/app/dashboard/ai/sender-rules/SenderRulesView';
import { RulesCard } from '@/app/dashboard/ai/sender-rules/RulesCard';
import { createSenderRulesApi } from '@/lib/sender-rules/api';
import { diffLineText, diffRuleSets } from '@/lib/sender-rules/diff';
import { parseOrgList } from '@/lib/sender-rules/orgs';
import { TIPS } from '@/lib/sender-rules/tips';
import { hasNewAppOnlyKey, type SenderRuleSet, type SenderRulesAdminState } from '@/lib/sender-rules/types';
import { invalidReason, setThreshold } from '@/lib/sender-rules/validate';

import { ORG_A } from '../sender-rules-4186/fixtures';
import { CONTENT_V3, CONTENT_V4, ORG_LIST, STATE_MIXED } from '../sender-rules-4186/fixtures-pr-c';
import { bundled, clone, fakeClient, type RpcCall } from '../sender-rules-4186/helpers';

const LABEL = 'Newsletter answers to skip a sender';
const NOT_SET = 'Not set (app default 2)';

function withKey(c: SenderRuleSet, n: number): SenderRuleSet {
  const out = clone(c);
  out.thresholds.userSuppressMinAnswers = n;
  return out;
}

function setup(opts: { released?: SenderRuleSet; v4?: SenderRuleSet } = {}) {
  const released = opts.released ?? clone(CONTENT_V3);
  const v4 = opts.v4 ?? clone(CONTENT_V4);
  const fake = fakeClient({
    sender_rule_set_admin_content: (args) => ({
      data: args?.p_version === 3 ? clone(released) : args?.p_version === 4 ? clone(v4) : null,
    }),
    sender_rule_set_publish: { data: 5 },
  });
  render(
    <SenderRulesView
      access="owner"
      load={{ ok: true, state: clone(STATE_MIXED) as SenderRulesAdminState, released }}
      orgs={parseOrgList(clone(ORG_LIST), null)}
      api={createSenderRulesApi(fake.client)}
    />,
  );
  return fake;
}

const publishEveryone = () => screen.getAllByRole('button', { name: 'Publish to everyone' })[0] as HTMLButtonElement;
const publishTest = () => screen.getAllByRole('button', { name: 'Publish to test org' })[0] as HTMLButtonElement;
const writes = (calls: RpcCall[]) => calls.filter((c) => c.fn !== 'sender_rule_set_admin_content');
const field = () => screen.getByLabelText(LABEL) as HTMLInputElement;

beforeEach(() => {
  nav.refresh.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the field', () => {
  it('owner: renders empty with the app default as placeholder when the set does not carry it', () => {
    setup();
    expect(field().value).toBe('');
    expect(field().placeholder).toBe(NOT_SET);
    expect(screen.getByRole('button', { name: `About ${LABEL}` })).toBeTruthy();
    expect(TIPS.userSuppressMinAnswers).toBe(
      'How many times a user marks a sender as newsletter in Learn before Keepr skips that sender for them. 0 turns it off.',
    );
  });

  it('owner: shows the stored value when the set carries it', () => {
    setup({ released: withKey(CONTENT_V3, 3) });
    expect(field().value).toBe('3');
  });

  it('viewer: read-only shows "Not set" or the value', () => {
    render(<RulesCard content={bundled()} readOnly releasedVersion={1} />);
    expect(screen.getByTestId('rules-card').textContent).toContain(LABEL);
    expect(screen.getByTestId('rules-card').textContent).toContain(NOT_SET);
    cleanup();
    render(<RulesCard content={withKey(bundled(), 0)} readOnly releasedVersion={1} />);
    expect(screen.getByTestId('rules-card').textContent).not.toContain(NOT_SET);
    expect(document.getElementById('threshold-userSuppressMinAnswers')?.textContent).toBe('0');
  });

  it('edits: a typed 3 is stored as the NUMBER 3 and listed as a change', async () => {
    const fake = setup();
    fireEvent.change(field(), { target: { value: '3' } });
    expect(screen.getByTestId('draft-changes').textContent).toContain(`${LABEL}: not set to 3`);
    fireEvent.click(screen.getByLabelText(OLD_APP_CONFIRM));
    fireEvent.click(publishEveryone());
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Publish to everyone' }));
    await waitFor(() => expect(writes(fake.calls)).toHaveLength(1));
    const t = (writes(fake.calls)[0].wire?.p_content as SenderRuleSet).thresholds;
    expect(t.userSuppressMinAnswers).toBe(3);
    expect(typeof t.userSuppressMinAnswers).toBe('number');
  });

  it('refuses 21 and 1.5 inline; Publish stays off', () => {
    setup();
    fireEvent.change(field(), { target: { value: '21' } });
    expect(screen.getByText('Must be at most 20.')).toBeTruthy();
    expect(publishEveryone().disabled).toBe(true);
    fireEvent.change(field(), { target: { value: '1.5' } });
    expect(screen.getByText('Enter a whole number.')).toBeTruthy();
    expect(publishEveryone().disabled).toBe(true);
  });

  it('clears: emptying the field removes the key (not undefined) and lists the change', async () => {
    const fake = setup({ released: withKey(CONTENT_V3, 3) });
    fireEvent.change(field(), { target: { value: '' } });
    expect(screen.getByTestId('draft-changes').textContent).toContain(`${LABEL}: 3 to not set`);
    expect(screen.queryByTestId('old-app-guard-draft')).toBeNull();
    expect(publishEveryone().disabled).toBe(false);
    fireEvent.click(publishEveryone());
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Publish to everyone' }));
    await waitFor(() => expect(writes(fake.calls)).toHaveLength(1));
    const t = (writes(fake.calls)[0].wire?.p_content as SenderRuleSet).thresholds;
    expect(Object.prototype.hasOwnProperty.call(t, 'userSuppressMinAnswers')).toBe(false);
  });
});

describe('validate parity (unchanged by this PR)', () => {
  it.each([0, 2, 20])('accepts %s', (n) => {
    expect(invalidReason(withKey(bundled(), n))).toBeNull();
  });
  it.each([21, -1, 1.5, '2', null])('refuses %s with the server reason', (n) => {
    const c = clone(bundled()) as unknown as { thresholds: Record<string, unknown> };
    c.thresholds.userSuppressMinAnswers = n;
    expect(invalidReason(c)).toBe('thresholds.userSuppressMinAnswers: not an integer 0-20');
  });
  it('setThreshold: empty removes the optional key; empty is still refused for a required one', () => {
    const r = setThreshold(withKey(bundled(), 4), 'userSuppressMinAnswers', '  ');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect('userSuppressMinAnswers' in r.content.thresholds).toBe(false);
      expect(invalidReason(r.content)).toBeNull();
    }
    expect(setThreshold(bundled(), 'minCensusLinkedEmails', '')).toEqual({ ok: false, reason: 'Enter a whole number.' });
  });
});

describe('diff', () => {
  it('shows a row when the key is added, changed or removed', () => {
    const base = bundled();
    expect(diffRuleSets(base, withKey(base, 2))).toEqual([
      { kind: 'threshold', key: 'userSuppressMinAnswers', from: undefined, to: 2 },
    ]);
    expect(diffRuleSets(base, withKey(base, 2)).map(diffLineText)).toEqual([`${LABEL}: not set to 2`]);
    expect(diffRuleSets(withKey(base, 2), withKey(base, 5)).map(diffLineText)).toEqual([`${LABEL}: 2 to 5`]);
    expect(diffRuleSets(withKey(base, 0), base).map(diffLineText)).toEqual([`${LABEL}: 0 to not set`]);
    expect(diffRuleSets(withKey(base, 2), withKey(base, 2))).toEqual([]);
  });
});

describe('publish guard (SR R6): apps older than 2.49 refuse the key', () => {
  it('hasNewAppOnlyKey reads the key, not its value', () => {
    expect(hasNewAppOnlyKey(bundled())).toBe(false);
    expect(hasNewAppOnlyKey(withKey(bundled(), 0))).toBe(true);
  });

  it('blocks both publish buttons until the box is ticked', () => {
    setup();
    fireEvent.change(screen.getByLabelText('Test org'), { target: { value: ORG_A } });
    fireEvent.change(field(), { target: { value: '2' } });
    const guard = screen.getByTestId('old-app-guard-draft');
    expect(guard.textContent).toContain(OLD_APP_WARNING);
    expect(OLD_APP_WARNING).toBe("Apps older than 2.49 can't read this setting and will keep their current rules until they update.");
    expect(publishEveryone().disabled).toBe(true);
    expect(publishTest().disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(OLD_APP_CONFIRM));
    expect(publishEveryone().disabled).toBe(false);
    expect(publishTest().disabled).toBe(false);
  });

  it('shows while the key is present even when it is unchanged from everyone\'s rules', () => {
    setup({ released: withKey(CONTENT_V3, 2) });
    fireEvent.change(screen.getByLabelText('Add to Domains'), { target: { value: 'other.example.com' } });
    fireEvent.click(within(screen.getByTestId('list-suppress.hosts')).getByRole('button', { name: 'Add' }));
    expect(screen.getByTestId('old-app-guard-draft')).toBeTruthy();
    expect(publishEveryone().disabled).toBe(true);
  });

  it('a tick does not survive clearing and re-entering the value', () => {
    setup();
    fireEvent.change(field(), { target: { value: '2' } });
    fireEvent.click(screen.getByLabelText(OLD_APP_CONFIRM));
    expect(publishEveryone().disabled).toBe(false);
    fireEvent.change(field(), { target: { value: '' } });
    fireEvent.change(field(), { target: { value: '3' } });
    expect(publishEveryone().disabled).toBe(true);
  });

  it('promote: a canary carrying the key needs the same tick', async () => {
    const fake = setup({ v4: withKey(CONTENT_V4, 2) });
    fireEvent.click(within(screen.getByTestId(`pin-${ORG_A}`)).getByRole('button', { name: "Make this everyone's" }));
    const dialog = await screen.findByRole('alertdialog');
    await waitFor(() => expect(within(dialog).getByTestId('old-app-guard-promote').textContent).toContain(OLD_APP_WARNING));
    const confirm = within(dialog).getByRole('button', { name: "Make this everyone's" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(writes(fake.calls)).toEqual([]);
    fireEvent.click(within(dialog).getByLabelText(OLD_APP_CONFIRM));
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(writes(fake.calls)).toHaveLength(1));
    expect((writes(fake.calls)[0].wire?.p_content as SenderRuleSet).thresholds.userSuppressMinAnswers).toBe(2);
  });

  it('promote: a canary without the key shows no guard', async () => {
    setup();
    fireEvent.click(within(screen.getByTestId(`pin-${ORG_A}`)).getByRole('button', { name: "Make this everyone's" }));
    const dialog = await screen.findByRole('alertdialog');
    const confirm = within(dialog).getByRole('button', { name: "Make this everyone's" }) as HTMLButtonElement;
    await waitFor(() => expect(confirm.disabled).toBe(false));
    expect(within(dialog).queryByTestId('old-app-guard-promote')).toBeNull();
  });
});
