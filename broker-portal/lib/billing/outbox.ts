/**
 * Billing outbox drain (BACKLOG-3849, plan step 0 §2 + SR R4-R9, R14).
 *
 * One run: claim up to OUTBOX_CLAIM_LIMIT due rows of this deployment's Stripe
 * mode, run each row's handler, record the result on the row, report stale rows.
 *
 *  - Claim: `billing_outbox_claim` (3845) locks the rows, leases them for five
 *    minutes and increments `attempts`, so `row.attempts` here is the number of
 *    this try.
 *  - Every write is guarded on `attempts = row.attempts`: a worker whose lease
 *    ran out and whose row was claimed again writes nothing (0 rows = lease lost).
 *  - Success: processed_at = now. Retryable failure: run_after = now + backoff,
 *    lease released. Final failure, or the try cap reached: parked
 *    (run_after = 'infinity', processed_at stays NULL) + one alert. A person
 *    requeues a parked row with
 *    `update billing_outbox set run_after = now(), attempts = 0, last_error = null where id = ...`.
 *  - A row claimed past the cap is parked without running (R4): its earlier try
 *    died without writing a result.
 *  - Time budget (R5): rows run one at a time; once the budget is spent the
 *    remaining claimed rows are released for the next run with their try
 *    count restored (they did not run).
 *  - last_error holds a code, never a raw error message (R14).
 *  - `run_after` may be the string "infinity"; parseRunAfter() is the only place
 *    it is turned into a date (R8).
 */

import Stripe from 'stripe';
import type { createServiceClient } from '@/lib/supabase/service';
import { billingAlert } from './alert';
import type { StripeMode } from './mode';
import {
  NonRetryableOutboxError,
  type OutboxHandler,
  type OutboxRow,
} from './outboxKinds';

type ServiceClient = ReturnType<typeof createServiceClient>;

/** Tries before a row is parked (founder decision Q2). */
export const OUTBOX_MAX_ATTEMPTS = 8;
/** Rows claimed per run (the claim function allows 1..100). */
export const OUTBOX_CLAIM_LIMIT = 10;
/** Backoff cap. */
export const OUTBOX_MAX_BACKOFF_MINUTES = 60;
/**
 * Stop starting rows after this much of the run. The route's maxDuration is
 * 60 s: budget + one row's worst Stripe call (timeout x (1 + retries)) + 5 s
 * margin must fit (20 + 30 + 5 = 55 s).
 */
export const OUTBOX_RUN_BUDGET_MS = 20_000;
/** Per-request timeout of the drain's Stripe client. */
export const OUTBOX_STRIPE_TIMEOUT_MS = 15_000;
/** Network retries of the drain's Stripe client. */
export const OUTBOX_STRIPE_MAX_RETRIES = 1;
/** Margin kept between the worst-case run and the route's maxDuration. */
export const OUTBOX_RUN_MARGIN_MS = 5_000;
/** A due row this much past its run_after, not leased, is stale. */
export const OUTBOX_STALE_AFTER_MS = 10 * 60_000;
/** One stale alert per hour per mode, plus one when the oldest stale row first crosses the line. */
export const OUTBOX_STALE_ALERT_PERIOD_MS = 60 * 60_000;
/** The drain runs once a minute; the crossing window is one run interval. */
export const OUTBOX_RUN_INTERVAL_MS = 60_000;

const MAX_ERROR_CODE_LENGTH = 200;

/** Stripe errors whose answer a retry cannot change: Stripe stores the response under the key for 24 h. */
const FINAL_STRIPE_ERRORS = new Set([
  'StripeInvalidRequestError',
  'StripeCardError',
  'StripePermissionError',
  'StripeAuthenticationError',
  'StripeIdempotencyError',
  'StripeInvalidGrantError',
]);
/** Stripe errors that are not stored and may succeed later. */
const RETRYABLE_STRIPE_ERRORS = new Set(['StripeConnectionError', 'StripeRateLimitError', 'StripeAPIError']);

export interface DrainContext {
  service: ServiceClient;
  stripe: Stripe;
  mode: StripeMode;
  handlers: Readonly<Record<string, OutboxHandler>>;
  /** Injected clock (tests). */
  now?: () => Date;
  budgetMs?: number;
}

