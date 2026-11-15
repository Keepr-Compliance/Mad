-- BACKLOG-3513 PR-3h (migration 20261114100000, rows with several statuses / agents) DB controls.
-- Venue: keepr-test ONLY, where 20261112200000 is committed. Composed by compose.py: tracking off,
-- 20261114100000 twice (the second apply proves the pin's second-run branch), the PR-2 prelude
-- (fixtures; call_as = SET LOCAL ROLE authenticated + jwt claims), then this file. ONE call, ONE
-- transaction ending in RAISE: nothing persists. Output: RAISE 'P3513B_RESULT {total, pass, fail, reds}'.
--
-- Fixtures used from the PR-2 prelude (O1 = 101):
--   users 1 B1 broker, 2 B2 broker, 5 G1 agent, 6 G2 agent, 13 broker of T (broker_reports off),
--         14 no membership
--   O1 deal heads (scope all): 301 submitted G1, 303 resubmitted G1, 304 under_review G1,
--     306 needs_changes G2, 308 submitted B1, 310 resubmitted B1, 311 under_review B1,
--     312 approved A1, 313 submitted G3, 315 resubmitted G2.  (302, 307, 309 are superseded;
--     305, 314 uploading.)
--   402 'Report two' O1, owner B1, row_scope own, B2 viewer -> B2's effective scope is own; B2's
--     only own head is 309 (its child 310 is B1's, which own scope does not count).
--
-- The old single-value function is the oracle for parity: the multi result must equal the deduped
-- union of the old function's results for each (status, agent) pair, in the same sort order.

-- the multi function as user-visible json {ids (in returned order), total}
CREATE FUNCTION pg_temp.q_m(o int, def int, sts text[], ags int[], srt text DEFAULT 'newest', lim int DEFAULT 200, off int DEFAULT 0)
RETURNS text LANGUAGE sql AS $b$
  SELECT format('SELECT jsonb_build_object(''ids'', coalesce(jsonb_agg(pg_temp.nx(r.id) ORDER BY r.o), ''[]''), '
                '''total'', coalesce(max(r.total_count), 0)) '
                'FROM (SELECT x.*, row_number() OVER () AS o FROM public.broker_report_submissions_rows_multi('
                '%L::uuid, %s, %L::text[], %L::uuid[], NULL, NULL, %L, %s, %s) x) r',
                pg_temp.fx(o), CASE WHEN def IS NULL THEN 'NULL' ELSE quote_literal(pg_temp.fx(def)) || '::uuid' END,
                sts,
                CASE WHEN ags IS NULL THEN NULL
                     ELSE coalesce((SELECT array_agg(pg_temp.fx(a) ORDER BY a) FROM unnest(ags) a), '{}'::uuid[]) END,
                srt, lim, off)
$b$;
-- the old single-value function, same shape
CREATE FUNCTION pg_temp.q_o(o int, def int, st text, ag int, srt text DEFAULT 'newest')
RETURNS text LANGUAGE sql AS $b$
  SELECT format('SELECT jsonb_build_object(''ids'', coalesce(jsonb_agg(pg_temp.nx(r.id) ORDER BY r.o), ''[]''), '
                '''total'', coalesce(max(r.total_count), 0)) '
                'FROM (SELECT x.*, row_number() OVER () AS o FROM public.broker_report_submissions_rows('
                '%L::uuid, %s, %L, %L::uuid, NULL, NULL, %L, 200, 0) x) r',
                pg_temp.fx(o), CASE WHEN def IS NULL THEN 'NULL' ELSE quote_literal(pg_temp.fx(def)) || '::uuid' END,
                st, CASE WHEN ag IS NULL THEN NULL ELSE pg_temp.fx(ag) END, srt)
$b$;
-- ids of a reply, sorted (set comparison)
CREATE FUNCTION pg_temp.ids_sorted(s text) RETURNS jsonb LANGUAGE sql AS $b$
  SELECT CASE WHEN s LIKE 'ERR%' THEN to_jsonb(s)
              ELSE coalesce((SELECT jsonb_agg(e ORDER BY e::int) FROM jsonb_array_elements(s::jsonb -> 'ids') e), '[]') END
$b$;
-- multi, as u, sorted ids
CREATE FUNCTION pg_temp.m(u int, o int, def int, sts text[], ags int[]) RETURNS jsonb LANGUAGE sql AS $b$
  SELECT pg_temp.ids_sorted(pg_temp.call_as(u, pg_temp.q_m(o, def, sts, ags)))
$b$;
-- the oracle: deduped union of the old function over every (status, agent) pair, as u, sorted ids
CREATE FUNCTION pg_temp.union_old(u int, o int, def int, sts text[], ags int[]) RETURNS jsonb LANGUAGE plpgsql AS $b$
DECLARE acc int[] := '{}'; s text; st text; ag int; e jsonb;
BEGIN
  FOREACH st IN ARRAY coalesce(sts, ARRAY[NULL::text]) LOOP
    FOREACH ag IN ARRAY coalesce(ags, ARRAY[NULL::int]) LOOP
      s := pg_temp.call_as(u, pg_temp.q_o(o, def, st, ag));
      IF s LIKE 'ERR%' THEN RETURN to_jsonb(s); END IF;
      FOR e IN SELECT * FROM jsonb_array_elements(s::jsonb -> 'ids') LOOP
        acc := acc || (e #>> '{}')::int;
      END LOOP;
    END LOOP;
  END LOOP;
  RETURN coalesce((SELECT jsonb_agg(DISTINCT x ORDER BY x) FROM unnest(acc) x), '[]');
END $b$;
CREATE FUNCTION pg_temp.eq(got jsonb, want jsonb) RETURNS text LANGUAGE sql AS $b$
  SELECT pg_temp.pass(got = want, 'got ' || got::text || ' want ' || want::text)
$b$;

CREATE FUNCTION pg_temp.run() RETURNS jsonb LANGUAGE plpgsql AS $b$
DECLARE
  r jsonb := '{}'::jsonb;
  s text;
  s2 text;
  st text;
  srt text;
  bad text := '';
  ALL_HEADS jsonb := '[301, 303, 304, 306, 308, 310, 311, 312, 313, 315]';
  NEW_SIG text := 'public.broker_report_submissions_rows_multi(uuid,uuid,text[],uuid[],timestamptz,timestamptz,text,integer,integer)';
  OLD_SIG text := 'public.broker_report_submissions_rows(uuid,uuid,text,uuid,timestamptz,timestamptz,text,integer,integer)';
BEGIN
  PERFORM pg_temp.setup();

  -- ===== catalog =====
  r := r || jsonb_build_object('C_current_user', pg_temp.pass(
    pg_temp.call_as(1, 'SELECT to_jsonb(current_user::text)') = 'authenticated', 'not authenticated'));
  SELECT prosecdef::text || '/' || provolatile::text || '/' || coalesce(proconfig::text, 'null')
    INTO s FROM pg_proc WHERE oid = to_regprocedure(NEW_SIG);
  r := r || jsonb_build_object('C_invoker_stable_search_path', pg_temp.pass(s = 'false/s/{search_path=public}', s));
  SELECT has_function_privilege('anon', to_regprocedure(NEW_SIG), 'EXECUTE')::text || '/'
         || has_function_privilege('authenticated', to_regprocedure(NEW_SIG), 'EXECUTE')::text || '/'
         || (coalesce(proacl::text, '') NOT LIKE '%{=X%' AND coalesce(proacl::text, '') NOT LIKE '%,=X%'
             AND proacl IS NOT NULL)::text
    INTO s FROM pg_proc WHERE oid = to_regprocedure(NEW_SIG);
  r := r || jsonb_build_object('C_grants', pg_temp.pass(s = 'false/true/true', s));
  s := pg_temp.call_as(1, pg_temp.q_m(101, NULL, ARRAY['approved'], NULL), 'anon');
  r := r || jsonb_build_object('C_anon_refused', pg_temp.pass(s LIKE 'ERR 42501%', s));
  SELECT md5(prosrc) || '/' || has_function_privilege('authenticated', oid, 'EXECUTE')::text
         || '/' || has_function_privilege('anon', oid, 'EXECUTE')::text
    INTO s FROM pg_proc WHERE oid = to_regprocedure(OLD_SIG);
  r := r || jsonb_build_object('C_old_function_unchanged', pg_temp.pass(s = '922f977f729dd92cfcea89e51fc412ae/true/false', s));

  -- ===== statuses: union of each value's group =====
  r := r || jsonb_build_object('S_two_exact', pg_temp.eq(
    pg_temp.m(1, 101, NULL, ARRAY['under_review', 'needs_changes'], NULL), '[304, 306, 311]'));
  r := r || jsonb_build_object('S_two_exact_oracle', pg_temp.eq(
    pg_temp.m(1, 101, NULL, ARRAY['under_review', 'needs_changes'], NULL),
    pg_temp.union_old(1, 101, NULL, ARRAY['under_review', 'needs_changes'], NULL)));
  r := r || jsonb_build_object('S_groups_new_resubmitted', pg_temp.eq(
    pg_temp.m(1, 101, NULL, ARRAY['new', 'resubmitted'], NULL), '[301, 303, 308, 310, 313, 315]'));
  r := r || jsonb_build_object('S_group_pending_plus_approved', pg_temp.eq(
    pg_temp.m(1, 101, NULL, ARRAY['pending', 'approved'], NULL),
    pg_temp.union_old(1, 101, NULL, ARRAY['pending', 'approved'], NULL)));
  -- overlapping groups: each deal once, and total_count counts it once
  s := pg_temp.call_as(1, pg_temp.q_m(101, NULL, ARRAY['submitted', 'new', 'pending'], NULL));
  r := r || jsonb_build_object('S_overlap_deduped', pg_temp.pass(
    s NOT LIKE 'ERR%' AND (s::jsonb -> 'ids') = (SELECT (pg_temp.call_as(1, pg_temp.q_o(101, NULL, 'pending', NULL)))::jsonb -> 'ids')
    AND (s::jsonb ->> 'total')::int = jsonb_array_length(s::jsonb -> 'ids'), s));
  -- one value = the old function exactly (order and total too), for every value and every sort
  FOREACH st IN ARRAY ARRAY['submitted', 'pending', 'new', 'resubmitted', 'under_review', 'needs_changes', 'approved', 'rejected'] LOOP
    FOREACH srt IN ARRAY ARRAY['newest', 'oldest', 'status', 'price_desc', 'price_asc'] LOOP
      s := pg_temp.call_as(1, pg_temp.q_m(101, NULL, ARRAY[st], NULL, srt));
      s2 := pg_temp.call_as(1, pg_temp.q_o(101, NULL, st, NULL, srt));
      IF s IS DISTINCT FROM s2 THEN bad := bad || st || '/' || srt || ':' || s || '<>' || s2 || ' '; END IF;
    END LOOP;
  END LOOP;
  r := r || jsonb_build_object('S_single_value_parity', pg_temp.pass(bad = '', bad));
  -- no filter: NULL, {}, any 'all'
  r := r || jsonb_build_object('S_null_all_rows', pg_temp.eq(pg_temp.m(1, 101, NULL, NULL, NULL), ALL_HEADS));
  r := r || jsonb_build_object('S_empty_all_rows', pg_temp.eq(pg_temp.m(1, 101, NULL, '{}'::text[], NULL), ALL_HEADS));
  r := r || jsonb_build_object('S_all_all_rows', pg_temp.eq(pg_temp.m(1, 101, NULL, ARRAY['all'], NULL), ALL_HEADS));
  r := r || jsonb_build_object('S_all_plus_value_all_rows', pg_temp.eq(pg_temp.m(1, 101, NULL, ARRAY['approved', 'all'], NULL), ALL_HEADS));
  -- a NULL element is ignored, it does not turn the filter off
  r := r || jsonb_build_object('S_null_element_ignored', pg_temp.eq(pg_temp.m(1, 101, NULL, ARRAY[NULL, 'approved'], NULL), '[312]'));
  r := r || jsonb_build_object('S_unknown_value_matches_nothing', pg_temp.eq(pg_temp.m(1, 101, NULL, ARRAY['bogus'], NULL), '[]'));

  -- ===== agents =====
  r := r || jsonb_build_object('A_two_agents', pg_temp.eq(pg_temp.m(1, 101, NULL, NULL, ARRAY[5, 6]), '[301, 303, 304, 306, 315]'));
  r := r || jsonb_build_object('A_two_agents_oracle', pg_temp.eq(
    pg_temp.m(1, 101, NULL, NULL, ARRAY[5, 6]), pg_temp.union_old(1, 101, NULL, NULL, ARRAY[5, 6])));
  r := r || jsonb_build_object('A_empty_all_rows', pg_temp.eq(pg_temp.m(1, 101, NULL, NULL, '{}'::int[]), ALL_HEADS));
  r := r || jsonb_build_object('A_with_statuses', pg_temp.eq(
    pg_temp.m(1, 101, NULL, ARRAY['submitted'], ARRAY[1, 5]), '[301, 303, 308, 310]'));
  r := r || jsonb_build_object('A_with_statuses_oracle', pg_temp.eq(
    pg_temp.m(1, 101, NULL, ARRAY['submitted', 'under_review'], ARRAY[1, 5, 7]),
    pg_temp.union_old(1, 101, NULL, ARRAY['submitted', 'under_review'], ARRAY[1, 5, 7])));

  -- ===== own scope: other agents' ids give nothing beyond the caller's own rows =====
  -- B2 is a broker (RLS shows the org's rows) but views 402 (row_scope own) -> effective own
  r := r || jsonb_build_object('O_own_viewer_no_filter', pg_temp.eq(pg_temp.m(2, 101, 402, NULL, NULL), '[309]'));
  r := r || jsonb_build_object('O_own_viewer_other_agent', pg_temp.eq(pg_temp.m(2, 101, 402, NULL, ARRAY[5]), '[]'));
  r := r || jsonb_build_object('O_own_viewer_others_and_self', pg_temp.eq(pg_temp.m(2, 101, 402, NULL, ARRAY[1, 2, 5, 6]), '[309]'));
  r := r || jsonb_build_object('O_own_viewer_oracle', pg_temp.eq(
    pg_temp.m(2, 101, 402, NULL, ARRAY[1, 5]), pg_temp.union_old(2, 101, 402, NULL, ARRAY[1, 5])));
  -- an agent (own by role)
  r := r || jsonb_build_object('O_agent_other_agent', pg_temp.eq(pg_temp.m(5, 101, NULL, NULL, ARRAY[6]), '[]'));
  r := r || jsonb_build_object('O_agent_self_and_other', pg_temp.eq(pg_temp.m(5, 101, NULL, NULL, ARRAY[5, 6]), '[301, 303, 304]'));

  -- ===== paging: total_count is the whole match, LIMIT/OFFSET in SQL =====
  s := pg_temp.call_as(1, pg_temp.q_m(101, NULL, ARRAY['pending', 'approved'], NULL, 'newest', 2, 0));
  s2 := pg_temp.call_as(1, pg_temp.q_m(101, NULL, ARRAY['pending', 'approved'], NULL, 'newest', 2, 2));
  r := r || jsonb_build_object('P_paging', pg_temp.pass(
    s NOT LIKE 'ERR%' AND s2 NOT LIKE 'ERR%'
    AND jsonb_array_length(s::jsonb -> 'ids') = 2 AND jsonb_array_length(s2::jsonb -> 'ids') = 2
    AND (s::jsonb ->> 'total')::int = jsonb_array_length(pg_temp.m(1, 101, NULL, ARRAY['pending', 'approved'], NULL))
    AND (s::jsonb ->> 'total') = (s2::jsonb ->> 'total')
    AND (SELECT count(*) FROM jsonb_array_elements(s::jsonb -> 'ids') a JOIN jsonb_array_elements(s2::jsonb -> 'ids') b ON a = b) = 0,
    s || ' | ' || s2));

  -- ===== refusals: the same as the old function =====
  s := pg_temp.call_as(14, pg_temp.q_m(101, NULL, ARRAY['approved'], NULL));
  r := r || jsonb_build_object('X_nonmember', pg_temp.pass(s = 'ERR P0001 Report not found', s));
  s := pg_temp.call_as(13, pg_temp.q_m(105, NULL, ARRAY['approved'], NULL));
  r := r || jsonb_build_object('X_feature_off', pg_temp.pass(s = 'ERR P0001 Report not found', s));
  s := pg_temp.call_as(10, pg_temp.q_m(101, NULL, NULL, NULL));
  r := r || jsonb_build_object('X_other_org_caller', pg_temp.pass(s = 'ERR P0001 Report not found', s));
  s := pg_temp.call_as(5, pg_temp.q_m(101, 403, NULL, NULL));
  r := r || jsonb_build_object('X_def_other_org', pg_temp.pass(s = 'ERR P0001 Report not found', s));

  -- ===== K2: the pin refuses an unknown broker_report_scope body =====
  BEGIN
    EXECUTE $q$CREATE OR REPLACE FUNCTION public.broker_report_scope(p_org uuid, p_def uuid DEFAULT NULL) RETURNS jsonb
             LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS 'SELECT NULL::jsonb'$q$;
    EXECUTE $mg$__MIGRATION__$mg$;
    s := 'applied';
    RAISE EXCEPTION 'RB_DONE' USING DETAIL = s;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'RB_DONE' THEN GET STACKED DIAGNOSTICS s = PG_EXCEPTION_DETAIL; ELSE s := SQLERRM; END IF;
  END;
  r := r || jsonb_build_object('K2_pin_refuses_unknown_scope', pg_temp.pass(s LIKE '%broker_report_scope(uuid,uuid) body changed%', s));

  -- ===== K3: the pin refuses a foreign body already at the new name =====
  BEGIN
    EXECUTE $q$CREATE OR REPLACE FUNCTION public.broker_report_submissions_rows_multi(
               p_org uuid, p_def uuid DEFAULT NULL, p_statuses text[] DEFAULT NULL, p_agents uuid[] DEFAULT NULL,
               p_from timestamptz DEFAULT NULL, p_to timestamptz DEFAULT NULL, p_sort text DEFAULT 'newest',
               p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
             RETURNS TABLE (id uuid, submitted_by uuid, property_address text, property_city text, property_state text,
               transaction_type text, status text, listing_price numeric, sale_price numeric, created_at timestamptz,
               closed_at timestamptz, total_count bigint)
             LANGUAGE sql STABLE AS 'SELECT NULL::uuid, NULL::uuid, NULL, NULL, NULL, NULL, NULL, NULL::numeric, NULL::numeric, NULL::timestamptz, NULL::timestamptz, 0::bigint WHERE false'$q$;
    EXECUTE $mg$__MIGRATION__$mg$;
    s := 'applied';
    RAISE EXCEPTION 'RB_DONE' USING DETAIL = s;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'RB_DONE' THEN GET STACKED DIAGNOSTICS s = PG_EXCEPTION_DETAIL; ELSE s := SQLERRM; END IF;
  END;
  r := r || jsonb_build_object('K3_pin_refuses_foreign_new_body', pg_temp.pass(s LIKE '%broker_report_submissions_rows_multi(%body changed%', s));

  -- ===== K4: rollback drops the new signature only =====
  BEGIN
    EXECUTE $rb$__ROLLBACK__$rb$;
    s := coalesce(to_regprocedure(NEW_SIG)::text, 'gone')
         || '/' || (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure(OLD_SIG))
         || '/' || has_function_privilege('authenticated', to_regprocedure(OLD_SIG), 'EXECUTE')::text
         || '/' || (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.broker_report_scope(uuid,uuid)'))
         || '/' || (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
                     AND proname = 'broker_report_submissions_rows_multi');
    RAISE EXCEPTION 'RB_DONE' USING DETAIL = s;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'RB_DONE' THEN GET STACKED DIAGNOSTICS s = PG_EXCEPTION_DETAIL; ELSE s := 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 80); END IF;
  END;
  r := r || jsonb_build_object('K4_rollback', pg_temp.pass(
    s = 'gone/922f977f729dd92cfcea89e51fc412ae/true/86899bd79510d5c29d6f33374e1040ff/0', s));

  RETURN r;
END $b$;

DO $drv$
DECLARE v_r jsonb;
BEGIN
  v_r := pg_temp.run();
  RAISE EXCEPTION 'P3513B_RESULT %', jsonb_build_object(
    'total', (SELECT count(*) FROM jsonb_each_text(v_r)),
    'pass', (SELECT count(*) FROM jsonb_each_text(v_r) e WHERE e.value = 'PASS'),
    'fail', (SELECT count(*) FROM jsonb_each_text(v_r) e WHERE e.value <> 'PASS'),
    'reds', (SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) FROM jsonb_each_text(v_r) e WHERE e.value <> 'PASS'));
END
$drv$;
