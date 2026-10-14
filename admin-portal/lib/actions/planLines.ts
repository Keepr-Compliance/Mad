'use server';

/**
 * Plan lines for the users list — BACKLOG-3859.
 *
 * A server action is a public POST endpoint: the gate inside it is the only
 * gate. In order, BEFORE any service client exists:
 *   1. a signed-in staff session (getAuthenticatedUser);
 *   2. has_permission(<that session's user id>, 'users.view') through the
 *      SESSION client. Since BACKLOG-3946 has_permission answers only for
 *      auth.uid(); through the service client auth.uid() is NULL and it would
 *      refuse everyone. An RPC error refuses too (fail closed);
 *   3. 1..100 uuids.
 * Only then is the service client created for lib/planLines.ts's batched reads.
 */

import * as Sentry from '@sentry/nextjs';
import type { PlanLine } from '@keepr/shared';
import { createServiceClient, getAuthenticatedUser } from '@/lib/supabase/server';
import { readPlanLines, validPlanLineIds } from '@/lib/planLines';

export type PlanLinesResult =
  | { ok: true; lines: Record<string, PlanLine> }
  | { ok: false; error: 'not_authorized' | 'invalid_ids' | 'unavailable' };

export async function getPlanLines(ids: unknown): Promise<PlanLinesResult> {
  const { supabase, user } = await getAuthenticatedUser();
  if (!user) return { ok: false, error: 'not_authorized' };

  const { data: allowed, error: permError } = await supabase.rpc('has_permission', {
    check_user_id: user.id,
    required_permission: 'users.view',
  });
  if (permError || allowed !== true) return { ok: false, error: 'not_authorized' };

  const valid = validPlanLineIds(ids);
  if (!valid) return { ok: false, error: 'invalid_ids' };

  try {
    const lines = await readPlanLines(createServiceClient(), valid);
    return { ok: true, lines };
  } catch (err) {
    Sentry.captureException(err, { tags: { area: 'admin-plan-lines' } });
    return { ok: false, error: 'unavailable' };
  }
}
