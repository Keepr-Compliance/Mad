-- BACKLOG-4185 PR A controls: public.devices.hardware_profile / profile_updated_at.
-- keepr-test ONLY (kt-sql refuses the production ref). Run through run.sh, which applies the
-- migration (twice) and mutations.sql in the same transaction before this block. The block ends
-- in RAISE, so nothing persists.
--
-- Fixtures, all invented, ids built at run time (no literal UUID in this file):
--   A    plain user, one active device
--   B    plain user, one active device (the victim row)
--   ADM  Super Admin (system role): report access to 'analytics', so devices_select_public lets
--        ADM SELECT every device row. This is the actor an open UPDATE policy would let through;
--        a plain-user actor cannot see B's row and so cannot tell a guarded table from an open one.
--
-- Output: RAISE 'P4185_RESULT {...}' with total / pass / fail / reds and one entry per control.
DO $drv$
DECLARE
  r jsonb := '{}'::jsonb;
  reds text[] := '{}';
  total int := 0;
  a uuid; b uuid; adm uuid;
  r_sa uuid := (SELECT id FROM public.admin_roles WHERE name = 'Super Admin');
  n int; st text; v text; ok boolean;
  big jsonb; at_limit jsonb; over_limit jsonb;
BEGIN
  EXECUTE $f$CREATE FUNCTION pg_temp.fx(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $b$
    SELECT ('00000000-0000-4185-8000-' || lpad(n::text, 12, '0'))::uuid
  $b$$f$;
  -- run q as user u (NULL u = anon); returns 'rows=<n>' or 'err=<SQLSTATE>'
  EXECUTE $f$CREATE FUNCTION pg_temp.as_user(u uuid, q text) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE n int; st text;
  BEGIN
    BEGIN
      IF u IS NULL THEN
        PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
        PERFORM set_config('request.jwt.claim.sub', '', true);
        SET LOCAL ROLE anon;
      ELSE
        PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
        PERFORM set_config('request.jwt.claim.sub', u::text, true);
        SET LOCAL ROLE authenticated;
      END IF;
      EXECUTE q;
      GET DIAGNOSTICS n = ROW_COUNT;
      RESET ROLE;
      RETURN 'rows=' || n;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE;
      RESET ROLE;
      RETURN 'err=' || st;
    END;
  END $b$$f$;
  -- count rows visible to user u for a SELECT
  EXECUTE $f$CREATE FUNCTION pg_temp.count_as(u uuid, q text) RETURNS int LANGUAGE plpgsql AS $b$
  DECLARE n int;
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', u::text, true);
    SET LOCAL ROLE authenticated;
    EXECUTE q INTO n;
    RESET ROLE;
    RETURN n;
  END $b$$f$;

  a := pg_temp.fx(1); b := pg_temp.fx(2); adm := pg_temp.fx(3);

  -- ===== schema state (S*) =====
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'devices' AND column_name = 'hardware_profile'
     AND data_type = 'jsonb' AND is_nullable = 'YES' AND column_default IS NULL;
  total := total + 1; ok := n = 1; r := r || jsonb_build_object('S1_hardware_profile_jsonb_nullable_no_default', n);
  IF NOT ok THEN reds := reds || 'S1_hardware_profile_jsonb_nullable_no_default'; END IF;

  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'devices' AND column_name = 'profile_updated_at'
     AND data_type = 'timestamp with time zone' AND is_nullable = 'YES' AND column_default IS NULL;
  total := total + 1; ok := n = 1; r := r || jsonb_build_object('S2_profile_updated_at_timestamptz_nullable', n);
  IF NOT ok THEN reds := reds || 'S2_profile_updated_at_timestamptz_nullable'; END IF;

  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'public.devices'::regclass AND conname = 'devices_hardware_profile_shape' AND contype = 'c';
  total := total + 1; ok := n = 1; r := r || jsonb_build_object('S3_shape_check_present', n);
  IF NOT ok THEN reds := reds || 'S3_shape_check_present'; END IF;

  -- no backfill: every pre-existing row is NULL
  SELECT count(*) INTO n FROM public.devices WHERE hardware_profile IS NOT NULL OR profile_updated_at IS NOT NULL;
  total := total + 1; ok := n = 0; r := r || jsonb_build_object('S4_no_backfill_nonnull_rows', n);
  IF NOT ok THEN reds := reds || 'S4_no_backfill_nonnull_rows'; END IF;

  -- policy text pin (SR 0ab69ffd item 3b)
  SELECT qual INTO v FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'devices' AND policyname = 'Users can update own devices';
  total := total + 1; ok := v IS NOT DISTINCT FROM '(( SELECT auth.uid() AS uid) = user_id)';
  r := r || jsonb_build_object('S5_update_policy_qual_pin', ok);
  IF NOT ok THEN reds := reds || 'S5_update_policy_qual_pin'; END IF;

  -- WITH CHECK stays implicit (NULL = Postgres re-applies USING to the new row)
  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'devices' AND policyname = 'Users can update own devices'
     AND with_check IS NULL;
  total := total + 1; ok := n = 1; r := r || jsonb_build_object('S6_update_policy_with_check_implicit', n);
  IF NOT ok THEN reds := reds || 'S6_update_policy_with_check_implicit'; END IF;

  -- SR d74c0c2e C3: the own-row policy is the ONLY policy that grants UPDATE
  SELECT count(*), string_agg(policyname, ',' ORDER BY policyname) INTO n, v FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'devices' AND cmd IN ('UPDATE', 'ALL');
  total := total + 1; ok := n = 1 AND v = 'Users can update own devices';
  r := r || jsonb_build_object('S7_only_one_update_policy', coalesce(v, '') || ' n=' || n);
  IF NOT ok THEN reds := reds || 'S7_only_one_update_policy'; END IF;

  SELECT count(*) INTO n FROM information_schema.role_table_grants
   WHERE table_schema = 'public' AND table_name = 'devices' AND privilege_type = 'TRUNCATE'
     AND grantee IN ('anon', 'authenticated', 'PUBLIC');
  total := total + 1; ok := n = 0; r := r || jsonb_build_object('S8_no_truncate_for_clients', n);
  IF NOT ok THEN reds := reds || 'S8_no_truncate_for_clients'; END IF;

  SELECT relrowsecurity::int INTO n FROM pg_class WHERE oid = 'public.devices'::regclass;
  total := total + 1; ok := n = 1; r := r || jsonb_build_object('S9_rls_enabled', n);
  IF NOT ok THEN reds := reds || 'S9_rls_enabled'; END IF;

  -- no writer function: nothing in public mentions the new column
  SELECT count(*) INTO n FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.prosrc ILIKE '%hardware_profile%';
  total := total + 1; ok := n = 0; r := r || jsonb_build_object('S10_no_function_writes_profile', n);
  IF NOT ok THEN reds := reds || 'S10_no_function_writes_profile'; END IF;

  -- ===== fixtures =====
  INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  VALUES (a,   'p4185-a@example.test',   'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now()),
         (b,   'p4185-b@example.test',   'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now()),
         (adm, 'p4185-adm@example.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now());
  INSERT INTO public.internal_roles (user_id, role_id) VALUES (adm, r_sa);
  INSERT INTO public.devices (user_id, device_id, device_name, platform, is_active)
  VALUES (a, 'p4185-dev-a', 'p4185 A', 'macos', true),
         (b, 'p4185-dev-b', 'p4185 B', 'windows', true),
         (adm, 'p4185-dev-adm', 'p4185 ADM', 'macos', true);

  -- fixture positive controls: without these the admin rows below prove nothing
  v := public._report_access_role(adm, 'analytics');
  total := total + 1; ok := v IS NOT NULL; r := r || jsonb_build_object('F1_admin_has_analytics_access', coalesce(v, 'NULL'));
  IF NOT ok THEN reds := reds || 'F1_admin_has_analytics_access'; END IF;

  n := pg_temp.count_as(adm, format('SELECT count(*)::int FROM public.devices WHERE user_id = %L', b));
  total := total + 1; ok := n = 1; r := r || jsonb_build_object('F2_admin_can_select_b', n);
  IF NOT ok THEN reds := reds || 'F2_admin_can_select_b'; END IF;

  n := pg_temp.count_as(a, format('SELECT count(*)::int FROM public.devices WHERE user_id = %L', b));
  total := total + 1; ok := n = 0; r := r || jsonb_build_object('F3_plain_cannot_select_b', n);
  IF NOT ok THEN reds := reds || 'F3_plain_cannot_select_b'; END IF;

  -- ===== behaviour (B*) =====
  v := pg_temp.as_user(a, format($q$UPDATE public.devices SET hardware_profile = '{"cpuCores":8}', profile_updated_at = now() WHERE user_id = %L$q$, b));
  total := total + 1; ok := v = 'rows=0'; r := r || jsonb_build_object('B1_plain_cross_user_update', v);
  IF NOT ok THEN reds := reds || 'B1_plain_cross_user_update'; END IF;

  v := pg_temp.as_user(adm, format($q$UPDATE public.devices SET hardware_profile = '{"cpuCores":8}', profile_updated_at = now() WHERE user_id = %L$q$, b));
  total := total + 1; ok := v = 'rows=0'; r := r || jsonb_build_object('B2_admin_cross_user_update', v);
  IF NOT ok THEN reds := reds || 'B2_admin_cross_user_update'; END IF;

  v := pg_temp.as_user(NULL, format($q$UPDATE public.devices SET hardware_profile = '{"cpuCores":8}' WHERE user_id = %L$q$, b));
  total := total + 1; ok := v IN ('rows=0', 'err=42501'); r := r || jsonb_build_object('B3_anon_update', v);
  IF NOT ok THEN reds := reds || 'B3_anon_update'; END IF;

  SELECT count(*) INTO n FROM public.devices WHERE user_id = b AND (hardware_profile IS NOT NULL OR profile_updated_at IS NOT NULL);
  total := total + 1; ok := n = 0; r := r || jsonb_build_object('B4_victim_row_untouched', n);
  IF NOT ok THEN reds := reds || 'B4_victim_row_untouched'; END IF;

  -- the write PR B will make: own row, object profile
  v := pg_temp.as_user(a, format($q$UPDATE public.devices SET hardware_profile = '{"v":1,"cpuCores":8,"ramGB":16}', profile_updated_at = now() WHERE user_id = %L AND device_id = 'p4185-dev-a'$q$, a));
  total := total + 1; ok := v = 'rows=1'; r := r || jsonb_build_object('B5_own_row_write', v);
  IF NOT ok THEN reds := reds || 'B5_own_row_write'; END IF;

  -- the OFF clear PR B will make
  v := pg_temp.as_user(a, format($q$UPDATE public.devices SET hardware_profile = NULL, profile_updated_at = now() WHERE user_id = %L AND device_id = 'p4185-dev-a'$q$, a));
  total := total + 1; ok := v = 'rows=1'; r := r || jsonb_build_object('B6_own_row_clear', v);
  IF NOT ok THEN reds := reds || 'B6_own_row_clear'; END IF;

  -- moving a row to another user: plain user and admin both refused
  v := pg_temp.as_user(a, format($q$UPDATE public.devices SET user_id = %L, is_active = false WHERE user_id = %L$q$, b, a));
  total := total + 1; ok := v = 'err=42501'; r := r || jsonb_build_object('B7_plain_move_row_to_b', v);
  IF NOT ok THEN reds := reds || 'B7_plain_move_row_to_b'; END IF;

  -- is_active = false keeps check_device_limit out of the result
  v := pg_temp.as_user(adm, format($q$UPDATE public.devices SET user_id = %L, is_active = false WHERE user_id = %L$q$, b, adm));
  total := total + 1; ok := v = 'err=42501'; r := r || jsonb_build_object('B8_admin_move_row_to_b', v);
  IF NOT ok THEN reds := reds || 'B8_admin_move_row_to_b'; END IF;

  -- shape CHECK, boundary swept at 8192 / 8193 bytes of text form
  SELECT jsonb_build_object('pad', string_agg(md5(i::text), '')) INTO big FROM generate_series(1, 3200) i;
  at_limit := jsonb_build_object('p', repeat('x', 8192 - octet_length(jsonb_build_object('p', '')::text)));
  over_limit := jsonb_build_object('p', repeat('x', 8193 - octet_length(jsonb_build_object('p', '')::text)));
  total := total + 1; ok := octet_length(at_limit::text) = 8192 AND octet_length(over_limit::text) = 8193;
  r := r || jsonb_build_object('B9_boundary_fixture_sizes', octet_length(at_limit::text) || '/' || octet_length(over_limit::text));
  IF NOT ok THEN reds := reds || 'B9_boundary_fixture_sizes'; END IF;

  v := pg_temp.as_user(a, format('UPDATE public.devices SET hardware_profile = %L::jsonb WHERE user_id = %L', at_limit, a));
  total := total + 1; ok := v = 'rows=1'; r := r || jsonb_build_object('B10_8192_bytes_accepted', v);
  IF NOT ok THEN reds := reds || 'B10_8192_bytes_accepted'; END IF;

  v := pg_temp.as_user(a, format('UPDATE public.devices SET hardware_profile = %L::jsonb WHERE user_id = %L', over_limit, a));
  total := total + 1; ok := v = 'err=23514'; r := r || jsonb_build_object('B11_8193_bytes_refused', v);
  IF NOT ok THEN reds := reds || 'B11_8193_bytes_refused'; END IF;

  v := pg_temp.as_user(a, format('UPDATE public.devices SET hardware_profile = %L::jsonb WHERE user_id = %L', big, a));
  total := total + 1; ok := v = 'err=23514'; r := r || jsonb_build_object('B12_100kb_refused', v);
  IF NOT ok THEN reds := reds || 'B12_100kb_refused'; END IF;

  v := pg_temp.as_user(a, format($q$UPDATE public.devices SET hardware_profile = '[1,2]' WHERE user_id = %L$q$, a));
  total := total + 1; ok := v = 'err=23514'; r := r || jsonb_build_object('B13_array_refused', v);
  IF NOT ok THEN reds := reds || 'B13_array_refused'; END IF;

  v := pg_temp.as_user(a, format($q$UPDATE public.devices SET hardware_profile = '"text"' WHERE user_id = %L$q$, a));
  total := total + 1; ok := v = 'err=23514'; r := r || jsonb_build_object('B14_scalar_refused', v);
  IF NOT ok THEN reds := reds || 'B14_scalar_refused'; END IF;

  -- ===== rollback script (R*) =====
  __ROLLBACK__
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'devices' AND column_name IN ('hardware_profile', 'profile_updated_at');
  total := total + 1; ok := n = 0; r := r || jsonb_build_object('R1_rollback_drops_columns', n);
  IF NOT ok THEN reds := reds || 'R1_rollback_drops_columns'; END IF;

  RAISE EXCEPTION 'P4185_RESULT %', jsonb_build_object('total', total, 'pass', total - coalesce(array_length(reds, 1), 0),
    'fail', coalesce(array_length(reds, 1), 0), 'reds', to_jsonb(reds), 'controls', r)::text;
END $drv$;
