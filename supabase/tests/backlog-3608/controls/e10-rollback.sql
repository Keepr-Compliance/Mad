-- harness: rollback
-- E10: rollback-3608.sql (run by the harness after the 3608 file) restores
-- the state before it: the 3477 guard body and header, and the 3596 UPDATE
-- rule text; the behaviour 3608 changed is back:
--   agent-typed append on its uploading row -> rows:1
--   agent sets review fields on its uploading row -> rows:1
--   agent moves its needs_changes row to resubmitted -> rows:1
--   agent changes organization_id on its uploading row -> rows:1
--   agent sets its uploading row to needs_changes -> rows:1
-- and the legitimate paths (finalize, broker decision) still work.
DO $e10$
DECLARE
  agent  uuid := pg_temp.id('u_t1_agent');
  broker uuid := pg_temp.id('u_t1_broker');
  v1 uuid; v2 uuid; v3 uuid;
BEGIN
  PERFORM pg_temp.check((SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.guard_status_history_append_only()'::regprocedure)
                          = '46aba17498774aa04a64e679e5a39c84', 'E10 guard body is the 3477 body');
  PERFORM pg_temp.check((SELECT NOT prosecdef AND proconfig = ARRAY['search_path=""'] AND provolatile = 'v'
                                AND NOT has_function_privilege('authenticated', oid, 'EXECUTE')
                                AND NOT has_function_privilege('anon', oid, 'EXECUTE')
                                AND has_function_privilege('service_role', oid, 'EXECUTE')
                           FROM pg_proc WHERE oid = 'public.guard_status_history_append_only()'::regprocedure),
                        'E10 guard header: INVOKER, search_path empty, volatile, EXECUTE service_role only');
  PERFORM pg_temp.check((SELECT md5(COALESCE(pg_get_expr(polqual, polrelid), '') || '|' || COALESCE(pg_get_expr(polwithcheck, polrelid), ''))
                           FROM pg_policy WHERE polrelid = 'public.transaction_submissions'::regclass
                            AND polname = 'transaction_submissions_update_public')
                          = 'f81c2ae8429f810aba8c880e757add81', 'E10 UPDATE rule text is the 3596 text');

  v1 := pg_temp.mk_sub('fixture-3608-e10', 1, NULL, 'uploading');
  PERFORM pg_temp.act_as(agent);
  PERFORM pg_temp.expect('E10 agent-typed append on uploading row (restored)',
    format($q$UPDATE public.transaction_submissions SET status_history = status_history || jsonb_build_array(jsonb_build_object('type', 'checklist_review', 'changed_by', %L::text)) WHERE id = %L$q$, agent, v1), 'rows:1');
  PERFORM pg_temp.expect('E10 agent sets review fields (restored)',
    format($q$UPDATE public.transaction_submissions SET reviewed_by = %L, review_notes = 'x' WHERE id = %L$q$, broker, v1), 'rows:1');
  PERFORM pg_temp.act_owner();
  UPDATE public.transaction_submissions SET reviewed_by = NULL, review_notes = NULL WHERE id = v1;
  PERFORM pg_temp.act_as(agent);
  PERFORM pg_temp.expect('E10 desktop finalize', format($q$UPDATE public.transaction_submissions SET status = 'submitted' WHERE id = %L$q$, v1), 'rows:1');
  PERFORM pg_temp.act_as(broker);
  PERFORM pg_temp.expect('E10 broker decision needs_changes',
    format($q$UPDATE public.transaction_submissions SET status = 'needs_changes', reviewed_by = %L, reviewed_at = now(), review_notes = 'Fix' WHERE id = %L$q$, broker, v1), 'rows:1');
  PERFORM pg_temp.act_as(agent);
  PERFORM pg_temp.expect('E10 agent needs_changes -> resubmitted (restored)',
    format($q$UPDATE public.transaction_submissions SET status = 'resubmitted' WHERE id = %L$q$, v1), 'rows:1');
  PERFORM pg_temp.act_owner();
  v2 := pg_temp.mk_sub('fixture-3608-e10b', 1, NULL, 'uploading');
  PERFORM pg_temp.act_as(agent);
  PERFORM pg_temp.expect('E10 agent changes organization_id (restored)',
    format($q$UPDATE public.transaction_submissions SET organization_id = %L WHERE id = %L$q$, pg_temp.id('o_t2'), v2), 'rows:1');
  PERFORM pg_temp.act_owner();
  v3 := pg_temp.mk_sub('fixture-3608-e10c', 1, NULL, 'uploading');
  PERFORM pg_temp.act_as(agent);
  PERFORM pg_temp.expect('E10 agent sets its uploading row to needs_changes (restored)',
    format($q$UPDATE public.transaction_submissions SET status = 'needs_changes' WHERE id = %L$q$, v3), 'rows:1');
  PERFORM pg_temp.act_owner();
END
$e10$;
