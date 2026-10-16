/**
 * API route: email a brokerage's IT admins that a SCIM write was refused because every
 * license is in use (BACKLOG-3851 PR-2c).
 *
 * Server callers only: the scim Edge Function, with `x-api-secret` = INTERNAL_API_SECRET.
 * It reads the recipients and counts from the database and sends
 * `{ recipients, personLabel, brokerageName, used, maxSeats, kind }`.
 * There is no session path.
 */

import * as Sentry from '@sentry/nextjs';
import { NextRequest, NextResponse } from 'next/server';
import { sendSeatLimitReachedEmail } from '@/lib/email';

const MAX_RECIPIENTS = 20;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: NextRequest) {
  try {
    const expected = process.env.INTERNAL_API_SECRET;
    const presented = request.headers.get('x-api-secret');
    if (!expected || presented !== expected) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const recipients = body?.recipients;
    const personLabel = body?.personLabel;
    const brokerageName = body?.brokerageName;
    const used = body?.used;
    const maxSeats = body?.maxSeats;
    const kind = body?.kind;

    if (
      !Array.isArray(recipients) || recipients.length === 0 || recipients.length > MAX_RECIPIENTS ||
      !recipients.every((r) => typeof r === 'string' && EMAIL_RE.test(r)) ||
      typeof personLabel !== 'string' || !personLabel ||
      typeof brokerageName !== 'string' || !brokerageName ||
      typeof used !== 'number' ||
      !(maxSeats === null || typeof maxSeats === 'number') ||
      (kind !== 'add' && kind !== 'reactivate')
    ) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    let sent = 0;
    for (const to of recipients as string[]) {
      const result = await sendSeatLimitReachedEmail({
        recipientEmail: to,
        personLabel,
        brokerageName,
        used,
        maxSeats: maxSeats as number | null,
        kind,
      });
      if (result.success) sent++;
      else {
        Sentry.captureMessage('Seat-limit email failed', { level: 'warning', extra: { error: result.error } });
      }
    }

    return NextResponse.json({ success: sent === recipients.length, sent });
  } catch (err) {
    Sentry.captureException(err, { tags: { route: 'email/seat-limit-reached' } });
    console.error('[SeatLimitReached] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
