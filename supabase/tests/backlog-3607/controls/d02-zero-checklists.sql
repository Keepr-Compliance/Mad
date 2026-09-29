-- D02 (plan §1, C-8 gap 770af91b, P02/P07): a version sent with NO checklist
-- records every removal; a repeat of the [] call (lost response, retry) adds
-- nothing; [] from an org without the feature returns quietly; a stranger
-- still reads not_authorized there.
DO $d02$
DECLARE
  agent uuid := pg_temp.id('u_t1_agent');
  a2    uuid := pg_temp.id('u_t2_agent');
  v1 uuid; v2 uuid; s uuid; res jsonb;
BEGIN
  v1 := pg_temp.build_v1('fixture-3607-d02');
  v2 := pg_temp.new_version(v1, 2);
  res := pg_temp.snap_as(agent, v2, '[]'::jsonb);
  PERFORM pg_temp.check(res -> 'carry' = '{"status": "no_checklists"}'::jsonb, 'D02 carry result: ' || res::text);
  PERFORM pg_temp.check(pg_temp.vd(v2) = 'checklist_removed:Fixture custom B,checklist_removed:Fixture starter A',
                        'D02 both removed: ' || pg_temp.vd(v2));
  PERFORM pg_temp.snap_as(agent, v2, '[]'::jsonb);
  PERFORM pg_temp.check(jsonb_array_length(pg_temp.hist(v2)) = 2, 'D02 retry adds nothing: ' || jsonb_array_length(pg_temp.hist(v2)));

  s := pg_temp.mk_sub('fixture-3607-d02-t2', 1, NULL, 'uploading', a2, pg_temp.id('o_t2'));
  res := pg_temp.snap_as(a2, s, '[]'::jsonb);
  PERFORM pg_temp.check(res -> 'carry' = '{"status": "not_in_plan"}'::jsonb AND (res ->> 'checklists')::int = 0,
                        'D02 feature off, [] -> quiet: ' || res::text);
  PERFORM pg_temp.act_as(agent);
  PERFORM pg_temp.expect('D02 stranger on the feature-off version',
                         format('SELECT public.carry_submission_checklist_reviews(%L)', s), '~^42501:not_authorized$');
  PERFORM pg_temp.act_owner();
END
$d02$;
