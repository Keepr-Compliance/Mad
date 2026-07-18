/**
 * @jest-environment node
 *
 * Tests for the receipt email template + fulfillment dispatch (BACKLOG-2009).
 */

/* eslint-disable @typescript-eslint/no-require-imports */

// ---- Template tests (no mocks needed) ------------------------------------

import { buildReceiptEmail } from '../../../lib/email/templates/receipt';

describe('buildReceiptEmail', () => {
  const params = {
    recipientEmail: 'buyer@example.com',
    amountCents: 4999,
    description: 'Transaction audit unlock',
    paymentReference: 'pi_123ABC',
    purchasedAt: '2026-07-17T12:00:00.000Z',
  };

  it('formats the amount as USD in subject + body', () => {
    const result = buildReceiptEmail(params);
    expect(result.subject).toContain('$49.99');
    expect(result.html).toContain('$49.99');
    expect(result.text).toContain('$49.99');
  });

  it('includes the description and payment reference', () => {
    const result = buildReceiptEmail(params);
    expect(result.html).toContain('Transaction audit unlock');
    expect(result.html).toContain('pi_123ABC');
    expect(result.text).toContain('pi_123ABC');
  });

  it('uses a generic description when omitted', () => {
    const { description: _omit, ...rest } = params;
    void _omit;
    const result = buildReceiptEmail(rest);
    expect(result.html).toContain('Transaction audit unlock');
  });

  it('escapes HTML in the description', () => {
    const result = buildReceiptEmail({ ...params, description: '<script>x</script>' });
    expect(result.html).not.toContain('<script>');
    expect(result.html).toContain('&lt;script&gt;');
  });

  it('uses inline CSS only (no style tags)', () => {
    const result = buildReceiptEmail(params);
    expect(result.html).not.toMatch(/<style[\s>]/);
  });
});

// ---- Dispatch tests -------------------------------------------------------

const mockSendReceipt = jest.fn();

jest.mock('../../../lib/email', () => ({
  sendReceiptEmail: (...args: unknown[]) => mockSendReceipt(...args),
}));

import { dispatchReceiptEmail } from '../../../lib/payments/receipt';

function serviceWith(getUserResult: unknown) {
  return {
    auth: { admin: { getUserById: jest.fn().mockResolvedValue(getUserResult) } },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const args = { userId: 'u-1', amountCents: 4999, stripePaymentIntentId: 'pi_9' };

beforeEach(() => jest.clearAllMocks());

describe('dispatchReceiptEmail', () => {
  it('resolves the email and sends the receipt (sent -> true)', async () => {
    mockSendReceipt.mockResolvedValueOnce({ success: true, outcome: 'sent' });
    const service = serviceWith({ data: { user: { email: 'buyer@example.com' } }, error: null });

    const ok = await dispatchReceiptEmail(service, args);

    expect(ok).toBe(true);
    expect(mockSendReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientEmail: 'buyer@example.com',
        amountCents: 4999,
        paymentReference: 'pi_9',
      }),
    );
  });

  it('treats a queued outcome as accepted (true)', async () => {
    mockSendReceipt.mockResolvedValueOnce({ success: false, outcome: 'queued' });
    const service = serviceWith({ data: { user: { email: 'buyer@example.com' } }, error: null });

    expect(await dispatchReceiptEmail(service, args)).toBe(true);
  });

  it('returns false (no send) when the email cannot be resolved', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
    const service = serviceWith({ data: { user: { email: null } }, error: null });

    const ok = await dispatchReceiptEmail(service, args);

    expect(ok).toBe(false);
    expect(mockSendReceipt).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('never throws when the send path errors', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
    mockSendReceipt.mockRejectedValueOnce(new Error('boom'));
    const service = serviceWith({ data: { user: { email: 'buyer@example.com' } }, error: null });

    const ok = await dispatchReceiptEmail(service, args);

    expect(ok).toBe(false);
    consoleSpy.mockRestore();
  });
});
