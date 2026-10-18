-- BACKLOG-3851 PR-2f DB controls (C1-C6, names, C21). Venue: keepr-test (cloud), ONE
-- transaction that ends in RAISE, so nothing persists. Run via compose.sh:
--   M4a + M4 (or a mutant of M4) + this file, as one execute_sql call.
-- Every result is recorded in r; the final RAISE prints them:
--   PR2F_RESULT {"C1": "PASS", ...}  -- any value other than PASS is a red.
-- Fixtures: two new organizations and eight new auth users (p2fc-*@example.test).
-- Test Brokerage Alpha/Beta and their members are never read or written.

DO $ctl$
DECLARE
  r jsonb := '{}'::jsonb;
  o_full uuid := gen_random_uuid();  -- max_seats 2: admin + one licensed invite = full
  o_free uuid := gen_random_uuid();  -- max_seats 5
  o_chk uuid := gen_random_uuid();   -- C21 brokerage
  ua uuid := gen_random_uuid(); ub uuid := gen_random_uuid();
  u1 uuid := gen_random_uuid(); u2 uuid := gen_random_uuid(); u3 uuid := gen_random_uuid();
  u4 uuid := gen_random_uuid(); uc uuid := gen_random_uuid(); ucadm uuid := gen_random_uuid();
  v jsonb; s text; n int; n2 int; p_org uuid;
