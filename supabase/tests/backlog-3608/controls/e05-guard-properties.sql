-- harness: pre-rows
-- E05: the guard after this file. Copy of 3596 C10 with the new body pinned,
-- plus the 3608 UPDATE rule text and the unchanged status trigger function;
-- the trigger is still attached and still sorts BEFORE track_status_changes;
-- INVOKER, search_path '', grants unchanged; the file rewrote no row
-- (t3608_h0 = every status_history taken just before it ran).
DO $e05$
DECLARE
  agent uuid := pg_temp.id('u_t1_agent');
  v1    uuid := pg_temp.build_v1('fixture-3608-e05');
  v2    uuid := pg_temp.new_version(v1, 2);
BEGIN
  PERFORM pg_temp.check((SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.guard_status_history_append_only()'::regprocedure)
                          = '7bdcafeaacb65f164c85056501724071', 'E05 guard body is the 3608 body');
  PERFORM pg_temp.check((SELECT md5(COALESCE(pg_get_expr(polqual, polrelid), '') || '|' || COALESCE(pg_get_expr(polwithcheck, polrelid), ''))
                           FROM pg_policy WHERE polrelid = 'public.transaction_submissions'::regclass
                            AND polname = 'transaction_submissions_update_public')
                          = '80e689b0c48a379821ee08d0415d62f3', 'E05 UPDATE rule text is the 3608 text');
  PERFORM pg_temp.check((SELECT md5(prosrc) FROM pg_proc WHERE proname = 'track_submission_status_changes')
                          = '61a29cd512ecfab789db6a8d2bf90f49', 'E05 status trigger function unchanged');
  PERFORM pg_temp.check((SELECT NOT prosecdef AND proconfig = ARRAY['search_path=""']
                                AND NOT has_function_privilege('authenticated', oid, 'EXECUTE')
                                AND NOT has_function_privilege('anon', oid, 'EXECUTE')
                           FROM pg_proc WHERE oid = 'public.guard_status_history_append_only()'::regprocedure),
                        'E05 guard is INVOKER, search_path empty, not executable by clients');
  PERFORM pg_temp.check((SELECT array_agg(tgname::text ORDER BY tgname) FROM pg_trigger
                          WHERE tgrelid = 'public.transaction_submissions'::regclass AND NOT tgisinternal
                            AND tgtype & 2 = 2 AND tgenabled = 'O')   -- BEFORE row triggers
                        = ARRAY['status_history_append_only', 'track_status_changes', 'update_submissions_updated_at'],
                        'E05 guard attached and sorts before track_status_changes');
  PERFORM pg_temp.check((SELECT count(*) FROM t3608_h0) > 0, 'E05 pre-rows exist');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM t3608_h0 h JOIN public.transaction_submissions s USING (id)
                                     WHERE s.status_history IS DISTINCT FROM h.status_history)
                        AND (SELECT count(*) FROM t3608_h0) = (SELECT count(*) FROM public.transaction_submissions s JOIN t3608_h0 h USING (id)),
                        'E05 no existing history changed by the file');
  PERFORM pg_temp.snap_as(agent, v2, pg_temp.item_set(pg_temp.base_payload(), 'L-item-1', 'note', to_jsonb('edited'::text)));
  PERFORM pg_temp.check((SELECT bool_and(x.e ->> 'changed_by' = agent::text) FROM jsonb_array_elements(pg_temp.hist(v2)) AS x(e))
                        AND jsonb_array_length(pg_temp.hist(v2)) = 1, 'E05 the carry entry names the agent');
END
$e05$;
