-- C07 (A-C7, substitute): the harness runs one session per control, so two
-- concurrent ticks cannot be raced here. What makes them safe is that each
-- function appends in ONE UPDATE whose right-hand side reads the row's own
-- status_history (re-read under the row lock), never a value copied into a
-- variable earlier. This control reads both function bodies for exactly that
-- shape and for the absence of a history read into a variable.
-- Wrong implementation this catches: SELECT status_history INTO v ... then
-- SET status_history = v || entry (loses a concurrent entry).
DO $c07$
DECLARE
  f text;
  src text;
BEGIN
  FOREACH f IN ARRAY ARRAY['set_submission_checklist_reviewer_check', 'add_submission_checklist_at_review'] LOOP
    SELECT p.prosrc INTO src FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = f;
    PERFORM pg_temp.check(src ~ 'SET status_history = COALESCE\(status_history, ''\[\]''::jsonb\) \|\|',
                          f || ': appends from the row''s own status_history');
    PERFORM pg_temp.check(src !~* 'status_history\s+INTO', f || ': never reads status_history into a variable');
    PERFORM pg_temp.check((SELECT count(*) FROM regexp_matches(src, 'status_history', 'g')) = 2,
                          f || ': status_history named exactly twice (the one append)');
  END LOOP;
END
$c07$;
