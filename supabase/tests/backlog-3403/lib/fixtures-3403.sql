-- BACKLOG-3403 fixtures. Loaded inside each control's transaction, BEFORE the
-- migration (or a mutant of it). Every id and name is invented.
--
-- People: A agent (submitter), B agent (same org), K broker (same org),
--         O agent (other org), Z internal user (no org).
-- S  : A's submission, 'uploading', 2 messages (M1 sms, M2 email), 1
--      attachment row AT1 -> M1 at P1, object P1, 2 checklist headers.
-- S2 : A's other 'uploading' submission (same org), object POTHER in its folder.
SELECT
  'aaaaaaaa-3403-4000-8000-000000000001'::text AS "A",  -- pii-allow-uuid: invented fixture id
  'aaaaaaaa-3403-4000-8000-000000000002'::text AS "B",  -- pii-allow-uuid: invented fixture id
  'aaaaaaaa-3403-4000-8000-000000000003'::text AS "K",  -- pii-allow-uuid: invented fixture id
  'aaaaaaaa-3403-4000-8000-000000000004'::text AS "O",  -- pii-allow-uuid: invented fixture id
  'aaaaaaaa-3403-4000-8000-000000000005'::text AS "Z",  -- pii-allow-uuid: invented fixture id
  '0e340300-0000-4000-8000-0000000000a1'::text AS "ORG",  -- pii-allow-uuid: invented fixture id
  '0e340300-0000-4000-8000-0000000000a2'::text AS "ORG2",  -- pii-allow-uuid: invented fixture id
  '5b340300-0000-4000-8000-000000000001'::text AS "S",  -- pii-allow-uuid: invented fixture id
  '5b340300-0000-4000-8000-000000000002'::text AS "S2",  -- pii-allow-uuid: invented fixture id
  '5b340300-0000-4000-8000-0000000000ff'::text AS "SP",  -- pii-allow-uuid: invented fixture id
  '3e340300-0000-4000-8000-000000000001'::text AS "M1",  -- pii-allow-uuid: invented fixture id
  '3e340300-0000-4000-8000-000000000002'::text AS "M2",  -- pii-allow-uuid: invented fixture id
  '3e340300-0000-4000-8000-000000000003'::text AS "M3",  -- pii-allow-uuid: invented fixture id
  'a7340300-0000-4000-8000-000000000001'::text AS "AT1",  -- pii-allow-uuid: invented fixture id
  'a7340300-0000-4000-8000-000000000002'::text AS "AT2",  -- pii-allow-uuid: invented fixture id
  '0e340300-0000-4000-8000-0000000000a1/5b340300-0000-4000-8000-000000000001/loc1/contract.pdf'::text AS "P1",  -- pii-allow-uuid: invented fixture id
  '0e340300-0000-4000-8000-0000000000a1/5b340300-0000-4000-8000-000000000001/loc2/photo.jpg'::text AS "P2",  -- pii-allow-uuid: invented fixture id
  '0e340300-0000-4000-8000-0000000000a1/5b340300-0000-4000-8000-000000000002/loc9/other.pdf'::text AS "POTHER"  -- pii-allow-uuid: invented fixture id
\gset

SELECT set_config('t3403.asserts', '0', true);
CREATE FUNCTION pg_temp.ok(c boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT coalesce(c, false) THEN RAISE EXCEPTION 'ASSERT FAILED: %', label; END IF;
  PERFORM set_config('t3403.asserts', (coalesce(nullif(current_setting('t3403.asserts', true), ''), '0')::int + 1)::text, true);
END $$;
-- Sets the JWT claims for uid; the control then runs `SET LOCAL ROLE authenticated`.
CREATE FUNCTION pg_temp.claims(uid uuid) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  SELECT set_config('request.jwt.claim.sub', '', true);
$$;
-- The manifest that matches the fixture exactly.
CREATE FUNCTION pg_temp.mf() RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'message_ids', jsonb_build_array('3e340300-0000-4000-8000-000000000001', '3e340300-0000-4000-8000-000000000002'),  -- pii-allow-uuid: invented fixture id
    'attachments', jsonb_build_array(jsonb_build_object(
        'id', 'a7340300-0000-4000-8000-000000000001',  -- pii-allow-uuid: invented fixture id
        'storage_path', '0e340300-0000-4000-8000-0000000000a1/5b340300-0000-4000-8000-000000000001/loc1/contract.pdf',  -- pii-allow-uuid: invented fixture id
        'message_id', '3e340300-0000-4000-8000-000000000001')),  -- pii-allow-uuid: invented fixture id
    'checklists', 2);
$$;
-- Deletes a storage object as postgres (the venue's protect_delete trigger
-- refuses SQL deletes unless this setting is on, as the Storage API sets it).
CREATE FUNCTION pg_temp.rm_object(p text) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('storage.allow_delete_query', 'true', true);
  DELETE FROM storage.objects WHERE bucket_id = 'submission-attachments' AND name = p;
$$;

