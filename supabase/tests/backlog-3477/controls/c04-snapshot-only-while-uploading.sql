-- C04 (A-C4): the snapshot, a header and an item are refused once the
-- submission is past 'uploading'. As u_t1_agent on S_sub (submitted).
-- Positive control: the same header insert on S_up succeeds.
-- Wrong implementation this catches: the header rule without its status term.
DO $c04$
DECLARE
  s uuid := pg_temp.id('s_sub');
  payload jsonb := jsonb_build_array(jsonb_build_object('template_name', 'Late',
    'items', jsonb_build_array(jsonb_build_object('title', 'Late item'))));
BEGIN
  PERFORM pg_temp.act_as(pg_temp.id('u_t1_agent'));
  PERFORM pg_temp.expect('C04 snapshot refused', format('SELECT public.snapshot_submission_checklists(%L, %L::jsonb)', s, payload), 'RLS');
  PERFORM pg_temp.expect('C04 direct header refused',
    format('INSERT INTO public.submission_checklists (submission_id, template_name) VALUES (%L, %L)', s, 'Late'), 'RLS');
  PERFORM pg_temp.expect('C04 direct item refused',
    format('INSERT INTO public.submission_checklist_items (submission_id, submission_checklist_id, title, is_required) VALUES (%L, %L, %L, true)',
           s, pg_temp.id('h_sub'), 'Late item'), 'RLS');
  PERFORM pg_temp.expect('C04 positive: header on S_up',
    format('INSERT INTO public.submission_checklists (submission_id, template_name) VALUES (%L, %L)', pg_temp.id('s_up'), 'On time'), 'rows:1');
  PERFORM pg_temp.act_owner();
END
$c04$;
