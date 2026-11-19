/**
 * "An AI app was connected" email job (BACKLOG-4263 PR-10.8).
 *
 * Vercel Cron hits this route every 5 minutes (see broker-portal/vercel.json; Vercel runs crons on
 * the production deployment only). lib/aiApps/connectNotices.ts has the steps.
 *
 * Auth: CRON_SECRET bearer via lib/auth/cronAuth (refuses when CRON_SECRET is unset). An
 * unauthorized call makes no database call and sends nothing.
 *
 * Always 200 after the check, with counts only: no address, no id.
 */

import { NextResponse } from 'next/server';
import { isAuthorizedCronRequest } from '@/lib/auth/cronAuth';
import { drainAiAppConnectNotices } from '@/lib/aiApps/connectNotices';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: Request): Promise<Response> {
  if (!isAuthorizedCronRequest(req.headers.get('authorization'))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { claimed, sent, queued, skipped, failed } = await drainAiAppConnectNotices();
  return NextResponse.json({ claimed, sent, queued, skipped, failed });
}