INSERT INTO auth.users (id, email) VALUES
  (:'A', 'f3403-a@example.test'), (:'B', 'f3403-b@example.test'), (:'K', 'f3403-k@example.test'),
  (:'O', 'f3403-o@example.test'), (:'Z', 'f3403-z@example.test');
INSERT INTO public.organizations (id) VALUES (:'ORG'), (:'ORG2');
INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
  (:'ORG', :'A', 'agent'), (:'ORG', :'B', 'agent'), (:'ORG', :'K', 'broker'), (:'ORG2', :'O', 'agent');
INSERT INTO public.internal_roles (user_id) VALUES (:'Z');

INSERT INTO public.transaction_submissions (id, organization_id, submitted_by, local_transaction_id, property_address, status, version)
VALUES (:'S', :'ORG', :'A', 't1', 'Fixture Street 1', 'uploading', 1),
       (:'S2', :'ORG', :'A', 't2', 'Fixture Street 2', 'uploading', 1);
INSERT INTO public.submission_messages (id, submission_id, channel) VALUES (:'M1', :'S', 'sms'), (:'M2', :'S', 'email');
INSERT INTO public.submission_attachments (id, submission_id, message_id, filename, storage_path)
VALUES (:'AT1', :'S', :'M1', 'contract.pdf', :'P1');
INSERT INTO storage.objects (bucket_id, name) VALUES ('submission-attachments', :'P1'), ('submission-attachments', :'POTHER');
INSERT INTO public.submission_checklists (submission_id, template_name) VALUES (:'S', 'a'), (:'S', 'b');

-- Production fingerprint (lib/fp-3403.sql, run read-only on production
-- 2026-10-04, ledger head 20261003195046): the state before the migration.
CREATE TEMP TABLE prod3403_before (k text, v text);
INSERT INTO prod3403_before VALUES
  ('function:can_review_submission(p_org_id uuid)', '686faa4d11f82471fb7e11b173ba66ce'),
  ('function:guard_status_history_append_only()', 'e53db0cc2573622f0135b1dfb363cc11'),
  ('function:track_submission_status_changes()', 'e2aca483ff4e280f8cb1d8bfdc5d49fa'),
  ('index:idx_submission_attachments_message_id', '8a53e144c1d38ffeb9e4c16f188c9a74'),
  ('index:idx_submission_messages_sent_at', 'cf9616b7e98317faa8e75be169404694'),
  ('index:submission_attachments_pkey', '18c4033a048af146c0ff85b06a0404aa'),
  ('index:submission_messages_pkey', '09c66b94d63d517150a2b16738802174'),
  ('policy:public.submission_attachments:agents_can_delete_own_attachments', '9275792d55943323c38ef08bff0252a6'),
  ('policy:public.submission_attachments:agents_can_insert_attachments', '8a39e35a5e3d49f598c83b078fffd840'),
  ('policy:public.submission_attachments:attachment_access_via_submission', '5fd04dbe87bd2e39046bc08b2577a2e0'),
  ('policy:public.submission_attachments:service_role_full_access_attachments', '9817600947398574e3f92b8cf76ebbd8'),
  ('policy:public.submission_checklists:submission_checklists_insert', 'b8a888b704e85bd428dd45a6a9017722'),
  ('policy:public.submission_checklists:submission_checklists_select', '1e88553934bfbe0ed21b638b59067084'),
  ('policy:public.submission_messages:agents_can_insert_messages', '8a39e35a5e3d49f598c83b078fffd840'),
  ('policy:public.submission_messages:message_access_via_submission', 'b9b10f09a272a92910d979d7e021654d'),
  ('policy:public.submission_messages:service_role_full_access_messages', '9817600947398574e3f92b8cf76ebbd8'),
  ('policy:public.transaction_submissions:agents_can_create_submissions', '38a9cf5eb29e0a1f2ba9892a584a6801'),
  ('policy:public.transaction_submissions:agents_can_delete_stale_uploads', 'a6bd17a0486bd9e932104d9e24f8fba3'),
  ('policy:public.transaction_submissions:service_role_full_access_submissions', '9817600947398574e3f92b8cf76ebbd8'),
  ('policy:public.transaction_submissions:transaction_submissions_select_public', '1f7a9a0362edae36f14bc25651b0ebdb'),
  ('policy:public.transaction_submissions:transaction_submissions_update_public', 'bc018b00b5631adb96bfcb0c884ed840'),
  ('policy:storage.objects:Members can upload submission attachments', 'd5a9d000a2f0d277fa04c55d4b53fdfe'),
  ('policy:storage.objects:Submission attachments follow their submission', '725e2398891f4f556ba0f9cdcd0c83be'),
  ('trigger:commission_figures_locked', 'cd011e6b485fbcda676d7d227cf24798'),
  ('trigger:status_history_append_only', '79b540c4d25b7c43b997571f779a0d4f'),
  ('trigger:track_status_changes', 'ac2dfb97abf1a9a6c62065d4e12cb564'),
  ('trigger:update_submissions_updated_at', '08b37138ea7734f7d05bfbdbc2d4617a');

