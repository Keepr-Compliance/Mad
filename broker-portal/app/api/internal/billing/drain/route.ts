/**
 * Billing outbox drain endpoint (BACKLOG-3849).
 *
 * Called once a minute by a database cron job (`billing_drain_invoke`, pg_net)
 * with the `x-billing-drain-secret` header. Order of checks:
 *   1. header is 64 lowercase hex characters, else 401 (no database call);
 *   2. billing off (BILLING_ENABLED) -> 200 {disabled:true}, nothing else runs;
 *   3. Stripe mode from this deployment's key (never from the request);
 *      unknown key -> 500, nothing claimed;
 *   4. expected secret from `billing_drain_secret()`; RPC error or no value -> 401;
 *   5. constant-time compare of SHA-256 digests -> 401 on mismatch;
 *   6. drain. Row failures live on the rows; the answer is 200 unless the claim fails.
 * Request headers are never logged or echoed.
 */

import { createHash, timingSafeEqual } from 'crypto';
import { NextResponse } from 'next/server';
import { billingEnabled } from '@/lib/billing/flag';
import { currentStripeMode, type StripeMode } from '@/lib/billing/mode';
import { createDrainStripe, drainOnce, OutboxClaimError } from '@/lib/billing/outbox';
import { OUTBOX_HANDLERS } from '@/lib/billing/outboxKinds';
import { createServiceClient } from '@/lib/supabase/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const SECRET_HEADER = 'x-billing-drain-secret';
const SECRET_SHAPE = /^[0-9a-f]{64}$/;

function unauthorized(): Response {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export async function POST(req: Request): Promise<Response> {
  const presented = req.headers.get(SECRET_HEADER);
  if (!presented || !SECRET_SHAPE.test(presented)) return unauthorized();

  if (!billingEnabled()) {
    return NextResponse.json({ disabled: true });
  }

  let mode: StripeMode;
  try {
    mode = currentStripeMode();
  } catch {
    console.error('[billing/drain] Stripe key missing or of unknown mode; nothing claimed');
    return NextResponse.json({ error: 'not configured' }, { status: 500 });
  }

  const service = createServiceClient();
  const { data: expected, error: secretError } = await service.rpc('billing_drain_secret');
  if (secretError || typeof expected !== 'string' || expected.length === 0) {
    if (secretError) console.error(`[billing/drain] secret lookup failed: ${secretError.code ?? 'unknown'}`);
    return unauthorized();
  }
  if (!timingSafeEqual(digest(presented), digest(expected))) return unauthorized();

  try {
    const result = await drainOnce({
      service,
      stripe: createDrainStripe(),
      mode,
      handlers: OUTBOX_HANDLERS,
    });
    return NextResponse.json({ mode, ...result });
  } catch (err) {
    const code = err instanceof OutboxClaimError ? err.code : 'drain_failed';
    console.error(`[billing/drain] ${mode} run failed: ${code}`);
    return NextResponse.json({ error: 'drain failed' }, { status: 500 });
  }
}
