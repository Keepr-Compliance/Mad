/**
 * @jest-environment node
 *
 * BACKLOG-4045 — the "Auto-renew is back on" email, text exactly as the founder approved it.
 * BACKLOG-4200/4209: line 1 now opens "As you requested," (founder ruling on 4200).
 */

import { autoRenewOnLines, buildAutoRenewOnEmail } from '@/lib/email/templates/auto-renew-on';

const params = {
  recipientEmail: 'billing-4045@example.test',
  brokerageName: 'Brokerage 4045 & Co',
  outboxKey: 'notify_auto_renew_on:test:ORG-4045:v3',
  organizationId: 'ORG-4045',
};

describe('auto-renew-on email', () => {
  it('C9: subject and three lines, exact', () => {
    const e = buildAutoRenewOnEmail(params);
    expect(e.subject).toBe('Auto-renew is back on for Brokerage 4045 & Co');
    expect(autoRenewOnLines(params)).toEqual([
      'As you requested, Keepr turned auto-renew back on for Brokerage 4045 & Co.',
      'Your plan renews each month and is billed as before.',
      'If you did not ask for this, contact your Keepr account manager.',
    ]);
    expect(e.text).toBe(
      [
        'Auto-renew is back on for Brokerage 4045 & Co',
        '',
        'As you requested, Keepr turned auto-renew back on for Brokerage 4045 & Co.',
        '',
        'Your plan renews each month and is billed as before.',
        '',
        'If you did not ask for this, contact your Keepr account manager.',
        '',
      ].join('\n'),
    );
  });

  it('C9b: the brokerage name is escaped in the HTML', () => {
    const e = buildAutoRenewOnEmail(params);
    expect(e.html).toContain('Brokerage 4045 &amp; Co');
    expect(e.html).not.toContain('Brokerage 4045 & Co');
  });
});
