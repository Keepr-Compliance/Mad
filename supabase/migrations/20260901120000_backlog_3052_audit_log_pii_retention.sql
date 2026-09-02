-- ============================================================================
-- BACKLOG-3052: audit_logs — purge third-party PII, and stop accepting it
--               without consent
-- ============================================================================
-- Date: 2026-09-01
--
-- ## What was happening
--
-- `auditService.syncToCloud()` ran unconditionally — no tier check, no flag, no
-- consent — and `sanitizeMetadata` redacts credential-shaped keys only. Contact
-- names and property addresses went straight through, written by purely LOCAL
-- desktop actions:
--
--   CONTACT_CREATE      504 rows, 393 carrying a contact's name
--   TRANSACTION_DELETE  215 rows, 215 carrying a property address
--   CONTACT_UPDATE      113 rows,  19 names
--   DATA_EXPORT         106 rows, 106 addresses   (export to a LOCAL folder)
--   CONTACT_DELETE       56 rows,  56 names
--   TRANSACTION_SUBMIT   17 rows,  17 addresses
--   TRANSACTION_CREATE   12 rows,  12 addresses
--
-- 818 rows, 28 users, 26 of whom have never submitted anything to a broker.
-- Oldest 2025-12-06, newest 2026-08-31. Measured on production on 2026-09-01;
-- the count is re-derived by this migration rather than trusted, see below.
--
-- The live privacy policy says contacts are "not transmitted to Keepr's
-- servers" (§3.1) and that audit logs hold "action type, affected resource,
-- user identifier, IP address, and user-agent" (§3.2). Neither was true.
--
-- ## The design (founder's decision, 2026-09-01)
--
--   default                  names and addresses stripped from audit metadata
--   support access granted   they are included
--   backend                  purged at 14 days, regardless of grant length
--
-- The desktop half is `auditService.stripPiiForCloud()`, gated on the existing
-- support-access grant. This file is the backend half.
--
-- ## Why the purge is the whole mechanism, not a backstop
--
-- Support-access expiry does NOT delete anything server-side today. Ending a
-- window (`SupportAccessService.end`) clears the LOCAL scoped log store; the
-- uploaded diagnostic attachments are purged on their own per-row `expires_at`
-- set at upload time, by `support_purge_expired_attachments()`. Nothing ties a
-- server-side deletion to grant expiry. So for `audit_logs` there is no second
-- line of defence behind this job — this job is the line.
--
-- ## Why 14 days and not the user's chosen duration
--
-- Deliberate, and the founder's call. The grant screen offers 24h / 7d / 14d /
-- 30d; the purge ignores all four. Accepted consequence, stated rather than
-- discovered later: a user who grants 30 days loses audit detail at day 14.
--
-- ## Why `created_at` and not `timestamp`
--
-- `timestamp` is when the action happened on the user's Mac. `created_at` is
-- when the row arrived here — it is DB-defaulted, and `batchInsertAuditLogs`
-- does not send it. A laptop that was shut for three weeks syncs rows whose
-- `timestamp` is three weeks old and whose `created_at` is today. Keyed on
-- `timestamp` those rows would be deleted by the next hourly tick, before
-- support could ever read them, while the retention promise ("we hold it for
-- 14 days") would be quietly false in the user's favour and useless in
-- support's. `created_at` is how long Keepr has actually held the data, which
-- is the thing being limited. Max observed skew on live data: 3h18m.
--
-- ## Rows, not redaction
--
-- A PII-bearing row is deleted whole. The alternative — stripping the keys and
-- keeping the row — was considered and NOT built: the item says purge, and the
-- consequence is worth stating plainly rather than hiding behind a default.
-- After day 14 a granted user's CONTACT_CREATE row is gone entirely, while an
-- ungranted user keeps theirs forever with the name already stripped at source.
-- Redaction in place would converge those two; it is a one-line change to this
-- function (UPDATE ... SET metadata = metadata - 'name' - 'propertyAddress')
-- if that is preferred.
--
-- Non-PII rows are untouched at every age. LOGIN, LOGOUT, MAILBOX_CONNECT,
-- SETTINGS_CHANGE, TRANSACTION_UPDATE and every other row without one of the
-- two keys is not eligible for this job, ever. It is still an audit log.
--
-- ## What is NOT covered, on purpose
--
--   `email` on MAILBOX_CONNECT — 458 rows. That is the user's OWN mailbox
--   address, not a third party's, and outside this item's stated scope of
--   "names and addresses". Raised on BACKLOG-3052 as an adjacent finding for a
--   separate decision rather than folded in here.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Index the purge predicate.
--
--    Partial on the two keys, so the hourly job scans only eligible rows rather
--    than the whole table. jsonb `?` uses the default jsonb_ops GIN opclass.
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_audit_logs_pii_metadata
  ON public.audit_logs USING gin (metadata)
  WHERE metadata ?| ARRAY['name', 'propertyAddress'];

CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at
  ON public.audit_logs (created_at);

COMMENT ON COLUMN public.audit_logs.metadata IS
  'Operational detail for the action. Third-party identity (contact `name`, '
  '`propertyAddress`) is uploaded ONLY while the user has an open '
  'support-access window — see auditService.stripPiiForCloud — and is deleted '
  '14 days after arrival by purge_audit_log_pii(). BACKLOG-3052.';

-- ----------------------------------------------------------------------------
-- 2. The purge.
--
--    Not exposed to `authenticated` — service role / scheduled job only.
--    Returns the count so a run is observable rather than assumed.
--
--    `p_retention_days` is a parameter so the boundary can be probed at 13/14/15
--    days without editing the function, and is clamped: a zero or negative
--    value passed by accident would delete rows support is actively reading,
--    and there is no legitimate caller asking for a 100-day audit-PII window.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.purge_audit_log_pii(
  p_retention_days integer DEFAULT 14
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_retention integer;
  v_cutoff timestamptz;
  v_deleted integer := 0;
BEGIN
  v_retention := LEAST(GREATEST(COALESCE(p_retention_days, 14), 1), 90);
  v_cutoff := now() - (v_retention || ' days')::interval;

  WITH purged AS (
    DELETE FROM audit_logs
    WHERE created_at < v_cutoff
      AND metadata ?| ARRAY['name', 'propertyAddress']
    RETURNING 1
  )
  SELECT count(*) INTO v_deleted FROM purged;

  RETURN jsonb_build_object(
    'deleted', v_deleted,
    'retention_days', v_retention,
    'cutoff', v_cutoff,
    'at', now()
  );
END;
$$;

COMMENT ON FUNCTION public.purge_audit_log_pii(integer) IS
  'BACKLOG-3052. Deletes audit_logs rows carrying a contact name or property '
  'address once they are older than p_retention_days (default 14, clamped '
  '1..90) measured on created_at. Rows without those keys are never eligible.';

-- ----------------------------------------------------------------------------
-- 3. Backfill: the rows that are already here.
--
--    Nobody consented to any of these, at any age, so the retention window does
--    not apply to them — every one goes.
--
--    The count is DERIVED here and raised as a NOTICE, not asserted against the
--    818 measured on 2026-09-01. If rows arrived between the measurement and
--    this migration running, deleting them is still correct and the number in
--    the log is the true one. A hardcoded expectation would either be wrong or
--    would abort a correct deletion.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_before integer;
  v_after integer;
BEGIN
  SELECT count(*) INTO v_before
  FROM public.audit_logs
  WHERE metadata ?| ARRAY['name', 'propertyAddress'];

  DELETE FROM public.audit_logs
  WHERE metadata ?| ARRAY['name', 'propertyAddress'];

  SELECT count(*) INTO v_after
  FROM public.audit_logs
  WHERE metadata ?| ARRAY['name', 'propertyAddress'];

  RAISE NOTICE 'BACKLOG-3052 backfill: deleted % audit_logs rows carrying a contact name or property address; % remain.',
    v_before, v_after;

  IF v_after <> 0 THEN
    RAISE EXCEPTION 'BACKLOG-3052 backfill did not clear the table: % rows still match the predicate.', v_after;
  END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 4. Schedule it.
--
--    Hourly, mirroring `purge-expired-support-attachments`. Retention is
--    measured in days against an indexed partial predicate; there is no reason
--    to wake 288 times a day to enforce a 14-day deadline.
--
--    Minute 23 rather than 17 so the two purges do not contend.
--
--    Idempotent: cron.schedule upserts on job name, so re-running this
--    migration re-points the same job rather than creating a duplicate.
-- ----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

SELECT cron.schedule(
  'purge-audit-log-pii',
  '23 * * * *',
  $$SELECT public.purge_audit_log_pii();$$
);

-- ----------------------------------------------------------------------------
-- 5. Grants.
--
--    REVOKE FROM PUBLIC comes FIRST and is the one that matters. Postgres
--    attaches an implicit `GRANT EXECUTE ... TO PUBLIC` to every new function;
--    anon and authenticated inherit it as members of PUBLIC, and revoking from
--    those two roles alone does NOT remove the inherited grant — the function
--    stays callable by anon. Learned the hard way in BACKLOG-2436.
-- ----------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.purge_audit_log_pii(integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.purge_audit_log_pii(integer) FROM authenticated, anon;
GRANT EXECUTE ON FUNCTION public.purge_audit_log_pii(integer) TO service_role;

-- ============================================================================
-- POST-APPLY VERIFICATION (run by hand; not part of the migration)
-- ============================================================================
-- -- 1. No PII-bearing rows remain:
-- SELECT count(*) FROM audit_logs WHERE metadata ?| ARRAY['name','propertyAddress'];
-- --    expected: 0
--
-- -- 2. Non-PII audit history survived the backfill:
-- SELECT count(*) FROM audit_logs;
-- --    expected: 2030  (2848 total - 818 PII-bearing, as measured 2026-09-01)
--
-- -- 3. The job is registered and active:
-- SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'purge-audit-log-pii';
--
-- -- 4. anon cannot call it:
-- SELECT has_function_privilege('anon', 'public.purge_audit_log_pii(integer)', 'EXECUTE');
-- --    expected: false

-- ============================================================================
-- ROLLBACK
-- ============================================================================
-- SELECT cron.unschedule('purge-audit-log-pii');
-- DROP FUNCTION IF EXISTS public.purge_audit_log_pii(integer);
-- DROP INDEX IF EXISTS idx_audit_logs_pii_metadata;
-- DROP INDEX IF EXISTS idx_audit_logs_created_at;
-- (The backfill DELETE is not reversible. That is the point of it.)
