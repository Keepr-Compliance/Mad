/**
 * Daily domain claim re-check (BACKLOG-3962 PR2).
 *
 * Vercel Cron hits this route once a day (see broker-portal/vercel.json). It takes up to
 * BATCH_LIMIT verified and lapsed claims from _domain_claims_due_for_recheck (which selects and
 * stamps them in one statement), reads each claim's `_keepr.<domain>` TXT record over DNS-over-HTTPS,
 * and records the answer with _domain_claim_record_check, p_source 'recheck', for the claim's own
 * organization as returned by the due query.
 *
 * _domain_claim_begin_check is NOT called: the due query already stamped last_checked_at, so it
 * would answer too_soon. The miss counting (spaced misses, lapse on the third) lives in the database.
 *
 * Auth: CRON_SECRET bearer via lib/auth/cronAuth (refuses when CRON_SECRET is unset).
 */

import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { isAuthorizedCronRequest } from '@/lib/auth/cronAuth';
import { lookupClaimTxt } from '@/lib/domain/doh';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const BATCH_LIMIT = 50;
const CONCURRENCY = 5;

interface DueRow {
  claim_id: string;
  organization_id: string;
  domain: string;
}

function isDueRow(v: unknown): v is DueRow {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return typeof r.claim_id === 'string' && typeof r.organization_id === 'string' && typeof r.domain === 'string';
}

interface RecheckSummary {
  due: number;
  recorded: number;
  failed: number;
  results: Record<string, number>;
}

export async function GET(req: Request): Promise<Response> {
  if (!isAuthorizedCronRequest(req.headers.get('authorization'))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const service = createServiceClient();
  const { data, error } = await service.rpc('_domain_claims_due_for_recheck', { p_limit: BATCH_LIMIT });
  if (error) {
    console.error('[cron/domain-recheck] due query failed:', error.message);
    return NextResponse.json({ error: 'due query failed' }, { status: 500 });
  }
  const rows = (Array.isArray(data) ? data : []).filter(isDueRow);

  const summary: RecheckSummary = { due: rows.length, recorded: 0, failed: 0, results: {} };

  const checkOne = async (row: DueRow): Promise<void> => {
    try {
      const lookup = await lookupClaimTxt(row.domain);
      const recorded = await service.rpc('_domain_claim_record_check', {
        p_claim: row.claim_id,
        p_org: row.organization_id,
        p_answers: lookup.answers,
        p_resolver_ok: lookup.resolverOk,
        p_source: 'recheck',
      });
      const reply = (recorded.data ?? {}) as { success?: unknown; result?: unknown };
      if (recorded.error || reply.success !== true) {
        summary.failed += 1;
        console.error('[cron/domain-recheck] record_check failed:', recorded.error?.message ?? 'not recorded');
        return;
      }
      summary.recorded += 1;
      const result = typeof reply.result === 'string' ? reply.result : 'unknown';
      summary.results[result] = (summary.results[result] ?? 0) + 1;
    } catch (e) {
      summary.failed += 1;
      console.error('[cron/domain-recheck] check threw:', e instanceof Error ? e.message : 'unknown');
    }
  };

  // Bounded concurrency: CONCURRENCY workers drain one shared queue.
  const queue = [...rows];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (let row = queue.shift(); row; row = queue.shift()) {
      await checkOne(row);
    }
  });
  await Promise.all(workers);

  return NextResponse.json(summary);
}
