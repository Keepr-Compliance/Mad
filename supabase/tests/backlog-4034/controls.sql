-- BACKLOG-4034 SQL controls for public.user_id_for_idp_object_id(text,text) and
-- public.idp_object_ids_for_users(uuid[],text). keepr-test only.
--
-- Everything runs in ONE DO block that always ends by raising: 'ALL PASS ...' on success,
-- '<control> FAIL ...' otherwise. The raise aborts the transaction, so every fixture row,
-- the temporary grant and the role switches are rolled back either way.
-- Run: kt-sql supabase/tests/backlog-4034/controls.sql   (expect ERROR text "ALL PASS: ...")
-- C6a (rights matrix) is the separate read-only query in rights.sql.
DO $controls$
DECLARE
  -- All-zero-style placeholders. A/B: same object id in tenants TA/TB (C3).
  a  uuid := ('00000000-0000-0000-0000-' || lpad('f0a1', 12, '0'));
  b  uuid := ('00000000-0000-0000-0000-' || lpad('f0b1', 12, '0'));
  d1 uuid := ('00000000-0000-0000-0000-' || lpad('f0d1', 12, '0'));
  d2 uuid := ('00000000-0000-0000-0000-' || lpad('f0d2', 12, '0'));
  e  uuid := ('00000000-0000-0000-0000-' || lpad('f0e1', 12, '0'));
  ta text := ('00000000-0000-0000-0000-' || lpad('e0a1', 12, '0'));
  tb text := ('00000000-0000-0000-0000-' || lpad('e0b1', 12, '0'));
  tc text := ('00000000-0000-0000-0000-' || lpad('e0c1', 12, '0'));
  td text := ('00000000-0000-0000-0000-' || lpad('e0d1', 12, '0'));
  o  text := ('00000000-0000-0000-0000-' || lpad('c001', 12, '0'));
  o_forged text := ('00000000-0000-0000-0000-' || lpad('c0ff', 12, '0'));
  o_dup text := ('00000000-0000-0000-0000-' || lpad('c0d0', 12, '0'));
  o_e text := ('00000000-0000-0000-0000-' || lpad('c0e0', 12, '0'));
  v_state text;
BEGIN
  -- Fixtures (as the migration owner). handle_new_user writes the public.users rows.
  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
  SELECT x.id, ('00000000-0000-0000-0000-' || lpad('0', 12, '0'))::uuid, 'authenticated', 'authenticated', x.email,
         x.meta, '{"provider":"azure"}'::jsonb, now(), now()
    FROM (VALUES
      (a,  'c4034a@example.test',  jsonb_build_object('custom_claims', jsonb_build_object('tid', ta, 'oid', o_forged))),
      (b,  'c4034b@example.test',  '{}'::jsonb),
      (d1, 'c4034d1@example.test', '{}'::jsonb),
      (d2, 'c4034d2@example.test', '{}'::jsonb),
      (e,  'c4034e@example.test',  '{}'::jsonb)) AS x(id, email, meta);

  INSERT INTO auth.identities (id, user_id, provider, provider_id, identity_data, created_at, updated_at)
  SELECT gen_random_uuid(), x.uid, 'azure', x.pid,
         jsonb_build_object('sub', x.pid, 'custom_claims', jsonb_build_object('tid', x.tid, 'oid', x.oid)), now(), now()
    FROM (VALUES
      (a,  'p4034-a',  upper(ta), ' ' || upper(o) || ' '),  -- case and spaces: lower(btrim()) must match
      (b,  'p4034-b',  tb, o),
      (d1, 'p4034-d1', td, o_dup),
      (d2, 'p4034-d2', td, o_dup),
      (e,  'p4034-e',  ta, o_e)) AS x(uid, pid, tid, oid);

  -- C6e fixture: the identity's user has no public.users row.
  DELETE FROM public.users WHERE id = e;

  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  SET LOCAL ROLE service_role;

  -- C3: the tenant decides.
  IF public.user_id_for_idp_object_id(ta, o) IS DISTINCT FROM a THEN RAISE EXCEPTION 'C3 FAIL: tenant A'; END IF;
  IF public.user_id_for_idp_object_id(tb, o) IS DISTINCT FROM b THEN RAISE EXCEPTION 'C3 FAIL: tenant B'; END IF;
  IF public.user_id_for_idp_object_id(tc, o) IS NOT NULL THEN RAISE EXCEPTION 'C3 FAIL: unknown tenant'; END IF;
  IF (SELECT count(*) FROM public.idp_object_ids_for_users(ARRAY[a, b], ta)) <> 1 THEN
    RAISE EXCEPTION 'C3 FAIL: member map crossed tenants'; END IF;
  IF (SELECT m.object_id FROM public.idp_object_ids_for_users(ARRAY[a, b], ta) m WHERE m.user_id = a) IS DISTINCT FROM o THEN
    RAISE EXCEPTION 'C3 FAIL: member map object id not lower(btrim())'; END IF;

  -- C6c: a client-settable claim (raw_user_meta_data) is never read.
  IF public.user_id_for_idp_object_id(ta, o_forged) IS NOT NULL THEN RAISE EXCEPTION 'C6c FAIL: forged claim matched'; END IF;

  -- C6d: two accounts with the same (tid, oid) -> NULL.
  IF public.user_id_for_idp_object_id(td, o_dup) IS NOT NULL THEN RAISE EXCEPTION 'C6d FAIL: ambiguous returned an id'; END IF;

  -- C6e: no public.users row -> NULL, and not in the member map.
  IF public.user_id_for_idp_object_id(ta, o_e) IS NOT NULL THEN RAISE EXCEPTION 'C6e FAIL: id without a users row'; END IF;
  IF (SELECT count(*) FROM public.idp_object_ids_for_users(ARRAY[e], ta)) <> 0 THEN
    RAISE EXCEPTION 'C6e FAIL: member map returned an id without a users row'; END IF;

  -- C6b: the inside check refuses a signed-in caller even when EXECUTE is granted.
  RESET ROLE;
  GRANT EXECUTE ON FUNCTION public.user_id_for_idp_object_id(text, text) TO authenticated;
  GRANT EXECUTE ON FUNCTION public.idp_object_ids_for_users(uuid[], text) TO authenticated;
  PERFORM set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', a)::text, true);
  SET LOCAL ROLE authenticated;
  v_state := NULL;
  BEGIN
    PERFORM public.user_id_for_idp_object_id(ta, o);
  EXCEPTION WHEN OTHERS THEN v_state := SQLSTATE;
  END;
  IF v_state IS DISTINCT FROM '42501' THEN RAISE EXCEPTION 'C6b FAIL: user_id_for_idp_object_id answered (%)', v_state; END IF;
  v_state := NULL;
  BEGIN
    PERFORM count(*) FROM public.idp_object_ids_for_users(ARRAY[a], ta);
  EXCEPTION WHEN OTHERS THEN v_state := SQLSTATE;
  END;
  IF v_state IS DISTINCT FROM '42501' THEN RAISE EXCEPTION 'C6b FAIL: idp_object_ids_for_users answered (%)', v_state; END IF;
  RESET ROLE;

  RAISE EXCEPTION 'ALL PASS: C3 C6b C6c C6d C6e';
END
$controls$;
