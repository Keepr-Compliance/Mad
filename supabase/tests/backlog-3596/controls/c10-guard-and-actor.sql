-- C10 (plan C10, ruling f581efb4 1): the append-only guard is exactly the
-- BACKLOG-3477 function, still attached, and still refuses an entry naming
-- someone else; the carry has no other actor and no service-role path.
DO $c10$
DECLARE
  agent uuid := pg_temp.id('u_t1_agent');
  v1    uuid := pg_temp.build_v1('fixture-3596-c10');
  v2    uuid := pg_temp.new_version(v1, 2);
BEGIN
  PERFORM pg_temp.check((SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.guard_status_history_append_only()'::regprocedure)
                          = '46aba17498774aa04a64e679e5a39c84', 'C10 guard body is the 3477 body');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.transaction_submissions'::regclass
                                   AND tgname = 'status_history_append_only' AND tgenabled = 'O'),
                        'C10 guard attached');
  PERFORM pg_temp.check((SELECT prosrc NOT ILIKE '%service_role%' AND prosrc NOT ILIKE '%set_config%'
                           AND prosrc NOT ILIKE '%00000000-0000-0000-0000-000000000000%'
                           FROM pg_proc WHERE oid = 'public.carry_submission_checklist_reviews(uuid)'::regprocedure),
                        'C10 carry has no service-role path, no role switch, no sentinel');
  PERFORM pg_temp.snap_as(agent, v2, pg_temp.item_set(pg_temp.base_payload(), 'L-item-1', 'note', to_jsonb('edited'::text)));
  PERFORM pg_temp.act_as(agent);
  PERFORM pg_temp.expect('C10 the agent appending an entry naming the broker',
    format($q$UPDATE public.transaction_submissions SET status_history = status_history || jsonb_build_array(jsonb_build_object('type', 'checklist_review_cleared', 'changed_by', %L)) WHERE id = %L$q$,
           pg_temp.id('u_t1_broker'), v2),
    '~^42501:status_history_append_only$');
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.check((SELECT bool_and(x.e ->> 'changed_by' = agent::text) FROM jsonb_array_elements(pg_temp.hist(v2)) AS x(e))
                        AND jsonb_array_length(pg_temp.hist(v2)) = 1, 'C10 the carry entry names the agent');
END
$c10$;