BEGIN
  EXECUTE $f$CREATE FUNCTION pg_temp.as_user(u uuid, e text) RETURNS void LANGUAGE plpgsql AS $b$
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated', 'email', e)::text, true);
    PERFORM set_config('request.jwt.claim.sub', u::text, true);
  END $b$$f$;
  EXECUTE $f$CREATE FUNCTION pg_temp.row_of(o uuid, e text) RETURNS text LANGUAGE sql AS $b$
    SELECT string_agg(license_status || '/' || CASE WHEN user_id IS NULL THEN 'unclaimed' ELSE 'claimed' END, ',')
      FROM public.organization_members WHERE organization_id = o AND invited_email = e
  $b$$f$;
  EXECUTE $f$CREATE FUNCTION pg_temp.seats(o uuid) RETURNS int LANGUAGE sql AS $b$
    SELECT count(*)::int FROM public.organization_members
     WHERE organization_id = o AND public.member_row_holds_seat(license_status, invitation_expires_at, user_id)
  $b$$f$;

  INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  SELECT x.id, x.e, 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now()
  FROM (VALUES (ua, 'p2fc-a@example.test'), (ub, 'p2fc-b@example.test'), (u1, 'p2fc-u1@example.test'),
               (u2, 'p2fc-u2@example.test'), (u3, 'p2fc-u3@example.test'), (u4, 'p2fc-u4@example.test'),
               (uc, 'p2fc-c@example.test'), (ucadm, 'p2fc-cadm@example.test')) x(id, e);
  INSERT INTO public.users (id, email, oauth_provider, oauth_id)
  SELECT x.id, x.e, 'email', x.id::text
  FROM (VALUES (ua, 'p2fc-a@example.test'), (ub, 'p2fc-b@example.test'), (uc, 'p2fc-c@example.test'), (ucadm, 'p2fc-cadm@example.test')) x(id, e)
  ON CONFLICT (id) DO NOTHING;
  -- u2 already has a first name (fill-blank must keep it) and no last name.
  INSERT INTO public.users (id, email, oauth_provider, oauth_id, first_name, last_name)
  VALUES (u2, 'p2fc-u2@example.test', 'email', u2::text, 'Zed', NULL)
  ON CONFLICT (id) DO UPDATE SET first_name = 'Zed', last_name = NULL;

  INSERT INTO organizations (id, name, slug, max_seats) VALUES
    (o_full, 'P2FC Full', 'p2fc-full-' || left(o_full::text, 8), 2),
    (o_free, 'P2FC Free', 'p2fc-free-' || left(o_free::text, 8), 5),
    (o_chk, 'P2FC Checklists', 'p2fc-chk-' || left(o_chk::text, 8), 5);
  INSERT INTO organization_members (organization_id, user_id, role, license_status, joined_at, provisioned_by)
  VALUES (o_full, ua, 'admin', 'active', now(), 'manual'), (o_free, ub, 'admin', 'active', now(), 'manual');
  INSERT INTO organization_members (organization_id, invited_email, role, license_status, invitation_token, invitation_expires_at, invited_by, provisioned_by)
  VALUES (o_full, 'p2fc-licensed@example.test', 'agent', 'pending', 'p2fc-tok-lic', now() + interval '7 days', ua, 'invite');

  -- C1: unlicensed client invite into a FULL org is inserted; seat count unchanged (2).
  BEGIN
    PERFORM pg_temp.as_user(ua, 'p2fc-a@example.test'); EXECUTE 'SET LOCAL ROLE authenticated';
    INSERT INTO organization_members (organization_id, invited_email, role, license_status, invitation_token, invitation_expires_at, invited_by, invited_at, provisioned_by, invited_first_name, invited_last_name)
    VALUES (o_full, 'p2fc-u1@example.test', 'agent', 'unassigned', 'p2fc-tok-u1', now() + interval '7 days', ua, now(), 'invite', 'Ann', 'Lee');
    EXECUTE 'RESET ROLE';
    n := pg_temp.seats(o_full);
    r := r || jsonb_build_object('C1', CASE WHEN n = 2 AND pg_temp.row_of(o_full, 'p2fc-u1@example.test') = 'unassigned/unclaimed' THEN 'PASS' ELSE 'FAIL seats=' || n END);
  EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE'; r := r || jsonb_build_object('C1', 'FAIL ' || SQLSTATE || ' ' || left(SQLERRM, 80)); END;

  -- C6a: a LICENSED client invite into the full org is still refused (42501 max seats).
  BEGIN
    PERFORM pg_temp.as_user(ua, 'p2fc-a@example.test'); EXECUTE 'SET LOCAL ROLE authenticated';
    INSERT INTO organization_members (organization_id, invited_email, role, license_status, invitation_token, invitation_expires_at, invited_by, invited_at, provisioned_by)
    VALUES (o_full, 'p2fc-x@example.test', 'agent', 'pending', 'p2fc-tok-x', now() + interval '7 days', ua, now(), 'invite');
    EXECUTE 'RESET ROLE';
    r := r || jsonb_build_object('C6a', 'FAIL licensed invite inserted into a full org');
  EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE';
    r := r || jsonb_build_object('C6a', CASE WHEN SQLSTATE = '42501' AND SQLERRM = 'Organization has reached maximum seats' THEN 'PASS' ELSE 'FAIL ' || SQLSTATE || ' ' || left(SQLERRM, 80) END);
  END;

  -- S-c (recorded behaviour, not a red): a client insert of an already-expired 'pending'
  -- invite into the full org is now admitted (it holds no seat); its Resend meets the seat trigger.
  BEGIN
    PERFORM pg_temp.as_user(ua, 'p2fc-a@example.test'); EXECUTE 'SET LOCAL ROLE authenticated';
    INSERT INTO organization_members (organization_id, invited_email, role, license_status, invitation_token, invitation_expires_at, invited_by, invited_at, provisioned_by)
    VALUES (o_full, 'p2fc-y@example.test', 'agent', 'pending', 'p2fc-tok-y', now() - interval '1 day', ua, now(), 'invite');
    BEGIN
      UPDATE organization_members SET invitation_token = 'p2fc-tok-y2', invitation_expires_at = now() + interval '7 days'
       WHERE organization_id = o_full AND invited_email = 'p2fc-y@example.test';
      s := 'resend ADMITTED';
    EXCEPTION WHEN OTHERS THEN s := 'resend refused ' || SQLSTATE;
    END;
    EXECUTE 'RESET ROLE';
    r := r || jsonb_build_object('Sc_expired_pending_insert', 'admitted; ' || s);
    DELETE FROM organization_members WHERE organization_id = o_full AND invited_email = 'p2fc-y@example.test';
  EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE'; r := r || jsonb_build_object('Sc_expired_pending_insert', 'refused ' || SQLSTATE || ' ' || left(SQLERRM, 60)); END;

  -- F4: the landing page validator reports licensed=false and the invited first name.
  v := public.public_validate_invitation_token('p2fc-tok-u1');
  r := r || jsonb_build_object('F4_unlicensed', CASE WHEN (v->>'valid')::boolean AND v->'licensed' = 'false'::jsonb AND v->>'first_name' = 'Ann' THEN 'PASS' ELSE 'FAIL ' || v::text END);
  v := public.public_validate_invitation_token('p2fc-tok-lic');
  r := r || jsonb_build_object('F4_licensed', CASE WHEN v->'licensed' = 'true'::jsonb AND v ? 'first_name' AND v->'first_name' = 'null'::jsonb THEN 'PASS' ELSE 'FAIL ' || v::text END);

  -- Admin edits on an unclaimed unlicensed row: names may change; the status may not.
  BEGIN
    PERFORM pg_temp.as_user(ua, 'p2fc-a@example.test'); EXECUTE 'SET LOCAL ROLE authenticated';
    UPDATE organization_members SET invited_first_name = 'Anne' WHERE organization_id = o_full AND invited_email = 'p2fc-u1@example.test';
    GET DIAGNOSTICS n = ROW_COUNT;
    EXECUTE 'RESET ROLE';
    r := r || jsonb_build_object('G_admin_edits_name', CASE WHEN n = 1 THEN 'PASS' ELSE 'FAIL rows=' || n END);
  EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE'; r := r || jsonb_build_object('G_admin_edits_name', 'FAIL ' || SQLSTATE || ' ' || left(SQLERRM, 80)); END;
  BEGIN
    PERFORM pg_temp.as_user(ua, 'p2fc-a@example.test'); EXECUTE 'SET LOCAL ROLE authenticated';
    UPDATE organization_members SET license_status = 'pending' WHERE organization_id = o_full AND invited_email = 'p2fc-u1@example.test';
    EXECUTE 'RESET ROLE';
    r := r || jsonb_build_object('G_admin_cannot_flip_status', 'FAIL unassigned -> pending admitted');
  EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE';
    r := r || jsonb_build_object('G_admin_cannot_flip_status', CASE WHEN SQLSTATE = '42501' AND SQLERRM LIKE 'Only the role or invitation%' THEN 'PASS' ELSE 'FAIL ' || SQLSTATE || ' ' || left(SQLERRM, 80) END);
  END;

  -- C4: the detector sees the unlicensed invitation on its own (asserted before any accept).
  PERFORM pg_temp.as_user(u1, 'p2fc-u1@example.test'); EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    r := r || jsonb_build_object('C4_detector', CASE WHEN public.caller_has_pending_invite() THEN 'PASS' ELSE 'FAIL detector false' END);
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('C4_detector', 'FAIL ' || SQLSTATE); END;

  -- C3: accept in the FULL org succeeds and lands 'unassigned'; seats stay 2; names fill blanks.
  BEGIN
    v := public.accept_invitation('p2fc-tok-u1');
    EXECUTE 'RESET ROLE';
    s := pg_temp.row_of(o_full, 'p2fc-u1@example.test');
    SELECT coalesce(first_name, '-') || ' ' || coalesce(last_name, '-') || ' / ' || coalesce(display_name, '-') INTO STRICT s FROM (SELECT * FROM public.users WHERE id = u1) x;
    r := r || jsonb_build_object('C3', CASE WHEN (v->>'success')::boolean AND v->>'license_status' = 'unassigned'
                                              AND pg_temp.row_of(o_full, 'p2fc-u1@example.test') = 'unassigned/claimed'
                                              AND pg_temp.seats(o_full) = 2
                                         THEN 'PASS' ELSE 'FAIL ' || v::text || ' row=' || coalesce(pg_temp.row_of(o_full, 'p2fc-u1@example.test'), 'none') END);
    r := r || jsonb_build_object('N1_blank_filled', CASE WHEN s = 'Anne Lee / Anne Lee' THEN 'PASS' ELSE 'FAIL ' || s END);
  EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE'; r := r || jsonb_build_object('C3', 'FAIL ' || SQLSTATE || ' ' || left(SQLERRM, 80)); END;

  -- C2: in a FREE-seat org an unlicensed invitation is still accepted as 'unassigned'
  --     (the most likely wrong build, "the claim sets 'active'", succeeds here silently).
  BEGIN
    PERFORM pg_temp.as_user(ub, 'p2fc-b@example.test'); EXECUTE 'SET LOCAL ROLE authenticated';
    INSERT INTO organization_members (organization_id, invited_email, role, license_status, invitation_token, invitation_expires_at, invited_by, invited_at, provisioned_by, invited_first_name, invited_last_name)
    VALUES (o_free, 'p2fc-u2@example.test', 'agent', 'unassigned', 'p2fc-tok-u2', now() + interval '7 days', ub, now(), 'invite', 'Bob', 'Ray');
    EXECUTE 'RESET ROLE';
    PERFORM pg_temp.as_user(u2, 'p2fc-u2@example.test'); EXECUTE 'SET LOCAL ROLE authenticated';
    v := public.accept_invitation('p2fc-tok-u2');
    EXECUTE 'RESET ROLE';
    r := r || jsonb_build_object('C2', CASE WHEN (v->>'success')::boolean AND pg_temp.row_of(o_free, 'p2fc-u2@example.test') = 'unassigned/claimed'
                                         THEN 'PASS' ELSE 'FAIL ' || v::text || ' row=' || coalesce(pg_temp.row_of(o_free, 'p2fc-u2@example.test'), 'none') END);
    SELECT coalesce(first_name, '-') || ' ' || coalesce(last_name, '-') || ' / ' || coalesce(display_name, '-') INTO STRICT s FROM public.users WHERE id = u2;
    r := r || jsonb_build_object('N2_existing_kept', CASE WHEN s = 'Zed Ray / Zed Ray' THEN 'PASS' ELSE 'FAIL ' || s END);
  EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE'; r := r || jsonb_build_object('C2', 'FAIL ' || SQLSTATE || ' ' || left(SQLERRM, 80)); END;

  -- C6b: a LICENSED invitation is still accepted as 'active'.
  BEGIN
    INSERT INTO organization_members (organization_id, invited_email, role, license_status, invitation_token, invitation_expires_at, invited_by, invited_at, provisioned_by)
    VALUES (o_free, 'p2fc-u3@example.test', 'agent', 'pending', 'p2fc-tok-u3', now() + interval '7 days', ub, now(), 'invite');
    PERFORM pg_temp.as_user(u3, 'p2fc-u3@example.test'); EXECUTE 'SET LOCAL ROLE authenticated';
    v := public.accept_invitation('p2fc-tok-u3');
    EXECUTE 'RESET ROLE';
    r := r || jsonb_build_object('C6b', CASE WHEN (v->>'success')::boolean AND v->>'license_status' = 'active' AND pg_temp.row_of(o_free, 'p2fc-u3@example.test') = 'active/claimed'
                                          THEN 'PASS' ELSE 'FAIL ' || v::text END);
  EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE'; r := r || jsonb_build_object('C6b', 'FAIL ' || SQLSTATE || ' ' || left(SQLERRM, 80)); END;

  -- C5: an expired unlicensed invitation answers 'expired'; its Resend in the full org succeeds.
  BEGIN
    INSERT INTO organization_members (organization_id, invited_email, role, license_status, invitation_token, invitation_expires_at, invited_by, invited_at, provisioned_by)
    VALUES (o_full, 'p2fc-u4@example.test', 'agent', 'unassigned', 'p2fc-tok-u4', now() - interval '1 day', ua, now(), 'invite');
    PERFORM pg_temp.as_user(u4, 'p2fc-u4@example.test'); EXECUTE 'SET LOCAL ROLE authenticated';
    v := public.accept_invitation('p2fc-tok-u4');
    EXECUTE 'RESET ROLE';
    s := coalesce(v->>'error', 'success');
    PERFORM pg_temp.as_user(ua, 'p2fc-a@example.test'); EXECUTE 'SET LOCAL ROLE authenticated';
    UPDATE organization_members SET invitation_token = 'p2fc-tok-u4b', invitation_expires_at = now() + interval '7 days'
     WHERE organization_id = o_full AND invited_email = 'p2fc-u4@example.test';
    GET DIAGNOSTICS n = ROW_COUNT;
    EXECUTE 'RESET ROLE';
    r := r || jsonb_build_object('C5', CASE WHEN s = 'expired' AND n = 1 AND pg_temp.seats(o_full) = 2 THEN 'PASS' ELSE 'FAIL accept=' || s || ' resend_rows=' || n END);
  EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE'; r := r || jsonb_build_object('C5', 'FAIL ' || SQLSTATE || ' ' || left(SQLERRM, 80)); END;

  -- C21 (S3): a deactivated member with a Personal org reads 0 brokerage templates/items
  --      and updates 0. The brokerage row is created active, then suspended, so M2 attaches
  --      the Personal organization exactly as in production.
  BEGIN
    INSERT INTO organization_members (organization_id, user_id, role, license_status, joined_at, provisioned_by)
    VALUES (o_chk, ucadm, 'admin', 'active', now(), 'manual'), (o_chk, uc, 'agent', 'active', now(), 'manual');
    UPDATE organization_members SET license_status = 'suspended' WHERE organization_id = o_chk AND user_id = uc;
    SELECT id INTO p_org FROM organizations WHERE personal_owner_user_id = uc;
    IF p_org IS NULL THEN
      INSERT INTO organizations (name, slug, personal_owner_user_id) VALUES ('P2FC Personal', 'p2fc-pers-' || left(uc::text, 8), uc) RETURNING id INTO p_org;
      INSERT INTO organization_members (organization_id, user_id, role, license_status, joined_at, provisioned_by)
      VALUES (p_org, uc, 'admin', 'active', now(), 'manual');
    END IF;
    WITH t AS (
      INSERT INTO checklist_templates (organization_id, name, owner_user_id, created_by)
      VALUES (o_chk, 'P2FC brokerage template', NULL, ucadm), (o_chk, 'P2FC agent brokerage-era template', uc, uc), (p_org, 'P2FC personal template', uc, uc)
      RETURNING id
    ) INSERT INTO checklist_template_items (template_id, title) SELECT id, 'P2FC item' FROM t;
    PERFORM pg_temp.as_user(uc, 'p2fc-c@example.test'); EXECUTE 'SET LOCAL ROLE authenticated';
    SELECT count(*) INTO n FROM checklist_templates WHERE name LIKE 'P2FC%' AND organization_id = o_chk;
    SELECT count(*) INTO n2 FROM checklist_template_items i JOIN checklist_templates t ON t.id = i.template_id WHERE i.title = 'P2FC item' AND t.organization_id = o_chk;
    UPDATE checklist_templates SET name = name || ' x' WHERE organization_id = o_chk;
    EXECUTE 'RESET ROLE';
    SELECT count(*) INTO STRICT s FROM checklist_templates WHERE organization_id = o_chk AND name LIKE '% x';
    r := r || jsonb_build_object('C21', CASE WHEN n = 0 AND n2 = 0 AND s = '0' THEN 'PASS' ELSE 'FAIL templates=' || n || ' items=' || n2 || ' updated=' || s END,
                                 'C21_personal_visible_note', 'personal org ' || CASE WHEN p_org IS NULL THEN 'missing' ELSE 'present' END);
  EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE'; r := r || jsonb_build_object('C21', 'FAIL ' || SQLSTATE || ' ' || left(SQLERRM, 120)); END;

  -- Bodies that actually ran (compare with body_md5.py on the file or mutant that was composed).
  r := r || jsonb_build_object('md5',
    (SELECT string_agg(p.proname || '=' || left(md5(p.prosrc), 8), ' ' ORDER BY p.proname) FROM pg_proc p
      WHERE p.oid IN ('public.guard_invite_acceptance()'::regprocedure, 'public.accept_invitation(text,text)'::regprocedure,
                      'public.caller_has_pending_invite()'::regprocedure, 'public.public_validate_invitation_token(text)'::regprocedure)));
  RAISE EXCEPTION 'PR2F_RESULT %', r::text;
END $ctl$;
