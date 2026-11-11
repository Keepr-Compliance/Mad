/**
 * @jest-environment node
 */
/**
 * BACKLOG-3962 PR3a: the hourly switch job (lib/domain/captureSwitch.ts).
 *
 * The fake server-role client answers with the shapes in
 * supabase/migrations/20261112113000_backlog_3962_domain_capture.sql:
 *   _domain_capture_due     RETURNS TABLE (switch_id, organization_id, claim_id, user_id, domain, notice_delivered)
 *   _domain_capture_switch  jsonb: success/outcome 'switched' + license_status, payer, email, brokerage_name,
 *                           or success true + outcome 'cancelled' + reason, or success false + error
 * DNS and email are injected; no network.
 */

import { runCaptureSwitch } from '@/lib/domain/captureSwitch';

const ORG_A = '00000000-0000-4000-8000-00000000000a'; // pii-allow-uuid: invented fixture id
const ORG_B = '00000000-0000-4000-8000-00000000000b'; // pii-allow-uuid: invented fixture id
const CLAIM_A = '00000000-0000-4000-8000-0000000000c1'; // pii-allow-uuid: invented fixture id
const CLAIM_B = '00000000-0000-4000-8000-0000000000c2'; // pii-allow-uuid: invented fixture id

function sw(n: number, org = ORG_A, claim = CLAIM_A, delivered: boolean | null = true) {
  return {
    switch_id: `00000000-0000-4000-8000-0000000005${String(n).padStart(2, '0')}`, // pii-allow-uuid: invented fixture id
    organization_id: org,
    claim_id: claim,
    user_id: `user-${n}`,
    domain: claim === CLAIM_A ? 'a-brokerage.example' : 'b-brokerage.example',
    notice_delivered: delivered,
  };
}

type SwitchReply = Record<string, unknown>;
interface World {
  due: unknown[];
  dueError?: { code: string } | null;
  switchReply: (id: string) => SwitchReply;
  logged?: string[]; // switch ids with a 'sent' notice row
  members?: Array<{ user_id: string | null; role: string; license_status: string; invitation_expires_at: null }>;
}

function harness(w: World) {
  const rpc = jest.fn(async (fn: string, args: Record<string, unknown>) => {
    if (fn === '_domain_capture_due') return { data: w.dueError ? null : w.due, error: w.dueError ?? null };
    if (fn === '_domain_claim_record_check') return { data: { success: true, result: 'verified', status: 'verified' }, error: null };
    if (fn === '_domain_capture_mark_notice') return { data: { success: true }, error: null };
    if (fn === '_domain_capture_switch') return { data: w.switchReply(args.p_switch as string), error: null };
    return { data: null, error: { code: 'PGRST202' } };
  });
  const from = jest.fn((table: string) => {
    const f: Record<string, unknown> = {};
    const eqs: Record<string, unknown> = {};
    f.select = () => f;
    f.eq = (k: string, v: unknown) => { eqs[k] = v; return f; };
    f.in = async () => ({ data: [{ id: 'it-1', email: 'it@a-brokerage.example' }], error: null });
    f.limit = async () => ({
      data: table === 'email_delivery_log' && (w.logged ?? []).includes(eqs['metadata->>switchId'] as string) ? [{ id: 'log' }] : [],
      error: null,
    });
    f.maybeSingle = async () => ({ data: { name: 'A Brokerage', max_seats: 2 }, error: null });
    f.then = (res: (v: unknown) => unknown) =>
      res({
        data: w.members ?? [
          { user_id: 'it-1', role: 'it_admin', license_status: 'active', invitation_expires_at: null },
          { user_id: 'adm-1', role: 'admin', license_status: 'active', invitation_expires_at: null },
        ],
        error: null,
      });
    return f;
  });
  const lookup = jest.fn(async () => ({ resolverOk: true, answers: ['x'] }));
  const sendSwitched = jest.fn(async () => ({ success: true, outcome: 'sent' as const }));
  const sendSeatAlert = jest.fn(async () => ({ success: true, outcome: 'sent' as const }));
  const service = { rpc, from } as unknown as Parameters<typeof runCaptureSwitch>[0]['service'];
  return { rpc, from, lookup, sendSwitched, sendSeatAlert, run: () => runCaptureSwitch({ service, lookup, sendSwitched, sendSeatAlert, now: () => 0 }) };
}

const switched = (id: string, over: SwitchReply = {}): SwitchReply => ({
  success: true, outcome: 'switched', switch_id: id, license_status: 'active', payer: false,
  email: `${id.slice(-2)}@a-brokerage.example`, brokerage_name: 'A Brokerage', seat_fallback: false, ...over,
});

