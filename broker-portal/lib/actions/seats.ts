'use server';

/**
 * "Add seats" on the brokerage Billing page — BACKLOG-3854.
 *
 * Order, before the database is asked: impersonation refused -> who is calling, recomputed on the
 * server (orgActionContext: real billing set-up, the brokerage's suspension) -> caps.canAddSeats
 * (Broker, Admin) -> the arguments' shape -> a LIVE Stripe check that no open invoice is past due
 * (test clock aware; Stripe error or 3 s timeout -> refused) -> public.broker_add_seats with the
 * SIGNED-IN USER'S client (the database reads auth.uid(), takes the billing lock, adds to the
 * stored seats and repeats every refusal from its own mirror).
 *
 * `count` is how many seats to ADD. There is no organization argument: the organization is the
 * session's own. The new total is computed by the database, never here.
 */

import { revalidatePath } from 'next/cache';
import { blockWriteDuringImpersonation } from '@/lib/impersonation-guards';
import { orgActionContext } from '@/lib/billing/orgActionContext';
import { readOrgCustomerId } from '@/lib/billing/orgBillingSetUp';
import { liveOverdue, seatsErrorMessage } from '@/lib/billing/seats';
import { getStripe } from '@/lib/stripe';

export interface AddSeatsResult {
  ok: boolean;
  error: string | null;
  seatsTo?: number;
}

const fail = (code: string | null | undefined): AddSeatsResult => ({ ok: false, error: seatsErrorMessage(code) });

export async function addSeats(count: number, expectedVersion: number): Promise<AddSeatsResult> {
  const blocked = await blockWriteDuringImpersonation();
  if (blocked) return fail('impersonation');
  const ctx = await orgActionContext();
  if ('error' in ctx) return fail('not_authorized');
  if (!ctx.caps.canAddSeats) return fail('not_authorized');
  if (!Number.isInteger(count) || count < 1 || count > 10000) return fail('invalid_seats');
  if (!Number.isInteger(expectedVersion)) return fail('version_conflict');

  let customerId: string | null;
  try {
    customerId = await readOrgCustomerId(ctx.service, ctx.organizationId, ctx.mode);
  } catch {
    return fail('stripe_unavailable');
  }
  if (!customerId) return fail('no_deal');
  let stripe;
  try {
    stripe = getStripe();
  } catch {
    return fail('stripe_unavailable');
  }
  const overdue = await liveOverdue(stripe, customerId);
  if (overdue === 'overdue') return fail('invoice_overdue');
  if (overdue === 'unavailable') return fail('stripe_unavailable');

  const { data, error } = await ctx.portal.supabase.rpc('broker_add_seats', {
    p_org: ctx.organizationId,
    p_add: count,
    p_expected_version: expectedVersion,
  });
  if (error) return fail(error.code === '42501' ? 'not_authorized' : null);
  const res = data as { success?: boolean; error?: string; seats_to?: number } | null;
  if (!res?.success) return fail(res?.error);
  revalidatePath('/dashboard/billing');
  return { ok: true, error: null, seatsTo: typeof res.seats_to === 'number' ? res.seats_to : undefined };
}
