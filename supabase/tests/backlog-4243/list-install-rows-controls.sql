-- BACKLOG-4243 PR-3 controls for cloud_list_install_rows. run.py places this after the migration
-- (or a mutant of it) inside ONE transaction that ends in RAISE, so nothing persists. Every id,
-- address and value is invented; ids derive from __RUN__ (random per run).
SET LOCAL pg_stat_statements.track = 'none';

CREATE FUNCTION pg_temp.fx(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $h$ SELECT md5('__RUN__:' || n)::uuid $h$;
CREATE FUNCTION pg_temp.h(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $h$ SELECT encode(sha256(convert_to(t, 'UTF8')), 'hex') $h$;
CREATE FUNCTION pg_temp.pass(c boolean, detail text) RETURNS text LANGUAGE sql IMMUTABLE AS $h$
  SELECT CASE WHEN coalesce(c, false) THEN 'PASS' ELSE 'FAIL: ' || coalesce(left(detail, 400), '-') END $h$;
-- Calls the function as user u (NULL = no user). Returns the envelope, or 'ERR <sqlstate>'.
CREATE FUNCTION pg_temp.list_as(u uuid, e uuid, i uuid, k text, a uuid, l int) RETURNS jsonb LANGUAGE plpgsql AS $h$
DECLARE j jsonb;
BEGIN
  BEGIN
    PERFORM set_config('request.jwt.claims', CASE WHEN u IS NULL THEN '' ELSE json_build_object('sub', u, 'role', 'authenticated')::text END, true);
    PERFORM set_config('request.jwt.claim.sub', coalesce(u::text, ''), true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    SET LOCAL ROLE authenticated;
    j := public.cloud_list_install_rows(e, i, k, a, l);
    RESET ROLE;
    RETURN j;
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    RETURN jsonb_build_object('err', SQLSTATE);
  END;
END $h$;
CREATE FUNCTION pg_temp.ids(j jsonb) RETURNS text[] LANGUAGE sql IMMUTABLE AS $h$
  SELECT coalesce(array_agg(x ->> 'local_id' ORDER BY x ->> 'local_id'), '{}') FROM jsonb_array_elements(j -> 'rows') x $h$;

DO $controls$
DECLARE
  A uuid := pg_temp.fx(1); B uuid := pg_temp.fx(2); I1 uuid := pg_temp.fx(301); I2 uuid := pg_temp.fx(302);
  DA1 uuid := pg_temp.fx(401); DA2 uuid := pg_temp.fx(402); DA3 uuid := pg_temp.fx(403); DB1 uuid := pg_temp.fx(404);
  r jsonb := '{}'; j jsonb; j2 jsonb; n int;
BEGIN
  SET LOCAL session_replication_role = replica;
  INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  SELECT pg_temp.fx(x), 'p4243-' || substr(md5('__RUN__'), 1, 8) || '-' || x || '@example.test', 'authenticated', 'authenticated',
         '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now() FROM generate_series(1, 2) x;
  -- A: two deals from I1, one from I2. B: one deal from I1 (same install id, another owner).
  INSERT INTO public.cloud_deals (id, owner_user_id, source_install_id, local_transaction_id, content_hash) VALUES
    (DA1, A, I1, 't-a1', pg_temp.h('a1')), (DA2, A, I1, 't-a2', pg_temp.h('a2')),
    (DA3, A, I2, 't-a3', pg_temp.h('a3')), (DB1, B, I1, 't-b1', pg_temp.h('b1'));
  INSERT INTO public.cloud_deal_parties (owner_user_id, cloud_deal_id, local_party_id, content_hash, removed_at) VALUES
    (A, DA1, 'p-a1', pg_temp.h('pa1'), NULL), (A, DA1, 'p-a1x', pg_temp.h('pa1x'), now()),
    (A, DA3, 'p-a3', pg_temp.h('pa3'), NULL), (B, DB1, 'p-b1', pg_temp.h('pb1'), NULL);
  INSERT INTO public.cloud_deal_checklists (id, owner_user_id, cloud_deal_id, local_checklist_id, template_id, content_hash) VALUES
    (pg_temp.fx(501), A, DA1, 'c-a1', 'tpl', pg_temp.h('ca1')), (pg_temp.fx(502), A, DA3, 'c-a3', 'tpl', pg_temp.h('ca3')),
    (pg_temp.fx(503), B, DB1, 'c-b1', 'tpl', pg_temp.h('cb1'));
  INSERT INTO public.cloud_deal_checklist_items (owner_user_id, cloud_deal_id, cloud_checklist_id, local_item_id, content_hash) VALUES
    (A, DA1, pg_temp.fx(501), 'i-a1', pg_temp.h('ia1')), (A, DA3, pg_temp.fx(502), 'i-a3', pg_temp.h('ia3')),
    (B, DB1, pg_temp.fx(503), 'i-b1', pg_temp.h('ib1'));
  SET LOCAL session_replication_role = origin;

  -- L1 deals: only A's rows of I1
  j := pg_temp.list_as(A, A, I1, 'deal', NULL, 100);
  r := r || jsonb_build_object('L1_deals_owner_install', pg_temp.pass(
    j ->> 'ok' = 'true' AND pg_temp.ids(j) = ARRAY['t-a1', 't-a2'] AND j -> 'next_after' = 'null'::jsonb
    AND (SELECT bool_and(x ->> 'cloud_deal_id' = x ->> 'cloud_id') FROM jsonb_array_elements(j -> 'rows') x)
    AND (SELECT bool_and(x ->> 'removed' = 'false') FROM jsonb_array_elements(j -> 'rows') x), j::text));
  -- L2 children: only A's rows under A's I1 deals; removed flag reported
  j := pg_temp.list_as(A, A, I1, 'party', NULL, 100);
  r := r || jsonb_build_object('L2_party_owner_install_removed', pg_temp.pass(
    pg_temp.ids(j) = ARRAY['p-a1', 'p-a1x']
    AND (SELECT x ->> 'removed' FROM jsonb_array_elements(j -> 'rows') x WHERE x ->> 'local_id' = 'p-a1x') = 'true'
    AND (SELECT x ->> 'removed' FROM jsonb_array_elements(j -> 'rows') x WHERE x ->> 'local_id' = 'p-a1') = 'false'
    AND (SELECT x ->> 'content_hash' FROM jsonb_array_elements(j -> 'rows') x WHERE x ->> 'local_id' = 'p-a1') = pg_temp.h('pa1')
    AND (SELECT x ->> 'cloud_deal_id' FROM jsonb_array_elements(j -> 'rows') x WHERE x ->> 'local_id' = 'p-a1') = DA1::text, j::text));
  j := pg_temp.list_as(A, A, I1, 'checklist', NULL, 100);
  j2 := pg_temp.list_as(A, A, I1, 'checklist_item', NULL, 100);
  r := r || jsonb_build_object('L3_checklists_items_owner_install', pg_temp.pass(
    pg_temp.ids(j) = ARRAY['c-a1'] AND pg_temp.ids(j2) = ARRAY['i-a1'], j::text || j2::text));
  -- L4 B sees only B's I1 rows (owner term)
  j := pg_temp.list_as(B, B, I1, 'deal', NULL, 100);
  r := r || jsonb_build_object('L4_other_owner', pg_temp.pass(pg_temp.ids(j) = ARRAY['t-b1'], j::text));
  -- L5 refusals
  r := r || jsonb_build_object('L5_refusals', pg_temp.pass(
    pg_temp.list_as(A, B, I1, 'deal', NULL, 100) ->> 'error' = 'wrong_account'
    AND pg_temp.list_as(NULL, A, I1, 'deal', NULL, 100) ->> 'error' = 'not_authorized'
    AND pg_temp.list_as(A, A, I1, 'message', NULL, 100) ->> 'error' = 'invalid_input'
    AND pg_temp.list_as(A, A, NULL, 'deal', NULL, 100) ->> 'error' = 'invalid_input', 'refusals'));
  -- L6 paging: limit 1 returns one row and next_after; the next page returns the other; limit is capped
  j := pg_temp.list_as(A, A, I1, 'deal', NULL, 1);
  j2 := pg_temp.list_as(A, A, I1, 'deal', (j ->> 'next_after')::uuid, 1);
  r := r || jsonb_build_object('L6_paging', pg_temp.pass(
    jsonb_array_length(j -> 'rows') = 1 AND j ->> 'next_after' = (j -> 'rows' -> 0 ->> 'cloud_id')
    AND jsonb_array_length(j2 -> 'rows') = 1 AND (j2 -> 'rows' -> 0 ->> 'cloud_id') > (j ->> 'next_after')
    AND jsonb_array_length(pg_temp.list_as(A, A, I1, 'deal', NULL, 0) -> 'rows') = 1
    AND jsonb_array_length(pg_temp.list_as(A, A, I1, 'deal', NULL, 100000) -> 'rows') = 2, j::text || j2::text));
  -- L7 catalog: STABLE, SECURITY DEFINER, search_path '', EXECUTE for authenticated only
  SELECT count(*) INTO n FROM pg_proc p
   WHERE p.oid = 'public.cloud_list_install_rows(uuid,uuid,text,uuid,integer)'::regprocedure
     AND p.provolatile = 's' AND p.prosecdef
     AND EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c IN ('search_path=""', 'search_path='));
  r := r || jsonb_build_object('L7_catalog_grants', pg_temp.pass(
    n = 1
    AND has_function_privilege('authenticated', 'public.cloud_list_install_rows(uuid,uuid,text,uuid,integer)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.cloud_list_install_rows(uuid,uuid,text,uuid,integer)', 'EXECUTE')
    AND NOT has_function_privilege('service_role', 'public.cloud_list_install_rows(uuid,uuid,text,uuid,integer)', 'EXECUTE')
    AND (SELECT proacl::text FROM pg_proc WHERE oid = 'public.cloud_list_install_rows(uuid,uuid,text,uuid,integer)'::regprocedure) !~ '(^|[{,])=X',
    'catalog n=' || n || ' cfg=' || coalesce((SELECT proconfig::text FROM pg_proc WHERE oid = 'public.cloud_list_install_rows(uuid,uuid,text,uuid,integer)'::regprocedure), '-')));
  -- L8 read-only: the call wrote nothing
  r := r || jsonb_build_object('L8_no_writes', pg_temp.pass(
    (SELECT count(*) FROM public.cloud_deals WHERE owner_user_id IN (A, B)) = 4, 'writes'));
  RAISE EXCEPTION 'RESULTS %', r::text USING ERRCODE = 'T4243';
END $controls$;