describe('runCaptureSwitch', () => {
  it('reads DNS once per claim and records it as a re-check', async () => {
    const h = harness({ due: [sw(1), sw(2), sw(3, ORG_B, CLAIM_B)], switchReply: (id) => switched(id) });
    await h.run();
    expect(h.lookup).toHaveBeenCalledTimes(2);
    const recs = h.rpc.mock.calls.filter((c) => c[0] === '_domain_claim_record_check').map((c) => c[1]);
    expect(recs).toHaveLength(2);
    expect(recs.every((a) => a.p_source === 'recheck')).toBe(true);
    expect(recs.map((a) => a.p_claim).sort()).toEqual([CLAIM_A, CLAIM_B]);
  });

  it('records the DNS answer before any switch of that claim', async () => {
    const h = harness({ due: [sw(1)], switchReply: (id) => switched(id) });
    await h.run();
    const order = h.rpc.mock.calls.map((c) => c[0]);
    expect(order.indexOf('_domain_claim_record_check')).toBeLessThan(order.indexOf('_domain_capture_switch'));
  });

  it('sends one switched email to a non-payer and none to a payer', async () => {
    const a = sw(1); const b = sw(2);
    const h = harness({
      due: [a, b],
      switchReply: (id) => switched(id, { payer: id === b.switch_id }),
    });
    const s = await h.run();
    expect(h.sendSwitched).toHaveBeenCalledTimes(1);
    expect((h.sendSwitched.mock.calls as unknown[][])[0][0]).toMatchObject({ switchId: a.switch_id, licensed: true });
    expect(s.switched).toBe(2);
  });

  it('sends one seat alert per brokerage per run when people joined without a license', async () => {
    const h = harness({
      due: [sw(1), sw(2), sw(3)],
      switchReply: (id) => switched(id, { license_status: id.endsWith('01') ? 'active' : 'unassigned' }),
    });
    const s = await h.run();
    expect(s.unassigned).toBe(2);
    expect(s.seatAlerts).toBe(1);
    expect(h.sendSeatAlert).toHaveBeenCalledTimes(1);
    const p = (h.sendSeatAlert.mock.calls as unknown[][])[0][0] as Record<string, unknown>;
    expect(p).toMatchObject({ kind: 'domain_capture', recipientEmail: 'it@a-brokerage.example', maxSeats: 2, brokerageName: 'A Brokerage' });
    expect(p.personLabel).toBe('02@a-brokerage.example, 03@a-brokerage.example');
  });

  it('sends no seat alert when everyone got a license', async () => {
    const h = harness({ due: [sw(1), sw(2)], switchReply: (id) => switched(id) });
    await h.run();
    expect(h.sendSeatAlert).not.toHaveBeenCalled();
  });

  it('marks a queued notice delivered only when the delivery log has its sent row', async () => {
    const a = sw(1, ORG_A, CLAIM_A, null); const b = sw(2, ORG_A, CLAIM_A, null);
    const h = harness({ due: [a, b], logged: [a.switch_id], switchReply: (id) => switched(id) });
    await h.run();
    const marks = h.rpc.mock.calls.filter((c) => c[0] === '_domain_capture_mark_notice').map((c) => c[1]);
    expect(marks).toEqual([{ p_switch: a.switch_id, p_outcome: 'sent' }]);
  });

  it('counts cancellations and deferrals without emails', async () => {
    const a = sw(1); const b = sw(2);
    const h = harness({
      due: [a, b],
      switchReply: (id) => id === a.switch_id
        ? { success: true, outcome: 'cancelled', reason: 'notice_undelivered' }
        : { success: false, error: 'dns_not_fresh' },
    });
    const s = await h.run();
    expect(s.cancelled).toEqual({ notice_undelivered: 1 });
    expect(s.deferred).toEqual({ dns_not_fresh: 1 });
    expect(h.sendSwitched).not.toHaveBeenCalled();
    expect(h.sendSeatAlert).not.toHaveBeenCalled();
  });

  it('counts a suspended-brokerage cancellation as cancelled, not failed, and a Billing-step deferral as deferred', () => {
    const a = sw(1); const b = sw(2);
    const h = harness({
      due: [a, b],
      switchReply: (id) => id === a.switch_id
        ? { success: true, outcome: 'cancelled', reason: 'brokerage_suspended' }
        : { success: false, error: 'billing_setup_incomplete' },
    });
    return h.run().then((s) => {
      expect(s.cancelled).toEqual({ brokerage_suspended: 1 });
      expect(s.deferred).toEqual({ billing_setup_incomplete: 1 });
      expect(s.failed).toBe(0);
      expect(h.sendSwitched).not.toHaveBeenCalled();
    });
  });

  it('reports not_deployed when the functions are missing', async () => {
    const h = harness({ due: [], dueError: { code: 'PGRST202' }, switchReply: () => ({}) });
    const s = await h.run();
    expect(s.status).toBe('not_deployed');
    expect(h.lookup).not.toHaveBeenCalled();
  });
});
