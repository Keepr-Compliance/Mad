/**
 * BACKLOG-4186 PR B — data access: exact RPC arguments (A1, A2), promote re-publishes the stored
 * content (A3), thresholds reach the RPC as numbers (A14), the read shapes and the refusals.
 *
 * Every answer the fake client gives is transcribed from keepr-test (fixtures.ts).
 */
import {
  createSenderRulesApi,
  parseAdminState,
  SenderRulesError,
  toSenderRulesError,
} from '@/lib/sender-rules/api';
import { setThreshold } from '@/lib/sender-rules/validate';

import {
  CONTENT_MISSING,
  CONTENT_V2,
  ERRORS,
  ORG_A,
  PUBLISH_CANARY_RESULT,
  PUBLISH_RELEASE_RESULT,
  STATE_CANARY,
  STATE_INITIAL,
  STATE_RELEASED,
} from './fixtures';
import { READ_REFUSED, WRITE_REFUSED } from './fixtures-pr-c';
import { bundled, clone, fakeClient } from './helpers';

const has = (o: object | undefined, k: string) => o !== undefined && Object.prototype.hasOwnProperty.call(o, k);

async function rejection(p: Promise<unknown>): Promise<SenderRulesError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(SenderRulesError);
    return e as SenderRulesError;
  }
  throw new Error('expected a rejection');
}

describe('A1: a canary with no org is refused before any call', () => {
  it.each(['', '   '])('publishCanary(content, %j) rejects and calls nothing', async (org) => {
    const { client, calls } = fakeClient({ sender_rule_set_publish: { data: PUBLISH_CANARY_RESULT } });
    const err = await rejection(createSenderRulesApi(client).publishCanary(bundled(), org));
    expect(err.kind).toBe('org_required');
    expect(calls).toEqual([]);
  });

  it('unpin with no org rejects and calls nothing (a NULL org is a server error, not a no-op)', async () => {
    const { client, calls } = fakeClient();
    const err = await rejection(createSenderRulesApi(client).unpin(''));
    expect(err.kind).toBe('org_required');
    expect(calls).toEqual([]);
  });
});

describe('A2: p_pin_org is always sent explicitly', () => {
  it('a canary sends the org id', async () => {
    const { client, calls } = fakeClient({ sender_rule_set_publish: { data: PUBLISH_CANARY_RESULT } });
    const c = bundled();
    await expect(createSenderRulesApi(client).publishCanary(c, ORG_A)).resolves.toBe(2);
    expect(calls).toHaveLength(1);
    expect(calls[0].fn).toBe('sender_rule_set_publish');
    expect(calls[0].wire).toStrictEqual({ p_content: c, p_pin_org: ORG_A });
  });

  it('a release sends p_pin_org: null, present on the wire', async () => {
    const { client, calls } = fakeClient({ sender_rule_set_publish: { data: PUBLISH_RELEASE_RESULT } });
    const c = bundled();
    await expect(createSenderRulesApi(client).publishRelease(c)).resolves.toBe(3);
    expect(calls).toHaveLength(1);
    expect(has(calls[0].wire, 'p_pin_org')).toBe(true);
    expect(calls[0].wire).toStrictEqual({ p_content: c, p_pin_org: null });
  });

  it('unpin sends p_version: null for that org', async () => {
    const { client, calls } = fakeClient();
    await createSenderRulesApi(client).unpin(ORG_A);
    expect(calls).toHaveLength(1);
    expect(calls[0].fn).toBe('sender_rule_set_pin');
    expect(calls[0].wire).toStrictEqual({ p_org: ORG_A, p_version: null });
  });

  it('revertAll calls revert_all with no arguments', async () => {
    const { client, calls } = fakeClient({ sender_rule_set_revert_all: { data: 4 } });
    await expect(createSenderRulesApi(client).revertAll()).resolves.toBe(4);
    expect(calls.map((c) => [c.fn, c.args])).toEqual([['sender_rule_set_revert_all', undefined]]);
  });
});

