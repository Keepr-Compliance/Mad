-- harness: baseline
-- C0 (SR C-1): before the migration, the venue is the production shape.
SELECT pg_temp.check('c0 ledger head is the production head 20261004232511',
  (SELECT max(version) FROM supabase_migrations.schema_migrations) = '20261004232511',
  'ledger max ' || (SELECT max(version) FROM supabase_migrations.schema_migrations)
  || ', rows ' || (SELECT count(*) FROM supabase_migrations.schema_migrations));
SELECT pg_temp.check('c0 read rules are {public} with the production USING md5s',
  pg_temp.rules() = pg_temp.rules_with('{public}'), pg_temp.rules());
SELECT pg_temp.check('c0 anon can execute can_review_submission',
  pg_temp.can_exec('anon', 'public.can_review_submission(uuid)'), pg_temp.acl('public.can_review_submission(uuid)'));
SELECT pg_temp.check('c0 PUBLIC cannot execute can_review_submission',
  NOT pg_temp.can_exec('PUBLIC', 'public.can_review_submission(uuid)'));
SELECT pg_temp.check('c0 can_edit_checklist_templates already anon=f PUBLIC=f authenticated=t service_role=t',
  NOT pg_temp.can_exec('anon', 'public.can_edit_checklist_templates(uuid)')
  AND NOT pg_temp.can_exec('PUBLIC', 'public.can_edit_checklist_templates(uuid)')
  AND pg_temp.can_exec('authenticated', 'public.can_edit_checklist_templates(uuid)')
  AND pg_temp.can_exec('service_role', 'public.can_edit_checklist_templates(uuid)'),
  pg_temp.acl('public.can_edit_checklist_templates(uuid)'));
SELECT pg_temp.check('c0 postgres and service_role bypass RLS',
  (SELECT bool_and(rolbypassrls) AND count(*) = 2 FROM pg_roles WHERE rolname IN ('postgres', 'service_role')));
-- Today's behaviour: an anon read returns no rows and no error.
SELECT pg_temp.expect('c0 anon desktop poll today', 'anon', NULL,
  'SELECT id, status, review_notes, reviewed_by, reviewed_at FROM public.transaction_submissions WHERE id = ANY(ARRAY[''{s_sub}'',''{s_upl}'']::uuid[])', 'OK rows=0');
