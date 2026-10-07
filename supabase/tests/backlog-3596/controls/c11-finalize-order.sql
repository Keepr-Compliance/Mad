-- C11 (plan C11): the agent's finalize after the carry: the cleared entries
-- come first and the status entry the status trigger writes comes after
-- them (the portal groups typed entries under the NEXT status line).
DO $c11$
DECLARE
  agent uuid := pg_temp.id('u_t1_agent');
  v1    uuid := pg_temp.build_v1('fixture-3596-c11');
  v2    uuid := pg_temp.new_version(v1, 2);
  h     jsonb;
BEGIN
  PERFORM pg_temp.snap_as(agent, v2, pg_temp.item_set(pg_temp.item_set(pg_temp.base_payload(),
            'L-item-1', 'note', to_jsonb('edited'::text)), 'L-item-2', 'note', to_jsonb('edited'::text)));
  PERFORM pg_temp.act_as(agent);
  PERFORM pg_temp.expect('C11 agent finalizes v2', format($q$UPDATE public.transaction_submissions SET status = 'resubmitted' WHERE id = %L$q$, v2), 'rows:1');
  PERFORM pg_temp.act_owner();
  h := pg_temp.hist(v2);
  PERFORM pg_temp.check(jsonb_array_length(h) = 3
                        AND h -> 0 ->> 'type' = 'checklist_review_cleared'
                        AND h -> 1 ->> 'type' = 'checklist_review_cleared'
                        AND h -> 2 ->> 'status' = 'resubmitted' AND NOT (h -> 2 ? 'type'),
                        'C11 order: ' || h::text);
END
$c11$;
