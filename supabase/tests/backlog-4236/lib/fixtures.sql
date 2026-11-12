-- BACKLOG-4236 base fixtures (invented). Ids from pg_temp.fx(n), random per run.
--   users: 1 A agent in O (assigned), 2 B broker in O, 3 AD admin in O, 4 S solo (personal org PS,
--          key on by override), 5 J (personal org PJ with no membership, key on; agent in O, no
--          assignment), 6 X no organization, 7 IR internal-role user, member of nothing
--   orgs:  101 O brokerage (team plan, assignable on), 102 O2 brokerage (team plan, nothing on),
--          104 PS (S personal), 105 PJ (J personal)
--   installs: 301 I1, 302 I2
--   A (I1): deal t-1 in O with checklist cl-1, item it-1, message m-1, file f-1 on an uploaded blob
--   S (I1): deal s-1
CREATE FUNCTION pg_temp.base() RETURNS jsonb LANGUAGE plpgsql AS $h$
DECLARE A uuid := pg_temp.fx(1); S uuid := pg_temp.fx(4); O uuid := pg_temp.fx(101); I1 uuid := pg_temp.fx(301);
        t text; d uuid; reg jsonb; out jsonb := '{}';
BEGIN
  SET LOCAL session_replication_role = replica;
  INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  SELECT pg_temp.fx(x), 'p4236-' || substr(md5('__RUN__'), 1, 8) || '-' || x || '@example.test', 'authenticated', 'authenticated',
         '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now()
    FROM generate_series(1, 7) x;
  INSERT INTO public.users (id, email, oauth_provider, oauth_id, display_name)
  SELECT pg_temp.fx(x), 'p4236-' || substr(md5('__RUN__'), 1, 8) || '-' || x || '@example.test', 'email', pg_temp.fx(x)::text, 'Fixture user ' || x
    FROM generate_series(1, 7) x ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.organizations (id, name, slug, personal_owner_user_id) VALUES
    (pg_temp.fx(101), 'Fixture O',  'p4236-o-'  || substr(md5('__RUN__'), 1, 8), NULL),
    (pg_temp.fx(102), 'Fixture O2', 'p4236-o2-' || substr(md5('__RUN__'), 1, 8), NULL),
    (pg_temp.fx(104), 'Personal',   'p4236-ps-' || substr(md5('__RUN__'), 1, 8), pg_temp.fx(4)),
    (pg_temp.fx(105), 'Personal',   'p4236-pj-' || substr(md5('__RUN__'), 1, 8), pg_temp.fx(5));
  INSERT INTO public.organization_members (id, organization_id, user_id, role, license_status) VALUES
    (pg_temp.fx(201), pg_temp.fx(101), pg_temp.fx(1), 'agent',  'active'),
    (pg_temp.fx(202), pg_temp.fx(101), pg_temp.fx(2), 'broker', 'active'),
    (pg_temp.fx(203), pg_temp.fx(101), pg_temp.fx(3), 'admin',  'active'),
    (pg_temp.fx(204), pg_temp.fx(104), pg_temp.fx(4), 'agent',  'active'),
    (pg_temp.fx(205), pg_temp.fx(101), pg_temp.fx(5), 'agent',  'active');
  INSERT INTO public.organization_plans (organization_id, plan_id, feature_overrides)
  SELECT v.oid_, (SELECT id FROM public.plans WHERE tier = v.t ORDER BY sort_order, name LIMIT 1), v.ov::jsonb
    FROM (VALUES (pg_temp.fx(101), 'team', '{"cloud_autosave_assignable":{"enabled":true}}'),
                 (pg_temp.fx(102), 'team', '{}'),
                 (pg_temp.fx(104), 'individual', '{"cloud_autosave":{"enabled":true}}'),
                 (pg_temp.fx(105), 'individual', '{"cloud_autosave":{"enabled":true}}')) v(oid_, t, ov);
  INSERT INTO public.internal_roles (user_id, role_id)
  SELECT pg_temp.fx(7), r.id FROM public.admin_roles r WHERE r.name = 'Super Admin';
  SET LOCAL session_replication_role = origin;

  out := out || jsonb_build_object('assign_A', pg_temp.err(pg_temp.assign(O, A, true)));
  out := out || jsonb_build_object('on_A', pg_temp.err(pg_temp.onoff(A, true)), 'on_S', pg_temp.err(pg_temp.onoff(S, true)));
  t := pg_temp.deal(A, jsonb_build_object('source_install_id', I1, 'local_id', 't-1', 'content_hash', pg_temp.h('t-1'),
                                          'organization_id', O, 'detection_status', 'confirmed', 'status', 'active'));
  d := pg_temp.cid(t);
  out := out || jsonb_build_object('deal_A', pg_temp.st(t), 'deal_A_id', d);
  out := out || jsonb_build_object('cl_A', pg_temp.st(pg_temp.up(A, 'cloud_upsert_checklists', I1, d,
                 jsonb_build_array(jsonb_build_object('local_id', 'cl-1', 'content_hash', pg_temp.h('cl-1'), 'template_id', 'tpl-1')))));
  out := out || jsonb_build_object('item_A', pg_temp.st(pg_temp.up(A, 'cloud_upsert_checklist_items', I1, d,
                 jsonb_build_array(pg_temp.row_of('cloud_upsert_checklist_items', 'it-1')))));
  out := out || jsonb_build_object('party_A', pg_temp.st(pg_temp.up(A, 'cloud_upsert_parties', I1, d,
                 jsonb_build_array(pg_temp.row_of('cloud_upsert_parties', 'p-1')))));
  out := out || jsonb_build_object('msg_A', pg_temp.st(pg_temp.up(A, 'cloud_upsert_messages', I1, d,
                 jsonb_build_array(jsonb_build_object('local_id', 'm-1', 'content_hash', pg_temp.h('m-1'), 'channel_kind', 'email',
                                                      'hidden_from_export', false, 'subject', 'hello', 'body_text', 'body')))));
  reg := pg_temp.j(pg_temp.call_as(A, format('SELECT public.cloud_register_blob(%L, 10, %L)', pg_temp.h('blob-a'), 'application/pdf')));
  out := out || jsonb_build_object('blob_A', reg ->> 'state');
  out := out || jsonb_build_object('obj_A', pg_temp.call_as(A, format(
    'INSERT INTO storage.objects (bucket_id, name, metadata) VALUES (%L, %L, %L::jsonb)', 'cloud-deal-files', reg ->> 'storage_path', '{"size":"10"}')));
  out := out || jsonb_build_object('confirm_A', pg_temp.err(pg_temp.call_as(A, format('SELECT public.cloud_confirm_blob(%L::uuid)', reg ->> 'blob_id'))));
  out := out || jsonb_build_object('file_A', pg_temp.st(pg_temp.up(A, 'cloud_upsert_files', I1, d,
                 jsonb_build_array(jsonb_build_object('local_id', 'f-1', 'content_hash', pg_temp.h('f-1'), 'filename', 'a.pdf',
                                                      'message_channel_kind', 'email', 'message_local_id', 'm-1', 'blob_sha256', pg_temp.h('blob-a'))))));
  t := pg_temp.deal(S, jsonb_build_object('source_install_id', I1, 'local_id', 's-1', 'content_hash', pg_temp.h('s-1')));
  out := out || jsonb_build_object('deal_S', pg_temp.st(t));
  RETURN out;
END $h$;
