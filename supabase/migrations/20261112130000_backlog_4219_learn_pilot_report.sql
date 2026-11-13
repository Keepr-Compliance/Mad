-- ============================================================
-- BACKLOG-4219 PR1: opt-in Learn pilot report (server side)
--
-- A pilot user who turns on "Share my score with Keepr" sends one numbers-only snapshot of their
-- Learn mode score and sender-filter census per sender-rules version. Keepr's team reads the
-- snapshots on the admin page (PR3), next to the 4175 rule-set versions and test orgs.
--
--   learn_pilot_reports                 one row per (user, sender_rules_version); max 5 per user
--   learn_pilot_report_submit(jsonb)    the caller's snapshot; org derived here, never passed in
--   learn_pilot_report_withdraw()       deletes every snapshot of the caller; returns the count
--   learn_pilot_report_admin_list()     report access 'learn-pilot' (BACKLOG-4144) only
--   cron 'purge-learn-pilot-reports'    daily; rows older than 180 days
--
-- PAYLOAD (schema 1). The server accepts exactly these keys at every level, nothing more and
-- nothing less. Every number is a non-negative integer <= 10000000. The only strings are
-- app_version (x.y.z), sender_rules_source (download | cache | bundled) and provider
-- (gmail | outlook | unknown). Map keys are fixed names, so no free text can ride in a key.
-- The desktop builder (PR2) mirrors this list with a Zod strictObject.
--   schema = 1, app_version, learn_rules_version, sender_rules_version (>= 1),
--   sender_rules_source, sender_rules_download_rejected (bool),
--   window_months, rows_scanned, null_sent_at, labels_without_local_mail, legacy_manual_positives,
--   detections, true_detections, known_wrong, matched_neutral, unmatched, unmatched_deals,
--   unaskable, seed_linked_to_deals, positives, found, missed,
--   deals_in_key {manual, auto, hybrid, rejected}, cleanup {yes, no, unanswered},
--   hidden_by_seed {keys, detections, emails},
--   recall, recall_with_cleanup_yes, recall_excluding_legacy,
--   recall_with_cleanup_yes_excluding_legacy, precision_before_cleanup,
--   precision_after_cleanup: {k, n},
--   side {correct, wrong, not_predicted, skipped}, outcome {scorable, skipped, predicted},
--   bulk {answered, real_estate, newsletter_spam, skip, not_cached,
--         newsletter_flagged {k, n}, real_estate_flagged {k, n}},
--   answers_by_rule_version [<= 10] {rule_version, deal, bulk},
--   census {learn_questions, detector}, each block:
--     mailboxes [<= 10] {ordinal, provider, n, full {k, by_signal}, minus_contact_keeps {k, by_signal},
--                        address_pass_ready (bool), detector_ready (bool)},
--     by_signal = all 7 signal names (seedAddress, approvedHost, localPart, bulkHeaders,
--                 gmailPromotions, gmailSocial, gmailUpdates), zero-filled,
--     min_linked_emails, bulk_caught {k, n}, real_estate_suppressed {k, n},
--     found_deals_lost {full, minus}, cleanup_yes_lost {full, minus}, kept_by {K1, K2, K3},
--     keep_conflicts, coverage {gmail, outlook, unknown: {rows, headers, labels}}.
-- The whole report is at most 32768 bytes. A new signal name = schema 2 + a new migration.
--
-- Rollback script: supabase/tests/backlog-4219/rollback-4219.sql
-- Harness: supabase/tests/backlog-4219/ (keepr-test only)
-- Idempotent: safe to apply twice.
-- ============================================================

-- ============================================================
-- 1. Validators: PRIVATE (no client role may execute them)
-- ============================================================

