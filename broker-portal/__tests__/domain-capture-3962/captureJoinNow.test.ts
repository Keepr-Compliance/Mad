/**
 * @jest-environment node
 */
/**
 * BACKLOG-3962 "Join now": lib/domain/captureJoinNow.ts.
 *
 * The fake server-role client answers with the shapes in
 * supabase/migrations/20261112114500_backlog_3962_capture_join_now.sql (_domain_capture_join_now
 * returns the _domain_capture_switch reply, plus joined_early: true on 'switched') and
 * 20261112113000 (domain_capture_switches / domain_claims columns). DNS and email are injected.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import * as Sentry from '@sentry/nextjs';
import { runCaptureJoinNow, JOIN_DNS_FRESH_MS } from '@/lib/domain/captureJoinNow';

jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn(), captureException: jest.fn() }));

const NOW = Date.parse('2026-11-12T12:00:00Z');
const ORG = '00000000-0000-4000-8000-00000000000a'; // pii-allow-uuid: invented fixture id
const CLAIM = '00000000-0000-4000-8000-0000000000c1'; // pii-allow-uuid: invented fixture id
const ME = '00000000-0000-4000-8000-000000000101'; // pii-allow-uuid: invented fixture id
const SW = '00000000-0000-4000-8000-000000000501'; // pii-allow-uuid: invented fixture id

interface World {
  /** the switch row the owner-filtered read returns (null = none) */
  row?: Record<string, unknown> | null;
  claim?: Record<string, unknown>;
  join?: { data: unknown; error: { code?: string } | null };
}

function harness(w: World = {}) {
  const log: string[] = [];
  const filters: Record<string, Record<string, unknown>> = {};
  const row = w.row === undefined
    ? { id: SW, organization_id: ORG, claim_id: CLAIM, user_id: ME, switch_at: '2026-11-24T10:00:00Z' }
    : w.row;
  const claim = w.claim ?? { domain: 'a-brokerage.example', last_check_result: 'verified', last_checked_at: new Date(NOW - 2 * 3600_000).toISOString() };
  const from = jest.fn((table: string) => {
    const eqs: Record<string, unknown> = {};
    filters[table] = eqs;
    const f: Record<string, unknown> = {};
    f.select = () => f;
    f.eq = (k: string, v: unknown) => { eqs[k] = v; return f; };
    f.in = async () => ({ data: [{ id: 'it-1', email: 'it@a-brokerage.example' }], error: null });
    f.maybeSingle = async () => {
      log.push(`read:${table}`);
      if (table === 'domain_capture_switches') {
        // as the database: only the filters the code actually sent narrow the read
        const hit = row && (!('id' in eqs) || eqs.id === row.id) && (!('user_id' in eqs) || eqs.user_id === row.user_id)
          && (!('status' in eqs) || eqs.status === 'scheduled');
        return { data: hit ? row : null, error: null };
      }
      if (table === 'domain_claims') return { data: claim, error: null };
      return { data: { name: 'A Brokerage', max_seats: 2 }, error: null };
    };
    f.then = (res: (v: unknown) => unknown) =>
      res({
        data: [
          { user_id: 'it-1', role: 'it_admin', license_status: 'active', invitation_expires_at: null },
          { user_id: 'adm-1', role: 'admin', license_status: 'active', invitation_expires_at: null },
        ],
        error: null,
      });
    return f;
  });
  const rpc = jest.fn(async (fn: string, _args?: Record<string, unknown>) => {
    log.push(`rpc:${fn}`);
    if (fn === '_domain_claim_record_check') return { data: { success: true, result: 'verified' }, error: null };
    if (fn === '_domain_capture_join_now') {
      return w.join ?? {
        data: {
          success: true, outcome: 'switched', switch_id: SW, license_status: 'active', payer: false,
          email: 'me@a-brokerage.example', brokerage_name: 'A Brokerage', seat_fallback: false, joined_early: true,
        },
        error: null,
      };
    }
    return { data: null, error: { code: 'PGRST202' } };
  });
  const lookup = jest.fn(async () => { log.push('lookup'); return { resolverOk: true, answers: ['x'] }; });
  const sendSwitched = jest.fn(async () => ({ success: true, outcome: 'sent' as const }));
  const sendSeatAlert = jest.fn(async () => ({ success: true, outcome: 'sent' as const }));
  const service = { rpc, from } as unknown as Parameters<typeof runCaptureJoinNow>[0]['service'];
  const run = (userId = ME, switchId = SW) =>
    runCaptureJoinNow({ service, lookup, sendSwitched, sendSeatAlert, now: () => NOW }, userId, switchId);
  return { log, filters, rpc, from, lookup, sendSwitched, sendSeatAlert, run };
}

