/**
 * Hourly domain capture switch (BACKLOG-3962 PR3a).
 *
 * Vercel Cron hits this route every hour (see broker-portal/vercel.json). It moves the people whose
 * 14-day domain capture notice has run out into the brokerage; lib/domain/captureSwitch.ts has the
 * steps. Every decision is re-made in the database (_domain_capture_switch).
 *
 * Auth: CRON_SECRET bearer via lib/auth/cronAuth (refuses when CRON_SECRET is unset).
 */

import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { isAuthorizedCronRequest } from '@/lib/auth/cronAuth';
import { runCaptureSwitch } from '@/lib/domain/captureSwitch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(req: Request): Promise<Response> {
  if (!isAuthorizedCronRequest(req.headers.get('authorization'))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const summary = await runCaptureSwitch({ service: createServiceClient() });
  if (summary.status === 'error') {
    console.error('[cron/domain-capture-switch] due query failed');
    return NextResponse.json(summary, { status: 500 });
  }
  return NextResponse.json(summary);
}
