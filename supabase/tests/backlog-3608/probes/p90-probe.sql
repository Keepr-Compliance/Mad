-- E90 PROBE (not a control; always "RED" by design): records what a client
-- can write today. Ends with RAISE so the harness prints the outcomes.
DO $e90$
DECLARE
  agent  uuid := pg_temp.id('u_t1_agent');
  broker uuid := pg_temp.id('u_t1_broker');
  v1 uuid := pg_temp.build_v1('fixture-3608-e90');
  v2 uuid := pg_temp.new_version(v1, 2);
  v3 uuid;
  r text := '';
  q text := $q$UPDATE public.transaction_submissions SET status_history = COALESCE(status_history, '[]'::jsonb) || jsonb_build_array(%L::jsonb) WHERE id = %L$q$;
  last jsonb;
BEGIN
  PERFORM pg_temp.act_as(agent);
  r := r || ' A1 agent checklist_review self v2=' || pg_temp.outcome(format(q, jsonb_build_object('type','checklist_review','changed_by',agent)::text, v2));
  r := r || ' A2 agent status-shaped v2=' || pg_temp.outcome(format(q, jsonb_build_object('type','x','status','approved','changed_by',agent)::text, v2));
  r := r || ' A3 agent checklist_removed v1(needs_changes)=' || pg_temp.outcome(format(q, jsonb_build_object('type','checklist_removed','source','version','checklist_key','k','changed_by',agent)::text, v1));
  -- the status-trigger path: agent moves its own uploading row and names the broker as reviewer
  r := r || ' S1 agent status+reviewed_by=broker v2=' || pg_temp.outcome(format(
        $q$UPDATE public.transaction_submissions SET status = 'resubmitted', reviewed_by = %L, reviewed_at = now(), review_notes = 'Looks good' WHERE id = %L$q$, broker, v2));
  PERFORM pg_temp.act_owner();
  last := pg_temp.hist(v2) -> -1;
  r := r || ' S1 last entry: status=' || COALESCE(last ->> 'status', 'null') || ' changed_by=' || pg_temp.who((last ->> 'changed_by')::uuid)
         || ' notes=' || COALESCE(last ->> 'notes', 'null')
         || ' row reviewed_by=' || pg_temp.who((SELECT reviewed_by FROM public.transaction_submissions WHERE id = v2));
  -- broker direct append on an open version
  v3 := pg_temp.new_version(v1, 3, NULL, NULL, 'fixture-3608-e90b');
  PERFORM pg_temp.set_status(v3, 'submitted');
  PERFORM pg_temp.act_as(broker);
  r := r || ' B1 broker checklist_review self=' || pg_temp.outcome(format(q, jsonb_build_object('type','checklist_review','changed_by',broker)::text, v3));
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.check(true, 'probe');
  RAISE EXCEPTION 'PROBE:%', r;
END
$e90$;