describe('runCaptureJoinNow', () => {
  it('reads the own switch, re-checks DNS, then joins, in that order', async () => {
    const h = harness();
    const r = await h.run();
    expect(r).toEqual({ status: 'switched', brokerageName: 'A Brokerage', licensed: true });
    const order = h.log.filter((l) => l === 'read:domain_capture_switches' || l === 'lookup' || l.startsWith('rpc:'));
    expect(order).toEqual(['read:domain_capture_switches', 'lookup', 'rpc:_domain_claim_record_check', 'rpc:_domain_capture_join_now']);
    expect(h.filters.domain_capture_switches).toEqual({ id: SW, user_id: ME, status: 'scheduled' });
    const rec = h.rpc.mock.calls.find((c) => c[0] === '_domain_claim_record_check')?.[1];
    expect(rec).toMatchObject({ p_claim: CLAIM, p_org: ORG, p_source: 'recheck' });
    expect(h.rpc.mock.calls.find((c) => c[0] === '_domain_capture_join_now')?.[1]).toEqual({ p_switch: SW, p_user: ME });
  });

  it('a switch that is not the caller\'s: no DNS read, no write, not found', async () => {
    const h = harness();
    const r = await h.run('00000000-0000-4000-8000-0000000000ee'); // pii-allow-uuid: invented fixture id
    expect(r).toMatchObject({ status: 'error', code: 'switch_not_found' });
    expect(h.lookup).not.toHaveBeenCalled();
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('skips the DNS read when a verified answer is under 50 minutes old', async () => {
    const h = harness({ claim: { domain: 'a-brokerage.example', last_check_result: 'verified', last_checked_at: new Date(NOW - 10 * 60_000).toISOString() } });
    await h.run();
    expect(h.lookup).not.toHaveBeenCalled();
    expect(h.rpc.mock.calls.map((c) => c[0])).toEqual(['_domain_capture_join_now']);
  });

  it.each([
    ['older than 50 minutes', { last_check_result: 'verified', last_checked_at: new Date(NOW - JOIN_DNS_FRESH_MS - 1000).toISOString() }],
    ['last answer not verified', { last_check_result: 'not_found', last_checked_at: new Date(NOW - 60_000).toISOString() }],
    ['never checked', { last_check_result: null, last_checked_at: null }],
  ])('re-checks DNS when the answer is %s', async (_n, c) => {
    const h = harness({ claim: { domain: 'a-brokerage.example', ...c } });
    await h.run();
    expect(h.lookup).toHaveBeenCalledTimes(1);
  });

  it('a lookup that throws records nothing, and the join still asks the database', async () => {
    const h = harness({ join: { data: { success: false, error: 'dns_not_fresh' }, error: null } });
    h.lookup.mockRejectedValueOnce(new Error('resolver down'));
    const r = await h.run();
    expect(h.rpc.mock.calls.map((c) => c[0])).toEqual(['_domain_capture_join_now']);
    expect(r).toMatchObject({ status: 'error', code: 'dns_not_fresh', brokerageName: 'A Brokerage', switchAt: '2026-11-24T10:00:00Z' });
  });

  it('sends the switched email (joined early) to a non-payer and none to a payer', async () => {
    const h = harness();
    await h.run();
    expect(h.sendSwitched).toHaveBeenCalledTimes(1);
    expect((h.sendSwitched.mock.calls as unknown[][])[0][0]).toMatchObject({ switchId: SW, licensed: true, joinedEarly: true, recipientEmail: 'me@a-brokerage.example' });
    const p = harness({ join: { data: { success: true, outcome: 'switched', license_status: 'active', payer: true, email: 'me@a-brokerage.example', joined_early: true }, error: null } });
    await p.run();
    expect(p.sendSwitched).not.toHaveBeenCalled();
  });

  it('a throw from the notifications after the move still returns switched and warns in Sentry', async () => {
    const h = harness({ join: { data: { success: true, outcome: 'switched', license_status: 'unassigned', payer: false, email: 'me@a-brokerage.example', brokerage_name: 'A Brokerage', joined_early: true }, error: null } });
    h.sendSeatAlert.mockRejectedValueOnce(new Error('smtp down'));
    const r = await h.run();
    expect(r).toEqual({ status: 'switched', brokerageName: 'A Brokerage', licensed: false });
    expect(Sentry.captureMessage).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ level: 'warning' }));
  });

  it('joined without a license: the brokerage admins get the seat alert', async () => {
    const h = harness({ join: { data: { success: true, outcome: 'switched', license_status: 'unassigned', payer: false, email: 'me@a-brokerage.example', brokerage_name: 'A Brokerage', joined_early: true }, error: null } });
    const r = await h.run();
    expect(r).toEqual({ status: 'switched', brokerageName: 'A Brokerage', licensed: false });
    expect(h.sendSeatAlert).toHaveBeenCalledTimes(1);
    expect((h.sendSeatAlert.mock.calls as unknown[][])[0][0]).toMatchObject({
      kind: 'domain_capture', recipientEmail: 'it@a-brokerage.example', personLabel: 'me@a-brokerage.example',
    });
  });

  it('a licensed join sends no seat alert', async () => {
    const h = harness();
    await h.run();
    expect(h.sendSeatAlert).not.toHaveBeenCalled();
  });

  it.each([
    [{ data: { success: false, error: 'not_scheduled', status: 'opted_out' }, error: null }, { code: 'not_scheduled', rowStatus: 'opted_out' }],
    [{ data: { success: true, outcome: 'cancelled', reason: 'not_eligible' }, error: null }, { code: 'cancelled' }],
    [{ data: null, error: { code: '40P01' } }, { code: 'failed' }],
    [{ data: null, error: { code: 'PGRST202' } }, { code: 'unavailable' }],
  ])('maps a database answer to a code and sends nothing (%#)', async (join, want) => {
    const h = harness({ join });
    const r = await h.run();
    expect(r).toMatchObject({ status: 'error', ...want });
    expect(h.sendSwitched).not.toHaveBeenCalled();
    expect(h.sendSeatAlert).not.toHaveBeenCalled();
  });
});

describe('no GET path joins', () => {
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? files(p) : [p];
    });
  }
  it('no route under app/ calls the join (only the server action does)', () => {
    const root = join(__dirname, '..', '..', 'app');
    const routes = files(root).filter((p) => /route\.(ts|tsx)$/.test(p));
    expect(routes.length).toBeGreaterThan(10);
    const hits = routes.filter((p) => /_domain_capture_join_now|runCaptureJoinNow|joinNowSelf/.test(readFileSync(p, 'utf8')));
    expect(hits).toEqual([]);
  });
});
