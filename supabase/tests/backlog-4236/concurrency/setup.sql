-- BACKLOG-4236 two-session fixtures. Needs both migrations APPLIED (committed) on the test project.
-- run-concurrency.sh fills __A__ (user), __O__ (organization), __M__ (membership), __I__ (install)
-- and __RUN__, all random per run. COMMITS: one user, one organization on the team plan with
-- cloud_autosave_assignable on, one active membership, the assignment, Cloud on, deal cc-1 with
-- message cc-m1, deals cc-4a and cc-4b, two registered blobs. teardown.sql removes exactly these rows.
DO $cc$
DECLARE A uuid := '__A__'::uuid; O uuid := '__O__'::uuid; r jsonb; d uuid;
BEGIN
  SET LOCAL session_replication_role = replica;
  INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  VALUES (A, 'p4236cc-__RUN__@example.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now());
  INSERT INTO public.users (id, email, oauth_provider, oauth_id, display_name)
  VALUES (A, 'p4236cc-__RUN__@example.test', 'email', A::text, 'Fixture cc') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.organizations (id, name, slug) VALUES (O, 'Fixture cc', 'p4236cc-__RUN__');
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
  r := public.set_my_cloud_autosave(true, 1);
  IF r ->> 'success' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'enable failed: %', r; END IF;
  r := public.cloud_upsert_deal(jsonb_build_object('source_install_id', '__I__', 'local_id', 'cc-1', 'content_hash', encode(sha256('cc-1'::bytea), 'hex')));
  d := (r -> 'results' -> 0 ->> 'cloud_id')::uuid;
  r := public.cloud_upsert_messages('__I__'::uuid, d, jsonb_build_array(jsonb_build_object('local_id', 'cc-m1',
         'content_hash', encode(sha256('cc-m1'::bytea), 'hex'), 'channel_kind', 'email', 'hidden_from_export', false)));
  IF r -> 'results' -> 0 ->> 'status' IS DISTINCT FROM 'applied' THEN RAISE EXCEPTION 'message failed: %', r; END IF;
  PERFORM public.cloud_upsert_deal(jsonb_build_object('source_install_id', '__I__', 'local_id', 'cc-4a', 'content_hash', encode(sha256('cc-4a'::bytea), 'hex')));
  PERFORM public.cloud_upsert_deal(jsonb_build_object('source_install_id', '__I__', 'local_id', 'cc-4b', 'content_hash', encode(sha256('cc-4b'::bytea), 'hex')));
  PERFORM public.cloud_register_blob(encode(sha256('cc-b1-__RUN__'::bytea), 'hex'), 10, NULL);
  PERFORM public.cloud_register_blob(encode(sha256('cc-b2-__RUN__'::bytea), 'hex'), 10, NULL);
END
$cc$;
SELECT (SELECT id FROM public.cloud_deals WHERE owner_user_id = '__A__'::uuid AND local_transaction_id = 'cc-1') AS deal,
       (SELECT m.id FROM public.cloud_deal_messages m WHERE m.owner_user_id = '__A__'::uuid AND m.local_message_id = 'cc-m1') AS message,
       (SELECT id FROM public.cloud_deals WHERE owner_user_id = '__A__'::uuid AND local_transaction_id = 'cc-4a') AS deal4a,
       (SELECT id FROM public.cloud_deals WHERE owner_user_id = '__A__'::uuid AND local_transaction_id = 'cc-4b') AS deal4b,
       (SELECT sha256 FROM public.cloud_blobs WHERE owner_user_id = '__A__'::uuid ORDER BY id LIMIT 1) AS low_sha,
       (SELECT id FROM public.cloud_blobs WHERE owner_user_id = '__A__'::uuid ORDER BY id LIMIT 1) AS low_id,
       (SELECT sha256 FROM public.cloud_blobs WHERE owner_user_id = '__A__'::uuid ORDER BY id DESC LIMIT 1) AS high_sha;
