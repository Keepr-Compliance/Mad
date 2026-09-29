-- E04: every database function that writes status_history still does, called
-- by the client role it serves, each adding its entry naming the caller:
--   snapshot -> carry   (agent)   checklist_removed / checklist_review_cleared
--   tick                (broker)  checklist_review
--   add at review       (broker)  checklist_added
--   remove at review    (broker)  checklist_removed (source broker)
--   restore at review   (admin)   checklist_added (restored)
DO $e04$
DECLARE
  agent  uuid := pg_temp.id('u_t1_agent');
  broker uuid := pg_temp.id('u_t1_broker');
  admin  uuid := pg_temp.id('u_t1_admin');
  tpl    uuid := pg_temp.id('tpl_t1_a');
  v1 uuid; v2 uuid; src uuid; hdr uuid; n int; res jsonb; e jsonb; it uuid;
BEGIN
  -- carry (inside the agent's snapshot call): v2 drops checklist A
  v2 := pg_temp.rm_v2('fixture-3608-e04');
  v1 := (SELECT parent_submission_id FROM public.transaction_submissions WHERE id = v2);
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM jsonb_array_elements(pg_temp.hist(v2)) x(e)
                                 WHERE x.e ->> 'type' = 'checklist_removed' AND x.e ->> 'source' = 'version'
                                   AND (x.e ->> 'changed_by')::uuid = agent),
                        'E04 carry wrote checklist_removed naming the agent: ' || pg_temp.hist(v2)::text);
  src := pg_temp.hdr(v1, 'Fixture starter A');

  -- tick
  -- (every item of v2 carries a tick: the broker unticks one)
  it := (SELECT id FROM public.submission_checklist_items WHERE submission_id = v2 AND reviewer_checked ORDER BY sort_order, title LIMIT 1);
  PERFORM pg_temp.check(it IS NOT NULL, 'E04 v2 has a ticked item');
  n := jsonb_array_length(pg_temp.hist(v2));
  res := pg_temp.tick_as(broker, it, false);
  e := pg_temp.hist(v2) -> -1;
  PERFORM pg_temp.check(jsonb_array_length(pg_temp.hist(v2)) = n + 1 AND e ->> 'type' = 'checklist_review'
                        AND (e ->> 'changed_by')::uuid = broker, 'E04 tick wrote one entry: ' || res::text);

  -- restore at review (A, removed by the agent's version)
  n := jsonb_array_length(pg_temp.hist(v2));
  res := pg_temp.restore_as(admin, v2, src);
  hdr := (res ->> 'checklist_id')::uuid;
  e := pg_temp.hist(v2) -> -1;
  PERFORM pg_temp.check(res ->> 'status' = 'restored' AND jsonb_array_length(pg_temp.hist(v2)) = n + 1
                        AND e ->> 'type' = 'checklist_added' AND (e ->> 'changed_by')::uuid = admin,
                        'E04 restore wrote one entry: ' || res::text);

  -- remove at review (the restored checklist)
  n := jsonb_array_length(pg_temp.hist(v2));
  res := pg_temp.remove_as(broker, hdr);
  e := pg_temp.hist(v2) -> -1;
  PERFORM pg_temp.check(jsonb_array_length(pg_temp.hist(v2)) = n + 1 AND e ->> 'type' = 'checklist_removed'
                        AND (e ->> 'changed_by')::uuid = broker, 'E04 remove wrote one entry: ' || res::text);

  -- add at review (a separate deal, as 3596 C26 builds it)
  v1 := pg_temp.added_v1('fixture-3608-e04b');
  n := jsonb_array_length(pg_temp.hist(v1));
  hdr := pg_temp.add_as(broker, v1, tpl);
  e := pg_temp.hist(v1) -> -1;
  PERFORM pg_temp.check(jsonb_array_length(pg_temp.hist(v1)) = n + 1 AND e ->> 'type' = 'checklist_added'
                        AND (e ->> 'changed_by')::uuid = broker, 'E04 add wrote one entry');
END
$e04$;
