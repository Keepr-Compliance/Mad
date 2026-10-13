/**
 * Cron: Storage Size Check
 *
 * Runs daily via Vercel Cron. Queries Supabase storage usage
 * and sends a Teams alert if total exceeds the threshold.
 *
 * GET /api/cron/storage-check
 */

import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { isAuthorizedCronRequest } from '@/lib/auth/cronAuth';

const STORAGE_THRESHOLD_MB = 750;
const TEAMS_WEBHOOK_URL = process.env.TEAMS_STORAGE_ALERT_WEBHOOK_URL;

export async function GET(request: Request) {
  // Verify cron secret; refuses every request when CRON_SECRET is unset.
  if (!isAuthorizedCronRequest(request.headers.get('authorization'))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const supabase = createServiceClient();

    // Query storage usage per org
    const { data, error } = await supabase.rpc('get_storage_usage');

    if (error) {
      console.error('[storage-check] RPC error, falling back to direct query:', error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const totalBytes = data.reduce(
      (sum: number, row: { total_bytes: number }) => sum + row.total_bytes,
      0
    );
    const totalMB = totalBytes / (1024 * 1024);

    const result = {
      totalMB: Math.round(totalMB * 100) / 100,
      thresholdMB: STORAGE_THRESHOLD_MB,
      exceeded: totalMB > STORAGE_THRESHOLD_MB,
      orgs: data,
      checkedAt: new Date().toISOString(),
    };

    // Send Teams alert if threshold exceeded
    if (result.exceeded && TEAMS_WEBHOOK_URL) {
      const orgDetails = data
        .filter((row: { total_bytes: number }) => row.total_bytes > 0)
        .map(
          (row: { org_name: string; file_count: number; total_mb: number }) =>
            `- **${row.org_name}**: ${row.file_count} files, ${row.total_mb} MB`
        )
        .join('\n');

      await fetch(TEAMS_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'message',
          attachments: [
            {
              contentType: 'application/vnd.microsoft.card.adaptive',
              contentUrl: null,
              content: {
                $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
                type: 'AdaptiveCard',
                version: '1.4',
                body: [
                  {
                    type: 'TextBlock',
                    size: 'Medium',
                    weight: 'Bolder',
                    text: 'Supabase Storage Alert',
                    style: 'heading',
                  },
                  {
                    type: 'TextBlock',
                    text: `Storage usage has exceeded **${STORAGE_THRESHOLD_MB} MB**.`,
                    wrap: true,
                  },
                  {
                    type: 'FactSet',
                    facts: [
                      { title: 'Current Usage', value: `${result.totalMB.toFixed(0)} MB` },
                      { title: 'Threshold', value: `${STORAGE_THRESHOLD_MB} MB` },
                      { title: 'Free Tier Limit', value: '1,000 MB' },
                    ],
                  },
                  {
                    type: 'TextBlock',
                    text: 'Breakdown by Organization:',
                    weight: 'Bolder',
                    spacing: 'Medium',
                  },
                  {
                    type: 'TextBlock',
                    text: orgDetails,
                    wrap: true,
                    fontType: 'Default',
                    size: 'Small',
                  },
                ],
                actions: [
                  {
                    type: 'Action.OpenUrl',
                    title: 'Open Supabase Dashboard',
                    url: 'https://supabase.com/dashboard/project/nercleijfrxqcvfjskbc/storage/buckets',
                  },
                ],
              },
            },
          ],
        }),
      });

      console.log(`[storage-check] Alert sent: ${result.totalMB.toFixed(0)} MB exceeds ${STORAGE_THRESHOLD_MB} MB`);
    } else {
      console.log(`[storage-check] OK: ${result.totalMB.toFixed(0)} MB (threshold: ${STORAGE_THRESHOLD_MB} MB)`);
    }

    return NextResponse.json(result);
  } catch (err) {
    console.error('[storage-check] Error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
