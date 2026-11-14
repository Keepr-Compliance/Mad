-- ============================================================
-- BACKLOG-4212 PR1: optional rule-set threshold `thresholds.userSuppressMinAnswers`
--
-- Purpose: a rule set MAY carry thresholds.userSuppressMinAnswers, an integer 0-20 (0 = off):
-- how many "newsletter" answers a user gives about one sender before the desktop app hides that
-- sender's mail for that user only. The key is optional; a set without it stays valid.
-- Mirrors electron/utils/senderFilter/ruleSetSchema.ts and admin-portal/lib/sender-rules/validate.ts.
--
-- Changes ONE function: public._sender_rule_set_invalid(JSONB) (from 20261107235503, BACKLOG-4175).
-- Same signature, language, volatility (IMMUTABLE), SECURITY INVOKER, search_path = ''.
-- Only the thresholds block differs: the keys may be the three 4175 keys, or those three plus
-- userSuppressMinAnswers; when present it must be an integer 0-20. Every other function from 4175
-- (_sender_rule_set_keys_exact, _int_ok, _str_ok, _list_invalid, _release_blocks and the RPCs)
-- is unchanged; none of them reads thresholds.
--
-- No table changes. The CHECK sender_rule_sets_content_valid calls this function by name and
-- keeps working after CREATE OR REPLACE. Existing rows remain valid: the new function accepts
-- every rule set the 4175 function accepted (the three-key thresholds object is still allowed and
-- every other check is unchanged), so no stored row can start failing the CHECK. The shipped
-- (bundled) rule set is not changed and carries no new key.
--
-- Grants: as 4175 — private, EXECUTE revoked from PUBLIC, anon, authenticated; no GRANT. Callers
-- are the CHECK and the SECURITY DEFINER RPCs, which run as the owner. CREATE OR REPLACE keeps
-- the existing ACL; the REVOKE is restated anyway.
--
-- NOT APPLIED to production by this PR. Apply with the 2.49 release, after the PR merges.
-- Idempotent: safe to apply twice.
--
-- Rollback: run supabase/tests/backlog-4212/rollback-4212.sql, which restores the 4175 definition
-- of public._sender_rule_set_invalid(JSONB) verbatim (thresholds keys exactly
-- minCensusLinkedEmails, reportSendIntervalHours, reportMaxRows) plus its REVOKE and COMMENT.
-- Roll back only while no stored rule set carries userSuppressMinAnswers: the CHECK is not
-- re-run on existing rows, so such a row would remain but could no longer be re-validated.
-- ============================================================

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

  -- thresholds (BACKLOG-4212: userSuppressMinAnswers optional)
  IF NOT (public._sender_rule_set_keys_exact(p->'thresholds', ARRAY['minCensusLinkedEmails', 'reportSendIntervalHours', 'reportMaxRows'])
          OR public._sender_rule_set_keys_exact(p->'thresholds', ARRAY['minCensusLinkedEmails', 'reportSendIntervalHours', 'reportMaxRows', 'userSuppressMinAnswers'])) THEN
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
  IF (p->'thresholds') ? 'userSuppressMinAnswers'
     AND NOT public._sender_rule_set_int_ok(p #> '{thresholds,userSuppressMinAnswers}', 0, 20) THEN
    RETURN 'thresholds.userSuppressMinAnswers: not an integer 0-20';
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
  'BACKLOG-4175/4212: NULL when a rule set is valid (mirrors ruleSetSchema.ts, server stricter on non-ASCII), else the reason. thresholds.userSuppressMinAnswers optional, integer 0-20. Private; also the CHECK on sender_rule_sets.';