-- The venue fingerprint AFTER the migration (lib/fp-after-3403.txt): the
-- apply plan's post-check expects production to read exactly this.
CREATE TEMP TABLE post3403_after (k text, v text);
INSERT INTO post3403_after VALUES
  ('function:can_review_submission(p_org_id uuid)', '686faa4d11f82471fb7e11b173ba66ce'),
  ('function:finalize_submission(p_submission_id uuid, p_manifest jsonb)', 'fbc492f2f356457c67ad17015edac874'),
  ('function:guard_status_history_append_only()', 'e53db0cc2573622f0135b1dfb363cc11'),
  ('function:record_submission_attempt(p_submission_id uuid, p_organization_id uuid, p_outcome text, p_stage text, p_reason_code text, p_retry_count integer, p_counts jsonb, p_is_resubmit boolean, p_app_version text, p_platform text)', '14772e83896f1265e34548f9e142d9e3'),
  ('function:track_submission_status_changes()', 'e2aca483ff4e280f8cb1d8bfdc5d49fa'),
  ('index:idx_submission_attachments_message_id', '8a53e144c1d38ffeb9e4c16f188c9a74'),
  ('index:idx_submission_messages_sent_at', 'cf9616b7e98317faa8e75be169404694'),
  ('index:submission_attachments_pkey', '18c4033a048af146c0ff85b06a0404aa'),
  ('index:submission_attachments_submission_id_idx', 'dd0767b1a5950d2ec9a712c9b7767eb5'),
  ('index:submission_attempts_org_started_idx', '74c5d7be3c3e77a56206da4b661d734d'),
  ('index:submission_attempts_pkey', '5bbf2f69079b234c4dc99877e575d41d'),
  ('index:submission_attempts_started_idx', '65d5b2a281678655c79c61dd04fb8d22'),
  ('index:submission_attempts_submission_id_key', '3150219541f3f10b05729b519837475b'),
  ('index:submission_attempts_user_started_idx', 'e2288b34afe4934da1bb425083724f6f'),
  ('index:submission_messages_pkey', '09c66b94d63d517150a2b16738802174'),
  ('index:submission_messages_submission_id_idx', '1949b8cc7eebc95e60bff9bd71bce1b3'),
  ('policy:public.submission_attachments:agents_can_delete_own_attachments', '4d81b9298777e77bcf4ce4d0799f79ab'),
  ('policy:public.submission_attachments:agents_can_insert_attachments', '9b14cc7d7bfa754c5aac25d82d64d581'),
  ('policy:public.submission_attachments:attachment_access_via_submission', '5fd04dbe87bd2e39046bc08b2577a2e0'),
  ('policy:public.submission_attachments:service_role_full_access_attachments', '9817600947398574e3f92b8cf76ebbd8'),
  ('policy:public.submission_attempts:submission_attempts_select', '8aa0f7edf4ef6ff675dc1968c1578e49'),
  ('policy:public.submission_checklists:submission_checklists_insert', 'b8a888b704e85bd428dd45a6a9017722'),
  ('policy:public.submission_checklists:submission_checklists_select', '1e88553934bfbe0ed21b638b59067084'),
  ('policy:public.submission_messages:agents_can_insert_messages', 'd16ee16b70605e50a02461ae5ffb0710'),
  ('policy:public.submission_messages:message_access_via_submission', 'b9b10f09a272a92910d979d7e021654d'),
  ('policy:public.submission_messages:service_role_full_access_messages', '9817600947398574e3f92b8cf76ebbd8'),
  ('policy:public.transaction_submissions:agents_can_create_submissions', '38a9cf5eb29e0a1f2ba9892a584a6801'),
  ('policy:public.transaction_submissions:agents_can_delete_stale_uploads', 'a6bd17a0486bd9e932104d9e24f8fba3'),
  ('policy:public.transaction_submissions:service_role_full_access_submissions', '9817600947398574e3f92b8cf76ebbd8'),
  ('policy:public.transaction_submissions:transaction_submissions_select_public', '1f7a9a0362edae36f14bc25651b0ebdb'),
  ('policy:public.transaction_submissions:transaction_submissions_update_public', 'f02384bf4d3195198248c5a1119ab008'),
  ('policy:storage.objects:Members can upload submission attachments', 'd5a9d000a2f0d277fa04c55d4b53fdfe'),
  ('policy:storage.objects:Submission attachments follow their submission', '725e2398891f4f556ba0f9cdcd0c83be'),
  ('policy:storage.objects:Submitters can delete attachments of their abandoned upload', '1163c8339afcda9be4c12e44d9fd93b8'),
  ('table:submission_attempts', '8d270640ac760d2f57e462c9c87685a5'),
  ('trigger:commission_figures_locked', 'cd011e6b485fbcda676d7d227cf24798'),
  ('trigger:status_history_append_only', '79b540c4d25b7c43b997571f779a0d4f'),
  ('trigger:track_status_changes', 'ac2dfb97abf1a9a6c62065d4e12cb564'),
  ('trigger:update_submissions_updated_at', '08b37138ea7734f7d05bfbdbc2d4617a');
