-- BACKLOG-4263 S1 two-session fixtures. Needs 20261123100000 APPLIED (committed) on the test project.
-- run.sh fills __A__ (user), __O__ (organization), __M__ (membership), __IA__ / __IB__ (installs), __RUN__ and __ACTIVE__
-- ('IA' to make IA the active computer, 'none' to leave no active computer). COMMITS: one user, one organization on the
-- team plan with cloud_autosave_assignable on, one active membership, the assignment, Keepr Cloud on, deal r-a (IA),
-- deal r-b (IB), one registered blob of IA. teardown.sql removes exactly these rows (moves and notices go with the user).
DO $s1cc$
DECLARE A uuid := '__A__'::uuid; O uuid := '__O__'::uuid; r jsonb;
BEGIN
  -- one run at a time: refuse while another run's fixture user (or a leftover) exists
  IF EXISTS (SELECT 1 FROM auth.users u WHERE u.email LIKE 'p4263s1cc-%@example.test') THEN
    RAISE EXCEPTION 'another run is in progress or left fixtures behind (p4263s1cc-*@example.test): run.sh cleanup';
  END IF;
  SET LOCAL session_replication_role = replica;
  INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  VALUES (A, 'p4263s1cc-__RUN__@example.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now());
  INSERT INTO public.users (id, email, oauth_provider, oauth_id, display_name)
  VALUES (A, 'p4263s1cc-__RUN__@example.test', 'email', A::text, 'Fixture s1cc') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.organizations (id, name, slug) VALUES (O, 'Fixture s1cc', 'p4263s1cc-__RUN__');
  INSERT INTO public.organization_members (id, organization_id, user_id, role, license_status) VALUES ('__M__'::uuid, O, A, 'agent', 'active');
  INSERT INTO public.organization_plans (organization_id, plan_id, feature_overrides)
  VALUES (O, (SELECT id FROM public.plans WHERE tier = 'team' ORDER BY sort_order, name LIMIT 1), '{"cloud_autosave_assignable":{"enabled":true}}');
  SET LOCAL session_replication_role = origin;
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  r := public.assign_member_addon(O, A, 'cloud_autosave', true, NULL);
  IF r ->> 'state' IS DISTINCT FROM 'assigned' THEN RAISE EXCEPTION 'assign failed: %', r; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', A, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', A::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  r := public.set_my_cloud_autosave(A, true, 1, NULL);
  IF r ->> 'success' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'enable failed: %', r; END IF;
  -- both installs save once while no computer is active (the gate lets a computer write only when it is active or the
  -- switch is off; with the switch on and no active computer, set IA active for the fixture writes, then put back)
  UPDATE public.cloud_autosave_settings SET active_install_id = '__IA__'::uuid WHERE user_id = A;
  r := public.cloud_upsert_deal(A, jsonb_build_object('source_install_id', '__IA__', 'local_id', 'r-a', 'content_hash', encode(sha256('r-a'::bytea), 'hex')));
  IF r -> 'results' -> 0 ->> 'status' IS DISTINCT FROM 'applied' THEN RAISE EXCEPTION 'deal a failed: %', r; END IF;
  -- the blob row as cloud_register_blob writes a new one, inserted directly: from 20261123130000 on, register answers
  -- feature_off while cloud_release_switches.messages_upload is off
  INSERT INTO public.cloud_blobs (id, owner_user_id, sha256, size_bytes, mime_type, storage_path)
  SELECT b.id, A, encode(sha256('r-blob-__RUN__'::bytea), 'hex'), 10, NULL, A::text || '/' || b.id::text FROM (SELECT gen_random_uuid() AS id) b;
  UPDATE public.cloud_autosave_settings SET active_install_id = '__IB__'::uuid WHERE user_id = A;
  r := public.cloud_upsert_deal(A, jsonb_build_object('source_install_id', '__IB__', 'local_id', 'r-b', 'content_hash', encode(sha256('r-b'::bytea), 'hex')));
  IF r -> 'results' -> 0 ->> 'status' IS DISTINCT FROM 'applied' THEN RAISE EXCEPTION 'deal b failed: %', r; END IF;
  UPDATE public.cloud_autosave_settings SET active_install_id = CASE WHEN '__ACTIVE__' = 'IA' THEN '__IA__'::uuid END,
                                            active_since = CASE WHEN '__ACTIVE__' = 'IA' THEN now() - interval '1 hour' END
   WHERE user_id = A;
END
$s1cc$;
SELECT (SELECT id FROM public.cloud_blobs WHERE owner_user_id = '__A__'::uuid ORDER BY id LIMIT 1) AS blob,
       (SELECT one_computer FROM public.cloud_release_switches WHERE id) AS one_computer;
