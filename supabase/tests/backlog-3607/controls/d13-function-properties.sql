-- D13: both new RPCs are SECURITY DEFINER with search_path='', executable by
-- authenticated only (not PUBLIC, not anon). The removed-pair CHECK exists
-- with its exact definition (SR R-2).
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
  -- R-2: the pair CHECK is what makes dropping ONE removed predicate from the
  -- insert policy unobservable (n11b). Pin its definition, not only its name.
  PERFORM pg_temp.check((SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
                          WHERE c.conname = 'submission_checklists_removed_pair_check'
                            AND c.conrelid = 'public.submission_checklists'::regclass)
                        = 'CHECK (((removed_at_review_by IS NULL) = (removed_at_review_at IS NULL)))',
                        'D13 removed pair CHECK: ' || COALESCE((SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
                          WHERE c.conname = 'submission_checklists_removed_pair_check'), 'missing'));
END
$d13$;
