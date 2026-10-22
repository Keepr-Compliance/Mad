/**
 * API route: email Keepr support and the brokerage's IT contact that the brokerage's last
 * active admin was kept (BACKLOG-4027, founder decision B).
 *
 * Server callers only: the scim and directory-sync Edge Functions, with `x-api-secret` =
 * INTERNAL_API_SECRET. They send `{ recipients, personLabel, brokerageName, kind, source }`.
 * There is no session path.
 */

import * as Sentry from '@sentry/nextjs';
import { NextRequest, NextResponse } from 'next/server';
import { sendLastAdminKeptEmail } from '@/lib/email';

const MAX_RECIPIENTS = 10;
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
    const kind = body?.kind;
    const source = body?.source;

    if (
      !Array.isArray(recipients) || recipients.length === 0 || recipients.length > MAX_RECIPIENTS ||
      !recipients.every((r) => typeof r === 'string' && EMAIL_RE.test(r)) ||
      typeof personLabel !== 'string' || !personLabel ||
      typeof brokerageName !== 'string' || !brokerageName ||
      (kind !== 'deactivate' && kind !== 'demote') ||
      (source !== 'scim' && source !== 'directory_sync')
    ) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    let sent = 0;
    for (const to of recipients as string[]) {
      const result = await sendLastAdminKeptEmail({ recipientEmail: to, personLabel, brokerageName, kind, source });
      if (result.success) sent++;
      else Sentry.captureMessage('Last-admin email failed', { level: 'warning', extra: { error: result.error } });
    }

    return NextResponse.json({ success: sent === recipients.length, sent });
  } catch (err) {
    Sentry.captureException(err, { tags: { route: 'email/last-admin-kept' } });
    console.error('[LastAdminKept] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
