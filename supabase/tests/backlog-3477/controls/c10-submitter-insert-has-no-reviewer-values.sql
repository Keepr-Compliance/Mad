-- C10 (A-C10, C2): a submitter cannot insert an item that is already
-- reviewer-checked -- directly or through the snapshot.
--   direct INSERT with reviewer_checked true, _by a broker, _at now -> RLS
--   direct INSERT with only reviewer_checked_by set (CHECK-valid pair is
--     impossible, so this is the pair CHECK) -> refused
--   positive control: the same INSERT without reviewer values -> rows:1
--   snapshot payload carrying reviewer_checked / _by keys -> the item is
--     written with an empty reviewer layer
-- Wrong implementations this catches: the item rule without the new terms;
-- the snapshot passing reviewer values through from the payload.
DO $c10$
DECLARE
  broker uuid := pg_temp.id('u_t1_broker');
  s uuid := pg_temp.id('s_up');
  payload jsonb;
BEGIN
  PERFORM pg_temp.act_as(pg_temp.id('u_t1_agent'));
  PERFORM pg_temp.expect('C10 pre-ticked item',
    format('INSERT INTO public.submission_checklist_items (submission_id, submission_checklist_id, title, is_required, reviewer_checked, reviewer_checked_by, reviewer_checked_at) VALUES (%L, %L, %L, true, true, %L, now())',
           s, pg_temp.id('h_up'), 'Preticked', broker), 'RLS');
  PERFORM pg_temp.expect('C10 half a tick',
    format('INSERT INTO public.submission_checklist_items (submission_id, submission_checklist_id, title, is_required, reviewer_checked_by) VALUES (%L, %L, %L, true, %L)',
           s, pg_temp.id('h_up'), 'Half', broker), '~^(23514|42501):');
  PERFORM pg_temp.expect('C10 positive: plain item',
    format('INSERT INTO public.submission_checklist_items (submission_id, submission_checklist_id, title, is_required) VALUES (%L, %L, %L, true)',
           s, pg_temp.id('h_up'), 'Plain'), 'rows:1');
  payload := jsonb_build_array(jsonb_build_object('template_name', 'Payload',
    'items', jsonb_build_array(jsonb_build_object('title', 'Payload item', 'is_required', true,
      'reviewer_checked', true, 'reviewer_checked_by', broker, 'reviewer_checked_at', '2026-09-01T00:00:00Z'))));
  PERFORM public.snapshot_submission_checklists(s, payload);
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.check((SELECT NOT reviewer_checked AND reviewer_checked_by IS NULL AND reviewer_checked_at IS NULL
                           FROM public.submission_checklist_items WHERE submission_id = s AND title = 'Payload item'),
                        'C10 payload reviewer keys ignored');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM public.submission_checklist_items WHERE submission_id = s AND title IN ('Preticked', 'Half')),
                        'C10 no pre-ticked row');
END
$c10$;
