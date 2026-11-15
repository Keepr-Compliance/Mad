/**
 * @jest-environment node
 */
/**
 * BACKLOG-3962 PR4a T1: setBlockSoloSignups runs on the SESSION client (the database decides on
 * auth.uid()), never the server role, validates its input, and maps the function's replies
 * (transcribed from domain_claim_set_block_solo's RETURN lines: success, not_verified, not_found).
 */

const mockBlock = jest.fn();
const mockAccess = jest.fn();
const mockCreateServiceClient = jest.fn();
jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn() }));
jest.mock('@/lib/impersonation-guards', () => ({ blockWriteDuringImpersonation: () => mockBlock() }));
jest.mock('@/lib/domain/access', () => ({ requireDomainClaimAccess: () => mockAccess() }));
jest.mock('@/lib/supabase/service', () => ({ createServiceClient: (o: unknown) => mockCreateServiceClient(o) }));

import { setBlockSoloSignups } from '@/lib/actions/domainClaim';
import {
  BLOCK_SOLO_NOT_VERIFIED,
  BLOCK_SOLO_OFF_MESSAGE,
  BLOCK_SOLO_ON_MESSAGE,
  DOMAIN_CLAIM_NOT_AUTHORIZED,
  DOMAIN_CLAIM_NOT_FOUND,
} from '@/lib/domain/claims';

const CLAIM = '00000000-0000-4000-8000-0000000000c1'; // pii-allow-uuid: invented fixture id
let rpc: jest.Mock;

function given(reply: unknown, ok = true): void {
  rpc = jest.fn().mockResolvedValue({ data: reply, error: null });
  mockAccess.mockResolvedValue(ok ? { ok: true, supabase: { rpc }, organizationId: 'org', userId: 'u' } : { ok: false });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockBlock.mockResolvedValue(null);
});

it.each([
  [true, BLOCK_SOLO_ON_MESSAGE],
  [false, BLOCK_SOLO_OFF_MESSAGE],
])('on=%s -> session-client rpc with the claim and flag', async (on, message) => {
  given({ success: true, claim_id: CLAIM, block_solo_signups: on });
  expect(await setBlockSoloSignups(CLAIM, on)).toEqual({ success: true, message, status: 'verified' });
  expect(rpc).toHaveBeenCalledWith('domain_claim_set_block_solo', { p_claim: CLAIM, p_on: on });
  expect(mockCreateServiceClient).not.toHaveBeenCalled();
});

it('not_verified -> its own message', async () => {
  given({ success: false, error: 'not_verified' });
  expect(await setBlockSoloSignups(CLAIM, true)).toEqual({ success: false, message: BLOCK_SOLO_NOT_VERIFIED });
});

it('not_found -> not found', async () => {
  given({ success: false, error: 'not_found' });
  expect((await setBlockSoloSignups(CLAIM, true)).message).toBe(DOMAIN_CLAIM_NOT_FOUND);
});

it.each([
  ['not-a-uuid', true],
  [CLAIM, 'yes' as unknown as boolean],
])('bad input %s / %s -> refused before any call', async (id, on) => {
  given({ success: true });
  expect((await setBlockSoloSignups(id, on)).message).toBe(DOMAIN_CLAIM_NOT_FOUND);
  expect(rpc).not.toHaveBeenCalled();
});

it('not an admin -> not authorized, no call', async () => {
  given({ success: true }, false);
  expect((await setBlockSoloSignups(CLAIM, true)).message).toBe(DOMAIN_CLAIM_NOT_AUTHORIZED);
  expect(rpc).not.toHaveBeenCalled();
});

it('support session -> refused', async () => {
  given({ success: true });
  mockBlock.mockResolvedValue({ error: 'read only' });
  expect(await setBlockSoloSignups(CLAIM, true)).toEqual({ success: false, message: 'read only' });
  expect(rpc).not.toHaveBeenCalled();
});
