-- harness: apply-twice
-- E11: the 3608 file applied twice (the harness runs it a second time) ends
-- in the same state: one UPDATE rule with the 3608 text, the 3608 guard
-- body, and the refusals and the finalize path unchanged.
DO $e11$
DECLARE
  agent uuid := pg_temp.id('u_t1_agent');
  v1 uuid;
BEGIN
  PERFORM pg_temp.check((SELECT count(*) FROM pg_policy WHERE polrelid = 'public.transaction_submissions'::regclass
                           AND polcmd = 'w') = 1, 'E11 one UPDATE rule');
  PERFORM pg_temp.check((SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.guard_status_history_append_only()'::regprocedure)
                          = current_setting('t3608.guard_md5'), 'E11 guard body is the 3608 body');
  PERFORM pg_temp.check((SELECT md5(COALESCE(pg_get_expr(polqual, polrelid), '') || '|' || COALESCE(pg_get_expr(polwithcheck, polrelid), ''))
                           FROM pg_policy WHERE polrelid = 'public.transaction_submissions'::regclass
                            AND polname = 'transaction_submissions_update_public')
                          = current_setting('t3608.pol_md5'), 'E11 UPDATE rule text is the first apply''s text');
  v1 := pg_temp.mk_sub('fixture-3608-e11', 1, NULL, 'uploading');
  PERFORM pg_temp.act_as(agent);
  PERFORM pg_temp.expect('E11 agent sets review_notes', format($q$UPDATE public.transaction_submissions SET review_notes = 'x' WHERE id = %L$q$, v1),
                         '~^42501:review_fields_reviewer_only$');
  PERFORM pg_temp.expect('E11 desktop finalize', format($q$UPDATE public.transaction_submissions SET status = 'submitted' WHERE id = %L$q$, v1), 'rows:1');
  PERFORM pg_temp.act_owner();
END
$e11$;
