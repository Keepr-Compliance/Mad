-- BACKLOG-4212 rollback (20261116100000_backlog_4212_user_suppress_threshold.sql).
-- Restores public._sender_rule_set_invalid(JSONB) exactly as 20261107235503 (BACKLOG-4175) defined
-- it: thresholds keys exactly minCensusLinkedEmails, reportSendIntervalHours, reportMaxRows.
-- Run only while no row of public.sender_rule_sets carries thresholds.userSuppressMinAnswers.
-- Copied verbatim from the 4175 migration (the 4212 harness checks the restored definition equals
-- the one keepr-test had before the 4212 migration ran).
-- the whole rule set. NULL when valid, else a short reason ("suppress.hosts[3]: not a valid host").
CREATE OR REPLACE FUNCTION public._sender_rule_set_invalid(p JSONB)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $fn$
DECLARE
  v_r TEXT;
  v_bad BIGINT;
  v_sig TEXT;
  v_surf TEXT;
  v_allowed JSONB;
BEGIN
  IF NOT public._sender_rule_set_keys_exact(p, ARRAY['schema', 'version', 'suppress', 'keep', 'freeMailDomains', 'thresholds', 'modes']) THEN
    RETURN 'root: keys';
  END IF;
  IF NOT public._sender_rule_set_int_ok(p->'schema', 1, 1) THEN
    RETURN 'schema: must be 1';
  END IF;
  IF NOT public._sender_rule_set_int_ok(p->'version', 1, 9007199254740991) THEN
    RETURN 'version: not a positive integer';
  END IF;

  -- suppress
  IF NOT public._sender_rule_set_keys_exact(p->'suppress', ARRAY['exactAddresses', 'hosts', 'localParts', 'bulkHeaders']) THEN
    RETURN 'suppress: keys';
  END IF;
  v_r := public._sender_rule_set_list_invalid(p #> '{suppress,exactAddresses}', 500, 'address');
  IF v_r IS NOT NULL THEN RETURN 'suppress.exactAddresses' || v_r; END IF;
  v_r := public._sender_rule_set_list_invalid(p #> '{suppress,hosts}', 2000, 'host');
  IF v_r IS NOT NULL THEN RETURN 'suppress.hosts' || v_r; END IF;
  IF jsonb_typeof(p #> '{suppress,localParts}') IS DISTINCT FROM 'array' THEN
    RETURN 'suppress.localParts: not a list';
  END IF;
  IF jsonb_array_length(p #> '{suppress,localParts}') > 50 THEN
    RETURN 'suppress.localParts: more than 50 items';
  END IF;
  SELECT min(e.i) INTO v_bad
  FROM jsonb_array_elements(p #> '{suppress,localParts}') WITH ORDINALITY AS e(v, i)
  WHERE NOT (public._sender_rule_set_keys_exact(e.v, ARRAY['value', 'match'])
             AND public._sender_rule_set_str_ok(e.v->'value', 'localpart')
             AND coalesce(e.v->'match' IN ('"exact"'::jsonb, '"prefix"'::jsonb), false));
  IF v_bad IS NOT NULL THEN
    RETURN 'suppress.localParts[' || (v_bad - 1) || ']: not a valid item';
  END IF;
  IF NOT public._sender_rule_set_keys_exact(p #> '{suppress,bulkHeaders}', ARRAY['anyKeyPresent', 'precedenceValues', 'autoSubmittedCounts']) THEN
    RETURN 'suppress.bulkHeaders: keys';
  END IF;
  v_r := public._sender_rule_set_list_invalid(p #> '{suppress,bulkHeaders,anyKeyPresent}', 4, 'bulkkey');
  IF v_r IS NOT NULL THEN RETURN 'suppress.bulkHeaders.anyKeyPresent' || v_r; END IF;
  v_r := public._sender_rule_set_list_invalid(p #> '{suppress,bulkHeaders,precedenceValues}', 10, 'precedence');
  IF v_r IS NOT NULL THEN RETURN 'suppress.bulkHeaders.precedenceValues' || v_r; END IF;
  IF jsonb_typeof(p #> '{suppress,bulkHeaders,autoSubmittedCounts}') IS DISTINCT FROM 'boolean' THEN
    RETURN 'suppress.bulkHeaders.autoSubmittedCounts: not a boolean';
  END IF;

  -- keep
  IF NOT public._sender_rule_set_keys_exact(p->'keep', ARRAY['platformHosts', 'platformAddresses']) THEN
    RETURN 'keep: keys';
  END IF;
  v_r := public._sender_rule_set_list_invalid(p #> '{keep,platformHosts}', 200, 'host');
  IF v_r IS NOT NULL THEN RETURN 'keep.platformHosts' || v_r; END IF;
  v_r := public._sender_rule_set_list_invalid(p #> '{keep,platformAddresses}', 200, 'address');
  IF v_r IS NOT NULL THEN RETURN 'keep.platformAddresses' || v_r; END IF;

  -- freeMailDomains
  v_r := public._sender_rule_set_list_invalid(p->'freeMailDomains', 500, 'host');
  IF v_r IS NOT NULL THEN RETURN 'freeMailDomains' || v_r; END IF;

  -- thresholds
  IF NOT public._sender_rule_set_keys_exact(p->'thresholds', ARRAY['minCensusLinkedEmails', 'reportSendIntervalHours', 'reportMaxRows']) THEN
    RETURN 'thresholds: keys';
  END IF;
  IF NOT public._sender_rule_set_int_ok(p #> '{thresholds,minCensusLinkedEmails}', 0, 9007199254740991) THEN
    RETURN 'thresholds.minCensusLinkedEmails: not an integer >= 0';
  END IF;
  IF NOT public._sender_rule_set_int_ok(p #> '{thresholds,reportSendIntervalHours}', 1, 9007199254740991) THEN
    RETURN 'thresholds.reportSendIntervalHours: not a positive integer';
  END IF;
  IF NOT public._sender_rule_set_int_ok(p #> '{thresholds,reportMaxRows}', 1, 500) THEN
    RETURN 'thresholds.reportMaxRows: not an integer 1-500';
  END IF;

  -- modes: 7 signals x 3 surfaces; gmailUpdates is measure-only
  IF NOT public._sender_rule_set_keys_exact(p->'modes', ARRAY['seedAddress', 'approvedHost', 'localPart', 'bulkHeaders', 'gmailPromotions', 'gmailSocial', 'gmailUpdates']) THEN
    RETURN 'modes: keys';
  END IF;
  FOREACH v_sig IN ARRAY ARRAY['seedAddress', 'approvedHost', 'localPart', 'bulkHeaders', 'gmailPromotions', 'gmailSocial', 'gmailUpdates'] LOOP
    IF NOT public._sender_rule_set_keys_exact(p #> ARRAY['modes', v_sig], ARRAY['learnQuestions', 'addressPass', 'detector']) THEN
      RETURN 'modes.' || v_sig || ': keys';
    END IF;
    v_allowed := CASE WHEN v_sig = 'gmailUpdates' THEN '["off", "measure"]'::jsonb ELSE '["off", "measure", "live"]'::jsonb END;
    FOREACH v_surf IN ARRAY ARRAY['learnQuestions', 'addressPass', 'detector'] LOOP
      IF NOT (jsonb_typeof(p #> ARRAY['modes', v_sig, v_surf]) = 'string'
              AND v_allowed @> jsonb_build_array(p #> ARRAY['modes', v_sig, v_surf])) THEN
        RETURN 'modes.' || v_sig || '.' || v_surf || ': not an allowed mode';
      END IF;
    END LOOP;
  END LOOP;

  RETURN NULL;
END
$fn$;

REVOKE EXECUTE ON FUNCTION public._sender_rule_set_invalid(JSONB) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public._sender_rule_set_invalid(JSONB) IS
  'BACKLOG-4175: NULL when a rule set is valid (mirrors ruleSetSchema.ts, server stricter on non-ASCII), else the reason. Private; also the CHECK on sender_rule_sets.';
