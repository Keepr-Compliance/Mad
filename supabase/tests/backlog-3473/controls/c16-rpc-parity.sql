-- C16 (Addendum B R1, K6): parity of the three read functions, before
-- migration 1 (t3473_rpc_before, taken by run.sh after the fixtures and BEFORE
-- migration 1) against after (taken here, after migration 1 and any mutant).
--
-- Assertions on BOTH snapshots:
--   1 no counted cell carries `error`; get/broker `features` is an object
--   2 counts: check_feature_access member = 5 x |F|; get_org_features member
--     = 5 x |F|; broker_get_org_features member + non-member = 10 x |F|, with
--     |F| = count(feature_definitions) now; the keys transaction_checklists,
--     sso_login, call_log, desktop_hide_from_export, voice_transcription present
--   3 pinned literals (non-member and anon) equal the live bodies' outputs
--   4 preconditions: the plan rows the expected tuples rest on (K6)
--   5 proacl / prosecdef / provolatile / proconfig identical
-- Then the diff (raw cells, not only the pinned fields) must be EXACTLY:
--   scope all:    {T1 x sso_login, I x transaction_checklists, I x call_log}
--   scope narrow: {I x transaction_checklists}
--   x {check_feature_access member, get_org_features member,
--      broker_get_org_features member, broker_get_org_features non-member}
--   each: before {enabled true, source override, value 'false'}
--         after  {enabled false, source plan, value 'false', override_ignored true}
-- Named wrong implementation: building migration 1 from the repo's
-- 20260311224054 body instead of live changes the non-member
-- get_org_features literal -- assertion 3 reds it.
-- Mutants: m50a (broker gains a membership check), m50b (broker's anon early
-- return deleted), m50c (a blocked override falls to default, not the plan
-- row), m25 (< -> <=), m28 (narrowing line live under scope all), m24a/b/c.

SELECT pg_temp.act_owner();
CREATE TEMP TABLE t3473_rpc_after AS SELECT * FROM pg_temp.rpc_snapshot();

DO $c16$
DECLARE
  f        bigint := (SELECT count(*) FROM public.feature_definitions);
  snap     text;
  n        bigint;
  r        record;
  expected text[];
  got      text[];
