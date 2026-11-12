/**
 * @jest-environment node
 */
/**
 * BACKLOG-3962 PR3a: capture email copy, the seat alert kind, the SCIM-only HTTP route, the
 * recipient role order.
 */

jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn(), captureException: jest.fn() }));
const mockSeat = jest.fn();
jest.mock('@/lib/email', () => ({ sendSeatLimitReachedEmail: (...a: unknown[]) => mockSeat(...a) }));

import { buildDomainCaptureNoticeEmail } from '@/lib/email/templates/domain-capture-notice';
import { buildDomainCaptureSwitchedEmail } from '@/lib/email/templates/domain-capture-switched';
import { buildSeatLimitReachedEmail } from '@/lib/email/templates/seat-limit-reached';
import { pickSeatRecipientIds, SEAT_EMAIL_ROLE_ORDER } from '@/lib/users/seatRecipients';
import { SEAT_EMAIL_ROLE_ORDER as SCIM_ORDER } from '../../../supabase/functions/scim/shared/seatLimit';
import { PROVISIONING_SOURCE_LABELS } from '@/lib/types/users';
import { POST } from '@/app/api/email/seat-limit-reached/route';

describe('capture emails', () => {
  const JOIN = 'https://portal.example/dashboard?capture=join';
  const KEEP = 'https://portal.example/dashboard?capture=keep';

  it('notice names the date, the account, the trade-off and both portal links', () => {
    const e = buildDomainCaptureNoticeEmail({
      recipientEmail: 'one@a-brokerage.example', brokerageName: 'A Brokerage', domain: 'a-brokerage.example',
      switchAt: '2026-11-24T10:00:00Z', joinUrl: JOIN, keepUrl: KEEP, switchId: 's1',
      payer: true,
    });
    expect(e.subject).toBe('A Brokerage will move your Keepr account on November 24, 2026');
    expect(e.text).toContain('one@a-brokerage.example');
    expect(e.text).toContain('On November 24, 2026, your Keepr account (one@a-brokerage.example) will move into A Brokerage, and any personal Keepr plan on it will end.');
    expect(e.text).toContain('After the move, A Brokerage will manage this account and can end your access to it.');
    expect(e.text).toContain('If you opt out, your account stays separate and stays on your own paid plan.');
    expect(e.text).toContain(`Join now: ${JOIN}`);
    expect(e.text).toContain(`Keep my personal account: ${KEEP}`);
    expect(e.text).toContain('To join now, or to keep your personal account, sign in before November 24, 2026.');
    // two plain links (GET only), join first
    const hrefs = Array.from(e.html.matchAll(/href="([^"]+)"/g)).map((m) => m[1]);
    expect(hrefs.filter((h) => h.includes('capture='))).toEqual([JOIN, KEEP]);
    expect(e.html).toContain('>\n              Join now\n');
    expect(e.html).toContain('>\n              Keep my personal account\n');
  });

  it('notice link values are escaped in the html', () => {
    const e = buildDomainCaptureNoticeEmail({
      recipientEmail: 'one@a-brokerage.example', brokerageName: 'A', domain: 'a.example',
      switchAt: '2026-11-24T10:00:00Z', joinUrl: 'https://p.example/x?a=1&b="2"', keepUrl: KEEP, switchId: 's1',
    });
    expect(e.html).toContain('href="https://p.example/x?a=1&amp;b=&quot;2&quot;"');
  });

  it('notice for a non-payer does not mention a paid plan', () => {
    const base = {
      recipientEmail: 'one@a-brokerage.example', brokerageName: 'A Brokerage', domain: 'a-brokerage.example',
      switchAt: '2026-11-24T10:00:00Z', joinUrl: JOIN, keepUrl: KEEP, switchId: 's1',
    };
    for (const payer of [false, undefined]) {
      const e = buildDomainCaptureNoticeEmail({ ...base, payer });
      expect(e.text).toContain('If you opt out, your account stays separate.');
      expect(e.text).not.toContain('paid plan');
      expect(e.html).not.toContain('paid plan');
    }
    expect(buildDomainCaptureNoticeEmail({ ...base, payer: true }).html).toContain('stays on your own paid plan');
  });

  it('switched email differs for licensed and unlicensed', () => {
    const on = buildDomainCaptureSwitchedEmail({ recipientEmail: 'x@a.example', brokerageName: 'A', licensed: true, switchId: 's' });
    const off = buildDomainCaptureSwitchedEmail({ recipientEmail: 'x@a.example', brokerageName: 'A', licensed: false, switchId: 's' });
    expect(on.text).toContain('gave you a Keepr license');
    expect(off.text).toContain('no free license');
  });

  it('switched email after "Join now" says the person asked for it', () => {
    const early = buildDomainCaptureSwitchedEmail({ recipientEmail: 'x@a.example', brokerageName: 'A', licensed: true, switchId: 's', joinedEarly: true });
    expect(early.text).toContain('moved into A today, as you asked.');
    expect(early.text).not.toContain('14 days ago');
    const due = buildDomainCaptureSwitchedEmail({ recipientEmail: 'x@a.example', brokerageName: 'A', licensed: true, switchId: 's' });
    expect(due.text).toContain('as our earlier notice said.');
    expect(due.text).not.toContain('14 days');
    expect(due.html).toContain('as our earlier notice said.');
    expect(due.html).not.toContain('14 days');
  });

  it('domain_capture seat alert never says the person was not added', () => {
    const e = buildSeatLimitReachedEmail({ recipientEmail: 'it@a.example', personLabel: 'one@a.example', brokerageName: 'A', used: 2, maxSeats: 2, kind: 'domain_capture' });
    expect(e.text).not.toMatch(/did not (add|re-activate)/i);
    expect(e.text).toContain('joined without one');
    expect(e.text).toContain('(2 of 2)');
    const scim = buildSeatLimitReachedEmail({ recipientEmail: 'it@a.example', personLabel: 'p', brokerageName: 'A', used: 2, maxSeats: 2, kind: 'add' });
    expect(scim.text).toContain('Keepr did not add them');
  });
});

describe('seat-limit HTTP route stays SCIM-only', () => {
  it('rejects kind domain_capture', async () => {
    process.env.INTERNAL_API_SECRET = 's3cret';
    const req = new Request('https://x/api/email/seat-limit-reached', {
      method: 'POST',
      headers: { 'x-api-secret': 's3cret', 'content-type': 'application/json' },
      body: JSON.stringify({ recipients: ['it@a.example'], personLabel: 'p', brokerageName: 'A', used: 1, maxSeats: 1, kind: 'domain_capture' }),
    });
    const res = await POST(req as unknown as Parameters<typeof POST>[0]);
    expect(res.status).toBe(400);
    expect(mockSeat).not.toHaveBeenCalled();
  });
});

describe('recipients', () => {
  it('portal role order equals the SCIM order', () => {
    expect([...SEAT_EMAIL_ROLE_ORDER]).toEqual([...SCIM_ORDER]);
  });
  it('first role with an active member wins', () => {
    const rows = [
      { user_id: 'a1', role: 'admin', license_status: 'active', invitation_expires_at: null },
      { user_id: 'i1', role: 'it_admin', license_status: 'suspended', invitation_expires_at: null },
      { user_id: 'b1', role: 'broker', license_status: 'active', invitation_expires_at: null },
    ];
    expect(pickSeatRecipientIds(rows)).toEqual(['a1']);
    expect(pickSeatRecipientIds(rows, ['a1'])).toEqual(['b1']);
  });
  it('labels the new provisioning source', () => {
    expect(PROVISIONING_SOURCE_LABELS.domain_capture).toBe('Domain');
  });
});