describe('A3: promote releases the stored content, never anything else', () => {
  it('fetches v2 and releases exactly that content, version key included', async () => {
    const { client, calls } = fakeClient({
      sender_rule_set_admin_content: (args) => ({ data: args?.p_version === 2 ? clone(CONTENT_V2) : null }),
      sender_rule_set_publish: { data: PUBLISH_RELEASE_RESULT },
    });
    await expect(createSenderRulesApi(client).promote(2)).resolves.toBe(3);
    expect(calls.map((c) => c.fn)).toEqual(['sender_rule_set_admin_content', 'sender_rule_set_publish']);
    expect(calls[0].wire).toStrictEqual({ p_version: 2 });
    expect(calls[1].wire).toStrictEqual({ p_content: CONTENT_V2, p_pin_org: null });
    expect((calls[1].wire?.p_content as { version: number }).version).toBe(2);
  });

  it('a missing version rejects and publishes nothing', async () => {
    const { client, calls } = fakeClient({
      sender_rule_set_admin_content: { data: CONTENT_MISSING },
      sender_rule_set_publish: { data: PUBLISH_RELEASE_RESULT },
    });
    const err = await rejection(createSenderRulesApi(client).promote(999999));
    expect(err.kind).toBe('version_not_found');
    expect(calls.map((c) => c.fn)).toEqual(['sender_rule_set_admin_content']);
  });
});

describe('A14: thresholds reach the RPC as numbers', () => {
  it('an edited threshold is a number in p_content', async () => {
    const { client, calls } = fakeClient({ sender_rule_set_publish: { data: PUBLISH_RELEASE_RESULT } });
    const r = setThreshold(bundled(), 'minCensusLinkedEmails', '25');
    if (!r.ok) throw new Error(r.reason);
    await createSenderRulesApi(client).publishRelease(r.content);
    const sent = calls[0].wire?.p_content as { thresholds: Record<string, unknown> };
    expect(sent.thresholds.minCensusLinkedEmails).toBe(25);
    expect(typeof sent.thresholds.minCensusLinkedEmails).toBe('number');
  });

  it('content with a string threshold is refused before any call', async () => {
    const { client, calls } = fakeClient({ sender_rule_set_publish: { data: PUBLISH_RELEASE_RESULT } });
    const bad = clone(bundled()) as unknown as { thresholds: Record<string, unknown> };
    bad.thresholds.minCensusLinkedEmails = '20';
    const err = await rejection(createSenderRulesApi(client).publishRelease(bad as never));
    expect(err.kind).toBe('invalid');
    expect(err.message).toBe(ERRORS.invalid.message); // the server's own words for the same input
    expect(calls).toEqual([]);
  });
});

describe('reads', () => {
  it.each([
    ['initial', STATE_INITIAL],
    ['canary', STATE_CANARY],
    ['released', STATE_RELEASED],
  ] as const)('parseAdminState reads the captured %s state unchanged', (_n, s) => {
    expect(parseAdminState(clone(s))).toEqual(s);
  });

  it.each([
    ['[]', []],
    ['null', null],
    ['a string', 'x'],
    ['no pins', { ...STATE_INITIAL, pins: undefined }],
    ['released_version as text', { ...STATE_INITIAL, released_version: '1' }],
    ['a version row without published_at', { ...STATE_INITIAL, versions: [{ ...STATE_INITIAL.versions[0], published_at: undefined }] }],
    ['a pin with a numeric org id', { ...STATE_CANARY, pins: [{ ...STATE_CANARY.pins[0], org_id: 1 }] }],
  ])('parseAdminState(%s) -> null', (_n, v) => {
    expect(parseAdminState(v)).toBeNull();
  });

  it('a deleted org reads as a null name, row kept', () => {
    const s = clone(STATE_CANARY);
    s.versions[0].canary_org_name = null as never;
    expect(parseAdminState(s)?.versions[0]).toMatchObject({ version: 2, canary_org_name: null });
  });

  it('state() calls admin_state with no arguments; an unreadable answer rejects', async () => {
    const ok = fakeClient({ sender_rule_set_admin_state: { data: clone(STATE_CANARY) } });
    await expect(createSenderRulesApi(ok.client).state()).resolves.toEqual(STATE_CANARY);
    expect(ok.calls.map((c) => [c.fn, c.args])).toEqual([['sender_rule_set_admin_state', undefined]]);
    const bad = fakeClient({ sender_rule_set_admin_state: { data: [] } });
    expect((await rejection(createSenderRulesApi(bad.client).state())).kind).toBe('unreadable');
  });

  it('content() returns the stored content, null for a missing version', async () => {
    const { client } = fakeClient({
      sender_rule_set_admin_content: (args) => ({ data: args?.p_version === 2 ? clone(CONTENT_V2) : CONTENT_MISSING }),
    });
    const api = createSenderRulesApi(client);
    await expect(api.content(2)).resolves.toEqual(CONTENT_V2);
    await expect(api.content(999999)).resolves.toBeNull();
  });
});

