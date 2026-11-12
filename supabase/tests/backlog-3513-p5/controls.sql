-- BACKLOG-3513 PR-5 DB controls: one admin_audit_logs row per effective sharing change.
-- Venue: keepr-test ONLY (kt-sql refuses the production ref). ONE call, ONE transaction ending in RAISE,
-- so nothing persists (this matters: admin_audit_logs is append-only). Run with compose.py
-- --with-migration (the migration applied TWICE in front), or after 20261112160000 is applied.
-- Mutations are applied to the migration FILE by mutate.py, then this runs with --with-migration.
-- Fixtures (invented; ids built at run time from fx(n), emails p3513-<n>@example.test; roles BY NAME):
--   users  1 A Super Admin (report owner)   2 B Support Supervisor   3 C Support Supervisor
--          4 D Super Admin   5 E Support Agent (internal role WITHOUT analytics.view)
--   views  21 V = A on funnel
-- Every audit control compares the WHOLE new-row list (actor, action, target, metadata) with jsonb =.
-- C5 controls are guard preservation (a refused call RAISEs, which rolls back any audit row), not
-- audit controls.
-- Output: RAISE 'P3513P5_RESULT {total, pass, fail, reds}'.

DO $drv$
DECLARE
  v_r jsonb;
BEGIN
  EXECUTE $f$CREATE FUNCTION pg_temp.fx(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $b$
    SELECT ('00000000-0000-3513-8000-' || lpad(n::text, 12, '0'))::uuid
  $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.clear_claims() RETURNS void LANGUAGE plpgsql AS $b$
  BEGIN
    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claim.role', '', true);
  END $b$$f$;

  -- run one SELECT returning jsonb as an authenticated user: the reply as text, or 'ERR <sqlstate> <message>'
  EXECUTE $f$CREATE FUNCTION pg_temp.call_as(u uuid, q text) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE j jsonb;
  BEGIN
    BEGIN
      PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
      PERFORM set_config('request.jwt.claim.sub', u::text, true);
      PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
      SET LOCAL ROLE authenticated;
      EXECUTE q INTO j;
      RESET ROLE;
      PERFORM pg_temp.clear_claims();
      RETURN coalesce(j::text, 'null');
    EXCEPTION WHEN OTHERS THEN
      RESET ROLE;
      PERFORM pg_temp.clear_claims();
      RETURN 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 80);
    END;
  END $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.pass(ok boolean, detail text) RETURNS text LANGUAGE sql AS $b$
    SELECT CASE WHEN coalesce(ok, false) THEN 'PASS' ELSE 'FAIL ' || coalesce(detail, '(null)') END
  $b$$f$;

  -- ids of every report_* audit row now present
  EXECUTE $f$CREATE FUNCTION pg_temp.ids() RETURNS uuid[] LANGUAGE sql AS $b$
    SELECT coalesce(array_agg(id), '{}') FROM public.admin_audit_logs WHERE action LIKE 'report\_%'
  $b$$f$;

  -- the report_* audit rows added since snapshot b
  EXECUTE $f$CREATE FUNCTION pg_temp.added(b uuid[]) RETURNS jsonb LANGUAGE sql AS $b$
    SELECT coalesce(jsonb_agg(jsonb_build_object('actor_id', a.actor_id, 'action', a.action,
             'target_type', a.target_type, 'target_id', a.target_id, 'metadata', a.metadata)
             ORDER BY a.action, a.target_id), '[]'::jsonb)
      FROM public.admin_audit_logs a
     WHERE a.action LIKE 'report\_%' AND NOT (a.id = ANY (b))
  $b$$f$;

  -- one expected audit row
  EXECUTE $f$CREATE FUNCTION pg_temp.row1(actor uuid, act text, target uuid, meta jsonb) RETURNS jsonb LANGUAGE sql AS $b$
    SELECT jsonb_build_array(jsonb_build_object('actor_id', actor, 'action', act,
             'target_type', 'user', 'target_id', target::text, 'metadata', meta))
  $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.am(k text, u uuid, f text, t text) RETURNS jsonb LANGUAGE sql AS $b$
    SELECT jsonb_build_object('report_key', k, 'user_id', u, 'from_level', f, 'to_level', t)
  $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.sm(v uuid, k text, u uuid, f text, t text) RETURNS jsonb LANGUAGE sql AS $b$
    SELECT jsonb_build_object('view_id', v, 'report_key', k, 'user_id', u, 'from_level', f, 'to_level', t)
  $b$$f$;

  -- run q as u; PASS when the reply equals want_reply (text) and the added rows equal want_rows
  EXECUTE $f$CREATE FUNCTION pg_temp.ctl(u uuid, q text, want_reply text, want_rows jsonb) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE b uuid[] := pg_temp.ids(); s text; got jsonb;
  BEGIN
    s := pg_temp.call_as(u, q);
    got := pg_temp.added(b);
    RETURN pg_temp.pass(
      (s = want_reply OR (want_reply LIKE '{%' AND s NOT LIKE 'ERR%' AND s::jsonb = want_reply::jsonb)) AND got = want_rows,
      'reply=' || s || ' rows=' || got::text);
  END $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.def(sig text) RETURNS text LANGUAGE sql AS $b$
    SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure(sig)
  $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.run() RETURNS jsonb LANGUAGE plpgsql AS $b$
  DECLARE
    r jsonb := '{}'::jsonb;
    s text; n int;
    uA uuid := pg_temp.fx(1); uB uuid := pg_temp.fx(2); uC uuid := pg_temp.fx(3);
    uD uuid := pg_temp.fx(4); uE uuid := pg_temp.fx(5);
    V uuid := pg_temp.fx(21);
    r_sa uuid := (SELECT id FROM public.admin_roles WHERE name = 'Super Admin');
    r_ss uuid := (SELECT id FROM public.admin_roles WHERE name = 'Support Supervisor');
    r_ag uuid := (SELECT id FROM public.admin_roles WHERE name = 'Support Agent');
    NF text := 'ERR P0001 Report not found';
    VNF text := 'ERR P0001 Saved view not found';
    OK text := '{"success": true}';
    sigs text[] := ARRAY['public.report_access_set(text,uuid,text)', 'public.report_access_remove(text,uuid)',
                         'public.report_share_set(uuid,uuid,text)', 'public.report_share_remove(uuid,uuid)'];
    aset text := 'SELECT public.report_access_set(%L, %L::uuid, %L)';
    arem text := 'SELECT public.report_access_remove(%L, %L::uuid)';
    sset text := 'SELECT public.report_share_set(%L::uuid, %L::uuid, %L)';
    srem text := 'SELECT public.report_share_remove(%L::uuid, %L::uuid)';
  BEGIN
    -- ===== fixtures =====
    INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    SELECT pg_temp.fx(x), 'p3513-' || x || '@example.test', 'authenticated', 'authenticated',
           '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now()
      FROM generate_series(1, 5) x;
    INSERT INTO public.users (id, email, oauth_provider, oauth_id, display_name)
    SELECT pg_temp.fx(x), 'p3513-' || x || '@example.test', 'email', pg_temp.fx(x)::text, 'P3513 user ' || x
      FROM generate_series(1, 5) x
    ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name;
    INSERT INTO public.internal_roles (user_id, role_id) VALUES (uA, r_sa), (uB, r_ss), (uC, r_ss), (uD, r_sa), (uE, r_ag);
    INSERT INTO public.report_saved_views (id, user_id, report_key, name, filters, metric) VALUES
      (V, uA, 'funnel', 'A funnel', '{}', '{"col":"rows","fn":"count"}');

    r := r || jsonb_build_object('K0_fixtures', pg_temp.pass(
      r_sa IS NOT NULL AND r_ss IS NOT NULL AND r_ag IS NOT NULL
      AND public._report_access_role(uA, 'funnel') = 'owner'
      AND public._report_access_role(uD, 'funnel') = 'owner'
      AND public._report_share_eligible(uB) AND public._report_share_eligible(uC)
      AND NOT public._report_share_eligible(uE)
      AND NOT EXISTS (SELECT 1 FROM public.report_access WHERE user_id IN (uA, uB, uC, uD, uE)),
      'fixture mismatch'));

    -- ===== access family =====
    r := r || jsonb_build_object('C1_access_first_grant', pg_temp.ctl(uA, format(aset, 'funnel', uB, 'viewer'),
      jsonb_build_object('report_key', 'funnel', 'user_id', uB, 'role', 'viewer')::text,
      pg_temp.row1(uA, 'report_access.set', uB, pg_temp.am('funnel', uB, NULL, 'viewer'))));
    r := r || jsonb_build_object('C2_access_change', pg_temp.ctl(uA, format(aset, 'funnel', uB, 'editor'),
      jsonb_build_object('report_key', 'funnel', 'user_id', uB, 'role', 'editor')::text,
      pg_temp.row1(uA, 'report_access.set', uB, pg_temp.am('funnel', uB, 'viewer', 'editor'))));
    r := r || jsonb_build_object('C4_access_unchanged_no_row', pg_temp.ctl(uA, format(aset, 'funnel', uB, 'editor'),
      jsonb_build_object('report_key', 'funnel', 'user_id', uB, 'role', 'editor')::text, '[]'::jsonb));
    -- C gets viewer so the refused-remove and self-remove cases have a row to act on
    r := r || jsonb_build_object('C1b_access_first_grant_C', pg_temp.ctl(uA, format(aset, 'funnel', uC, 'viewer'),
      jsonb_build_object('report_key', 'funnel', 'user_id', uC, 'role', 'viewer')::text,
      pg_temp.row1(uA, 'report_access.set', uC, pg_temp.am('funnel', uC, NULL, 'viewer'))));
    -- C5 guard preservation: an editor (not an owner) cannot set; a third party cannot remove
    r := r || jsonb_build_object('C5_access_set_refused_nonowner', pg_temp.ctl(uB, format(aset, 'funnel', uC, 'editor'), NF, '[]'::jsonb));
    r := r || jsonb_build_object('C5_access_remove_refused_third_party', pg_temp.ctl(uB, format(arem, 'funnel', uC), NF, '[]'::jsonb));
    r := r || jsonb_build_object('C5_access_rows_intact', pg_temp.pass(
      (SELECT role FROM public.report_access WHERE report_key = 'funnel' AND user_id = uC) = 'viewer',
      'C row ' || coalesce((SELECT role FROM public.report_access WHERE report_key = 'funnel' AND user_id = uC), 'gone')));
    -- C3b: the grantee removes their own access
    r := r || jsonb_build_object('C3b_access_self_remove', pg_temp.ctl(uC, format(arem, 'funnel', uC), OK,
      pg_temp.row1(uC, 'report_access.remove', uC, pg_temp.am('funnel', uC, 'viewer', NULL))));

    -- ===== share family (B holds editor on funnel; C now holds no access; D is an owner) =====
    r := r || jsonb_build_object('C5_share_set_refused_nonowner', pg_temp.ctl(uB, format(sset, V, uD, 'viewer'), VNF, '[]'::jsonb));
    r := r || jsonb_build_object('S6_share_refused_no_report_access', pg_temp.ctl(uA, format(sset, V, uC, 'viewer'), VNF, '[]'::jsonb));
    r := r || jsonb_build_object('C1_share_first_grant', pg_temp.ctl(uA, format(sset, V, uB, 'viewer'),
      jsonb_build_object('view_id', V, 'user_id', uB, 'role', 'viewer')::text,
      pg_temp.row1(uA, 'report_share.set', uB, pg_temp.sm(V, 'funnel', uB, NULL, 'viewer'))));
    r := r || jsonb_build_object('C2_share_change', pg_temp.ctl(uA, format(sset, V, uB, 'editor'),
      jsonb_build_object('view_id', V, 'user_id', uB, 'role', 'editor')::text,
      pg_temp.row1(uA, 'report_share.set', uB, pg_temp.sm(V, 'funnel', uB, 'viewer', 'editor'))));
    r := r || jsonb_build_object('C4_share_unchanged_no_row', pg_temp.ctl(uA, format(sset, V, uB, 'editor'),
      jsonb_build_object('view_id', V, 'user_id', uB, 'role', 'editor')::text, '[]'::jsonb));
    r := r || jsonb_build_object('C1b_share_first_grant_D', pg_temp.ctl(uA, format(sset, V, uD, 'viewer'),
      jsonb_build_object('view_id', V, 'user_id', uD, 'role', 'viewer')::text,
      pg_temp.row1(uA, 'report_share.set', uD, pg_temp.sm(V, 'funnel', uD, NULL, 'viewer'))));
    r := r || jsonb_build_object('C5_share_remove_refused_third_party', pg_temp.ctl(uD, format(srem, V, uB), VNF, '[]'::jsonb));
    r := r || jsonb_build_object('C5_share_rows_intact', pg_temp.pass(
      (SELECT role FROM public.report_saved_view_shares WHERE view_id = V AND user_id = uB) = 'editor',
      'B share ' || coalesce((SELECT role FROM public.report_saved_view_shares WHERE view_id = V AND user_id = uB), 'gone')));
    -- C3b: the grantee leaves the share
    r := r || jsonb_build_object('C3b_share_self_leave', pg_temp.ctl(uD, format(srem, V, uD), OK,
      pg_temp.row1(uD, 'report_share.remove', uD, pg_temp.sm(V, 'funnel', uD, 'viewer', NULL))));
    r := r || jsonb_build_object('C3_share_owner_remove', pg_temp.ctl(uA, format(srem, V, uB), OK,
      pg_temp.row1(uA, 'report_share.remove', uB, pg_temp.sm(V, 'funnel', uB, 'editor', NULL))));

    -- ===== access remove by the owner =====
    r := r || jsonb_build_object('C3_access_owner_remove', pg_temp.ctl(uA, format(arem, 'funnel', uB), OK,
      pg_temp.row1(uA, 'report_access.remove', uB, pg_temp.am('funnel', uB, 'editor', NULL))));

    -- ===== K1: grants and function settings unchanged on all four =====
    SELECT count(*) INTO n FROM unnest(sigs) x JOIN pg_proc p ON p.oid = to_regprocedure(x)
     WHERE p.prosecdef AND p.proconfig = ARRAY['search_path=public']
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
       AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0);
    r := r || jsonb_build_object('K1_grants_unchanged', pg_temp.pass(n = 4, n || ' of 4 compliant'));

    -- ===== K2: the pin refuses a third body =====
    BEGIN
      EXECUTE $q$CREATE OR REPLACE FUNCTION public.report_share_remove(p_view_id uuid, p_user_id uuid) RETURNS jsonb
               LANGUAGE sql SECURITY DEFINER SET search_path = public AS 'SELECT NULL::jsonb'$q$;
      EXECUTE $mg$__MIGRATION__$mg$;
      s := 'applied';
      RAISE EXCEPTION 'RB_DONE' USING DETAIL = s;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM = 'RB_DONE' THEN GET STACKED DIAGNOSTICS s = PG_EXCEPTION_DETAIL;
      ELSE s := SQLERRM; END IF;
    END;
    r := r || jsonb_build_object('K2_pin_refuses_third_body', pg_temp.pass(s LIKE '%report_share_remove(uuid,uuid) body changed%', s));

    -- ===== K3: the pin refuses a second log_admin_action =====
    BEGIN
      EXECUTE $q$CREATE FUNCTION public.log_admin_action(p text) RETURNS void LANGUAGE sql AS 'SELECT NULL'$q$;
      EXECUTE $mg$__MIGRATION__$mg$;
      s := 'applied';
      RAISE EXCEPTION 'RB_DONE' USING DETAIL = s;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM = 'RB_DONE' THEN GET STACKED DIAGNOSTICS s = PG_EXCEPTION_DETAIL;
      ELSE s := SQLERRM; END IF;
    END;
    r := r || jsonb_build_object('K3_pin_refuses_overload', pg_temp.pass(s LIKE '%log_admin_action is not the single known function%', s));

    -- ===== K4: the rollback restores the four prior bodies exactly =====
    BEGIN
      EXECUTE $rb$__ROLLBACK__$rb$;
      s := (SELECT string_agg(md5(pg_temp.def(x)), ',' ORDER BY x) FROM unnest(sigs) x);
      RAISE EXCEPTION 'RB_DONE' USING DETAIL = s;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM = 'RB_DONE' THEN GET STACKED DIAGNOSTICS s = PG_EXCEPTION_DETAIL;
      ELSE s := 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 80); END IF;
    END;
    r := r || jsonb_build_object('K4_rollback_restores', pg_temp.pass(
      s = '48f078c8dba63a4bfb90b3cb59df1672,cce862164b14e9f6cf48f62ec875b226,c8af0079e34f296a7c245d3ac1a4f837,6cc31aece22873a562551ed0c7265620', s));

    RETURN r;
  END $b$$f$;

  v_r := pg_temp.run();
  RAISE EXCEPTION 'P3513P5_RESULT %', jsonb_build_object(
    'total', (SELECT count(*) FROM jsonb_each_text(v_r)),
    'pass', (SELECT count(*) FROM jsonb_each_text(v_r) e WHERE e.value = 'PASS'),
    'fail', (SELECT count(*) FROM jsonb_each_text(v_r) e WHERE e.value <> 'PASS'),
    'reds', (SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) FROM jsonb_each_text(v_r) e WHERE e.value <> 'PASS'));
END
$drv$;