BEGIN
  FOREACH snap IN ARRAY ARRAY['t3473_rpc_before', 't3473_rpc_after'] LOOP
    -- 1
    PERFORM pg_temp.check(pg_temp.n(format($q$SELECT count(*) FROM %I WHERE key = '#meta'
                                              AND (cell ->> 'has_error' <> 'false' OR cell ->> 'features_type' <> 'object')$q$, snap)) = 0,
                          snap || ': no get/broker counted response carries error; features is an object');
    PERFORM pg_temp.check(pg_temp.n(format($q$SELECT count(*) FROM %I WHERE rpc = 'check_feature_access'
                                              AND caller_kind = 'member' AND cell ? 'error'$q$, snap)) = 0,
                          snap || ': no counted check_feature_access cell carries error');
    -- 2
    n := pg_temp.n(format($q$SELECT count(*) FROM %I WHERE rpc = 'check_feature_access' AND caller_kind = 'member'$q$, snap));
    PERFORM pg_temp.check(n = 5 * f, format('%s: check_feature_access member cells %s = 5 x %s', snap, n, f));
    n := pg_temp.n(format($q$SELECT count(*) FROM %I WHERE rpc = 'get_org_features' AND caller_kind = 'member' AND key NOT LIKE '#%%'$q$, snap));
    PERFORM pg_temp.check(n = 5 * f, format('%s: get_org_features member cells %s = 5 x %s', snap, n, f));
    n := pg_temp.n(format($q$SELECT count(*) FROM %I WHERE rpc = 'broker_get_org_features' AND caller_kind IN ('member', 'non_member') AND key NOT LIKE '#%%'$q$, snap));
    PERFORM pg_temp.check(n = 10 * f, format('%s: broker_get_org_features cells %s = 10 x %s', snap, n, f));
    n := pg_temp.n(format($q$SELECT count(DISTINCT key) FROM %I WHERE rpc = 'check_feature_access' AND key IN
                            ('transaction_checklists', 'sso_login', 'call_log', 'desktop_hide_from_export', 'voice_transcription')$q$, snap));
    PERFORM pg_temp.check(n = 5, snap || ': the five keys the tuples rest on are present');
    -- 3
    n := pg_temp.n(format($q$SELECT count(*) FROM %I s WHERE key = '*' AND NOT (
            (s.rpc = 'check_feature_access' AND s.cell = '{"allowed": false, "error": "not_authorized"}'::jsonb)
         OR (s.rpc = 'get_org_features' AND s.cell = '{"error": "not_authorized", "features": []}'::jsonb)
         OR (s.rpc = 'broker_get_org_features' AND s.caller_kind = 'anon'
             AND s.cell - 'org_id' = '{"plan_name": "none", "plan_tier": "none", "features": {}, "error": "not_authenticated"}'::jsonb
             AND s.cell ? 'org_id'))$q$, snap));
    PERFORM pg_temp.check(n = 0, format('%s: %s pinned literal(s) differ from the live outputs', snap, n));
    n := pg_temp.n(format($q$SELECT count(*) FROM %I WHERE key = '*'$q$, snap));
    PERFORM pg_temp.check(n = 25, format('%s: 25 pinned responses (5 orgs x 5), got %s', snap, n));
  END LOOP;

  -- 4 (K6)
  FOR r IN SELECT * FROM (VALUES
    ('team', 'sso_login', 'false', 'NULL'), ('team', 'call_log', 'true', 'NULL'),
    ('individual', 'call_log', 'false', 'NULL'), ('individual', 'voice_transcription', 'false', 'NULL'),
    ('individual', 'desktop_hide_from_export', 'false', 'false'),
    ('individual', 'transaction_checklists', 'false', 'false'), ('team', 'transaction_checklists', 'false', 'false'),
    ('enterprise', 'transaction_checklists', 'true', 'true')
  ) v(slug, key, enabled, value) LOOP
    PERFORM pg_temp.check(
      (SELECT pf.enabled::text || '/' || coalesce(pf.value, 'NULL')
         FROM public.plan_features pf JOIN public.plans p ON p.id = pf.plan_id
         JOIN public.feature_definitions fd ON fd.id = pf.feature_id
        WHERE p.slug = r.slug AND fd.key = r.key) = r.enabled || '/' || r.value,
      format('precondition: %s x %s plan row is %s/%s', r.slug, r.key, r.enabled, r.value));
  END LOOP;

  -- 5
  PERFORM pg_temp.check(
    (SELECT count(*) FROM (SELECT key, cell FROM t3473_rpc_before WHERE rpc = '#fn'
                           EXCEPT SELECT key, cell FROM t3473_rpc_after WHERE rpc = '#fn') d) = 0
    AND (SELECT count(*) FROM t3473_rpc_after WHERE rpc = '#fn') = 3,
    'function metadata (acl, secdef, volatility, config) identical for the 3 functions');

  -- the diff
  SELECT array_agg(x ORDER BY x) INTO got FROM (
    SELECT coalesce(b.rpc, a.rpc) || '|' || coalesce(b.caller_kind, a.caller_kind) || '|' ||
           coalesce(b.org, a.org) || '|' || coalesce(b.key, a.key) AS x
      FROM t3473_rpc_before b
      FULL JOIN t3473_rpc_after a USING (rpc, caller_kind, org, key)
     WHERE coalesce(b.rpc, a.rpc) <> '#fn'
       AND b.cell IS DISTINCT FROM a.cell) d;
  SELECT array_agg(x ORDER BY x) INTO expected FROM (
    SELECT c.rpc || '|' || c.kind || '|' || t.org || '|' || t.key AS x
      FROM (VALUES ('check_feature_access', 'member'), ('get_org_features', 'member'),
                   ('broker_get_org_features', 'member'), ('broker_get_org_features', 'non_member')) c(rpc, kind)
     CROSS JOIN (VALUES ('T1', 'sso_login', 'all'), ('I', 'transaction_checklists', 'both'), ('I', 'call_log', 'all')) t(org, key, scope)
     WHERE t.scope = 'both' OR t.scope = current_setting('t3473.scope')) e;
  PERFORM pg_temp.check(got IS NOT DISTINCT FROM expected,
                        format('diff set (scope %s): want %s, got %s', current_setting('t3473.scope'), expected, got));

  FOR r IN
    SELECT b.rpc, b.caller_kind, b.org, b.key, b.cell AS bc, a.cell AS ac
      FROM t3473_rpc_before b JOIN t3473_rpc_after a USING (rpc, caller_kind, org, key)
     WHERE b.rpc <> '#fn' AND b.cell IS DISTINCT FROM a.cell
  LOOP
    PERFORM pg_temp.check(
      coalesce(r.bc -> 'enabled', r.bc -> 'allowed') = 'true'::jsonb AND r.bc ->> 'source' = 'override'
      AND r.bc ->> 'value' = 'false' AND NOT r.bc ? 'override_ignored',
      format('before %s %s %s %s: want enabled true / override / value false, got %s', r.rpc, r.caller_kind, r.org, r.key, r.bc));
    PERFORM pg_temp.check(
      coalesce(r.ac -> 'enabled', r.ac -> 'allowed') = 'false'::jsonb AND r.ac ->> 'source' = 'plan'
      AND r.ac ->> 'value' = 'false' AND r.ac -> 'override_ignored' = 'true'::jsonb,
      format('after %s %s %s %s: want enabled false / plan / value false / ignored, got %s', r.rpc, r.caller_kind, r.org, r.key, r.ac));
    PERFORM pg_temp.check(
      (r.ac - 'override_ignored' - 'enabled' - 'allowed' - 'source') = (r.bc - 'enabled' - 'allowed' - 'source'),
      format('%s %s %s %s: every other key unchanged', r.rpc, r.caller_kind, r.org, r.key));
  END LOOP;
END
$c16$;
