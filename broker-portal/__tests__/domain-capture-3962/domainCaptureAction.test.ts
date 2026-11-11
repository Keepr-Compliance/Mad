/**
 * @jest-environment node
 */
/**
 * BACKLOG-3962 PR3a: the domain capture server actions. Reply shapes are transcribed from
 * supabase/migrations/20261112113000_backlog_3962_domain_capture.sql (domain_capture_start,
 * domain_capture_cancel, domain_capture_opt_out_self, _domain_capture_mark_notice).
 */

const mockBlock = jest.fn();
const mockAccess = jest.fn();
const mockServiceRpc = jest.fn();
const mockSessionClient = jest.fn();
const mockSendNotice = jest.fn();

jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn() }));
jest.mock('@/lib/impersonation-guards', () => ({ blockWriteDuringImpersonation: () => mockBlock() }));
jest.mock('@/lib/domain/access', () => ({ requireDomainClaimAccess: () => mockAccess() }));
jest.mock('@/lib/supabase/service', () => ({ createServiceClient: () => ({ rpc: (...a: unknown[]) => mockServiceRpc(...a) }) }));
jest.mock('@/lib/supabase/server', () => ({ createClient: () => mockSessionClient() }));
jest.mock('@/lib/email', () => ({ sendDomainCaptureNoticeEmail: (...a: unknown[]) => mockSendNotice(...a) }));

import {
  DOMAIN_CAPTURE_BILLING_SETUP,
  DOMAIN_CAPTURE_CONFIRM,
  DOMAIN_CAPTURE_NOT_AUTHORIZED,
  DOMAIN_CAPTURE_UNAVAILABLE,
} from '@/lib/domain/captureMessages';
import { cancelCapture, optOutSelf, startCapture } from '@/lib/actions/domainCapture';

const ORG_A = '00000000-0000-4000-8000-00000000000a'; // pii-allow-uuid: invented fixture id
const ORG_EVIL = '00000000-0000-4000-8000-0000000000ee'; // pii-allow-uuid: invented fixture id
const CLAIM = '00000000-0000-4000-8000-0000000000c1'; // pii-allow-uuid: invented fixture id
const U1 = '00000000-0000-4000-8000-000000000101'; // pii-allow-uuid: invented fixture id
const U2 = '00000000-0000-4000-8000-000000000102'; // pii-allow-uuid: invented fixture id
const S1 = '00000000-0000-4000-8000-000000000501'; // pii-allow-uuid: invented fixture id
const S2 = '00000000-0000-4000-8000-000000000502'; // pii-allow-uuid: invented fixture id

let sessionRpc: jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockBlock.mockResolvedValue(null);
  sessionRpc = jest.fn(async (fn: string) => {
    if (fn === 'domain_capture_start') {
      return {
        data: {
          success: true, domain: 'a-brokerage.example', brokerage_name: 'A Brokerage',
          scheduled: [
            { switch_id: S1, user_id: U1, email: 'one@a-brokerage.example', switch_at: '2026-11-24T10:00:00Z', payer: true },
            { switch_id: S2, user_id: U2, email: 'two@a-brokerage.example', switch_at: '2026-11-24T10:00:00Z', payer: false },
          ],
          skipped: [],
        },
        error: null,
      };
    }
    if (fn === 'domain_capture_cancel') return { data: { success: true, status: 'cancelled' }, error: null };
    if (fn === 'domain_capture_opt_out_self') return { data: { success: true, status: 'opted_out' }, error: null };
    return { data: null, error: { code: 'PGRST202' } };
  });
  mockAccess.mockResolvedValue({ ok: true, supabase: { rpc: sessionRpc }, userId: 'admin-a', organizationId: ORG_A });
  mockServiceRpc.mockResolvedValue({ data: { success: true }, error: null });
  mockSendNotice.mockImplementation(async (p: { switchId: string }) =>
    p.switchId === S1 ? { success: true, outcome: 'sent' } : { success: false, outcome: 'failed' });
  mockSessionClient.mockResolvedValue({
    auth: { getUser: async () => ({ data: { user: { id: U1 } } }) },
    rpc: sessionRpc,
  });
});

