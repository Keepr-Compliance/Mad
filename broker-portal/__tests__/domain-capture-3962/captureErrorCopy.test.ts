/**
 * @jest-environment node
 */
/**
 * BACKLOG-3962 PR3b: every error the capture functions can return reaches the screen as plain
 * copy. Codes transcribed from supabase/migrations/20261112113000_backlog_3962_domain_capture.sql
 * (domain_capture_start / _cancel / _opt_out_self) and every reason _domain_capture_eval returns.
 */

const mockBlock = jest.fn();
const mockAccess = jest.fn();
const mockSessionClient = jest.fn();

jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn() }));
jest.mock('@/lib/impersonation-guards', () => ({ blockWriteDuringImpersonation: () => mockBlock() }));
jest.mock('@/lib/domain/access', () => ({ requireDomainClaimAccess: () => mockAccess() }));
jest.mock('@/lib/supabase/service', () => ({ createServiceClient: () => ({ rpc: jest.fn() }) }));
jest.mock('@/lib/supabase/server', () => ({ createClient: () => mockSessionClient() }));
jest.mock('@/lib/email', () => ({ sendDomainCaptureNoticeEmail: jest.fn() }));

import * as M from '@/lib/domain/captureMessages';
import { cancelCapture, optOutSelf, startCapture } from '@/lib/actions/domainCapture';
import { CAPTURE_REASON_COPY, CAPTURE_REASON_FALLBACK, captureReasonCopy } from '@/lib/domain/captureCopy';

const ORG = '00000000-0000-4000-8000-00000000000a'; // pii-allow-uuid: invented fixture id
const CLAIM = '00000000-0000-4000-8000-0000000000c1'; // pii-allow-uuid: invented fixture id
const U1 = '00000000-0000-4000-8000-000000000101'; // pii-allow-uuid: invented fixture id
const S1 = '00000000-0000-4000-8000-000000000501'; // pii-allow-uuid: invented fixture id

let rpc: jest.Mock;
beforeEach(() => {
  jest.clearAllMocks();
  mockBlock.mockResolvedValue(null);
  rpc = jest.fn();
  mockAccess.mockResolvedValue({ ok: true, supabase: { rpc }, userId: 'admin-a', organizationId: ORG });
  mockSessionClient.mockResolvedValue({ auth: { getUser: async () => ({ data: { user: { id: U1 } } }) }, rpc });
});

const START_CODES: Array<[string, string]> = [
  ['not_authenticated', M.DOMAIN_CAPTURE_NOT_AUTHORIZED],
  ['not_authorized', M.DOMAIN_CAPTURE_NOT_AUTHORIZED],
  ['claim_not_found', M.DOMAIN_CAPTURE_NOT_VERIFIED],
  ['claim_not_verified', M.DOMAIN_CAPTURE_NOT_VERIFIED],
  ['billing_not_ready', M.DOMAIN_CAPTURE_BILLING_NOT_READY],
  ['billing_setup_incomplete', M.DOMAIN_CAPTURE_BILLING_SETUP],
  ['invalid_selection', M.DOMAIN_CAPTURE_FAILED],
];

describe('startCapture error copy', () => {
  it.each(START_CODES)('%s -> its message', async (code, message) => {
    rpc.mockResolvedValueOnce({ data: { success: false, error: code }, error: null });
    const res = await startCapture({ claimId: CLAIM, userIds: [U1] });
    expect(res).toEqual({ success: false, message });
  });

  it.each(['PGRST202', 'PGRST205', '42883'])('not deployed (%s) -> unavailable', async (code) => {
    rpc.mockResolvedValueOnce({ data: null, error: { code } });
    const res = await startCapture({ claimId: CLAIM, userIds: [U1] });
    expect(res.message).toBe(M.DOMAIN_CAPTURE_UNAVAILABLE);
  });

  it('a caller without domain access gets the admin-only message', async () => {
    mockAccess.mockResolvedValueOnce({ ok: false });
    const res = await startCapture({ claimId: CLAIM, userIds: [U1] });
    expect(res.message).toBe(M.DOMAIN_CAPTURE_NOT_AUTHORIZED);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('cancel / opt-out error copy', () => {
  it.each([
    ['switch_not_found', M.DOMAIN_CAPTURE_NOT_FOUND],
    ['not_scheduled', M.DOMAIN_CAPTURE_NOT_SCHEDULED],
    ['not_authenticated', M.DOMAIN_CAPTURE_NOT_AUTHORIZED],
  ])('cancel %s -> its message', async (code, message) => {
    rpc.mockResolvedValueOnce({ data: { success: false, error: code }, error: null });
    expect((await cancelCapture(S1)).message).toBe(message);
  });

  it.each([
    ['switch_not_found', M.DOMAIN_CAPTURE_NOT_FOUND],
    ['not_scheduled', M.DOMAIN_CAPTURE_NOT_SCHEDULED],
    ['too_late', M.DOMAIN_CAPTURE_TOO_LATE],
  ])('opt out %s -> its message', async (code, message) => {
    rpc.mockResolvedValueOnce({ data: { success: false, error: code }, error: null });
    expect((await optOutSelf({ switchId: S1, confirm: true })).message).toBe(message);
  });
});

describe('reason copy', () => {
  // Every `no:<code>` _domain_capture_eval returns, plus start's already_scheduled.
  const CODES = [
    'no_user', 'email_domain', 'not_personal', 'brokerage_member', 'no_tenant',
    'foreign_tenant', 'no_attestation', 'already_scheduled',
  ];
  it.each(CODES)('%s has its own copy', (code) => {
    expect(CAPTURE_REASON_COPY[code]).toBeTruthy();
    expect(captureReasonCopy(code)).not.toBe(CAPTURE_REASON_FALLBACK);
  });
  it('an unknown code falls back', () => {
    expect(captureReasonCopy('something_new')).toBe(CAPTURE_REASON_FALLBACK);
  });
});

describe('start confirm copy', () => {
  it('singular and plural', () => {
    const { captureStartConfirmText } = jest.requireActual('@/lib/domain/captureCopy');
    expect(captureStartConfirmText(1, 'D')).toBe('This person gets an email today and moves on D. They can opt out until then.');
    expect(captureStartConfirmText(3, 'D')).toBe('These 3 people get an email today and move on D. Each can opt out until then.');
  });
});
