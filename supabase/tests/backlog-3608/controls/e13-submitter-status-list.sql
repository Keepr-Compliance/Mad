-- E13: the submitter branch's WITH CHECK admits resubmitted / uploading /
-- submitted, not needs_changes.
--   refused (the row matches USING, so the WITH CHECK failure raises 42501
--     "new row violates row-level security policy"): the agent sets its own
--     uploading row to needs_changes; row unchanged, no status entry.
--   allowed (rows:1 + status entry naming the reviewer): broker and admin
--     set an open row to needs_changes (ReviewActions shape).
--   allowed: desktop finalize uploading -> submitted, uploading ->
--     resubmitted.
DO $e13$
DECLARE
  agent  uuid := pg_temp.id('u_t1_agent');
  broker uuid := pg_temp.id('u_t1_broker');
  admin  uuid := pg_temp.id('u_t1_admin');
  v1 uuid; v2 uuid; v3 uuid; u uuid; e jsonb;
BEGIN
  v1 := pg_temp.mk_sub('fixture-3608-e13', 1, NULL, 'uploading');
  PERFORM pg_temp.act_as(agent);
  PERFORM pg_temp.expect('E13 agent sets its own uploading row to needs_changes',
    format($q$UPDATE public.transaction_submissions SET status = 'needs_changes' WHERE id = %L$q$, v1),
    '~^42501:new row violates row-level security policy');
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.check((SELECT status = 'uploading' FROM public.transaction_submissions WHERE id = v1)
                        AND jsonb_array_length(COALESCE(pg_temp.hist(v1), '[]'::jsonb)) = 0,
                        'E13 v1 still uploading, no status entry');
  PERFORM pg_temp.act_as(agent);
  PERFORM pg_temp.expect('E13 desktop finalize v1 -> submitted',
    format($q$UPDATE public.transaction_submissions SET status = 'submitted' WHERE id = %L$q$, v1), 'rows:1');
  v2 := pg_temp.mk_sub('fixture-3608-e13', 2, v1, 'uploading');
  PERFORM pg_temp.act_as(agent);
  PERFORM pg_temp.expect('E13 desktop finalize v2 -> resubmitted',
    format($q$UPDATE public.transaction_submissions SET status = 'resubmitted' WHERE id = %L$q$, v2), 'rows:1');
  PERFORM pg_temp.act_owner();
  v3 := pg_temp.mk_sub('fixture-3608-e13b', 1, NULL, 'submitted');
  FOREACH u IN ARRAY ARRAY[broker, admin] LOOP
    PERFORM pg_temp.act_as(u);
    PERFORM pg_temp.expect('E13 reviewer sets an open row to needs_changes (' || pg_temp.who(u) || ')',
      format($q$UPDATE public.transaction_submissions SET status = 'needs_changes', reviewed_by = %L, reviewed_at = now(), review_notes = 'Fix it' WHERE id = %L AND status IN ('submitted','resubmitted','under_review')$q$,
             u, CASE WHEN u = broker THEN v1 ELSE v3 END), 'rows:1');
    PERFORM pg_temp.act_owner();
    e := pg_temp.hist(CASE WHEN u = broker THEN v1 ELSE v3 END) -> -1;
    PERFORM pg_temp.check(e ->> 'status' = 'needs_changes' AND (e ->> 'changed_by')::uuid = u,
                          'E13 needs_changes entry names the reviewer (' || pg_temp.who(u) || ')');
  END LOOP;
END
$e13$;
