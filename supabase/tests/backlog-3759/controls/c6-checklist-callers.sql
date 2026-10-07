-- C6: the checklist-template callers still reach can_edit_checklist_templates
-- when signed in (the invoker wrappers call it as the caller); anon cannot.
-- A refusal from inside save_checklist_template (not_authorized, feature
-- gate) is fine here; a privilege error on a function is not.
SELECT pg_temp.expect('c6 broker can_edit_checklist_templates runs', 'authenticated', pg_temp.id('u_broker'),
  'SELECT public.can_edit_checklist_templates(''{o_main}'')', 'OK rows=1');
SELECT pg_temp.expect('c6 broker can_write_checklist_template runs', 'authenticated', pg_temp.id('u_broker'),
  'SELECT public.can_write_checklist_template(''{o_main}'', NULL)', 'OK rows=1');
SELECT pg_temp.check('c6 broker save_checklist_template reaches its own checks',
  got !~ 'permission denied for function', got)
  FROM (SELECT pg_temp.run_as('authenticated', pg_temp.id('u_broker'),
    'SELECT * FROM public.save_checklist_template(''{o_main}'', NULL, NULL, ''T'', NULL, ''[{"label":"a"}]''::jsonb)') AS got) x;
SELECT pg_temp.expect('c6 anon can_edit_checklist_templates refused', 'anon', NULL,
  'SELECT public.can_edit_checklist_templates(''{o_main}'')', '~^ERR 42501 permission denied for function');
