-- BACKLOG-4186 PR B: capture the RPC answers that admin-portal/__tests__/sender-rules-4186/fixtures.ts
-- transcribes. keepr-test ONLY (kt-sql refuses the production ref). One transaction ending in RAISE,
-- so nothing persists.
-- Usage (from the repo root): python3 supabase/tests/backlog-4186/capture-pr-b.py > out.json
--   which drops and re-creates the two PR A read functions inside the same transaction, then runs this.
-- Fixtures: one owner (Super Admin by name), orgs A and B, all invented (example.test).
-- Captures: admin_state before / with a canary + a second pin / after the release; admin_content for
-- a canary and a missing version; publish refusals (guard DETAIL with one block of each kind,
-- invalid rule set, unknown org); pin refusals.
DO $drv$
DECLARE
  r jsonb := '{}'::jsonb;
  u1 uuid;
  oA uuid;
  oB uuid;
  r_sa uuid := (SELECT id FROM public.admin_roles WHERE name = 'Super Admin');
  seed jsonb;
  c jsonb;
  v bigint;
  st text; msg text; det text; hn text;
BEGIN
  -- invented ids, built at run time (no literal UUID in this file)
  EXECUTE $f$CREATE FUNCTION pg_temp.fx(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $b$
    SELECT ('00000000-0000-4186-8000-' || lpad(n::text, 12, '0'))::uuid
  $b$$f$;
  u1 := pg_temp.fx(177); oA := pg_temp.fx(193); oB := pg_temp.fx(194);
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
  VALUES (u1, 'p4186b-1@example.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now());
  INSERT INTO public.users (id, email, oauth_provider, oauth_id, display_name)
  VALUES (u1, 'p4186b-1@example.test', 'email', u1::text, 'P4186B user') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.internal_roles (user_id, role_id) VALUES (u1, r_sa);
  SET LOCAL session_replication_role = replica;
  INSERT INTO public.organizations (id, name, slug) VALUES (oA, 'P4186B Org A', 'p4186b-a'), (oB, 'P4186B Org B', 'p4186b-b');
  SET LOCAL session_replication_role = origin;

  seed := (SELECT content FROM public.sender_rule_sets WHERE released ORDER BY version DESC LIMIT 1);
  r := r || jsonb_build_object('access', pg_temp.call(u1, $q$SELECT to_jsonb(public.report_my_access('sender-rules'))$q$));
  r := r || jsonb_build_object('state_initial', pg_temp.call(u1, 'SELECT public.sender_rule_set_admin_state()'));

  -- guarded release: one of each block kind (mode, add, remove, flag), nothing canaried yet
  c := seed;
  c := jsonb_set(c, '{modes,bulkHeaders,learnQuestions}', '"live"');
  c := jsonb_set(c, '{suppress,hosts}', '["promo.example.com"]');
  c := jsonb_set(c, '{keep,platformHosts}', (c #> '{keep,platformHosts}') - 'showingtime.net');
  c := jsonb_set(c, '{suppress,bulkHeaders,autoSubmittedCounts}', 'true');
  r := r || jsonb_build_object('release_refused', pg_temp.call(u1, format('SELECT to_jsonb(public.sender_rule_set_publish(%L::jsonb, NULL))', c)));
  r := r || jsonb_build_object('invalid', pg_temp.call(u1, format('SELECT to_jsonb(public.sender_rule_set_publish(%L::jsonb, NULL))',
        jsonb_set(seed, '{thresholds,minCensusLinkedEmails}', '"20"'))));
  r := r || jsonb_build_object('org_not_found', pg_temp.call(u1, format('SELECT to_jsonb(public.sender_rule_set_publish(%L::jsonb, %L::uuid))',
        seed, pg_temp.fx(207))));

  -- canary to A with the same content, then pin B to it
  r := r || jsonb_build_object('canary', pg_temp.call(u1, format('SELECT to_jsonb(public.sender_rule_set_publish(%L::jsonb, %L::uuid))', c, oA)));
  v := (SELECT max(version) FROM public.sender_rule_sets);
  r := r || jsonb_build_object('pin_b', pg_temp.call(u1, format('SELECT to_jsonb(public.sender_rule_set_pin(%L::uuid, %L::bigint))', oB, v)));
  r := r || jsonb_build_object('pin_below', pg_temp.call(u1, format('SELECT to_jsonb(public.sender_rule_set_pin(%L::uuid, %L::bigint))', oB, 0)));
  r := r || jsonb_build_object('state_canary', pg_temp.call(u1, 'SELECT public.sender_rule_set_admin_state()'));
  r := r || jsonb_build_object('content_canary', pg_temp.call(u1, format('SELECT public.sender_rule_set_admin_content(%L::bigint)', v)));
  r := r || jsonb_build_object('content_missing', pg_temp.call(u1, 'SELECT public.sender_rule_set_admin_content(999999::bigint)'));
  -- the same release now passes (a newer canary carried every change)
  r := r || jsonb_build_object('release_after_canary', pg_temp.call(u1, format('SELECT to_jsonb(public.sender_rule_set_publish(%L::jsonb, NULL))', c)));
  r := r || jsonb_build_object('state_released', pg_temp.call(u1, 'SELECT public.sender_rule_set_admin_state()'));
  r := r || jsonb_build_object('pin_below_released', pg_temp.call(u1, format('SELECT to_jsonb(public.sender_rule_set_pin(%L::uuid, %L::bigint))', oB, v)));
  RAISE EXCEPTION 'P4186B_CAPTURE %', r;
END
$drv$;