describe('startCapture', () => {
  it('uses the session organization, never a posted one', async () => {
    await startCapture({ claimId: CLAIM, userIds: [U1, U2], organizationId: ORG_EVIL } as unknown as { claimId: string; userIds: string[] });
    const call = sessionRpc.mock.calls.find((c) => c[0] === 'domain_capture_start');
    expect(call?.[1]).toEqual({ p_org: ORG_A, p_claim: CLAIM, p_users: [U1, U2] });
  });

  it('sends one notice per scheduled switch and records each outcome', async () => {
    const r = await startCapture({ claimId: CLAIM, userIds: [U1, U2] });
    expect(mockSendNotice).toHaveBeenCalledTimes(2);
    expect(mockSendNotice.mock.calls[0][0]).toMatchObject({
      recipientEmail: 'one@a-brokerage.example', brokerageName: 'A Brokerage', domain: 'a-brokerage.example',
      switchId: S1, optOutUrl: expect.stringMatching(/\/dashboard\?capture=notice$/), payer: true,
    });
    expect(mockSendNotice.mock.calls[1][0]).toMatchObject({ switchId: S2, payer: false });
    expect(mockServiceRpc.mock.calls).toEqual([
      ['_domain_capture_mark_notice', { p_switch: S1, p_outcome: 'sent' }],
      ['_domain_capture_mark_notice', { p_switch: S2, p_outcome: 'failed' }],
    ]);
    expect(r).toMatchObject({ success: true, scheduled: 2, noticesSent: 1, noticesUndelivered: 1 });
  });

  it('refuses a caller without domain access and calls nothing', async () => {
    mockAccess.mockResolvedValue({ ok: false });
    const r = await startCapture({ claimId: CLAIM, userIds: [U1] });
    expect(r).toEqual({ success: false, message: DOMAIN_CAPTURE_NOT_AUTHORIZED });
    expect(sessionRpc).not.toHaveBeenCalled();
    expect(mockSendNotice).not.toHaveBeenCalled();
  });

  it('answers the not-deployed message when the function is missing', async () => {
    sessionRpc.mockResolvedValueOnce({ data: null, error: { code: 'PGRST202' } });
    const r = await startCapture({ claimId: CLAIM, userIds: [U1] });
    expect(r.message).toBe(DOMAIN_CAPTURE_UNAVAILABLE);
    expect(mockSendNotice).not.toHaveBeenCalled();
  });

  it('says to finish the Billing step when the database reports it pending', async () => {
    sessionRpc.mockResolvedValueOnce({ data: { success: false, error: 'billing_setup_incomplete' }, error: null });
    const r = await startCapture({ claimId: CLAIM, userIds: [U1] });
    expect(r).toEqual({ success: false, message: DOMAIN_CAPTURE_BILLING_SETUP });
    expect(mockSendNotice).not.toHaveBeenCalled();
  });

  it('sends nothing when the database refuses', async () => {
    sessionRpc.mockResolvedValueOnce({ data: { success: false, error: 'claim_not_verified' }, error: null });
    const r = await startCapture({ claimId: CLAIM, userIds: [U1] });
    expect(r.success).toBe(false);
    expect(mockSendNotice).not.toHaveBeenCalled();
  });
});

describe('cancelCapture', () => {
  it('runs on the session client', async () => {
    const r = await cancelCapture(S1);
    expect(r.success).toBe(true);
    expect(sessionRpc).toHaveBeenCalledWith('domain_capture_cancel', { p_switch: S1 });
    expect(mockServiceRpc).not.toHaveBeenCalled();
  });
});

describe('optOutSelf', () => {
  it('changes nothing without confirm', async () => {
    const r = await optOutSelf({ switchId: S1, confirm: false });
    expect(r).toEqual({ success: false, message: DOMAIN_CAPTURE_CONFIRM });
    expect(sessionRpc).not.toHaveBeenCalled();
  });

  it('opts out on the signed-in session client, never the server role', async () => {
    const r = await optOutSelf({ switchId: S1, confirm: true });
    expect(r.success).toBe(true);
    expect(sessionRpc).toHaveBeenCalledWith('domain_capture_opt_out_self', { p_switch: S1 });
    expect(mockServiceRpc).not.toHaveBeenCalled();
  });

  it('refuses a signed-out caller', async () => {
    mockSessionClient.mockResolvedValue({ auth: { getUser: async () => ({ data: { user: null } }) }, rpc: sessionRpc });
    const r = await optOutSelf({ switchId: S1, confirm: true });
    expect(r.success).toBe(false);
    expect(sessionRpc).not.toHaveBeenCalled();
  });
});
