/**
 * @jest-environment node
 *
 * BACKLOG-4200 — the "Auto-renew is off" email, text exactly as the founder approved it
 * (pm_comments on 4200 and 4209, "As you requested,").
 */

import { autoRenewOffLines, buildAutoRenewOffEmail } from '@/lib/email/templates/auto-renew-off';

const params = {
  recipientEmail: 'billing-4200@example.test',
  brokerageName: 'Brokerage 4200 & Co',
  endsOn: 'Nov 27, 2026',
  outboxKey: 'notify_auto_renew_off:test:ORG-4200:v2',
  organizationId: 'ORG-4200',
};

describe('auto-renew-off email', () => {
  it('E1: subject and three lines with the end date, exact', () => {
    const e = buildAutoRenewOffEmail(params);
    expect(e.subject).toBe('Auto-renew is off for Brokerage 4200 & Co');
    expect(autoRenewOffLines(params)).toEqual([
      'As you requested, Keepr turned off auto-renew for Brokerage 4200 & Co.',
      'Your plan ends on Nov 27, 2026. Members keep access until then.',
      'If you did not ask for this, contact your Keepr account manager.',
    ]);
    expect(e.text).toBe(
      [
        'Auto-renew is off for Brokerage 4200 & Co',
        '',
        'As you requested, Keepr turned off auto-renew for Brokerage 4200 & Co.',
        '',
        'Your plan ends on Nov 27, 2026. Members keep access until then.',
        '',
        'If you did not ask for this, contact your Keepr account manager.',
        '',
      ].join('\n'),
    );
  });

  it('E2: no end date -> the billing-period wording', () => {
    expect(autoRenewOffLines({ ...params, endsOn: null })[1]).toBe(
      'Your plan ends at the end of the billing period. Members keep access until then.',
    );
  });

  it('E3: the brokerage name is escaped in the HTML', () => {
    const e = buildAutoRenewOffEmail(params);
    expect(e.html).toContain('Brokerage 4200 &amp; Co');
    expect(e.html).not.toContain('Brokerage 4200 & Co');
  });
});
