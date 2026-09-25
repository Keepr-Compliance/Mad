-- C15: the five functions' security, search_path and EXECUTE grants.
--   every one: search_path pinned to '' (empty)
--   SECURITY DEFINER: can_review_submission, the tick, the add
--   SECURITY INVOKER: the snapshot, the guard
--   anon: EXECUTE on can_review_submission only (read rules for every role
--     call it); none on the snapshot, tick, add, guard
--   authenticated: EXECUTE on the helper, snapshot, tick, add; not the guard
--   no PUBLIC grant on any
--   the guard is a BEFORE UPDATE row trigger on transaction_submissions
DO $c15$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('can_review_submission',                   true,  true,  true),
      ('snapshot_submission_checklists',          false, false, true),
      ('set_submission_checklist_reviewer_check', true,  false, true),
      ('add_submission_checklist_at_review',      true,  false, true),
      ('guard_status_history_append_only',        false, false, false)) v(fn, definer, anon_x, auth_x) LOOP
    PERFORM pg_temp.check((SELECT p.proconfig = ARRAY['search_path=""'] FROM pg_proc p
                            WHERE p.pronamespace = 'public'::regnamespace AND p.proname = r.fn),
                          'C15 ' || r.fn || ' search_path pinned empty');
    PERFORM pg_temp.check((SELECT p.prosecdef = r.definer FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = r.fn),
                          'C15 ' || r.fn || ' security ' || CASE WHEN r.definer THEN 'definer' ELSE 'invoker' END);
    PERFORM pg_temp.check((SELECT has_function_privilege('anon', p.oid, 'EXECUTE') = r.anon_x FROM pg_proc p
                            WHERE p.pronamespace = 'public'::regnamespace AND p.proname = r.fn), 'C15 ' || r.fn || ' anon EXECUTE = ' || r.anon_x);
    PERFORM pg_temp.check((SELECT has_function_privilege('authenticated', p.oid, 'EXECUTE') = r.auth_x FROM pg_proc p
                            WHERE p.pronamespace = 'public'::regnamespace AND p.proname = r.fn), 'C15 ' || r.fn || ' authenticated EXECUTE = ' || r.auth_x);
    PERFORM pg_temp.check((SELECT NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) x WHERE x.grantee = 0) FROM pg_proc p
                            WHERE p.pronamespace = 'public'::regnamespace AND p.proname = r.fn), 'C15 ' || r.fn || ' no PUBLIC grant');
  END LOOP;
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM pg_trigger t
                                 WHERE t.tgrelid = 'public.transaction_submissions'::regclass
                                   AND t.tgname = 'status_history_append_only' AND t.tgenabled = 'O'
                                   AND t.tgfoid = 'public.guard_status_history_append_only()'::regprocedure
                                   AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2 AND (t.tgtype & 16) = 16),
                        'C15 guard is a BEFORE UPDATE row trigger');
END
$c15$;
