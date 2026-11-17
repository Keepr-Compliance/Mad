-- BACKLOG-4263 PR-2 fixtures (invented; ids from pg_temp.fx(n), random per run). Written through the
-- earlier one-way functions (cloud_upsert_checklists / _items / _files), which must still work after the migration.
--   users: 1 A (Cloud on), 2 B (Cloud on, another owner); organization 101 (team plan, assignable key on)
--   installs: 301 I1 (A), 302 I2 (A), 303 IB (B)
--   A: deal D1 (I1): checklist cl1 (template) items i1 (required), i2; checklist my1 (My items) item m1
--      deal D2 (I1): checklist cl2 item i3, a file f1 holding blob BL1
--      deal D3 (I2): checklist cl3 item i4
--   B: deal DB (IB): checklist clb item ib1
CREATE TEMP TABLE p4263_fx (k text PRIMARY KEY, v text);
CREATE FUNCTION pg_temp.id(k text) RETURNS uuid LANGUAGE sql STABLE AS $h$ SELECT v::uuid FROM pg_temp.p4263_fx WHERE p4263_fx.k = id.k $h$;
CREATE FUNCTION pg_temp.put(k text, v text) RETURNS void LANGUAGE sql AS $h$
  INSERT INTO pg_temp.p4263_fx VALUES (k, v) ON CONFLICT (k) DO UPDATE SET v = excluded.v
$h$;

CREATE FUNCTION pg_temp.base4263() RETURNS jsonb LANGUAGE plpgsql AS $h$
DECLARE A uuid := pg_temp.fx(1); B uuid := pg_temp.fx(2); O uuid := pg_temp.fx(101);
        I1 uuid := pg_temp.fx(301); I2 uuid := pg_temp.fx(302); IB uuid := pg_temp.fx(303);
        r jsonb; d uuid; out jsonb := '{}'; u uuid; x record;
