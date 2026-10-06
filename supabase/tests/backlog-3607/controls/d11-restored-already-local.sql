-- D11 (C-4.8): the agent had already picked A again locally, so the pull
-- returned 'exists' and v3 carries the agent's own A (its own local ids).
-- The restored ticks are reported 'not_carried' (4), not silently dropped;
-- no checklist-level entry (same template on both sides; the replaced rule
-- is for the agent's own checklists only).
DO $d11$
DECLARE
  broker uuid := pg_temp.id('u_t1_broker');
  v1 uuid; v2 uuid; v3 uuid; res jsonb;
BEGIN
  v2 := pg_temp.rm_v2('fixture-3607-d11');
  v1 := (SELECT parent_submission_id FROM public.transaction_submissions WHERE id = v2);
  PERFORM pg_temp.restore_as(broker, v2, pg_temp.hdr(v1, 'Fixture starter A'));
  PERFORM pg_temp.set_status(v2, 'needs_changes');
  v3 := pg_temp.new_version(v2, 3);
  res := pg_temp.snap_as(pg_temp.id('u_t1_agent'), v3, pg_temp.pb() || jsonb_build_array(pg_temp.base_payload() -> 0));
  PERFORM pg_temp.check((res -> 'carry' ->> 'removed')::int = 4
                        AND (SELECT count(*) FROM jsonb_array_elements(pg_temp.typed(v3, 'checklist_review_cleared')) e WHERE e ->> 'reason' = 'not_carried') = 4
                        AND pg_temp.vd(v3) = '',
                        'D11: ' || (res -> 'carry')::text || ' vd=' || pg_temp.vd(v3));
END
$d11$;
