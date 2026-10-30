/**
 * Add one row to billing_outbox — BACKLOG-3848 (the first producers).
 *
 * The row is unique on dedupe_key (UNIQUE billing_outbox_dedupe_key_key), so a
 * second enqueue for the same work is a no-op: the 23505 naming that
 * constraint answers 'exists'. Any other error throws (a webhook caller then
 * returns 500 and Stripe redelivers). The subject is a user or an organization
 * (billing_outbox_subject_ck wants one of them; BACKLOG-3853 added organization
 * subjects for brokerage work). The mode trigger (_guard_stripe_mode_is_test)
 * checks the organization's is_test, or the user's personal organization.
 */

import type { createServiceClient } from '@/lib/supabase/service';
import type { StripeMode } from './mode';

type ServiceClient = ReturnType<typeof createServiceClient>;

export const OUTBOX_DEDUPE_CONSTRAINT = 'billing_outbox_dedupe_key_key';

interface OutboxEnqueueBase {
  mode: StripeMode;
  kind: string;
  dedupeKey: string;
  payload: Record<string, unknown>;
  runAfter: Date;
}

/** A row about one user (Agent work) or one organization (brokerage work, BACKLOG-3853). */
export type OutboxEnqueue = OutboxEnqueueBase &
  ({ userId: string; organizationId?: never } | { organizationId: string; userId?: never });

export async function enqueueOutbox(service: ServiceClient, job: OutboxEnqueue): Promise<'enqueued' | 'exists'> {
  const { error } = await service.from('billing_outbox').insert({
    stripe_mode: job.mode,
    kind: job.kind,
    // An Agent row keeps the exact shape it had before organization subjects existed.
    ...(job.organizationId ? { organization_id: job.organizationId } : { user_id: job.userId }),
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