BEGIN
  SET LOCAL session_replication_role = replica;
  INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  SELECT pg_temp.fx(n), 'p4263-' || substr(md5('__RUN__'), 1, 8) || '-' || n || '@example.test', 'authenticated', 'authenticated',
         '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now() FROM generate_series(1, 2) n;
  INSERT INTO public.users (id, email, oauth_provider, oauth_id, display_name)
  SELECT pg_temp.fx(n), 'p4263-' || substr(md5('__RUN__'), 1, 8) || '-' || n || '@example.test', 'email', pg_temp.fx(n)::text, 'Fixture ' || n
    FROM generate_series(1, 2) n ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.organizations (id, name, slug) VALUES (O, 'Fixture O', 'p4263-o-' || substr(md5('__RUN__'), 1, 8));
  INSERT INTO public.organization_members (id, organization_id, user_id, role, license_status) VALUES
    (pg_temp.fx(201), O, A, 'agent', 'active'), (pg_temp.fx(202), O, B, 'agent', 'active');
  INSERT INTO public.organization_plans (organization_id, plan_id, feature_overrides)
  SELECT O, (SELECT id FROM public.plans WHERE tier = 'team' ORDER BY sort_order, name LIMIT 1), '{"cloud_autosave_assignable":{"enabled":true}}'::jsonb;
  SET LOCAL session_replication_role = origin;
  FOREACH u IN ARRAY ARRAY[A, B] LOOP
    PERFORM pg_temp.assign(O, u);
    out := out || jsonb_build_object('on_' || u, pg_temp.onoff(u, true) ->> 'success');
  END LOOP;
  PERFORM pg_temp.put('A', A::text); PERFORM pg_temp.put('B', B::text);
  PERFORM pg_temp.put('I1', I1::text); PERFORM pg_temp.put('I2', I2::text); PERFORM pg_temp.put('IB', IB::text);
  FOR x IN SELECT * FROM (VALUES ('D1', 1, 301, 'd1'), ('D2', 1, 301, 'd2'), ('D3', 1, 302, 'd3'), ('DB', 2, 303, 'db')) v(k, un, inst, lid) LOOP
    r := pg_temp.deal(pg_temp.fx(x.un), pg_temp.dp(pg_temp.fx(x.inst), x.lid));
    PERFORM pg_temp.put(x.k, r -> 'results' -> 0 ->> 'cloud_id');
    out := out || jsonb_build_object(x.k, r -> 'results' -> 0 ->> 'status');
  END LOOP;
  r := pg_temp.up(A, 'cloud_upsert_checklists', I1, pg_temp.id('D1'), jsonb_build_array(
         pg_temp.rw('cl1', jsonb_build_object('template_id', 'tpl-purchase', 'template_name', 'Purchase', 'sort_order', 1)),
         pg_temp.rw('my1', jsonb_build_object('template_id', 'keepr:my-items', 'template_name', 'My items', 'sort_order', 2))));
  out := out || jsonb_build_object('cl_d1', r);
  r := pg_temp.up(A, 'cloud_upsert_checklist_items', I1, pg_temp.id('D1'), jsonb_build_array(
         pg_temp.rw('i1', jsonb_build_object('local_checklist_id', 'cl1', 'title', 'Inspection report', 'is_required', true, 'is_checked', false, 'sort_order', 1)),
         pg_temp.rw('i2', jsonb_build_object('local_checklist_id', 'cl1', 'title', 'Appraisal', 'is_required', false, 'is_checked', false, 'sort_order', 2, 'note', 'start')),
         pg_temp.rw('m1', jsonb_build_object('local_checklist_id', 'my1', 'title', 'Call lender', 'is_checked', false, 'sort_order', 1))));
  out := out || jsonb_build_object('it_d1', r);
  r := pg_temp.up(A, 'cloud_upsert_checklists', I1, pg_temp.id('D2'), jsonb_build_array(pg_temp.rw('cl2', jsonb_build_object('template_id', 'tpl-sale', 'template_name', 'Sale'))));
  r := pg_temp.up(A, 'cloud_upsert_checklist_items', I1, pg_temp.id('D2'), jsonb_build_array(pg_temp.rw('i3', jsonb_build_object('local_checklist_id', 'cl2', 'title', 'Disclosure'))));
  out := out || jsonb_build_object('it_d2', r ->> 'ok');
  r := pg_temp.up(A, 'cloud_upsert_checklists', I2, pg_temp.id('D3'), jsonb_build_array(pg_temp.rw('cl3', jsonb_build_object('template_id', 'tpl-sale', 'template_name', 'Sale'))));
  r := pg_temp.up(A, 'cloud_upsert_checklist_items', I2, pg_temp.id('D3'), jsonb_build_array(pg_temp.rw('i4', jsonb_build_object('local_checklist_id', 'cl3', 'title', 'Title report'))));
  out := out || jsonb_build_object('it_d3', r ->> 'ok');
  r := pg_temp.up(B, 'cloud_upsert_checklists', IB, pg_temp.id('DB'), jsonb_build_array(pg_temp.rw('clb', jsonb_build_object('template_id', 'tpl-sale', 'template_name', 'Sale'))));
  r := pg_temp.up(B, 'cloud_upsert_checklist_items', IB, pg_temp.id('DB'), jsonb_build_array(pg_temp.rw('ib1', jsonb_build_object('local_checklist_id', 'clb', 'title', 'B item'))));
  out := out || jsonb_build_object('it_db', r ->> 'ok');
  -- a blob attached to D2
  r := pg_temp.rpc(A, format('SELECT public.cloud_register_blob(%L::uuid, %L, 10, NULL)', A, pg_temp.h('bl1-__RUN__')));
  PERFORM pg_temp.put('BL1', r ->> 'blob_id');
  UPDATE public.cloud_blobs SET uploaded_at = now() WHERE id = pg_temp.id('BL1');
  r := pg_temp.up(A, 'cloud_upsert_files', I1, pg_temp.id('D2'), jsonb_build_array(
         pg_temp.rw('f1', jsonb_build_object('filename', 'a.pdf', 'blob_sha256', pg_temp.h('bl1-__RUN__'), 'size_bytes', 10))));
  out := out || jsonb_build_object('file', r -> 'results' -> 0 ->> 'status');
  FOR x IN SELECT t.local_item_id AS lid, t.id FROM public.cloud_deal_checklist_items t WHERE t.owner_user_id IN (A, B) LOOP
    PERFORM pg_temp.put(x.lid, x.id::text);
  END LOOP;
  FOR x IN SELECT c.local_checklist_id AS lid, c.id FROM public.cloud_deal_checklists c WHERE c.owner_user_id IN (A, B) LOOP
    PERFORM pg_temp.put(x.lid, x.id::text);
  END LOOP;
  RETURN out;
END $h$;
