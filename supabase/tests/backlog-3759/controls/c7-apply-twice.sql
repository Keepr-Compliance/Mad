-- harness: apply-twice
-- C7 (SR C-2): the second apply passes its pre-check and is a no-op.
SELECT pg_temp.check('c7 read rules {authenticated}, USING unchanged after two applies',
  pg_temp.rules() = pg_temp.rules_with('{authenticated}'), pg_temp.rules());
SELECT pg_temp.check('c7 ACLs after two applies',
  pg_temp.acl('public.can_review_submission(uuid)') = '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
  AND pg_temp.acl('public.can_edit_checklist_templates(uuid)') = '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}',
  pg_temp.acl('public.can_review_submission(uuid)') || ' ' || pg_temp.acl('public.can_edit_checklist_templates(uuid)'));
SELECT pg_temp.expect('c7 anon poll after two applies', 'anon', NULL,
  'SELECT id FROM public.transaction_submissions WHERE id = ANY(ARRAY[''{s_sub}'']::uuid[])', 'OK rows=0');
