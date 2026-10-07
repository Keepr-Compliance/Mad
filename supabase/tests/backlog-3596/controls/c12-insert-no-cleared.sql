-- C12 (plan C12): the submitter cannot insert an item that already carries
-- a "changed since you checked" marker; an ordinary item still inserts.
DO $c12$
DECLARE
  agent  uuid := pg_temp.id('u_t1_agent');
  v2     uuid := pg_temp.mk_sub('fixture-3596-c12', 1, NULL, 'uploading');
  h      uuid;
BEGIN
  PERFORM pg_temp.snap_as(agent, v2, jsonb_build_array(jsonb_build_object('template_name', 'Fixture custom B', 'items', '[]'::jsonb)));
  h := (SELECT id FROM public.submission_checklists WHERE submission_id = v2);
  PERFORM pg_temp.act_as(agent);
  PERFORM pg_temp.expect('C12 item with cleared marker',
    format($q$INSERT INTO public.submission_checklist_items (submission_id, submission_checklist_id, title, is_required, cleared_reviewer_id, cleared_at) VALUES (%L, %L, 'Forged', false, %L, now())$q$,
           v2, h, pg_temp.id('u_t1_broker')), 'RLS');
  PERFORM pg_temp.expect('C12 ordinary item',
    format($q$INSERT INTO public.submission_checklist_items (submission_id, submission_checklist_id, title, is_required, local_item_id) VALUES (%L, %L, 'Plain', false, 'L-x')$q$, v2, h), 'rows:1');
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.expect('C12 half a marker (owner) breaks the pair CHECK',
    format($q$UPDATE public.submission_checklist_items SET cleared_at = now() WHERE submission_id = %L$q$, v2), 'CHK');
END
$c12$;
