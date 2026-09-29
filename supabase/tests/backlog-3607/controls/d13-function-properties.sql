-- D13: both new RPCs are SECURITY DEFINER with search_path='', executable by
-- authenticated only (not PUBLIC, not anon).
DO $d13$
DECLARE r record;
BEGIN
  FOR r IN SELECT p.oid, p.proname, p.prosecdef, p.proconfig FROM pg_proc p
            WHERE p.pronamespace = 'public'::regnamespace
              AND p.proname IN ('remove_submission_checklist_at_review', 'restore_submission_checklist_at_review') LOOP
    PERFORM pg_temp.check(r.prosecdef AND r.proconfig = ARRAY['search_path=""'], 'D13 definer + search_path: ' || r.proname || ' ' || COALESCE(r.proconfig::text, 'null'));
    PERFORM pg_temp.check(has_function_privilege('authenticated', r.oid, 'EXECUTE'), 'D13 authenticated executes ' || r.proname);
    PERFORM pg_temp.check(NOT has_function_privilege('anon', r.oid, 'EXECUTE'), 'D13 anon cannot execute ' || r.proname);
    PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM aclexplode((SELECT proacl FROM pg_proc WHERE oid = r.oid)) a WHERE a.grantee = 0),
                          'D13 PUBLIC cannot execute ' || r.proname);
  END LOOP;
  PERFORM pg_temp.check((SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
                           AND proname IN ('remove_submission_checklist_at_review', 'restore_submission_checklist_at_review')) = 2, 'D13 both exist');
END
$d13$;
