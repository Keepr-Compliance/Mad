-- BACKLOG-4257 PR A rollback (20261117120000_backlog_4257_learn_pilot_signals.sql).
-- Puts back the 4219 schema-1 validator text exactly (20261112130000), its comments, and drops the
-- signals validator. Schema-2 submits are refused again; schema 1 is unaffected.
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

COMMENT ON FUNCTION public.learn_pilot_report_submit(JSONB) IS
  'BACKLOG-4219: store the caller''s Learn pilot snapshot for its sender rules version. Caller-bound; org derived on the server; autodetect_eval required; schema 1 exactly.';

DROP FUNCTION IF EXISTS public._learn_pilot_signals_invalid(JSONB);
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261117120000';
