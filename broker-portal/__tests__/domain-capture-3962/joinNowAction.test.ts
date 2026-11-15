/**
 * @jest-environment node
 */
/**
 * BACKLOG-3962 "Join now": the joinNowSelf server action (lib/actions/domainCapture.ts) and its
 * code-to-words map (joinNowErrorMessage). runCaptureJoinNow is mocked; its own tests are in
 * captureJoinNow.test.ts.
 */

const mockBlock = jest.fn();
const mockSessionClient = jest.fn();
const mockRun = jest.fn();
const mockCreateService = jest.fn((opts?: unknown) => ({ opts }));

jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn() }));
jest.mock('@/lib/impersonation-guards', () => ({ blockWriteDuringImpersonation: () => mockBlock() }));
jest.mock('@/lib/domain/access', () => ({ requireDomainClaimAccess: jest.fn() }));
jest.mock('@/lib/supabase/service', () => ({ createServiceClient: (o?: unknown) => mockCreateService(o) }));
jest.mock('@/lib/supabase/server', () => ({ createClient: () => mockSessionClient() }));
jest.mock('@/lib/email', () => ({ sendDomainCaptureNoticeEmail: jest.fn() }));
jest.mock('@/lib/domain/captureJoinNow', () => ({ runCaptureJoinNow: (...a: unknown[]) => mockRun(...a) }));

import {
  DOMAIN_CAPTURE_FAILED,
  DOMAIN_CAPTURE_JOIN_CONFIRM,
  DOMAIN_CAPTURE_JOIN_SIGNED_OUT,
  DOMAIN_CAPTURE_NOT_FOUND,
  DOMAIN_CAPTURE_UNAVAILABLE,
  joinNowErrorMessage,
} from '@/lib/domain/captureMessages';
import { joinNowSelf } from '@/lib/actions/domainCapture';

const ME = '00000000-0000-4000-8000-000000000101'; // pii-allow-uuid: invented fixture id
const OTHER = '00000000-0000-4000-8000-0000000000ee'; // pii-allow-uuid: invented fixture id
const S1 = '00000000-0000-4000-8000-000000000501'; // pii-allow-uuid: invented fixture id

beforeEach(() => {
  jest.clearAllMocks();
  mockBlock.mockResolvedValue(null);
  mockSessionClient.mockResolvedValue({ auth: { getUser: async () => ({ data: { user: { id: ME } } }) }, rpc: jest.fn() });
  mockRun.mockResolvedValue({ status: 'switched', brokerageName: 'A Brokerage', licensed: true });
});

describe('joinNowSelf', () => {
  it('changes nothing without confirm', async () => {
    const r = await joinNowSelf({ switchId: S1, confirm: false });
    expect(r).toEqual({ success: false, message: DOMAIN_CAPTURE_JOIN_CONFIRM });
    expect(mockRun).not.toHaveBeenCalled();
    expect(mockCreateService).not.toHaveBeenCalled();
  });

  it('joins as the session user; a posted user id is never read', async () => {
    const r = await joinNowSelf({ switchId: S1, confirm: true, userId: OTHER } as unknown as { switchId: string; confirm: boolean });
    expect(r).toEqual({ success: true, joined: true, licensed: true, brokerageName: 'A Brokerage', message: 'Your account is now part of A Brokerage.' });
    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(mockRun.mock.calls[0][1]).toBe(ME);
    expect(mockRun.mock.calls[0][2]).toBe(S1);
    expect(mockCreateService).toHaveBeenCalledWith({ actorId: ME });
  });

  it('refuses during impersonation and calls nothing', async () => {
    mockBlock.mockResolvedValue({ error: 'Read-only while impersonating.' });
    const r = await joinNowSelf({ switchId: S1, confirm: true });
    expect(r).toEqual({ success: false, message: 'Read-only while impersonating.' });
    expect(mockRun).not.toHaveBeenCalled();
    expect(mockSessionClient).not.toHaveBeenCalled();
  });

  it('refuses a signed-out caller', async () => {
    mockSessionClient.mockResolvedValue({ auth: { getUser: async () => ({ data: { user: null } }) } });
    const r = await joinNowSelf({ switchId: S1, confirm: true });
    expect(r).toEqual({ success: false, message: DOMAIN_CAPTURE_JOIN_SIGNED_OUT });
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('a malformed switch id is not found and calls nothing', async () => {
    const r = await joinNowSelf({ switchId: 'nope', confirm: true });
    expect(r).toEqual({ success: false, message: DOMAIN_CAPTURE_NOT_FOUND });
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('passes on an unlicensed join', async () => {
    mockRun.mockResolvedValue({ status: 'switched', brokerageName: 'A Brokerage', licensed: false });
    const r = await joinNowSelf({ switchId: S1, confirm: true });
    expect(r).toMatchObject({ success: true, joined: true, licensed: false });
  });

  it('a deferral reports the scheduled date, in words', async () => {
    mockRun.mockResolvedValue({ status: 'error', code: 'billing_not_ready', brokerageName: 'A Brokerage', switchAt: '2026-11-24T10:00:00Z' });
    const r = await joinNowSelf({ switchId: S1, confirm: true });
    expect(r).toEqual({ success: false, message: "Joining early isn't available yet. Nothing changed. Your move is still set for Nov 24, 2026." });
  });

  it('a thrown error reads as a failure', async () => {
    mockRun.mockRejectedValue(new Error('boom'));
    const r = await joinNowSelf({ switchId: S1, confirm: true });
    expect(r).toEqual({ success: false, message: DOMAIN_CAPTURE_FAILED });
  });
});

describe('joinNowErrorMessage', () => {
  it.each([
    ['dns_not_fresh', undefined, "Keepr couldn't confirm A Brokerage's domain just now. Nothing changed. Try again in a few minutes."],
    ['billing_not_ready', undefined, "Joining early isn't available yet. Nothing changed. Your move is still set for Nov 24, 2026."],
    ['billing_setup_incomplete', undefined, "A Brokerage hasn't finished setting up billing, so you can't join yet. Nothing changed."],
    ['not_scheduled', 'opted_out', 'You chose to keep your personal account.'],
    ['not_scheduled', 'cancelled', 'This move was cancelled. Your account stays personal.'],
    ['not_scheduled', 'switched', 'Your account is already part of A Brokerage.'],
    ['cancelled', undefined, 'This move can no longer happen, so your account stays personal.'],
    ['switch_not_found', undefined, DOMAIN_CAPTURE_NOT_FOUND],
    ['unavailable', undefined, DOMAIN_CAPTURE_UNAVAILABLE],
    ['failed', undefined, DOMAIN_CAPTURE_FAILED],
    ['something_new', undefined, DOMAIN_CAPTURE_FAILED],
  ])('%s (%s)', (code, status, want) => {
    expect(joinNowErrorMessage(code, 'A Brokerage', 'Nov 24, 2026', status)).toBe(want);
  });
});
