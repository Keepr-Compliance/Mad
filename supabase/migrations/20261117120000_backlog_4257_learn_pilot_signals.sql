-- ============================================================
-- BACKLOG-4257 PR A: Learn pilot report schema 2 (signal counts), server side
--
-- Schema 2 = every schema-1 key (20261112130000_backlog_4219_learn_pilot_report.sql) plus
-- 'signals', a counts-only block. Schema 1 is accepted exactly as before: everything in
-- _learn_pilot_report_invalid after the new schema-2 branch is the 4219 text unchanged.
--
--   _learn_pilot_signals_invalid(jsonb)   NEW, private: the signals block, signals_version 1 only
--   _learn_pilot_report_invalid(jsonb)    REPLACED: schema 2 branch (65536-byte cap, 'signals'
--                                         required and checked, then the schema-1 checks on the
--                                         report minus 'signals' with schema 1, 32768-byte cap)
--   learn_pilot_report_submit(jsonb)      comment only ("schema 1 or 2"); body and grants unchanged
-- No table change.
--
-- SIGNALS (signals_version 1). Exact keys at every level; every number a non-negative integer
-- <= 10000000; the only other leaves are the two booleans.
--   signals_version = 1, terms_version, deal_linked_capped (bool), detection_capped (bool),
--   emails {newsletter, real_estate_sample, deal_linked, content_positives, true_detection, gate,
--           body_truncated},
--   text_coverage {newsletter, content_positives, true_detection: {emails, with_attachments,
--                  with_attachment_text}},
--   baseline {anchor, stage, sender, filename, forms: {k, n}},
--   values {<family>: {<value name>: {newsletter {k, n}, positives {k, n},
--           gate {true_kept, true_lost, known_wrong_dropped, known_wrong_total, cleanup_no_dropped,
--                 cleanup_no_total, cleanup_yes_lost, cleanup_yes_total, unmeasured}}}}
--   value names: the five ARRAYs in _learn_pilot_signals_invalid (40 in all).
-- A changed value list = a new signals_version + a new migration.
--
-- Rollback script: supabase/tests/backlog-4257/rollback-4257.sql
-- Harness: supabase/tests/backlog-4257/ (keepr-test only)
-- Idempotent: safe to apply twice.
-- ============================================================

-- ============================================================
-- 1. Signals validator: PRIVATE (no client role may execute it)
-- ============================================================

-- the signals block of a schema-2 report: NULL when valid, else the reason (a section or a fixed
-- name, never a value). Value names = SIGNAL_VALUES ids (electron/services/learn/signalScoring.ts)
-- split on '.', verbatim.
CREATE OR REPLACE FUNCTION public._learn_pilot_signals_invalid(s JSONB)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $fn$
DECLARE
  v_rate CONSTANT TEXT[] := ARRAY['k', 'n'];
  v_gate CONSTANT TEXT[] := ARRAY['true_kept', 'true_lost', 'known_wrong_dropped', 'known_wrong_total',
    'cleanup_no_dropped', 'cleanup_no_total', 'cleanup_yes_lost', 'cleanup_yes_total', 'unmeasured'];
  v_coverage CONSTANT TEXT[] := ARRAY['emails', 'with_attachments', 'with_attachment_text'];
  v_families CONSTANT TEXT[] := ARRAY['anchor', 'stage', 'sender', 'filename', 'forms'];
  v_anchor CONSTANT TEXT[] := ARRAY['subject', 'bodyTop', 'bodyMid', 'afterSignature', 'footer', 'none', 'nearFooterCue', 'inQuoteOnly'];
  v_stage CONSTANT TEXT[] := ARRAY['offer', 'counter', 'underContract', 'inspection', 'appraisal', 'closing', 'any', 'inSubject'];
  v_sender CONSTANT TEXT[] := ARRAY['dealContact', 'vendorRoleDomain', 'dealContactDomain', 'platform', 'freeMail', 'other', 'recipientIsDealContact', 'bulk'];
  v_filename CONSTANT TEXT[] := ARRAY['purchaseAgreement', 'counteroffer', 'addendum', 'inspection', 'appraisal', 'closing', 'disclosure', 'listing', 'other'];
  v_forms CONSTANT TEXT[] := ARRAY['anyMatch', 'purchase_agreement', 'buyer_agreement', 'listing_agreement', 'counteroffer', 'representation_termination', 'other'];
  fam TEXT;
  names TEXT[];
  nm TEXT;
  k TEXT;
  v JSONB;
