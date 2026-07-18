/**
 * Transactional email retry drain (BACKLOG-2009).
 *
 * Vercel Cron hits this route on a schedule (see broker-portal/vercel.json). It
 * drains due rows from email_delivery_queue — sends that a transient Graph
 * failure (429/5xx/network) left undelivered after in-request retries — re-sends
 * them, applies exponential backoff per attempt, and dead-letters at
 * max_attempts.
 *
 * Auth: CRON_SECRET bearer (same pattern as /api/cron/payment-reconcile).
 */

import { NextResponse } from 'next/server';
import { drainEmailQueue } from '@/lib/email/queue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const result = await drainEmailQueue();
  return NextResponse.json(result);
}
