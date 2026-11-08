/**
 * @jest-environment node
 *
 * BACKLOG-4209 — the two "Your Keepr account is active again" emails (staff and automatic), text
 * exactly as the founder approved it (pm_comments on 4209), with each billing line and the
 * line-less variant for a missing or canceled subscription (founder ruling on SR D1).
 */

import { buildOrgReinstatedEmail, orgReinstatedLines } from '@/lib/email/templates/org-reinstated';
import { buildOrgAutoReinstatedEmail, orgAutoReinstatedLines } from '@/lib/email/templates/org-auto-reinstated';
import type { BillingLine } from '@/lib/email/types';

const base = {
  recipientEmail: 'billing-4209@example.test',
  brokerageName: 'Brokerage 4209 & Co',
  outboxKey: 'notify_org_reinstated:test:ORG-4209:1794081916',
  organizationId: 'ORG-4209',
};
const RENEWS: BillingLine = { kind: 'renews' };
const ENDS: BillingLine = { kind: 'ends', endsOn: 'Nov 27, 2026' };
const ENDS_UNKNOWN: BillingLine = { kind: 'ends', endsOn: null };
const NONE: BillingLine = { kind: 'none' };

describe('org-reinstated (staff)', () => {
  it('S1: subject and lines, auto-renew on', () => {
    const e = buildOrgReinstatedEmail({ ...base, billing: RENEWS });
    expect(e.subject).toBe('Your Keepr account for Brokerage 4209 & Co is active again');
    expect(orgReinstatedLines({ ...base, billing: RENEWS })).toEqual([
      'As you requested, Keepr reinstated the account for Brokerage 4209 & Co. Members have full access again.',
      'Your plan renews each month and is billed as before.',
      'If you did not ask for this, contact your Keepr account manager.',
    ]);
    expect(e.text).toBe(
      [
        'Your Keepr account for Brokerage 4209 & Co is active again',
        '',
        'As you requested, Keepr reinstated the account for Brokerage 4209 & Co. Members have full access again.',
        '',
        'Your plan renews each month and is billed as before.',
        '',
        'If you did not ask for this, contact your Keepr account manager.',
        '',
      ].join('\n'),
    );
  });

  it('S2: auto-renew off, with a date and with the fallback', () => {
    expect(orgReinstatedLines({ ...base, billing: ENDS })[1]).toBe('Auto-renew is off. Your plan ends on Nov 27, 2026.');
    expect(orgReinstatedLines({ ...base, billing: ENDS_UNKNOWN })[1]).toBe('Auto-renew is off. Your plan ends at the end of the billing period.');
  });

  it('S3: no live subscription -> two lines, no billing line', () => {
    expect(orgReinstatedLines({ ...base, billing: NONE })).toEqual([
      'As you requested, Keepr reinstated the account for Brokerage 4209 & Co. Members have full access again.',
      'If you did not ask for this, contact your Keepr account manager.',
    ]);
  });

  it('S4: the brokerage name is escaped in the HTML', () => {
    const e = buildOrgReinstatedEmail({ ...base, billing: RENEWS });
    expect(e.html).toContain('Brokerage 4209 &amp; Co');
    expect(e.html).not.toContain('Brokerage 4209 & Co');
  });
});

describe('org-auto-reinstated (automatic, after a payment)', () => {
  it('U1: same subject; lines, auto-renew on', () => {
    const e = buildOrgAutoReinstatedEmail({ ...base, billing: RENEWS });
    expect(e.subject).toBe('Your Keepr account for Brokerage 4209 & Co is active again');
    expect(orgAutoReinstatedLines({ ...base, billing: RENEWS })).toEqual([
      'We received your payment, so Keepr turned the account for Brokerage 4209 & Co back on automatically. Members have full access again.',
      'Your plan renews each month and is billed as before.',
      'If you have questions, contact your Keepr account manager.',
    ]);
  });

  it('U2: auto-renew off with a date; no live subscription drops the line', () => {
    expect(orgAutoReinstatedLines({ ...base, billing: ENDS })[1]).toBe('Auto-renew is off. Your plan ends on Nov 27, 2026.');
    expect(orgAutoReinstatedLines({ ...base, billing: NONE })).toEqual([
      'We received your payment, so Keepr turned the account for Brokerage 4209 & Co back on automatically. Members have full access again.',
      'If you have questions, contact your Keepr account manager.',
    ]);
  });
});
