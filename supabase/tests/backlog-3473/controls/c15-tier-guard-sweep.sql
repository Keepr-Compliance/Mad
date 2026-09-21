-- C15 (Addendum B R5): the min-tier guard, swept across its boundaries, for
-- ALL THREE read functions. Each case is read by a member of the org, the org
-- has a plan, and the override is present -- so the guard is the only
-- decision. Pinned per case: enabled, source, override_ignored; no `error`.
--
--   case  org x key (override)                   scope all              scope narrow
--   15.1  I  x transaction_checklists (ON)        false plan ignored     same
--   15.2  T1 x transaction_checklists (ON)        true override          same
--   15.3  T2 x transaction_checklists (none)      false plan             same    (baseline)
--   15.4  E  x transaction_checklists (none)      true plan              same    (baseline)
--   15.5  E  x transaction_checklists (OFF, set in this control)
--                                                 false override         same    (NOT load-bearing:
--                                                 E is enterprise, no guard mutant can change it)
--   15.6  T1 x sso_login (ON)                     false plan ignored     true override
--   15.7  T1 x call_log (ON)                      true override          same
--   15.8  I  x call_log (ON)                      false plan ignored     true override
--   15.9  I  x desktop_hide_from_export (ON)      true override          same
--   15.10 I  x voice_transcription (OFF)          false override         same
--   15.11 C  x sso_login (ON), C on a custom plan  true override          same
--         (custom is legal but absent in production)
--
-- Mutants: m24a/b/c (guard reverted in one function each), m25 (< -> <=),
-- m26 (pinned to plan_tier = 'individual'), m27 (literal tier_rank('team')),
-- m28 (narrowing line live under scope all), m29 (ignores min_tier),
-- m30 (blocks an ON override when the plan row is false), m31 (enabled
-- conjunct dropped), m32 (tier map without custom).

CREATE TEMP TABLE t3473_c15 (c text, org text, member text, key text, exp_all jsonb, exp_narrow jsonb) ON COMMIT DROP;
INSERT INTO t3473_c15 VALUES
  ('15.1',  'o_i',  'u_i',        'transaction_checklists',   '{"enabled": false, "source": "plan", "override_ignored": true}', '{"enabled": false, "source": "plan", "override_ignored": true}'),
  ('15.2',  'o_t1', 'u_t1_agent', 'transaction_checklists',   '{"enabled": true, "source": "override"}',                         '{"enabled": true, "source": "override"}'),
  ('15.3',  'o_t2', 'u_t2_agent', 'transaction_checklists',   '{"enabled": false, "source": "plan"}',                            '{"enabled": false, "source": "plan"}'),
  ('15.4',  'o_e',  'u_e_agent',  'transaction_checklists',   '{"enabled": true, "source": "plan"}',                             '{"enabled": true, "source": "plan"}'),
  ('15.6',  'o_t1', 'u_t1_agent', 'sso_login',                '{"enabled": false, "source": "plan", "override_ignored": true}', '{"enabled": true, "source": "override"}'),
  ('15.7',  'o_t1', 'u_t1_agent', 'call_log',                 '{"enabled": true, "source": "override"}',                         '{"enabled": true, "source": "override"}'),
  ('15.8',  'o_i',  'u_i',        'call_log',                 '{"enabled": false, "source": "plan", "override_ignored": true}', '{"enabled": true, "source": "override"}'),
  ('15.9',  'o_i',  'u_i',        'desktop_hide_from_export', '{"enabled": true, "source": "override"}',                         '{"enabled": true, "source": "override"}'),
  ('15.10', 'o_i',  'u_i',        'voice_transcription',      '{"enabled": false, "source": "override"}',                        '{"enabled": false, "source": "override"}'),
  ('15.11', 'o_c',  'u_c_member', 'sso_login',                '{"enabled": true, "source": "override"}',                         '{"enabled": true, "source": "override"}');
GRANT ALL ON t3473_c15 TO authenticated;

CREATE FUNCTION pg_temp.c15_run(p_case text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  r    record;
  rpc  text;
  got  jsonb;
  norm jsonb;
  want jsonb;
BEGIN
  FOR r IN SELECT * FROM t3473_c15 WHERE c = p_case LOOP
    want := CASE current_setting('t3473.scope') WHEN 'narrow' THEN r.exp_narrow ELSE r.exp_all END;
    FOREACH rpc IN ARRAY ARRAY['check_feature_access', 'get_org_features', 'broker_get_org_features'] LOOP
      got := pg_temp.cell(rpc, pg_temp.id(r.org), r.key, pg_temp.id(r.member));
      norm := jsonb_build_object('enabled', got -> 'enabled', 'source', got -> 'source')
              || CASE WHEN got ? 'override_ignored' THEN jsonb_build_object('override_ignored', got -> 'override_ignored') ELSE '{}'::jsonb END;
      PERFORM pg_temp.check(NOT got ? 'error', format('C%s %s: no error, got %s', r.c, rpc, got));
      PERFORM pg_temp.check(norm = want, format('C%s %s %s x %s: want %s, got %s', r.c, rpc, r.org, r.key, want, got));
    END LOOP;
  END LOOP;
END
$$;

SELECT pg_temp.c15_run(c) FROM t3473_c15 ORDER BY c;

-- 15.5: E's OFF override, written now (after migration 1; OFF is never refused).
UPDATE public.organization_plans
   SET feature_overrides = '{"transaction_checklists": {"enabled": false}}'::jsonb
 WHERE organization_id = pg_temp.id('o_e');
INSERT INTO t3473_c15 VALUES
  ('15.5', 'o_e', 'u_e_agent', 'transaction_checklists', '{"enabled": false, "source": "override"}', '{"enabled": false, "source": "override"}');
SELECT pg_temp.c15_run('15.5');

DO $count$
BEGIN
  PERFORM pg_temp.check(current_setting('t3473.asserts')::int >= 66, 'C15 ran 11 cases x 3 functions x 2 checks');
END
$count$;
