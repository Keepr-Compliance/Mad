-- C1: function grants and read-rule roles after the migration.
SELECT pg_temp.check('c1 ' || f || ' ' || r || ' = ' || want,
  pg_temp.can_exec(r, f) = want, pg_temp.acl(f))
  FROM (VALUES ('public.can_review_submission(uuid)'), ('public.can_edit_checklist_templates(uuid)')) AS a(f),
       (VALUES ('anon', false), ('PUBLIC', false), ('authenticated', true), ('service_role', true)) AS b(r, want);
SELECT pg_temp.check('c1 read rules are {authenticated} with unchanged USING md5s',
  pg_temp.rules() = pg_temp.rules_with('{authenticated}'), pg_temp.rules());
SELECT pg_temp.expect('c1 anon calling can_review_submission is refused', 'anon', NULL,
  'SELECT public.can_review_submission(''{o_main}'')', '~^ERR 42501 permission denied for function can_review_submission');
SELECT pg_temp.expect('c1 anon calling can_edit_checklist_templates is refused', 'anon', NULL,
  'SELECT public.can_edit_checklist_templates(''{o_main}'')', '~^ERR 42501 permission denied for function can_edit_checklist_templates');
