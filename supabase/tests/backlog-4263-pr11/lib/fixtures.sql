-- BACKLOG-4263 PR-11a harness: fixtures, loaded BEFORE the migration (inside the same rolled-back call).
-- Users A and B (one organization, cloud entitlement and checklists enabled by a plan override), deals and todos made
-- by the real producers (cloud_upsert_deal, cloud_todo_push), AI-app connections for A (an 'anthropic' one whose
-- client_name reads 'ChatGPT', and an 'openai' one) and B, the portal secret in the prev slot, writes switched on,
-- and four uploading submissions of A. Set directly, each for this call only: the users, organization, plan,
-- membership, connections and tokens, mcp_settings / mcp_write_settings, transaction_submissions and one attachment row
-- (as the 3968 probe and PR-5's fixtures do).

DO $fx11a$
DECLARE A uuid := pg_temp.fx(1); B uuid := pg_temp.fx(2); O uuid := pg_temp.fx(101);
        IA uuid := pg_temp.fx(301); IB uuid := pg_temp.fx(302); r jsonb; k text; n int;
BEGIN
  SET LOCAL session_replication_role = replica;
  INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  SELECT pg_temp.fx(x), 'p4263-' || substr(md5('pr11a-harness'), 1, 8) || '-' || x || '@example.test', 'authenticated', 'authenticated',
         '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now() FROM generate_series(1, 2) x;
  INSERT INTO public.users (id, email, oauth_provider, oauth_id, display_name)
  SELECT pg_temp.fx(x), 'p4263-' || substr(md5('pr11a-harness'), 1, 8) || '-' || x || '@example.test', 'email', pg_temp.fx(x)::text, 'Fixture ' || x
    FROM generate_series(1, 2) x ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.organizations (id, name, slug) VALUES (O, 'Fixture O', 'p4263-o-' || substr(md5('pr11a-harness'), 1, 8));
  INSERT INTO public.organization_members (id, organization_id, user_id, role, license_status) VALUES
    (pg_temp.fx(201), O, A, 'agent', 'active'), (pg_temp.fx(202), O, B, 'agent', 'active');
  INSERT INTO public.organization_plans (organization_id, plan_id, feature_overrides)
  SELECT O, (SELECT id FROM public.plans WHERE tier = 'team' ORDER BY sort_order, name LIMIT 1),
         '{"cloud_autosave_assignable":{"enabled":true},"transaction_checklists":{"enabled":true}}'::jsonb;
  SET LOCAL session_replication_role = origin;
  PERFORM pg_temp.put('A', A::text); PERFORM pg_temp.put('B', B::text); PERFORM pg_temp.put('O', O::text);
  PERFORM pg_temp.put('IA', IA::text); PERFORM pg_temp.put('IB', IB::text);
  FOREACH k IN ARRAY ARRAY['A', 'B'] LOOP
    PERFORM pg_temp.assign(O, pg_temp.id(k));
    PERFORM pg_temp.rec('fx_on_' || k, pg_temp.onoff(pg_temp.id(k), true) -> 'success');
  END LOOP;

  -- deal D1 (A): My items m1..m8; deals T1..T12 (B, so A's pull page holds only D1) for the timing runs, one checklist each
  r := pg_temp.deal(A, pg_temp.dp(IA, 'd1'));
  PERFORM pg_temp.put('D1', r -> 'results' -> 0 ->> 'cloud_id');
  r := pg_temp.push(A, IA, jsonb_build_array(pg_temp.cc(pg_temp.id('D1'), 'd1-my', 'keepr:my-items', 'My items', 0))
         || (SELECT jsonb_agg(pg_temp.ci(pg_temp.id('D1'), 'd1-my', 'm' || x, 'Fixture item ' || x, x)) FROM generate_series(1, 8) x));
  PERFORM pg_temp.rec('fx_push_D1', (SELECT jsonb_agg(DISTINCT x ->> 'status') FROM jsonb_array_elements(r -> 'results') x));
  FOR n IN 1 .. 8 LOOP PERFORM pg_temp.put('m' || n, pg_temp.item_of(pg_temp.id('D1'), 'm' || n)::text); END LOOP;
  FOR n IN 1 .. 12 LOOP
    r := pg_temp.deal(B, pg_temp.dp(IB, 't' || n));
    PERFORM pg_temp.put('T' || n, r -> 'results' -> 0 ->> 'cloud_id');
    r := pg_temp.push(B, IB, jsonb_build_array(pg_temp.cc(pg_temp.id('T' || n), 't' || n || '-my', 'keepr:my-items', 'My items', 0)));
  END LOOP;
  PERFORM pg_temp.rec('fx_items_D1', to_jsonb((SELECT count(*) FROM public.cloud_deal_checklist_items WHERE cloud_deal_id = pg_temp.id('D1'))));

  -- AI-app connections and the switches (this call only)
  UPDATE public.mcp_settings SET portal_secret_prev_sha256 = sha256(convert_to(pg_temp.secret(), 'UTF8')), enabled = true WHERE id;
  UPDATE public.mcp_write_settings SET writes_enabled = true WHERE id;
  INSERT INTO public.mcp_oauth_clients (client_id, client_name, redirect_uris, ip_sha256)
  VALUES (pg_temp.client(), 'Fixture app', ARRAY['https://claude.ai/api/mcp/auth_callback', 'https://chatgpt.com/connector_platform_oauth_redirect'],
          sha256(convert_to('p11a-ip', 'UTF8')));
  PERFORM pg_temp.conn('KA', A, 1, 'anthropic', 'ChatGPT');
  PERFORM pg_temp.conn('KO', A, 2, 'openai', 'Fixture app');
  PERFORM pg_temp.conn('KB', B, 3, 'anthropic', 'Fixture app');

  -- submissions of A (uploading), with one uploaded attachment each for the link arm
  FOREACH k IN ARRAY ARRAY['S_old', 'S_new', 'S_sweep', 'S_ref', 'S_ref2', 'S_rb'] LOOP
    PERFORM pg_temp.put(k, md5('pr11a-harness-sub-' || k)::uuid::text);
    INSERT INTO public.transaction_submissions (id, organization_id, submitted_by, local_transaction_id, property_address, status)
    VALUES (pg_temp.id(k), O, A, 'p11a-' || lower(k), 'Fixture ' || k, 'uploading');
    INSERT INTO public.submission_attachments (submission_id, filename, storage_path, document_type, local_attachment_id)
    VALUES (pg_temp.id(k), 'p11a.pdf', 'p11a/' || lower(k) || '.pdf', 'other', 'p11a-att');
  END LOOP;
  PERFORM pg_temp.rec('fx_feature_A', pg_temp.j(pg_temp.call_as(A, format('SELECT public.check_feature_access(%L::uuid, %L)', O, 'transaction_checklists'))) -> 'allowed');
END
$fx11a$;

-- The payload of buildChecklistSnapshotPayload (electron/services/submissionChecklistSnapshot.ts:233-291, identical at
-- origin/main and at b5fdc730c; last change 63e8dd7f1): per checklist {template_id, template_name, sort_order, items};
-- per item {title, local_item_id, description, is_required, expected_document_type, is_checked, note, sort_order,
-- links: [{kind, label, sort_order, local_ids}]}. Values are invented; the keys and JSON types are the builder's.
CREATE FUNCTION pg_temp.payload248() RETURNS jsonb LANGUAGE sql IMMUTABLE AS $h$
  SELECT '[
    {"template_id": null, "template_name": "Purchase", "sort_order": 0, "items": [
      {"title": "Inspection report", "local_item_id": "p11a-li-1", "description": "Signed copy", "is_required": true,
       "expected_document_type": "inspection", "is_checked": true, "note": "Received from the inspector", "sort_order": 0,
       "links": [{"kind": "attachment", "label": "Report", "sort_order": 0, "local_ids": ["p11a-att"]}]},
      {"title": "Appraisal", "local_item_id": "p11a-li-2", "description": null, "is_required": false,
       "expected_document_type": null, "is_checked": false, "note": null, "sort_order": 1, "links": []}]},
    {"template_id": null, "template_name": "My items", "sort_order": 1, "items": [
      {"title": "Call the lender", "local_item_id": "p11a-li-3", "description": null, "is_required": false,
       "expected_document_type": null, "is_checked": false, "note": "   ", "sort_order": 0, "links": []}]}
  ]'::jsonb $h$;
