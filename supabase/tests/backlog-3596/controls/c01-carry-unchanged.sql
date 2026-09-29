-- C01 (plan C1, C4, C13 "same evidence on a new version"): an unchanged,
-- reviewer-ticked item arrives ticked on the next version with the ORIGINAL
-- reviewer and time, silently.
--   v1 reviewed (5 ticks, backdated); v2 uploads the same local files as NEW
--   cloud rows (L-att-1 was two uploads on v1, one on v2); the agent sends
--   the identical payload.
--   -> 5 carried, each with v1's reviewer_checked_by and _at verbatim
--   -> I4 (never ticked) untouched; no cleared columns; no history entry
-- Wrong builds this catches: re-stamping with the caller or now(); comparing
-- cloud row ids (every linked item would clear); the carry running before
-- the item inserts (0 carried); the snapshot dropping local_item_id.
DO $c01$
DECLARE
  agent uuid := pg_temp.id('u_t1_agent');
  v1    uuid := pg_temp.build_v1('fixture-3596-c01');
  v2    uuid := pg_temp.new_version(v1, 2);
  res   jsonb;
BEGIN
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM public.submission_attachments a2
                                      JOIN public.submission_attachments a1 ON a1.id = a2.id
                                     WHERE a2.submission_id = v2 AND a1.submission_id = v1),
                        'C01 v2 uploads are new cloud rows');
  res := pg_temp.snap_as(agent, v2, pg_temp.base_payload());
  PERFORM pg_temp.check(res -> 'carry' ->> 'status' = 'done'
                        AND (res -> 'carry' ->> 'carried')::int = 5
                        AND (res -> 'carry' ->> 'cleared')::int = 0
                        AND (res -> 'carry' ->> 'removed')::int = 0
                        AND res -> 'carry' -> 'unavailable' = 'null'::jsonb, 'C01 carry result: ' || res::text);
  PERFORM pg_temp.check(pg_temp.tick_state(v2) = pg_temp.base_ticks(),
                        'C01 original reviewer and time: ' || pg_temp.tick_state(v2));
  PERFORM pg_temp.check((SELECT NOT reviewer_checked FROM public.submission_checklist_items WHERE id = pg_temp.item(v2, 'L-item-4')),
                        'C01 never-ticked item stays unticked');
  PERFORM pg_temp.check((SELECT count(*) FROM public.submission_checklist_items
                          WHERE submission_id = v2 AND (cleared_reviewer_id IS NOT NULL OR cleared_at IS NOT NULL)) = 0,
                        'C01 no cleared marker');
  PERFORM pg_temp.check(jsonb_array_length(pg_temp.hist(v2)) = 0, 'C01 silent: no history entry on v2');
  PERFORM pg_temp.check((SELECT is_checked FROM public.submission_checklist_items WHERE id = pg_temp.item(v2, 'L-item-1')),
                        'C01 agent layer copied as sent');
END
$c01$;
