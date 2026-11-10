-- BACKLOG-4186 PR C: capture the RPC answers that admin-portal/__tests__/sender-rules-4186/fixtures-pr-c.ts
-- transcribes. keepr-test ONLY (kt-sql refuses the production ref). One transaction ending in RAISE,
-- so nothing persists.
-- Usage (from the repo root): python3 supabase/tests/backlog-4186/capture-pr-c.py > out.json
-- Fixtures, all invented (example.test): u1 Super Admin (owner); u2 Support Supervisor + viewer grant;
-- u3 Support Supervisor + editor grant; u4 Support Supervisor, no grant. Orgs A (not test), B (is_test).
-- Captures: report_my_access per user; reads as viewer / editor; the 42501 a no-grant user gets on a
-- READ and a viewer gets on a WRITE; a state where one org tests a newer canary while another is
-- pinned AT the released version; admin_list_organizations (the fixture orgs only); revert_all.
DO $drv$
DECLARE
  r jsonb := '{}'::jsonb;
  u1 uuid; u2 uuid; u3 uuid; u4 uuid;
  oA uuid; oB uuid;
  r_sa uuid := (SELECT id FROM public.admin_roles WHERE name = 'Super Admin');
  r_ss uuid := (SELECT id FROM public.admin_roles WHERE name = 'Support Supervisor');
  seed jsonb;
  c jsonb;
  c2 jsonb;
  v bigint;
  orgs jsonb;
