/**
 * @jest-environment node
 *
 * BACKLOG-3932 — the "Payment failed" email (founder copy option B, pm_comments 0486b6aa) and its
 * send wrapper: the pay link is a bearer link, so it may appear in the email body only, never in
 * the delivery-log metadata.
 */

const mockSendEmail = jest.fn();
jest.mock('@/lib/email/send-email', () => ({ sendEmail: (...a: unknown[]) => mockSendEmail(...a) }));

import { sendPaymentFailedEmail } from '@/lib/email';
import { buildPaymentFailedEmail } from '@/lib/email/templates/payment-failed';

const PAY = 'https://invoice.stripe.test/REDACTED/in_3932_email';
const params = {
  recipientEmail: 'billing-3932@example.test',
  brokerageName: 'Brokerage 3932 & Co',
  amountLabel: '$74.97',
  payUrl: PAY,
  outboxKey: 'notify_payment_failed:test:ORG-3932:in_3932_email:py_3932',
  organizationId: 'ORG-3932',
};

beforeEach(() => {
  mockSendEmail.mockReset();
  mockSendEmail.mockResolvedValue({ success: true, outcome: 'sent' });
});

describe('payment-failed email', () => {
  it('E1: subject, the three founder lines and the Pay invoice link, exact', () => {
    const e = buildPaymentFailedEmail(params);
    expect(e.subject).toBe('Payment failed for Brokerage 3932 & Co');
    expect(e.text).toBe(
      [
        'Payment failed for Brokerage 3932 & Co',
        '',
        "Your $74.97 payment for Brokerage 3932 & Co's Keepr subscription didn't go through.",
        '',
        'Please pay the invoice with the button below, or change your payment method under Manage billing on the Keepr Billing page.',
        '',
        `Pay invoice: ${PAY}`,
        '',
        'Your members keep their access. Questions? Reply to this email or contact your Keepr account manager.',
      ].join('\n')
    );
    expect(e.html).toContain('Brokerage 3932 &amp; Co');
    expect(e.html).toContain(`href="${PAY}"`);
  });

  it('E2: the send logs kind org_payment_failed with the outbox key, and no pay link anywhere in logMetadata', async () => {
    await sendPaymentFailedEmail(params);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const opts = mockSendEmail.mock.calls[0][0];
    expect(opts).toMatchObject({ to: params.recipientEmail, emailType: 'other' });
    expect(opts.logMetadata).toEqual({ kind: 'org_payment_failed', outboxKey: params.outboxKey, organizationId: 'ORG-3932' });
    expect(JSON.stringify(opts.logMetadata)).not.toContain('stripe.test');
  });
});
