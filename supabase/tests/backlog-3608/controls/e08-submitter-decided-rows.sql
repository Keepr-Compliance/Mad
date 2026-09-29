-- E08: the submitter's UPDATE reaches only its own 'uploading' rows.
--   allowed (rows:1 + one status entry): uploading -> submitted,
--     uploading -> resubmitted (desktop finalize, v1 and v2).
--   no row (rows:0), row unchanged: the submitter's status move on its own
--     needs_changes version (to resubmitted, to submitted, to uploading),
--     on approved / rejected versions, and on its own submitted, resubmitted
--     or under_review versions (already open for review).
DO $e08$
DECLARE
  agent  uuid := pg_temp.id('u_t1_agent');
  broker uuid := pg_temp.id('u_t1_broker');
  v1 uuid; v2 uuid; r record; h jsonb; st text;
BEGIN
  v1 := pg_temp.mk_sub('fixture-3608-e08', 1, NULL, 'uploading');
  PERFORM pg_temp.act_as(agent);
  PERFORM pg_temp.expect('E08 desktop finalize v1 uploading -> submitted',
    format($q$UPDATE public.transaction_submissions SET status='submitted' WHERE id=%L$q$, v1), 'rows:1');
  PERFORM pg_temp.act_as(broker);
  PERFORM pg_temp.expect('E08 broker decision needs_changes',
    format($q$UPDATE public.transaction_submissions SET status='needs_changes', reviewed_by=%L, reviewed_at=now(), review_notes='Fix it' WHERE id=%L AND status IN ('submitted','resubmitted','under_review')$q$, broker, v1), 'rows:1');
  PERFORM pg_temp.act_owner();
  h := pg_temp.hist(v1);
  PERFORM pg_temp.check(jsonb_array_length(h) = 2, 'E08 v1 history is submitted, needs_changes');
  PERFORM pg_temp.act_as(agent);
  FOREACH st IN ARRAY ARRAY['resubmitted', 'submitted', 'uploading'] LOOP
    PERFORM pg_temp.expect('E08 agent moves its needs_changes v1 to ' || st,
      format($q$UPDATE public.transaction_submissions SET status=%L WHERE id=%L$q$, st, v1), 'rows:0');
  END LOOP;
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.check((SELECT status = 'needs_changes' AND reviewed_by = broker AND review_notes = 'Fix it'
                           FROM public.transaction_submissions WHERE id = v1) AND pg_temp.hist(v1) = h,
                        'E08 v1 unchanged: needs_changes, decision kept, history unchanged');
  v2 := pg_temp.mk_sub('fixture-3608-e08', 2, v1, 'uploading');
  PERFORM pg_temp.act_as(agent);
  PERFORM pg_temp.expect('E08 desktop finalize v2 uploading -> resubmitted',
    format($q$UPDATE public.transaction_submissions SET status='resubmitted' WHERE id=%L$q$, v2), 'rows:1');
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.check(jsonb_array_length(pg_temp.hist(v2)) = 1 AND pg_temp.hist(v2) -> 0 ->> 'status' = 'resubmitted'
                        AND pg_temp.hist(v2) -> 0 ->> 'changed_by' IS NULL, 'E08 v2 one resubmitted entry, no reviewer named');
  FOR r IN SELECT * FROM (VALUES ('approved'), ('rejected')) v(st) LOOP
    v2 := pg_temp.mk_sub('fixture-3608-e08-' || r.st, 1, NULL, r.st);
    PERFORM pg_temp.act_as(agent);
    PERFORM pg_temp.expect('E08 agent moves its ' || r.st || ' row to resubmitted',
      format($q$UPDATE public.transaction_submissions SET status='resubmitted' WHERE id=%L$q$, v2), 'rows:0');
    PERFORM pg_temp.act_owner();
  END LOOP;
  FOREACH st IN ARRAY ARRAY['submitted', 'resubmitted', 'under_review'] LOOP
    v2 := pg_temp.mk_sub('fixture-3608-e08-own-' || st, 1, NULL, st);
    PERFORM pg_temp.act_as(agent);
    PERFORM pg_temp.expect('E08 agent updates its own ' || st || ' row',
      format($q$UPDATE public.transaction_submissions SET status='uploading' WHERE id=%L$q$, v2), 'rows:0');
    PERFORM pg_temp.act_owner();
  END LOOP;
END
$e08$;
