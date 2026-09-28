-- C15 (SR C-1): security, search_path and EXECUTE grants; the carry's exact
-- signature; authenticated still has no UPDATE (or DELETE) on items.
DO $c15$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('carry_submission_checklist_reviews(uuid)',                 true,  false, true),
      ('snapshot_submission_checklists(uuid, jsonb)',               false, false, true),
      ('set_submission_checklist_reviewer_check(uuid, boolean)',    true,  false, true),
      ('add_submission_checklist_at_review(uuid, uuid)',            true,  false, true)) v(fn, definer, anon_x, auth_x) LOOP
    PERFORM pg_temp.check((SELECT p.proconfig = ARRAY['search_path=""'] FROM pg_proc p WHERE p.oid = ('public.' || r.fn)::regprocedure),
                          'C15 ' || r.fn || ' search_path pinned empty');
    PERFORM pg_temp.check((SELECT p.prosecdef = r.definer FROM pg_proc p WHERE p.oid = ('public.' || r.fn)::regprocedure),
                          'C15 ' || r.fn || ' security ' || CASE WHEN r.definer THEN 'definer' ELSE 'invoker' END);
    PERFORM pg_temp.check(has_function_privilege('anon', ('public.' || r.fn)::regprocedure, 'EXECUTE') = r.anon_x, 'C15 ' || r.fn || ' anon EXECUTE');
    PERFORM pg_temp.check(has_function_privilege('authenticated', ('public.' || r.fn)::regprocedure, 'EXECUTE') = r.auth_x, 'C15 ' || r.fn || ' authenticated EXECUTE');
    PERFORM pg_temp.check((SELECT NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) x WHERE x.grantee = 0) FROM pg_proc p WHERE p.oid = ('public.' || r.fn)::regprocedure),
                          'C15 ' || r.fn || ' no PUBLIC grant');
  END LOOP;
  PERFORM pg_temp.check((SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'carry_submission_checklist_reviews') = 1
                        AND (SELECT pg_get_function_identity_arguments(oid) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'carry_submission_checklist_reviews') = 'p_submission_id uuid',
                        'C15 carry takes the submission id only');
  PERFORM pg_temp.check(NOT has_table_privilege('authenticated', 'public.submission_checklist_items', 'UPDATE')
                        AND NOT has_table_privilege('authenticated', 'public.submission_checklist_items', 'DELETE')
                        AND NOT EXISTS (SELECT 1 FROM information_schema.column_privileges
                                         WHERE table_schema = 'public' AND table_name = 'submission_checklist_items'
                                           AND grantee = 'authenticated' AND privilege_type = 'UPDATE'),
                        'C15 authenticated has no UPDATE / DELETE on items');
END
$c15$;
