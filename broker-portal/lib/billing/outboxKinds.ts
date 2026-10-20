/**
 * Billing outbox handlers, one per `billing_outbox.kind` (BACKLOG-3849).
 *
 * The drain (`./outbox.ts`) claims due rows and calls the handler registered for
 * the row's kind. This PR ships the drain with NO kinds: each producer slice adds
 * its own entry together with its convergence test.
 *
 * HANDLER CONTRACT (SR R7 — required for every kind added here):
 *
 * (a) Converge. Read the current truth (our DB and Stripe) first, compute the
 *     difference to the target state the row asks for, and do nothing when the
 *     target already holds. Running a handler twice for one row must leave the
 *     same state as running it once. The Stripe idempotency key is a backstop,
 *     not the guarantee: Stripe keeps a key for about 24 hours, so a parked row
 *     requeued by hand later, or a drain outage longer than that, executes again.
 * (b) Stable parameters. Stripe call parameters are a pure function of
 *     `row.payload` plus current state. Build every mutation's key with
 *     `outboxIdempotencyKey(row, step)`; when the parameters can differ between
 *     attempts, pass them as the third argument so a changed request gets a new
 *     key instead of Stripe's `idempotency_error`.
 * (c) A step that can charge money first looks for its own marker
 *     (`metadata.outbox_id = row.id`) on the recent invoices of the subscription
 *     and skips when it finds one.
 * (d) Throw `NonRetryableOutboxError(code)` for a business refusal (retrying
 *     cannot change the answer): the row is parked at once and an alert fires.
 *     Any other throw is retried with backoff unless it is a Stripe error that
 *     the drain classifies as final. Never put personal data in an error code.
 * (e) Deadline. A handler that makes more than one Stripe call checks
 *     `ctx.deadline` before every call after the first and, once
 *     `Date.now() >= ctx.deadline`, starts no further call: it throws an
 *     ordinary (retryable) error and the row converges on its next try (a).
 *     The route's maxDuration only covers the budget plus ONE call's worst
 *     case; a second call started late can outlive the function, and a killed
 *     run leaves its rows leased with the try counted.
 *
 * Every key in OUTBOX_HANDLERS must have
 * `__tests__/lib/billing/outboxKinds/<kind>.convergence.test.ts`
 * (enforced by `__tests__/lib/billing/outboxKinds.contract.test.ts`).
 */

import { createHash } from 'crypto';
import type Stripe from 'stripe';
import type { createServiceClient } from '@/lib/supabase/service';
import type { StripeMode } from './mode';

type ServiceClient = ReturnType<typeof createServiceClient>;

/** One `billing_outbox` row as PostgREST returns it (timestamps are strings; run_after may be "infinity"). */
export interface OutboxRow {
  id: string;
  stripe_mode: StripeMode;
  kind: string;
  user_id: string | null;
  organization_id: string | null;
  dedupe_key: string;
  run_after: string;
  payload: Record<string, unknown>;
  attempts: number;
  last_error: string | null;
  claimed_until: string | null;
  created_at: string;
  processed_at: string | null;
}

export interface OutboxHandlerContext {
  stripe: Stripe;
  service: ServiceClient;
  mode: StripeMode;
  /** Start no further Stripe call at or after this time (contract (e)). */
  deadline: Date;
}

export type OutboxHandler = (_row: OutboxRow, _ctx: OutboxHandlerContext) => Promise<void>;

/** A refusal a retry cannot change. `code` is written to last_error: short, no personal data. */
export class NonRetryableOutboxError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'NonRetryableOutboxError';
    this.code = code;
  }
}

/**
 * Stripe idempotency key for one step of one outbox row: `<row id>:<step>`, or
 * `<row id>:<step>:<first 16 hex of sha256(params)>` when params are given.
 * The same row, step and params always give the same key.
 */
export function outboxIdempotencyKey(row: Pick<OutboxRow, 'id'>, step: string, params?: unknown): string {
  const base = `${row.id}:${step}`;
  if (params === undefined) return base;
  const digest = createHash('sha256').update(stableJson(params)).digest('hex').slice(0, 16);
  return `${base}:${digest}`;
}

/** JSON with object keys sorted, so key order never changes a digest. */
function stableJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'undefined';
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
    .join(',')}}`;
}

/**
 * kind -> handler. Each entry calls through a dynamic import, so this module
 * and the handler modules (which import NonRetryableOutboxError from here)
 * never load each other in a cycle.
 *   - agent_receipt          BACKLOG-3848, lib/billing/agentReceipt.ts
 *   - agent_end_now_cancel   BACKLOG-3848, lib/billing/endPlanNow.ts
 *   - pause_agent_subscription / resume_agent_subscription
 *                            BACKLOG-3878, lib/billing/suspension.ts (enqueued by the
 *                            licences trigger and the nightly reconcile)
 *   - sync_org_subscription  BACKLOG-3853, lib/billing/brokerageSync.ts (enqueued by the
 *                            org_deals trigger, one row per deal version)
 *   - notify_org_suspended / notify_account_manager
 *                            BACKLOG-3853, lib/billing/brokerageNotify.ts (organization rows)
 *   - notify_setup_reminder  BACKLOG-4007, lib/billing/setupReminder.ts (enqueued by the
 *                            organization_members trigger, +3 d / +7 d after a broker/admin invite)
 */
export const OUTBOX_HANDLERS: Readonly<Record<string, OutboxHandler>> = Object.freeze({
  agent_receipt: async (row: OutboxRow, ctx: OutboxHandlerContext) =>
    (await import('./agentReceipt')).handleAgentReceiptRow(row, ctx),
  agent_end_now_cancel: async (row: OutboxRow, ctx: OutboxHandlerContext) =>
    (await import('./endPlanNow')).handleEndNowCancelRow(row, ctx),
  pause_agent_subscription: async (row: OutboxRow, ctx: OutboxHandlerContext) =>
    (await import('./suspension')).handlePauseRow(row, ctx),
  resume_agent_subscription: async (row: OutboxRow, ctx: OutboxHandlerContext) =>
    (await import('./suspension')).handleResumeRow(row, ctx),
  sync_org_subscription: async (row: OutboxRow, ctx: OutboxHandlerContext) =>
    (await import('./brokerageSync')).handleSyncOrgSubscriptionRow(row, ctx),
  notify_org_suspended: async (row: OutboxRow, ctx: OutboxHandlerContext) =>
    (await import('./brokerageNotify')).handleNotifyOrgSuspendedRow(row, ctx),
  notify_account_manager: async (row: OutboxRow, ctx: OutboxHandlerContext) =>
    (await import('./brokerageNotify')).handleNotifyAccountManagerRow(row, ctx),
  notify_setup_reminder: async (row: OutboxRow, ctx: OutboxHandlerContext) =>
    (await import('./setupReminder')).handleNotifySetupReminderRow(row, ctx),
});