BEGIN
  IF jsonb_typeof(s) IS DISTINCT FROM 'object' THEN
    RETURN 'not an object';
  END IF;
  IF s->'signals_version' = '1'::jsonb THEN
    IF NOT public._sender_rule_set_keys_exact(s, ARRAY['signals_version', 'terms_version',
         'deal_linked_capped', 'detection_capped', 'emails', 'text_coverage', 'baseline', 'values']) THEN
      RETURN 'keys';
    END IF;
    IF NOT public._learn_pilot_int_ok(s->'terms_version') THEN
      RETURN 'terms_version';
    END IF;
    IF jsonb_typeof(s->'deal_linked_capped') IS DISTINCT FROM 'boolean'
       OR jsonb_typeof(s->'detection_capped') IS DISTINCT FROM 'boolean' THEN
      RETURN 'capped';
    END IF;
    IF NOT public._learn_pilot_counts_ok(s->'emails', ARRAY['newsletter', 'real_estate_sample', 'deal_linked',
         'content_positives', 'true_detection', 'gate', 'body_truncated']) THEN
      RETURN 'emails';
    END IF;
    IF NOT public._sender_rule_set_keys_exact(s->'text_coverage', ARRAY['newsletter', 'content_positives', 'true_detection']) THEN
      RETURN 'text_coverage';
    END IF;
    FOREACH k IN ARRAY ARRAY['newsletter', 'content_positives', 'true_detection'] LOOP
      IF NOT public._learn_pilot_counts_ok(s->'text_coverage'->k, v_coverage) THEN
        RETURN 'text_coverage.' || k;
      END IF;
    END LOOP;
    IF NOT public._sender_rule_set_keys_exact(s->'baseline', v_families) THEN
      RETURN 'baseline';
    END IF;
    IF NOT public._sender_rule_set_keys_exact(s->'values', v_families) THEN
      RETURN 'values';
    END IF;
    FOREACH fam IN ARRAY v_families LOOP
      IF NOT public._learn_pilot_counts_ok(s->'baseline'->fam, v_rate) THEN
        RETURN 'baseline.' || fam;
      END IF;
      names := CASE fam
        WHEN 'anchor' THEN v_anchor
        WHEN 'stage' THEN v_stage
        WHEN 'sender' THEN v_sender
        WHEN 'filename' THEN v_filename
        WHEN 'forms' THEN v_forms
      END;
      IF NOT public._sender_rule_set_keys_exact(s->'values'->fam, names) THEN
        RETURN 'values.' || fam;
      END IF;
      FOREACH nm IN ARRAY names LOOP
        v := s->'values'->fam->nm;
        IF NOT public._sender_rule_set_keys_exact(v, ARRAY['newsletter', 'positives', 'gate'])
           OR NOT public._learn_pilot_counts_ok(v->'newsletter', v_rate)
           OR NOT public._learn_pilot_counts_ok(v->'positives', v_rate)
           OR NOT public._learn_pilot_counts_ok(v->'gate', v_gate) THEN
          RETURN 'values.' || fam || '.' || nm;
        END IF;
      END LOOP;
    END LOOP;
    RETURN NULL;
  ELSE
    RETURN 'signals_version';
  END IF;
END
$fn$;

REVOKE EXECUTE ON FUNCTION public._learn_pilot_signals_invalid(JSONB) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public._learn_pilot_signals_invalid(JSONB) IS
  'BACKLOG-4257: NULL when the signals block of a schema-2 Learn pilot report matches signals_version 1 exactly, else the reason. Private.';

-- ============================================================
-- 2. Report validator: schema 1 or schema 2. PRIVATE.
--    CREATE OR REPLACE keeps the existing ACL; the REVOKE is restated anyway.
-- ============================================================

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
  -- BACKLOG-4257: schema 2 = every schema-1 key + 'signals'. Its own cap, the signals block, then
  -- the schema-1 checks below on the report without 'signals' (and its 32768 cap).
  IF p->'schema' = '2'::jsonb THEN
    IF octet_length(p::text) > 65536 THEN
      RETURN 'too large';
    END IF;
    IF NOT p ? 'signals' THEN
      RETURN 'signals';
    END IF;
    r := public._learn_pilot_signals_invalid(p->'signals');
    IF r IS NOT NULL THEN
      RETURN 'signals: ' || r;
    END IF;
    RETURN public._learn_pilot_report_invalid((p - 'signals') || '{"schema": 1}'::jsonb);
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
  'BACKLOG-4219/4257: NULL when a Learn pilot report matches schema 1 or schema 2 exactly, else the reason. Private.';

-- ============================================================
-- 3. Submit: comment only
-- ============================================================

COMMENT ON FUNCTION public.learn_pilot_report_submit(JSONB) IS
  'BACKLOG-4219: store the caller''s Learn pilot snapshot for its sender rules version. Caller-bound; org derived on the server; autodetect_eval required; schema 1 or 2.';