-- a non-negative integer <= 10000000
CREATE OR REPLACE FUNCTION public._learn_pilot_int_ok(v JSONB)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $fn$
  SELECT CASE
    WHEN jsonb_typeof(v) IS DISTINCT FROM 'number' THEN false
    ELSE coalesce((SELECT x = trunc(x) AND x >= 0 AND x <= 10000000
                   FROM (SELECT (v #>> '{}')::numeric AS x) n), false)
  END
$fn$;

REVOKE EXECUTE ON FUNCTION public._learn_pilot_int_ok(JSONB) FROM PUBLIC, anon, authenticated;

-- an object with exactly these keys, every value an integer
CREATE OR REPLACE FUNCTION public._learn_pilot_counts_ok(o JSONB, k TEXT[])
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $fn$
  SELECT public._sender_rule_set_keys_exact(o, k)
     AND NOT EXISTS (SELECT 1 FROM jsonb_each(o) e WHERE NOT public._learn_pilot_int_ok(e.value))
$fn$;

REVOKE EXECUTE ON FUNCTION public._learn_pilot_counts_ok(JSONB, TEXT[]) FROM PUBLIC, anon, authenticated;

-- one census block (census.learn_questions or census.detector): NULL when valid, else the reason
CREATE OR REPLACE FUNCTION public._learn_pilot_census_invalid(c JSONB)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $fn$
DECLARE
  v_signals CONSTANT TEXT[] := ARRAY['seedAddress', 'approvedHost', 'localPart', 'bulkHeaders',
                                     'gmailPromotions', 'gmailSocial', 'gmailUpdates'];
  v_rate CONSTANT TEXT[] := ARRAY['k', 'n'];
  m JSONB;
  part TEXT;
BEGIN
  IF NOT public._sender_rule_set_keys_exact(c, ARRAY['mailboxes', 'min_linked_emails', 'bulk_caught',
       'real_estate_suppressed', 'found_deals_lost', 'cleanup_yes_lost', 'kept_by', 'keep_conflicts',
       'coverage']) THEN
    RETURN 'census keys';
  END IF;
  IF jsonb_typeof(c->'mailboxes') IS DISTINCT FROM 'array' OR jsonb_array_length(c->'mailboxes') > 10 THEN
    RETURN 'census.mailboxes';
  END IF;
  FOR m IN SELECT x FROM jsonb_array_elements(c->'mailboxes') x LOOP
    IF NOT public._sender_rule_set_keys_exact(m, ARRAY['ordinal', 'provider', 'n', 'full',
         'minus_contact_keeps', 'address_pass_ready', 'detector_ready']) THEN
      RETURN 'mailbox keys';
    END IF;
    IF NOT public._learn_pilot_int_ok(m->'ordinal') OR NOT public._learn_pilot_int_ok(m->'n') THEN
      RETURN 'mailbox ints';
    END IF;
    IF jsonb_typeof(m->'provider') IS DISTINCT FROM 'string'
       OR (m->>'provider') NOT IN ('gmail', 'outlook', 'unknown') THEN
      RETURN 'mailbox provider';
    END IF;
    IF jsonb_typeof(m->'address_pass_ready') IS DISTINCT FROM 'boolean'
       OR jsonb_typeof(m->'detector_ready') IS DISTINCT FROM 'boolean' THEN
      RETURN 'mailbox flags';
    END IF;
    FOREACH part IN ARRAY ARRAY['full', 'minus_contact_keeps'] LOOP
      IF NOT public._sender_rule_set_keys_exact(m->part, ARRAY['k', 'by_signal'])
         OR NOT public._learn_pilot_int_ok(m->part->'k')
         OR NOT public._learn_pilot_counts_ok(m->part->'by_signal', v_signals) THEN
        RETURN 'mailbox ' || part;
      END IF;
    END LOOP;
  END LOOP;
  IF NOT public._learn_pilot_int_ok(c->'min_linked_emails') OR NOT public._learn_pilot_int_ok(c->'keep_conflicts') THEN
    RETURN 'census ints';
  END IF;
  IF NOT public._learn_pilot_counts_ok(c->'bulk_caught', v_rate)
     OR NOT public._learn_pilot_counts_ok(c->'real_estate_suppressed', v_rate)
     OR NOT public._learn_pilot_counts_ok(c->'found_deals_lost', ARRAY['full', 'minus'])
     OR NOT public._learn_pilot_counts_ok(c->'cleanup_yes_lost', ARRAY['full', 'minus'])
     OR NOT public._learn_pilot_counts_ok(c->'kept_by', ARRAY['K1', 'K2', 'K3']) THEN
    RETURN 'census counts';
  END IF;
  IF NOT public._sender_rule_set_keys_exact(c->'coverage', ARRAY['gmail', 'outlook', 'unknown'])
     OR EXISTS (SELECT 1 FROM jsonb_each(c->'coverage') e
                WHERE NOT public._learn_pilot_counts_ok(e.value, ARRAY['rows', 'headers', 'labels'])) THEN
    RETURN 'census coverage';
  END IF;
  RETURN NULL;
END
$fn$;

REVOKE EXECUTE ON FUNCTION public._learn_pilot_census_invalid(JSONB) FROM PUBLIC, anon, authenticated;

-- the whole report: NULL when valid, else the reason (a key name or a section, never a value)
CREATE OR REPLACE FUNCTION public._learn_pilot_report_invalid(p JSONB)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $fn$
DECLARE
  v_rate CONSTANT TEXT[] := ARRAY['k', 'n'];
  v_ints CONSTANT TEXT[] := ARRAY['learn_rules_version', 'sender_rules_version', 'window_months',
    'rows_scanned', 'null_sent_at', 'labels_without_local_mail', 'legacy_manual_positives',
    'detections', 'true_detections', 'known_wrong', 'matched_neutral', 'unmatched', 'unmatched_deals',
    'unaskable', 'seed_linked_to_deals', 'positives', 'found', 'missed'];
  v_rates CONSTANT TEXT[] := ARRAY['recall', 'recall_with_cleanup_yes', 'recall_excluding_legacy',
    'recall_with_cleanup_yes_excluding_legacy', 'precision_before_cleanup', 'precision_after_cleanup'];
  k TEXT;
  a JSONB;
  r TEXT;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' THEN
    RETURN 'not an object';
  END IF;
  IF octet_length(p::text) > 32768 THEN
    RETURN 'too large';
  END IF;
  IF NOT public._sender_rule_set_keys_exact(p, v_ints || v_rates || ARRAY['schema', 'app_version',
       'sender_rules_source', 'sender_rules_download_rejected', 'deals_in_key', 'cleanup',
       'hidden_by_seed', 'side', 'outcome', 'bulk', 'answers_by_rule_version', 'census']) THEN
    RETURN 'report keys';
  END IF;
  IF p->'schema' IS DISTINCT FROM '1'::jsonb THEN
    RETURN 'schema';
  END IF;
  IF jsonb_typeof(p->'app_version') IS DISTINCT FROM 'string'
     OR (p->>'app_version') !~ '^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}$' THEN
    RETURN 'app_version';
  END IF;
  IF jsonb_typeof(p->'sender_rules_source') IS DISTINCT FROM 'string'
     OR (p->>'sender_rules_source') NOT IN ('download', 'cache', 'bundled') THEN
    RETURN 'sender_rules_source';
  END IF;
  IF jsonb_typeof(p->'sender_rules_download_rejected') IS DISTINCT FROM 'boolean' THEN
    RETURN 'sender_rules_download_rejected';
  END IF;
  FOREACH k IN ARRAY v_ints LOOP
    IF NOT public._learn_pilot_int_ok(p->k) THEN
      RETURN k;
    END IF;
  END LOOP;
  IF (p->>'sender_rules_version')::numeric < 1 THEN
    RETURN 'sender_rules_version';
  END IF;
  FOREACH k IN ARRAY v_rates LOOP
    IF NOT public._learn_pilot_counts_ok(p->k, v_rate) THEN
      RETURN k;
    END IF;
  END LOOP;
  IF NOT public._learn_pilot_counts_ok(p->'deals_in_key', ARRAY['manual', 'auto', 'hybrid', 'rejected']) THEN
    RETURN 'deals_in_key';
  END IF;
  IF NOT public._learn_pilot_counts_ok(p->'cleanup', ARRAY['yes', 'no', 'unanswered']) THEN
    RETURN 'cleanup';
  END IF;
  IF NOT public._learn_pilot_counts_ok(p->'hidden_by_seed', ARRAY['keys', 'detections', 'emails']) THEN
    RETURN 'hidden_by_seed';
  END IF;
  IF NOT public._learn_pilot_counts_ok(p->'side', ARRAY['correct', 'wrong', 'not_predicted', 'skipped']) THEN
    RETURN 'side';
  END IF;
  IF NOT public._learn_pilot_counts_ok(p->'outcome', ARRAY['scorable', 'skipped', 'predicted']) THEN
    RETURN 'outcome';
  END IF;
  IF NOT public._sender_rule_set_keys_exact(p->'bulk', ARRAY['answered', 'real_estate', 'newsletter_spam',
       'skip', 'not_cached', 'newsletter_flagged', 'real_estate_flagged'])
     OR NOT public._learn_pilot_counts_ok((p->'bulk') - 'newsletter_flagged'::text - 'real_estate_flagged'::text,
       ARRAY['answered', 'real_estate', 'newsletter_spam', 'skip', 'not_cached'])
     OR NOT public._learn_pilot_counts_ok(p->'bulk'->'newsletter_flagged', v_rate)
     OR NOT public._learn_pilot_counts_ok(p->'bulk'->'real_estate_flagged', v_rate) THEN
    RETURN 'bulk';
  END IF;
  IF jsonb_typeof(p->'answers_by_rule_version') IS DISTINCT FROM 'array'
     OR jsonb_array_length(p->'answers_by_rule_version') > 10 THEN
    RETURN 'answers_by_rule_version';
  END IF;
  FOR a IN SELECT x FROM jsonb_array_elements(p->'answers_by_rule_version') x LOOP
    IF NOT public._learn_pilot_counts_ok(a, ARRAY['rule_version', 'deal', 'bulk']) THEN
      RETURN 'answers_by_rule_version';
    END IF;
  END LOOP;
  IF NOT public._sender_rule_set_keys_exact(p->'census', ARRAY['learn_questions', 'detector']) THEN
    RETURN 'census';
  END IF;
  FOREACH k IN ARRAY ARRAY['learn_questions', 'detector'] LOOP
    r := public._learn_pilot_census_invalid(p->'census'->k);
    IF r IS NOT NULL THEN
      RETURN 'census.' || k || ': ' || r;
    END IF;
  END LOOP;
  RETURN NULL;
END
$fn$;

REVOKE EXECUTE ON FUNCTION public._learn_pilot_report_invalid(JSONB) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public._learn_pilot_report_invalid(JSONB) IS
  'BACKLOG-4219: NULL when a Learn pilot report matches schema 1 exactly, else the reason. Private.';

-- ============================================================
-- 2. Table
--    Reachable only through the SECURITY DEFINER functions below. No client privilege at all
--    (including TRUNCATE, which RLS never evaluates). RLS on with no policies.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.learn_pilot_reports (
  user_id               UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  sender_rules_version  BIGINT NOT NULL CHECK (sender_rules_version > 0),
  -- org at submit time (derived on the server)
  org_id                UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  report                JSONB NOT NULL,
  app_version           TEXT NOT NULL,
  submitted_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, sender_rules_version),
  CONSTRAINT learn_pilot_reports_version_matches
    CHECK (sender_rules_version = (report->>'sender_rules_version')::bigint)
);

CREATE INDEX IF NOT EXISTS idx_learn_pilot_reports_submitted_at
  ON public.learn_pilot_reports(submitted_at);

REVOKE ALL ON public.learn_pilot_reports FROM PUBLIC, anon, authenticated;
ALTER TABLE public.learn_pilot_reports ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.learn_pilot_reports IS
  'BACKLOG-4219: opt-in Learn pilot snapshots, one per (user, sender rules version), max 5 per user, 180 days. Numbers only.';

-- the report key for the admin page (BACKLOG-4144 report access)
INSERT INTO public.reports (report_key) VALUES ('learn-pilot') ON CONFLICT (report_key) DO NOTHING;

-- ============================================================
-- 3. learn_pilot_report_submit — the caller's snapshot for one sender rules version
-- ============================================================
CREATE OR REPLACE FUNCTION public.learn_pilot_report_submit(p_report JSONB)
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_uid UUID := auth.uid();
  v_org UUID;
  v_reason TEXT;
  v_version BIGINT;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501';
  END IF;

  -- one submit at a time per user (two machines for one user)
  PERFORM pg_advisory_xact_lock(hashtextextended(v_uid::text, 4219));

  -- the org: same rule as sender_rule_set_current (BACKLOG-4175), brokerage before personal
  SELECT om.organization_id INTO v_org
  FROM public.organization_members om
  JOIN public.organizations o ON o.id = om.organization_id
  WHERE om.user_id = v_uid
    AND om.license_status = 'active'
  ORDER BY (o.personal_owner_user_id IS NOT NULL), om.created_at ASC NULLS LAST, om.id
  LIMIT 1;

  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;

  IF (public.check_feature_access(v_org, 'autodetect_eval') ->> 'allowed') IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;

  v_reason := public._learn_pilot_report_invalid(p_report);
  IF v_reason IS NOT NULL THEN
    RAISE EXCEPTION 'Invalid report' USING ERRCODE = '22023', DETAIL = v_reason;
  END IF;

  -- read only after validation: an integer >= 1
  v_version := (p_report->>'sender_rules_version')::bigint;

  INSERT INTO public.learn_pilot_reports (user_id, sender_rules_version, org_id, report, app_version, submitted_at)
  VALUES (v_uid, v_version, v_org, p_report, p_report->>'app_version', now())
  ON CONFLICT (user_id, sender_rules_version) DO UPDATE
    SET org_id = EXCLUDED.org_id,
        report = EXCLUDED.report,
        app_version = EXCLUDED.app_version,
        submitted_at = EXCLUDED.submitted_at;

  -- keep the caller's 5 most recently submitted versions (not the 5 highest: versions go down too)
  DELETE FROM public.learn_pilot_reports
  WHERE user_id = v_uid
    AND sender_rules_version NOT IN (
      SELECT x.sender_rules_version FROM public.learn_pilot_reports x
      WHERE x.user_id = v_uid
      ORDER BY x.submitted_at DESC, x.sender_rules_version DESC
      LIMIT 5);

  -- retention sweep (the daily job does the same)
  DELETE FROM public.learn_pilot_reports WHERE submitted_at < now() - interval '180 days';
END
$fn$;

REVOKE EXECUTE ON FUNCTION public.learn_pilot_report_submit(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.learn_pilot_report_submit(JSONB) TO authenticated;

COMMENT ON FUNCTION public.learn_pilot_report_submit(JSONB) IS
  'BACKLOG-4219: store the caller''s Learn pilot snapshot for its sender rules version. Caller-bound; org derived on the server; autodetect_eval required; schema 1 exactly.';

-- ============================================================
-- 4. learn_pilot_report_withdraw — delete every snapshot of the caller
--    No feature or membership check: a user who lost the feature or left the org can still
--    delete their own rows.
-- ============================================================
CREATE OR REPLACE FUNCTION public.learn_pilot_report_withdraw()
RETURNS INTEGER
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_uid UUID := auth.uid();
  v_n INTEGER;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.learn_pilot_reports WHERE user_id = v_uid;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$fn$;

REVOKE EXECUTE ON FUNCTION public.learn_pilot_report_withdraw() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.learn_pilot_report_withdraw() TO authenticated;

COMMENT ON FUNCTION public.learn_pilot_report_withdraw() IS
  'BACKLOG-4219: delete every Learn pilot snapshot of the caller; returns the number deleted. Caller-bound.';

-- ============================================================
-- 5. learn_pilot_report_admin_list — the admin page read
--    Internal role AND report access 'learn-pilot' (owner | editor | viewer). Rows from the last
--    180 days whose user is still an active member of the row's org. Joined to the 4175 rule-set
--    versions and pins; never returns published_by or pinned_by. Each row names its user by Keepr
--    user id (user_id) and name (user_name: display_name, else first + last name, else NULL; the
--    admin users list rule). A name containing '@' is returned as NULL. Email is never returned.
-- ============================================================
CREATE OR REPLACE FUNCTION public.learn_pilot_report_admin_list()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_uid UUID := auth.uid();
  v_rows JSONB;
  v_total BIGINT;
BEGIN
  IF v_uid IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.internal_roles ir WHERE ir.user_id = v_uid)
     OR public.report_my_access('learn-pilot') IS NULL THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;

  WITH visible AS (
    SELECT r.*
    FROM public.learn_pilot_reports r
    WHERE r.submitted_at >= now() - interval '180 days'
      AND EXISTS (SELECT 1 FROM public.organization_members om
                  WHERE om.user_id = r.user_id AND om.organization_id = r.org_id
                    AND om.license_status = 'active')
  ), page AS (
    SELECT v.* FROM visible v ORDER BY v.submitted_at DESC, v.user_id, v.sender_rules_version LIMIT 200
  )
  SELECT
    coalesce(jsonb_agg(jsonb_build_object(
      'org_id', pg.org_id,
      'org_name', o.name,
      'user_id', pg.user_id,
      'user_name', CASE WHEN nm.name LIKE '%@%' THEN NULL ELSE nm.name END,
      'sender_rules_version', pg.sender_rules_version,
      'version_released', s.released,
      'version_bundled', s.bundled,
      'version_published_at', s.published_at,
      'version_canary_org', s.canary_org,
      'version_was_canary_for_this_org', coalesce(s.canary_org = pg.org_id, false),
      'org_current_pin_version', p.version,
      'org_current_pin_at', p.pinned_at,
      'report', pg.report,
      'app_version', pg.app_version,
      'submitted_at', pg.submitted_at
    ) ORDER BY pg.submitted_at DESC, pg.user_id, pg.sender_rules_version), '[]'::jsonb),
    (SELECT count(*) FROM visible)
  INTO v_rows, v_total
  FROM page pg
  LEFT JOIN public.organizations o ON o.id = pg.org_id
  LEFT JOIN public.users pu ON pu.id = pg.user_id
  LEFT JOIN LATERAL (SELECT coalesce(nullif(pu.display_name, ''),
                                     nullif(concat_ws(' ', nullif(pu.first_name, ''), nullif(pu.last_name, '')), '')) AS name) nm ON true
  LEFT JOIN public.sender_rule_sets s ON s.version = pg.sender_rules_version
  LEFT JOIN public.sender_rule_set_pins p ON p.org_id = pg.org_id;

  RETURN jsonb_build_object('rows', v_rows, 'truncated', v_total > 200);
END
$fn$;

REVOKE EXECUTE ON FUNCTION public.learn_pilot_report_admin_list() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.learn_pilot_report_admin_list() TO authenticated;

COMMENT ON FUNCTION public.learn_pilot_report_admin_list() IS
  'BACKLOG-4219: Learn pilot snapshots for the admin page (newest 200 + truncated). Internal role and report access learn-pilot required.';

-- ============================================================
-- 6. Retention: a daily job deletes rows older than 180 days, so an idle user's snapshot goes too.
--    cron.schedule upserts on the job name, so a second apply re-points the same job.
-- ============================================================
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

SELECT cron.schedule(
  'purge-learn-pilot-reports',
  '17 4 * * *',
  $$DELETE FROM public.learn_pilot_reports WHERE submitted_at < now() - interval '180 days'$$
);
