-- BACKLOG-4236 PR-1 rollback: drops every object of 20261112190000 and the rows of 20261112180000,
-- and the two ledger rows. Stored objects of the bucket are removed first (the bucket cannot be
-- dropped while it holds objects).
-- Each client write is dropped under both signatures: with p_expected_user_id first (current) and
-- without it (earlier).
DO $rbx4236$
BEGIN
  PERFORM set_config('storage.allow_delete_query', 'true', true);
  DELETE FROM storage.objects WHERE bucket_id = 'cloud-deal-files';
  DELETE FROM storage.buckets WHERE id = 'cloud-deal-files';
END
$rbx4236$;
DROP POLICY IF EXISTS "Cloud deal files: owner uploads registered blob" ON storage.objects;
DROP POLICY IF EXISTS "Cloud deal files: owner reads live blob" ON storage.objects;
DROP FUNCTION IF EXISTS public.cloud_confirm_blob(uuid, uuid);
DROP FUNCTION IF EXISTS public.cloud_confirm_blob(uuid);
DROP FUNCTION IF EXISTS public.cloud_register_blob(uuid, text, bigint, text);
DROP FUNCTION IF EXISTS public.cloud_register_blob(text, bigint, text);
DROP FUNCTION IF EXISTS public.cloud_mark_deal_synced(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS public.cloud_mark_deal_synced(uuid, uuid);
DROP FUNCTION IF EXISTS public.cloud_delete_deal(uuid, uuid);
DROP FUNCTION IF EXISTS public.cloud_delete_deal(uuid);
DROP FUNCTION IF EXISTS public.cloud_tombstone(uuid, uuid, text, uuid[]);
DROP FUNCTION IF EXISTS public.cloud_tombstone(uuid, text, uuid[]);
DROP FUNCTION IF EXISTS public.cloud_upsert_files(uuid, uuid, uuid, jsonb);
DROP FUNCTION IF EXISTS public.cloud_upsert_files(uuid, uuid, jsonb);
DROP FUNCTION IF EXISTS public.cloud_upsert_messages(uuid, uuid, uuid, jsonb);
DROP FUNCTION IF EXISTS public.cloud_upsert_messages(uuid, uuid, jsonb);
DROP FUNCTION IF EXISTS public.cloud_upsert_checklist_items(uuid, uuid, uuid, jsonb);
DROP FUNCTION IF EXISTS public.cloud_upsert_checklist_items(uuid, uuid, jsonb);
DROP FUNCTION IF EXISTS public.cloud_upsert_checklists(uuid, uuid, uuid, jsonb);
DROP FUNCTION IF EXISTS public.cloud_upsert_checklists(uuid, uuid, jsonb);
DROP FUNCTION IF EXISTS public.cloud_upsert_parties(uuid, uuid, uuid, jsonb);
DROP FUNCTION IF EXISTS public.cloud_upsert_parties(uuid, uuid, jsonb);
DROP FUNCTION IF EXISTS public.cloud_upsert_deal(uuid, jsonb);
DROP FUNCTION IF EXISTS public.cloud_upsert_deal(jsonb);
DROP FUNCTION IF EXISTS public.assign_member_addon(uuid, uuid, text, boolean, timestamptz);
DROP FUNCTION IF EXISTS public.cloud_delete_install(uuid, uuid);
DROP FUNCTION IF EXISTS public.cloud_delete_install(uuid);
DROP FUNCTION IF EXISTS public.cloud_list_installs();
DROP FUNCTION IF EXISTS public.set_my_cloud_autosave(uuid, boolean, integer);
DROP FUNCTION IF EXISTS public.set_my_cloud_autosave(boolean, integer);
DROP FUNCTION IF EXISTS public.get_my_cloud_autosave_state();
DROP FUNCTION IF EXISTS public.cloud_autosave_entitled();
DROP FUNCTION IF EXISTS public._cloud_autosave_license(uuid);
DROP FUNCTION IF EXISTS public._cloud_fence_unreferenced(uuid, uuid[]);
DROP FUNCTION IF EXISTS public._cloud_row_status(bigint, timestamptz, text, text, bigint);
DROP FUNCTION IF EXISTS public._cloud_bad_field(jsonb, text[], text[], text[], text[]);
DROP FUNCTION IF EXISTS public._cloud_autosave_current_notice_version();
DROP TABLE IF EXISTS public.cloud_deal_files;
DROP TABLE IF EXISTS public.cloud_blobs;
DROP TABLE IF EXISTS public.cloud_deal_messages;
DROP TABLE IF EXISTS public.cloud_deal_checklist_items;
DROP TABLE IF EXISTS public.cloud_deal_checklists;
DROP TABLE IF EXISTS public.cloud_deal_parties;
DROP TABLE IF EXISTS public.cloud_deals;
DROP TABLE IF EXISTS public.member_addons;
DROP TABLE IF EXISTS public.cloud_autosave_settings;
DELETE FROM public.plan_features WHERE feature_id IN (SELECT id FROM public.feature_definitions WHERE key IN ('cloud_autosave', 'cloud_autosave_assignable'));
DELETE FROM public.feature_definitions WHERE key IN ('cloud_autosave', 'cloud_autosave_assignable');
DELETE FROM supabase_migrations.schema_migrations WHERE version IN ('20261112180000', '20261112190000');
