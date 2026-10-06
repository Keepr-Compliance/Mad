-- e15: the catalogue after the 3618 file, pinned. These are the md5s
-- production must show after the apply (verification query: lib/fp-3618.sql).
-- An edit to the migration that changes any of them must update this list on
-- purpose. No anon EXECUTE anywhere: every ACL is postgres, authenticated,
-- service_role.
CREATE TEMP TABLE t3618_after_expected (k text, v text);
INSERT INTO t3618_after_expected
  VALUES
    ('column_grants', '0cdb1c024c375c1812815cfcf08e1d9f'),
    ('columns', 'a18ca0359567602c9ac3d5d5bdb8e9bc'),
    ('constraints', '436e8b4e446816db6bb67613099cf7ff'),
    ('fn:add_submission_checklist_at_review(uuid,uuid)', '84a87a9d9becc6ec8b2091c1c48f66bc def=true cfg=search_path="" acl={postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('fn:can_create_own_checklist_templates(uuid)', 'dcd2f626c7419b3988ffedebd8faebbf def=true cfg=search_path=public acl={postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('fn:can_edit_checklist_templates(uuid)', 'f6a29733517b1bb7e82197ff15eece8e def=true cfg=search_path=public acl={postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('fn:can_write_checklist_template(uuid,uuid)', '44b358b5385e3ce5b9c1e668f9601336 def=false cfg=search_path=public acl={postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('fn:save_checklist_template(uuid,uuid,text,text,text,jsonb,boolean,boolean)', '98df72955f3da7356a33359d1cc9ec99 def=false cfg=search_path=public acl={postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('fn:snapshot_submission_checklists(uuid,jsonb)', '35e682deaf1ed5254a87894cb4604470 def=false cfg=search_path="" acl={postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('indexes', 'checklist_templates_org_seed_key_key,checklist_templates_org_sort_idx,checklist_templates_owner_idx,checklist_templates_pkey'),
    ('policies', '04a320a5a58ba0eecfda5c9c1a1b0ce1');
SELECT pg_temp.check(pg_temp.fp_diff('SELECT * FROM pg_temp.fp3618()', 'SELECT * FROM t3618_after_expected') = '',
       'e15 after-fingerprint differs: ' || pg_temp.fp_diff('SELECT * FROM pg_temp.fp3618()', 'SELECT * FROM t3618_after_expected'));
-- Column privileges, readable form.
SELECT pg_temp.check(has_column_privilege('authenticated', 'public.checklist_templates', 'owner_user_id', 'SELECT')
                 AND has_column_privilege('authenticated', 'public.checklist_templates', 'include_in_submission', 'SELECT')
                 AND has_column_privilege('authenticated', 'public.checklist_templates', 'owner_user_id', 'INSERT')
                 AND has_column_privilege('authenticated', 'public.checklist_templates', 'include_in_submission', 'INSERT')
                 AND has_column_privilege('authenticated', 'public.checklist_templates', 'include_in_submission', 'UPDATE')
                 AND NOT has_column_privilege('authenticated', 'public.checklist_templates', 'owner_user_id', 'UPDATE')
                 AND NOT has_column_privilege('anon', 'public.checklist_templates', 'owner_user_id', 'SELECT'),
       'e15 column privileges');
SELECT pg_temp.check((SELECT confdeltype FROM pg_constraint WHERE conrelid = 'public.checklist_templates'::regclass AND contype = 'f'
                       AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'public.checklist_templates'::regclass AND attname = 'owner_user_id')]) = 'c',
       'e15 owner FK is ON DELETE CASCADE');
SELECT pg_temp.check(NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid::regprocedure::text = 'save_checklist_template(uuid,uuid,text,text,text,jsonb)'), 'e15 six-argument save is gone');