export interface DrainResult {
  claimed: number;
  done: number;
  retried: number;
  parked: number;
  released: number;
  leaseLost: number;
  stale: number;
}

export class OutboxClaimError extends Error {
  constructor(readonly code: string) {
    super(`billing_outbox_claim failed: ${code}`);
    this.name = 'OutboxClaimError';
  }
}

/** Minutes to wait after failed try number `attempts` (1-based): 1, 2, 4 ... capped at 60. */
export function backoffMinutes(attempts: number): number {
  const exp = Math.max(0, attempts - 1);
  return Math.min(2 ** exp, OUTBOX_MAX_BACKOFF_MINUTES);
}

export function nextRunAfter(attempts: number, now: Date): Date {
  return new Date(now.getTime() + backoffMinutes(attempts) * 60_000);
}

/** run_after as a Date, or null for "infinity" (a parked row) and anything unparseable. */
export function parseRunAfter(value: string | null | undefined): Date | null {
  if (!value || /^-?infinity$/i.test(value)) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export type FailureClass = { final: boolean; code: string };

function clip(code: string): string {
  return code.replace(/[^A-Za-z0-9_:.-]/g, '_').slice(0, MAX_ERROR_CODE_LENGTH);
}

/** How a handler failure is recorded (R6) and what last_error says (R14). */
export function classifyFailure(err: unknown): FailureClass {
  if (err instanceof NonRetryableOutboxError) {
    return { final: true, code: clip(`nonretryable:${err.code}`) };
  }
  const type = (err as { type?: unknown } | null)?.type;
  if (typeof type === 'string' && type.startsWith('Stripe')) {
    const raw = (err as { code?: unknown; rawType?: unknown }).code ?? (err as { rawType?: unknown }).rawType;
    const code = clip(`stripe:${type}:${typeof raw === 'string' ? raw : ''}`);
    if (FINAL_STRIPE_ERRORS.has(type)) return { final: true, code };
    if (RETRYABLE_STRIPE_ERRORS.has(type)) return { final: false, code };
    return { final: false, code };
  }
  return { final: false, code: 'handler_error' };
}

/** A Stripe client for the drain only: short timeout, one network retry (R5). */
export function createDrainStripe(key: string | undefined = process.env.STRIPE_SECRET_KEY): Stripe {
  if (!key) throw new Error('STRIPE_SECRET_KEY is not configured');
  return new Stripe(key, {
    apiVersion: '2025-02-24.acacia',
    typescript: true,
    timeout: OUTBOX_STRIPE_TIMEOUT_MS,
    maxNetworkRetries: OUTBOX_STRIPE_MAX_RETRIES,
  });
}

/** Guarded write on one claimed row. Returns true when the row was still ours. */
async function writeRow(ctx: DrainContext, row: OutboxRow, patch: Record<string, unknown>): Promise<boolean> {
  const { data, error } = await ctx.service
    .from('billing_outbox')
    .update(patch)
    .eq('id', row.id)
    .eq('attempts', row.attempts)
    .select('id');
  if (error) {
    throw new Error(`billing_outbox write failed: ${error.code ?? 'unknown'}`);
  }
  const ours = Array.isArray(data) && data.length > 0;
  if (!ours) {
    console.warn(`[billing/outbox] lease lost on ${row.id} (attempt ${row.attempts}); result not written`);
  }
  return ours;
}

async function park(
  ctx: DrainContext,
  row: OutboxRow,
  code: string,
  alert: 'outbox_dead_letter' | 'outbox_unknown_kind'
): Promise<boolean> {
  const ours = await writeRow(ctx, row, { run_after: 'infinity', claimed_until: null, last_error: code });
  if (ours) {
    billingAlert(alert, ctx.mode, { outbox_id: row.id, kind: row.kind, attempts: row.attempts, last_error: code });
  }
  return ours;
}

export async function drainOnce(ctx: DrainContext): Promise<DrainResult> {
  const now = ctx.now ?? (() => new Date());
  const budgetMs = ctx.budgetMs ?? OUTBOX_RUN_BUDGET_MS;
  const started = now().getTime();
  const deadline = new Date(started + budgetMs);
  const result: DrainResult = { claimed: 0, done: 0, retried: 0, parked: 0, released: 0, leaseLost: 0, stale: 0 };

  const { data, error } = await ctx.service.rpc('billing_outbox_claim', {
    p_mode: ctx.mode,
    p_limit: OUTBOX_CLAIM_LIMIT,
  });
  if (error) throw new OutboxClaimError(String(error.code ?? 'unknown'));
  const rows = (Array.isArray(data) ? data : []) as OutboxRow[];
  result.claimed = rows.length;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    if (now().getTime() - started > budgetMs) {
      for (const rest of rows.slice(i)) {
        // Not started: give the try back, so a row stuck behind slow ones is
        // never parked by the cap without having run.
        if (await writeRow(ctx, rest, { claimed_until: null, attempts: rest.attempts - 1 })) result.released++;
        else result.leaseLost++;
      }
      break;
    }

    if (row.attempts > OUTBOX_MAX_ATTEMPTS) {
      if (await park(ctx, row, 'parked_attempts_exhausted', 'outbox_dead_letter')) result.parked++;
      else result.leaseLost++;
      continue;
    }

    const handler = Object.prototype.hasOwnProperty.call(ctx.handlers, row.kind) ? ctx.handlers[row.kind] : undefined;
    if (!handler) {
      if (await park(ctx, row, 'unknown_kind', 'outbox_unknown_kind')) result.parked++;
      else result.leaseLost++;
      continue;
    }

    try {
      await handler(row, { stripe: ctx.stripe, service: ctx.service, mode: ctx.mode, deadline });
    } catch (err) {
      const failure = classifyFailure(err);
      if (failure.final || row.attempts >= OUTBOX_MAX_ATTEMPTS) {
        if (await park(ctx, row, failure.code, 'outbox_dead_letter')) result.parked++;
        else result.leaseLost++;
      } else {
        const ok = await writeRow(ctx, row, {
          run_after: nextRunAfter(row.attempts, now()).toISOString(),
          claimed_until: null,
          last_error: failure.code,
        });
        if (ok) result.retried++;
        else result.leaseLost++;
      }
      continue;
    }

    const ok = await writeRow(ctx, row, {
      processed_at: now().toISOString(),
      claimed_until: null,
      last_error: null,
    });
    if (ok) result.done++;
    else result.leaseLost++;
  }

  // The alert window is sampled at the run's start, so it does not drift with processing time.
  result.stale = await reportStaleRows(ctx, now(), new Date(started));
  return result;
}

