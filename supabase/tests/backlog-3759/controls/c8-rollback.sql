-- harness: rollback
-- C8: the rollback restores today's state exactly.
SELECT pg_temp.check('c8 read rules back to {public}, USING unchanged',
  pg_temp.rules() = pg_temp.rules_with('{public}'), pg_temp.rules());
SELECT pg_temp.check('c8 anon EXECUTE on can_review_submission restored, PUBLIC still absent',
  pg_temp.can_exec('anon', 'public.can_review_submission(uuid)')
  AND NOT pg_temp.can_exec('PUBLIC', 'public.can_review_submission(uuid)'),
  pg_temp.acl('public.can_review_submission(uuid)'));
SELECT pg_temp.expect('c8 anon poll after rollback', 'anon', NULL,
  'SELECT id FROM public.transaction_submissions WHERE id = ANY(ARRAY[''{s_sub}'']::uuid[])', 'OK rows=0');
SELECT pg_temp.expect('c8 broker reads after rollback', 'authenticated', pg_temp.id('u_broker'),
  'SELECT id FROM public.transaction_submissions WHERE organization_id = ''{o_main}''', 'OK rows=3');
