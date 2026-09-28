-- C07 (plan C7): a snapshot refused on its last element leaves nothing: no
-- checklist, no carried tick, no entry.
DO $c07$
DECLARE
  agent uuid := pg_temp.id('u_t1_agent');
  v1    uuid := pg_temp.build_v1('fixture-3596-c07');
  v2    uuid := pg_temp.new_version(v1, 2);
  p     jsonb;
BEGIN
  p := pg_temp.item_set(pg_temp.base_payload(), 'L-item-1', 'note', to_jsonb('edited'::text))
       || jsonb_build_array(jsonb_build_object('template_name', 'Bad', 'items', jsonb_build_array(
            jsonb_build_object('title', 'Bad item', 'links', jsonb_build_array(jsonb_build_object('kind', 'fax', 'label', 'x'))))));
  PERFORM pg_temp.act_as(agent);
  PERFORM pg_temp.expect('C07 bad last element', format('SELECT public.snapshot_submission_checklists(%L, %L::jsonb)', v2, p), '~^22023:invalid_payload$');
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.check((SELECT count(*) FROM public.submission_checklists WHERE submission_id = v2) = 0
                        AND (SELECT count(*) FROM public.submission_checklist_items WHERE submission_id = v2) = 0,
                        'C07 no copy');
  PERFORM pg_temp.check(jsonb_array_length(pg_temp.hist(v2)) = 0, 'C07 no entry');
END
$c07$;