BEGIN
  -- invented ids, built at run time (no literal UUID in this file)
  EXECUTE $f$CREATE FUNCTION pg_temp.fx(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $b$
    SELECT ('00000000-0000-4186-8000-' || lpad(n::text, 12, '0'))::uuid
  $b$$f$;
  u1 := pg_temp.fx(301); u2 := pg_temp.fx(302); u3 := pg_temp.fx(303); u4 := pg_temp.fx(304);
  oA := pg_temp.fx(321); oB := pg_temp.fx(322);
  EXECUTE $f$CREATE FUNCTION pg_temp.call(u uuid, q text) RETURNS jsonb LANGUAGE plpgsql AS $b$
  DECLARE j jsonb; st text; msg text; det text; hn text;
  BEGIN
    BEGIN
      PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
      PERFORM set_config('request.jwt.claim.sub', u::text, true);
      SET LOCAL ROLE authenticated;
      EXECUTE q INTO j;
      RESET ROLE;
      RETURN jsonb_build_object('data', j);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, msg = MESSAGE_TEXT, det = PG_EXCEPTION_DETAIL, hn = PG_EXCEPTION_HINT;
      RESET ROLE;
      RETURN jsonb_build_object('error', jsonb_build_object('code', st, 'message', msg, 'details', nullif(det, ''), 'hint', nullif(hn, '')));
    END;
  END $b$$f$;

  INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  SELECT pg_temp.fx(300 + x), 'p4186c-' || x || '@example.test', 'authenticated', 'authenticated',
         '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now()
    FROM generate_series(1, 4) x;
  INSERT INTO public.users (id, email, oauth_provider, oauth_id, display_name)
  SELECT pg_temp.fx(300 + x), 'p4186c-' || x || '@example.test', 'email', pg_temp.fx(300 + x)::text, 'P4186C user ' || x
    FROM generate_series(1, 4) x
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.internal_roles (user_id, role_id) VALUES (u1, r_sa), (u2, r_ss), (u3, r_ss), (u4, r_ss);
  INSERT INTO public.report_access (report_key, user_id, role) VALUES ('sender-rules', u2, 'viewer'), ('sender-rules', u3, 'editor');
  SET LOCAL session_replication_role = replica;
  INSERT INTO public.organizations (id, name, slug, is_test) VALUES (oA, 'P4186C Org A', 'p4186c-a', false), (oB, 'P4186C Org B', 'p4186c-b', true);
  SET LOCAL session_replication_role = origin;

  r := r || jsonb_build_object('access', jsonb_build_object(
    'owner', pg_temp.call(u1, $q$SELECT to_jsonb(public.report_my_access('sender-rules'))$q$),
    'viewer', pg_temp.call(u2, $q$SELECT to_jsonb(public.report_my_access('sender-rules'))$q$),
    'editor', pg_temp.call(u3, $q$SELECT to_jsonb(public.report_my_access('sender-rules'))$q$),
    'none', pg_temp.call(u4, $q$SELECT to_jsonb(public.report_my_access('sender-rules'))$q$)));

  -- reads by role
  r := r || jsonb_build_object('read_none', pg_temp.call(u4, 'SELECT public.sender_rule_set_admin_state()'));
  r := r || jsonb_build_object('read_viewer', pg_temp.call(u2, 'SELECT public.sender_rule_set_admin_state()'));
  r := r || jsonb_build_object('read_editor', pg_temp.call(u3, 'SELECT public.sender_rule_set_admin_state()'));

  seed := (SELECT content FROM public.sender_rule_sets WHERE released ORDER BY version DESC LIMIT 1);
  r := r || jsonb_build_object('write_viewer', pg_temp.call(u2, format('SELECT to_jsonb(public.sender_rule_set_publish(%L::jsonb, %L::uuid))', seed, oB)));
  r := r || jsonb_build_object('write_editor', pg_temp.call(u3, 'SELECT to_jsonb(public.sender_rule_set_revert_all())'));

  -- owner: canary to A, release it (ends the test), pin B AT the released version, newer canary to A
  c := jsonb_set(seed, '{suppress,hosts}', '["promo.example.com"]');
  r := r || jsonb_build_object('canary_1', pg_temp.call(u1, format('SELECT to_jsonb(public.sender_rule_set_publish(%L::jsonb, %L::uuid))', c, oA)));
  r := r || jsonb_build_object('release_1', pg_temp.call(u1, format('SELECT to_jsonb(public.sender_rule_set_publish(%L::jsonb, NULL))', c)));
  v := (SELECT max(version) FROM public.sender_rule_sets WHERE released);
  r := r || jsonb_build_object('pin_b_at_released', pg_temp.call(u1, format('SELECT to_jsonb(public.sender_rule_set_pin(%L::uuid, %L::bigint))', oB, v)));
  c2 := jsonb_set(c, '{suppress,hosts}', '["promo.example.com", "news.example.com"]');
  r := r || jsonb_build_object('canary_2', pg_temp.call(u1, format('SELECT to_jsonb(public.sender_rule_set_publish(%L::jsonb, %L::uuid))', c2, oA)));
  r := r || jsonb_build_object('state_mixed', pg_temp.call(u1, 'SELECT public.sender_rule_set_admin_state()'));
  r := r || jsonb_build_object('content_released', pg_temp.call(u1, format('SELECT public.sender_rule_set_admin_content(%L::bigint)', v)));
  r := r || jsonb_build_object('content_canary_2', pg_temp.call(u1,
        format('SELECT public.sender_rule_set_admin_content(%L::bigint)', (SELECT max(version) FROM public.sender_rule_sets))));

  -- the org list as the owner sees it, the fixture orgs only (keepr-test's own orgs are left out)
  orgs := pg_temp.call(u1, 'SELECT public.admin_list_organizations()');
  r := r || jsonb_build_object('orgs', jsonb_build_object(
    'success', orgs #> '{data,success}',
    'organizations', (SELECT jsonb_agg(o ORDER BY o->>'name') FROM jsonb_array_elements(orgs #> '{data,organizations}') o
                       WHERE (o->>'id')::uuid IN (oA, oB))));

  r := r || jsonb_build_object('revert_all', pg_temp.call(u1, 'SELECT to_jsonb(public.sender_rule_set_revert_all())'));
  r := r || jsonb_build_object('state_reverted', pg_temp.call(u1, 'SELECT public.sender_rule_set_admin_state()'));
  RAISE EXCEPTION 'P4186C_CAPTURE %', r;
END
$drv$;
