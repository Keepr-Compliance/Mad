-- ============================================================================
-- BACKLOG-3052: audit_logs — blank the identity fields after 14 days, and stop
--               accepting them without consent
-- ============================================================================
-- Date: 2026-09-19  (re-stamped from 2026-09-01; see "Why this file was
--                    re-stamped" below)
--
-- ## What was happening
--
-- `auditService.syncToCloud()` ran unconditionally — no tier check, no flag, no
-- consent — and `sanitizeMetadata` redacts credential-shaped keys only. Contact
-- names, property addresses and the user's own connected mailbox address went
-- straight through, written by purely LOCAL desktop actions: CONTACT_CREATE,
-- CONTACT_UPDATE, CONTACT_DELETE, TRANSACTION_CREATE, TRANSACTION_DELETE,
-- TRANSACTION_SUBMIT, DATA_EXPORT and MAILBOX_CONNECT.
--
-- Rationale and measurements: BACKLOG-3052 (tracker).
--
-- ## The design (founder's decisions, 2026-09-01 and 2026-09-19)
--
--   default                  identity fields stripped from audit metadata
--   support access granted   they are included
--   backend                  blanked 14 days after arrival, regardless of
--                            grant length
--
-- The desktop half is `auditService.stripPiiForCloud()`, gated on the existing
-- support-access grant. This file is the backend half.
--
-- ## Which keys, and why `email` is one of them (2026-09-19)
--
--   `name`             a contact's — a third party's identity
--   `propertyAddress`  a client's property — a third party's identity
--   `email`            the user's OWN connected mailbox address
--
-- The first two were the item's original scope. `email` was deliberately left
-- out and raised as an adjacent question, because it is the user's own address
-- rather than someone else's. The founder answered on 2026-09-19:
-- **"yes (we just need to know the user)"** — so it is treated the same way.
--
-- `user_id` is NOT in the list and is never touched, by this file or by the
-- desktop strip. That column is what "we just need to know the user" keeps.
--
-- ## Blanked, not deleted (founder, 2026-09-19: "ok just blanking")
--
-- Earlier drafts of this file DELETED the whole row. They no longer do.
-- Deleting audit history to fix a privacy problem trades one compliance story
-- for another, and it produced an odd asymmetry: a user who granted support
-- access lost the entire record at day 14, while a user who granted nothing
-- kept theirs forever with the name already absent. Blanking converges the two
-- and keeps the audit trail — the row still says who did what, to which
-- resource, when, and whether it succeeded.
--
-- The one-time cleanup in section 3 blanks as well, for the same reason. That
-- part is a PM reading of the same decision rather than a separate ruling, and
-- it is the reversible-in-spirit choice: the rows survive. The founder can
-- overrule it, in which case section 3 becomes a DELETE again and section 2
-- does not change.
--
-- Non-PII rows are untouched at every age. LOGIN, LOGOUT, SETTINGS_CHANGE,
-- TRANSACTION_UPDATE and every other row without one of the three keys is not
-- eligible for this job, ever. It is still an audit log.
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
-- `timestamp` those rows would be blanked by the next hourly tick, before
-- support could ever read them, while the retention promise ("we hold it for
-- 14 days") would be quietly false in the user's favour and useless in
-- support's. `created_at` is how long Keepr has actually held the data, which
-- is the thing being limited.
--
-- ## Why this file was re-stamped
--
-- It was `20260901120000_…`. Nine migrations with later stamps had already been
-- applied to production by the time it was ready, so the Supabase CLI would
-- have refused or flagged it, and applying it through the dashboard would have
-- recorded a fresh apply-time version while `20260901120000` stayed pending
-- forever — the phantom-pending shape BACKLOG-3126 spent a sprint clearing.
-- Renaming is safe ONLY while a migration is still pending, and this one is:
-- checked against the live ledger on 2026-09-19, the newest recorded version is
-- `20260918185446` and there is no row at `20260901120000`.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Index the predicate.
--
--    Partial on the three keys, so the hourly job scans only eligible rows
--    rather than the whole table. jsonb `?|` uses the default jsonb_ops GIN
--    opclass.
--
--    DROP first, deliberately. An earlier hand-application of this file would
--    have left an index of the same name built on a TWO-key predicate, and
--    `CREATE INDEX IF NOT EXISTS` would silently keep it — the job would then
--    miss every `email`-only row. Dropping makes the re-run idempotent in fact
--    rather than in name. The table is small enough that the rebuild is free.
-- ----------------------------------------------------------------------------
DROP INDEX IF EXISTS public.idx_audit_logs_pii_metadata;

CREATE INDEX IF NOT EXISTS idx_audit_logs_pii_metadata
  ON public.audit_logs USING gin (metadata)
  WHERE metadata ?| ARRAY['name', 'propertyAddress', 'email'];

CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at
  ON public.audit_logs (created_at);

COMMENT ON COLUMN public.audit_logs.metadata IS
  'Operational detail for the action. Identity fields (contact `name`, '
  '`propertyAddress`, and `email`, the connected mailbox address) are uploaded '
  'ONLY while the user has an open support-access window — see '
  'auditService.stripPiiForCloud — and are blanked out of the row 14 days '
  'after arrival by purge_audit_log_pii(). The row itself is kept. '
  'BACKLOG-3052.';

-- ----------------------------------------------------------------------------
-- 2. The purge: blank the keys, keep the row.
--
--    Not exposed to `authenticated` — service role / scheduled job only.
--    Returns the count so a run is observable rather than assumed.
--
--    `p_retention_days` is a parameter so the boundary can be probed at 13/14/15
--    days without editing the function, and is clamped: a zero or negative
--    value passed by accident would blank rows support is actively reading,
--    and there is no legitimate caller asking for a 100-day audit-PII window.
--
--    `metadata - ARRAY[...]::text[]` removes those keys and leaves every other
--    key in place. A row whose metadata held nothing else becomes `{}` rather
--    than NULL — the same shape the desktop strip produces, and it does not
--    match the predicate, so the UPDATE cannot find it again.
--
--    The `?|` in the WHERE clause is what makes this idempotent: after a run,
--    no eligible row still carries one of the keys, so a second run updates
--    nothing and reports 0.
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
  v_blanked integer := 0;
BEGIN
  v_retention := LEAST(GREATEST(COALESCE(p_retention_days, 14), 1), 90);
  v_cutoff := now() - (v_retention || ' days')::interval;

  WITH blanked AS (
    UPDATE audit_logs
    SET metadata = metadata - ARRAY['name', 'propertyAddress', 'email']::text[]
    WHERE created_at < v_cutoff
      AND metadata ?| ARRAY['name', 'propertyAddress', 'email']
    RETURNING 1
  )
  SELECT count(*) INTO v_blanked FROM blanked;

  RETURN jsonb_build_object(
    'blanked', v_blanked,
    'retention_days', v_retention,
    'cutoff', v_cutoff,
    'at', now()
  );
END;
$$;

COMMENT ON FUNCTION public.purge_audit_log_pii(integer) IS
  'BACKLOG-3052. Blanks the `name`, `propertyAddress` and `email` keys out of '
  'audit_logs.metadata once the row is older than p_retention_days (default '
  '14, clamped 1..90) measured on created_at. The row, its action, its '
  'user_id and every other metadata key are kept. Rows without those keys are '
  'never eligible.';

-- ----------------------------------------------------------------------------
-- 3. Backfill: the rows that are already here.
--
--    Nobody consented to any of these, at any age, so the retention window does
--    not apply to them — every one is blanked now.
--
--    Blanked, not deleted: see "Blanked, not deleted" in the header. The audit
--    trail survives; only the three identity keys go.
--
--    The count is DERIVED here and raised as a NOTICE, never asserted against a
--    number measured on another day. If rows arrived between the measurement
--    and this migration running, blanking them is still correct and the number
--    in the log is the true one. A hardcoded expectation would either be wrong
--    or would abort a correct update.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_before integer;
  v_blanked integer;
  v_after integer;
  v_rows_total_before integer;
  v_rows_total_after integer;
BEGIN
  SELECT count(*) INTO v_rows_total_before FROM public.audit_logs;

  SELECT count(*) INTO v_before
  FROM public.audit_logs
  WHERE metadata ?| ARRAY['name', 'propertyAddress', 'email'];

  WITH blanked AS (
    UPDATE public.audit_logs
    SET metadata = metadata - ARRAY['name', 'propertyAddress', 'email']::text[]
    WHERE metadata ?| ARRAY['name', 'propertyAddress', 'email']
    RETURNING 1
  )
  SELECT count(*) INTO v_blanked FROM blanked;

  SELECT count(*) INTO v_after
  FROM public.audit_logs
  WHERE metadata ?| ARRAY['name', 'propertyAddress', 'email'];

  SELECT count(*) INTO v_rows_total_after FROM public.audit_logs;

  RAISE NOTICE 'BACKLOG-3052 backfill: % of % audit_logs rows carried a contact name, a property address or a mailbox address; % were blanked; % still match in this transaction.',
    v_before, v_rows_total_before, v_blanked, v_after;

  -- The row count is the point of blanking rather than deleting, so it is
  -- asserted rather than merely logged: the only statement in this block is an
  -- UPDATE, so the count cannot legitimately fall.
  --
  -- `<`, not `<>`, and that is deliberate. Desktops upload audit rows on a
  -- 60-second tick; at READ COMMITTED each statement takes a fresh snapshot, so
  -- a concurrent INSERT that commits between the two counts is visible to the
  -- second one. Asserting equality would abort a perfectly correct run for no
  -- reason. A DROP in count is the thing being guarded against, and an INSERT
  -- can never cause one.
  IF v_rows_total_after < v_rows_total_before THEN
    RAISE EXCEPTION 'BACKLOG-3052 backfill: row count fell from % to %. This migration must not delete audit records.',
      v_rows_total_before, v_rows_total_after;
  END IF;

  -- NOTICE, deliberately not EXCEPTION.
  --
  -- `v_after = 0` is true inside this transaction and stops being true within
  -- about a minute of it committing: every desktop still running the shipped
  -- build keeps uploading these keys on its 60-second sync tick until it
  -- auto-updates to a build carrying the client-side gate.
  --
  -- Raising here would assert a steady state this migration does not create and
  -- cannot create on its own. What it actually promises is narrower and worth
  -- saying plainly: nothing that arrived before this ran keeps its identity
  -- fields, and anything that arrives during the rollout loses them within 14
  -- days by the hourly job in section 4. During rollout that job is the
  -- guarantee, not a backstop.
  IF v_after <> 0 THEN
    RAISE NOTICE 'BACKLOG-3052 backfill: % rows still match inside the transaction — unexpected, investigate before relying on this run.', v_after;
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
-- WHAT HAS BEEN REHEARSED, AND WHAT HAS NOT
-- ============================================================================
-- Read this before applying. The two halves below were rehearsed by different
-- methods and carry different weight.
--
-- ## A. STILL VALID — the 2026-09-01 write rehearsal of the PREDICATE
--
-- Every statement of the earlier, DELETE-shaped version of this file was
-- executed against the production schema inside a transaction that was rolled
-- back. What that rehearsal established is the part this rewrite did NOT
-- change: which rows are selected, and by which column.
--
-- Boundary, swept rather than sampled. Seven synthetic rows straddling the
-- cutoff were inserted alongside the real data, at p_retention_days = 14:
--
--   probe                          created_at            outcome
--   ---------------------------------------------------------------
--   A  name                        now() - 13d           NOT SELECTED
--   E  name                        now() - 14d + 1 min   NOT SELECTED
--   F  name                        now() - 14d - 1 min   SELECTED
--   B  name                        now() - 15d           SELECTED
--   C  propertyAddress             now() - 15d           SELECTED
--   D  {"provider":"google"}       now() - 400d          NOT SELECTED
--   G  {"updatedFields":[...]}     now() - 400d          NOT SELECTED
--
-- Mutations, each run the same way. A green predicate proves nothing until it
-- has been made to fail:
--
--   created_at -> timestamp     all 7 spared. PII kept forever: the probes'
--                               `timestamp` is now(). This is why the column
--                               choice above is load-bearing and not stylistic.
--   14d -> 16d                  all 7 spared. Boundary too loose.
--   14d -> 12d                  A and E selected. Boundary too tight.
--   drop the `?|` predicate     D and G selected. Non-PII rows lose their
--                               protection — this is the control for "it is
--                               still an audit log".
--
-- Grants, same method:
--   omitting `REVOKE ... FROM PUBLIC` and keeping only the role-level revokes
--   leaves has_function_privilege('anon', ...) = TRUE. With the line present it
--   is FALSE. The ordering in section 5 is load-bearing (BACKLOG-2436).
--
-- Clamp: p_retention_days 0 -> 1, 9999 -> 90.
-- Schedule: registers as '23 * * * *', active.
--
-- ## B. NOT RE-REHEARSED AS A WRITE — the action and the third key
--
-- Two things changed after that rehearsal: DELETE became UPDATE, and `email`
-- joined the key list. **Neither has been executed against production as a
-- write.** Say so plainly rather than let section A read as covering them.
--
-- What WAS done, on 2026-09-19, is a read-only rehearsal: the blanking
-- expression was evaluated over every matching production row inside a SELECT,
-- which writes nothing.
--
--   WITH target AS (
--     SELECT id, action, created_at, metadata,
--            metadata - ARRAY['name','propertyAddress','email']::text[] AS blanked
--     FROM audit_logs
--     WHERE metadata ?| ARRAY['name','propertyAddress','email']
--   ) SELECT ...
--
--   No matched row still carried any of the three keys after blanking. Every
--   matched MAILBOX_CONNECT row kept its `provider`. Rows that did not match —
--   including every row carrying only `updatedFields` — were never touched.
--   The 13d / 14d / 15d boundary behaved as section A describes.
--
--   Row counts: BACKLOG-3052 (tracker).
--
--   every metadata key that survives blanking, across every matched row:
--     attachmentsCount, bulkOperation, format, hiddenTextCount, messagesCount,
--     pending, provider, reason, restored_from, transactionId
--
-- That last line is the one worth reading twice: after blanking, the surviving
-- key set contains counts, enums and ids, and nobody's identity.
--
-- Before applying, re-run section B's SELECT (it is read-only and takes a
-- second) and then run the checks below.
-- ============================================================================

-- ============================================================================
-- POST-APPLY VERIFICATION (run by hand; not part of the migration)
-- ============================================================================
-- WHO APPLIES THIS, AND WHEN
--
-- By hand, after review, and AFTER a desktop build carrying
-- `auditService.stripPiiForCloud` has rolled out. Nothing in .github/workflows/
-- runs `supabase db push` or `supabase migration up` — checked, there is no
-- auto-apply on merge — so merging this PR does NOT apply it. It is a separate,
-- deliberate step.
--
-- THE ROLLOUT WINDOW
--
-- Applying this does not stop the uploads. Every desktop on the shipped build
-- keeps sending these keys every 60 seconds until it auto-updates to a build
-- containing the gate. So check 1 below reads 0 at the moment it is applied and
-- non-zero shortly after, and that is expected, not a failed migration. The
-- hourly job caps that exposure at 14 days, which is the whole guarantee until
-- the client rollout completes.
--
-- Order that shortens the window: ship the desktop build first, then apply.
--
-- -- 0. BEFORE applying: record the row count, so check 2 has something to
-- --    compare against. The number to use is the one you measure here, at
-- --    apply time.
-- SELECT count(*) FROM audit_logs;
--
-- -- 1. No row carries an identity key any more (see the rollout note above
-- --    before reading a non-zero result as a failure):
-- SELECT count(*) FROM audit_logs WHERE metadata ?| ARRAY['name','propertyAddress','email'];
-- --    expected: 0 at apply time
--
-- -- 2. NOTHING WAS DELETED. This is the check that distinguishes this version
-- --    of the migration from the one it replaced:
-- SELECT count(*) FROM audit_logs;
-- --    expected: exactly the number from check 0.
--
-- -- 3. The blanked rows are still audit records — they kept their action,
-- --    their user and their operational metadata:
-- SELECT count(*) FROM audit_logs WHERE action = 'MAILBOX_CONNECT' AND metadata ? 'provider';
-- --    expected: the same count you measure before applying, and never fewer
-- --    afterwards
-- SELECT count(*) FROM audit_logs WHERE user_id IS NOT NULL;
-- --    expected: unchanged by this migration
--
-- -- 4. The job is registered and active:
-- SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'purge-audit-log-pii';
--
-- -- 5. anon cannot call it:
-- SELECT has_function_privilege('anon', 'public.purge_audit_log_pii(integer)', 'EXECUTE');
-- --    expected: false

-- ============================================================================
-- ROLLBACK
-- ============================================================================
-- SELECT cron.unschedule('purge-audit-log-pii');
-- DROP FUNCTION IF EXISTS public.purge_audit_log_pii(integer);
-- DROP INDEX IF EXISTS idx_audit_logs_pii_metadata;
-- DROP INDEX IF EXISTS idx_audit_logs_created_at;
-- (The backfill's blanking is not reversible — the values are gone. The ROWS
--  remain, which is the difference between this version and the one it
--  replaced.)