describe('refusals (captured from keepr-test)', () => {
  it('the guard refusal carries its blocks in words', () => {
    const e = toSenderRulesError(ERRORS.release_refused);
    expect(e.kind).toBe('guard');
    expect(e.code).toBe('22023');
    expect(e.message).toBe('These changes must run on a test org first:');
    expect(e.blocks).toEqual([
      'Bulk headers turns Live in Learn questions',
      'Adds promo.example.com to Hide mail from: Domains',
      'Removes showingtime.net from Always keep: Platform domains',
      'Counts auto-submitted mail as bulk',
    ]);
  });

  it.each([
    ['invalid', ERRORS.invalid, 'invalid'],
    ['org_not_found', ERRORS.org_not_found, 'org_not_found'],
    ['pin_below_released', ERRORS.pin_below_released, 'pin_below'],
  ] as const)('%s -> %s, the server text kept', (_n, err, kind) => {
    const e = toSenderRulesError(err);
    expect(e.kind).toBe(kind);
    expect(e.message).toBe(err.message);
    expect(e.blocks).toBeUndefined();
  });

  it('42501 -> not_allowed; anything else -> unknown with its raw text', () => {
    const e = toSenderRulesError(WRITE_REFUSED);
    expect(e.kind).toBe('not_allowed');
    // PR B SR S1: the plain line, never the server's raw "Not allowed".
    expect(e.message).toBe("You can't change these rules.");
    const u = toSenderRulesError({ code: 'P0002', message: 'No bundled rule set' });
    expect([u.kind, u.message]).toEqual(['unknown', 'No bundled rule set']);
  });

  // PR B SR S2: a refused READ is worded as a read, not "You can't change these rules."
  it('a 42501 on a read (state, content) says the rules cannot be seen', async () => {
    const { client } = fakeClient({
      sender_rule_set_admin_state: { error: READ_REFUSED },
      sender_rule_set_admin_content: { error: READ_REFUSED },
    });
    const api = createSenderRulesApi(client);
    for (const p of [api.state(), api.content(3)]) {
      const e = await rejection(p);
      expect([e.kind, e.code, e.message]).toEqual(['not_allowed', '42501', "You don't have access to these rules."]);
    }
  });

  it('a 42501 on a write keeps the write wording', async () => {
    const { client } = fakeClient({ sender_rule_set_publish: { error: WRITE_REFUSED } });
    const e = await rejection(createSenderRulesApi(client).publishCanary(clone(CONTENT_V2), ORG_A));
    expect([e.kind, e.message]).toEqual(['not_allowed', "You can't change these rules."]);
  });

  it('a refused release rejects with the mapped error', async () => {
    const { client } = fakeClient({ sender_rule_set_publish: { error: ERRORS.release_refused } });
    const err = await rejection(createSenderRulesApi(client).publishRelease(clone(CONTENT_V2)));
    expect(err.kind).toBe('guard');
    expect(err.blocks).toHaveLength(4);
  });
});
