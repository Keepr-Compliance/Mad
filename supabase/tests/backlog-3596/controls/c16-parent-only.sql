-- C16 (SR, ruling a3f70fe0 3): parent only. v1 ticked I1; v2 carried it; the
-- broker then UNticked I1 on v2. v3 must arrive with I1 unticked and no
-- entry -- v1's tick must never jump past v2.
DO $c16$
DECLARE
  agent uuid := pg_temp.id('u_t1_agent');
  v1    uuid := pg_temp.build_v1('fixture-3596-c16');
  v2    uuid := pg_temp.new_version(v1, 2);
  v3    uuid;
  res   jsonb;
BEGIN
  PERFORM pg_temp.snap_as(agent, v2, pg_temp.base_payload());
  PERFORM pg_temp.set_status(v2, 'resubmitted');
  res := pg_temp.tick_as(pg_temp.id('u_t1_broker'), pg_temp.item(v2, 'L-item-1'), false);
  PERFORM pg_temp.check((res ->> 'changed')::boolean, 'C16 broker unticks I1 on v2');
  PERFORM pg_temp.set_status(v2, 'needs_changes');
  v3 := pg_temp.new_version(v2, 3);
  res := pg_temp.snap_as(agent, v3, pg_temp.base_payload());
  PERFORM pg_temp.check((SELECT NOT reviewer_checked AND cleared_reviewer_id IS NULL FROM public.submission_checklist_items WHERE id = pg_temp.item(v3, 'L-item-1')),
                        'C16 I1 unticked on v3: ' || res::text);
  PERFORM pg_temp.check((res -> 'carry' ->> 'carried')::int = 4 AND jsonb_array_length(pg_temp.hist(v3)) = 0,
                        'C16 the other four carry, silently');
END
$c16$;
