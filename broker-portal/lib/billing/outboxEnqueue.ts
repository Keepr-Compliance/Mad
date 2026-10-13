/**
 * Add one row to billing_outbox — BACKLOG-3848 (the first producers).
 *
 * The row is unique on dedupe_key (UNIQUE billing_outbox_dedupe_key_key), so a
 * second enqueue for the same work is a no-op: the 23505 naming that
 * constraint answers 'exists'. Any other error throws (a webhook caller then
 * returns 500 and Stripe redelivers). user_id is required: the table's
 * billing_outbox_subject_ck wants a user or an organization, and the mode
 * trigger (_guard_stripe_mode_is_test) checks the user's personal organization.
 */

import type { createServiceClient } from '@/lib/supabase/service';
import type { StripeMode } from './mode';

type ServiceClient = ReturnType<typeof createServiceClient>;

export const OUTBOX_DEDUPE_CONSTRAINT = 'billing_outbox_dedupe_key_key';

export interface OutboxEnqueue {
  mode: StripeMode;
  kind: string;
  userId: string;
  dedupeKey: string;
  payload: Record<string, unknown>;
  runAfter: Date;
}

export async function enqueueOutbox(service: ServiceClient, job: OutboxEnqueue): Promise<'enqueued' | 'exists'> {
  const { error } = await service.from('billing_outbox').insert({
    stripe_mode: job.mode,
    kind: job.kind,
    user_id: job.userId,
    dedupe_key: job.dedupeKey,
    payload: job.payload,
    run_after: job.runAfter.toISOString(),
  });
  if (!error) return 'enqueued';
  if (error.code === '23505' && `${error.message ?? ''} ${(error as { details?: string }).details ?? ''}`.includes(OUTBOX_DEDUPE_CONSTRAINT)) {
    return 'exists';
  }
  throw new Error(`billing_outbox insert failed: ${error.code ?? 'unknown'}`);
}
