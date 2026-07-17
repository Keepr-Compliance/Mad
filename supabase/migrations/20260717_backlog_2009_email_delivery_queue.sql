-- Migration: Transactional email retry queue (BACKLOG-2009)
--
-- PURPOSE
--   Durable retry/queue for transactional email sends (invite + Stripe receipt) via
--   the M365 Graph path in broker-portal. Today `sendEmail()` is best-effort:
--   a transient Graph failure (429/5xx/network) is logged to email_delivery_log +
--   Sentry and then dropped. This table makes those failures RECOVERABLE:
--
--     1. `sendEmail()` first retries in-request with exponential backoff. If a
--        TRANSIENT error still remains it enqueues a row here (status 'enqueued').
--     2. A Vercel Cron route (/api/cron/email-retry) drains due rows
--        (next_attempt_at <= now()), re-sends, applies exponential backoff per
--        attempt, and dead-letters at max_attempts (status 'failed').
--
--   PERMANENT failures (missing Azure creds / EMAIL_SENDER_ADDRESS 'skipped', or
--   4xx auth/validation errors) are NEVER enqueued — a retry cannot help.
--
-- SECURITY MODEL (mirrors email_delivery_log, BACKLOG-410)
--   RLS enabled. service_role ALL (enqueue + drain happen under the service-role
--   key). NO anon/authenticated access — end users must not read or write the
--   queue. Internal-role read is granted for observability dashboards.
--
-- ROLLBACK (clean; net-new table, no data migration to reverse)
--   DROP TABLE IF EXISTS public.email_delivery_queue;

-- ============================================================================
-- Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.email_delivery_queue (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_type       text        NOT NULL,
  recipient_email  text        NOT NULL,
  subject          text        NOT NULL,
  html             text        NOT NULL,
  body_text        text        NOT NULL,
  from_address     text,
  reply_to         text,
  log_metadata     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  status           text        NOT NULL DEFAULT 'enqueued'
                     CHECK (status IN ('enqueued', 'sent', 'failed')),
  attempts         integer     NOT NULL DEFAULT 0,
  max_attempts     integer     NOT NULL DEFAULT 5,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.email_delivery_queue IS
  'BACKLOG-2009: durable retry queue for transactional emails (M365 Graph). Rows '
  'are enqueued by sendEmail() only after in-request retries exhaust on a TRANSIENT '
  'error, and drained by the /api/cron/email-retry Vercel Cron route. Dead-lettered '
  '(status=failed) at max_attempts.';

COMMENT ON COLUMN public.email_delivery_queue.status IS
  'enqueued = awaiting a drain attempt; sent = delivered on a retry; failed = '
  'dead-lettered after max_attempts.';
COMMENT ON COLUMN public.email_delivery_queue.next_attempt_at IS
  'Exponential-backoff gate: the drain cron only picks up rows where '
  'next_attempt_at <= now().';
COMMENT ON COLUMN public.email_delivery_queue.body_text IS
  'Plain-text fallback body (named body_text to avoid the SQL reserved word "text").';

-- Partial index: the drain query only scans rows still awaiting a retry.
CREATE INDEX IF NOT EXISTS email_delivery_queue_due_idx
  ON public.email_delivery_queue (next_attempt_at)
  WHERE status = 'enqueued';

-- ============================================================================
-- RLS (service_role only writes/reads; internal role read for observability)
-- ============================================================================
ALTER TABLE public.email_delivery_queue ENABLE ROW LEVEL SECURITY;

-- service_role does everything (enqueue + drain). Under the service-role key
-- auth.uid() is NULL, so gate on the role name (BACKLOG-1875 pattern).
CREATE POLICY "email_delivery_queue service role all"
  ON public.email_delivery_queue
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

COMMENT ON POLICY "email_delivery_queue service role all" ON public.email_delivery_queue IS
  'BACKLOG-2009: enqueue + drain happen under the service-role key only. End users '
  '(anon/authenticated) have no access to the transactional email queue.';

-- Internal roles (support/admin) may READ the queue for delivery-visibility
-- dashboards. has_internal_role(uid) mirrors the pattern used across pm_* + support.
CREATE POLICY "email_delivery_queue internal read"
  ON public.email_delivery_queue
  FOR SELECT
  TO authenticated
  USING (public.has_internal_role((SELECT auth.uid())));

COMMENT ON POLICY "email_delivery_queue internal read" ON public.email_delivery_queue IS
  'BACKLOG-2009: internal roles may read the queue for delivery-visibility '
  'dashboards. Regular org users have no access.';
