-- C09 (A-C9, C4): a tick and an add never move the status and never append a
-- status-shaped entry. On S_rev (under_review): tick I_rev, untick it, add
-- starter A. Status stays under_review, no entry has a status key, and every
-- entry carries type, changed_at and changed_by.
-- Wrong implementation this catches: an entry written with a status key.
DO $c09$
DECLARE
  s uuid := pg_temp.id('s_rev');
BEGIN
  PERFORM pg_temp.act_as(pg_temp.id('u_t1_broker'));
  PERFORM public.set_submission_checklist_reviewer_check(pg_temp.id('i_rev'), true);
  PERFORM public.set_submission_checklist_reviewer_check(pg_temp.id('i_rev'), false);
  PERFORM public.add_submission_checklist_at_review(s, pg_temp.id('tpl_t1_a'));
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.check((SELECT status FROM public.transaction_submissions WHERE id = s) = 'under_review', 'C09 status unchanged');
  PERFORM pg_temp.check(jsonb_array_length(pg_temp.hist(s)) = 3, 'C09 three entries');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM jsonb_array_elements(pg_temp.hist(s)) e WHERE e ? 'status'), 'C09 no status key');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM jsonb_array_elements(pg_temp.hist(s)) e
                                     WHERE NOT (e ? 'type' AND e ? 'changed_at' AND e ? 'changed_by')),
                        'C09 every entry has type, changed_at, changed_by');
END
$c09$;