/**
 * Rows of this mode that should have run more than ten minutes ago and are not
 * being worked on (R9): unprocessed, run_after past the line and not parked,
 * no live lease. Alerts at most when the oldest such row first crosses the line
 * and then once an hour after that. Returns the count.
 *
 * `now` filters the rows; `dueAt` (the drain passes its run's start time) decides
 * whether this run falls in an alert window.
 */
export async function reportStaleRows(ctx: DrainContext, now: Date, dueAt: Date = now): Promise<number> {
  const line = new Date(now.getTime() - OUTBOX_STALE_AFTER_MS).toISOString();
  const { data, count, error } = await ctx.service
    .from('billing_outbox')
    .select('id, run_after', { count: 'exact' })
    .eq('stripe_mode', ctx.mode)
    .is('processed_at', null)
    .lt('run_after', line)
    .neq('run_after', 'infinity')
    .or(`claimed_until.is.null,claimed_until.lt.${now.toISOString()}`)
    .order('run_after', { ascending: true })
    .limit(1);
  if (error) {
    console.warn(`[billing/outbox] stale check failed: ${error.code ?? 'unknown'}`);
    return 0;
  }
  const n = count ?? (Array.isArray(data) ? data.length : 0);
  if (n === 0) return 0;
  const oldest = parseRunAfter((data as { run_after: string }[] | null)?.[0]?.run_after);
  if (oldest && staleAlertDue(oldest, dueAt)) {
    billingAlert('outbox_stale', ctx.mode, { stale_rows: n, oldest_run_after: oldest.toISOString() });
  }
  return n;
}

/** True in the run interval where the oldest stale row crosses the line, and once per period after. */
export function staleAlertDue(oldestRunAfter: Date, now: Date): boolean {
  const past = now.getTime() - (oldestRunAfter.getTime() + OUTBOX_STALE_AFTER_MS);
  if (past < 0) return false;
  return past % OUTBOX_STALE_ALERT_PERIOD_MS < OUTBOX_RUN_INTERVAL_MS;
}
