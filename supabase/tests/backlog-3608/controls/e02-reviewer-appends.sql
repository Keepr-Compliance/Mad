-- E02: a broker / admin reviewer cannot write status_history directly on an
-- open version either (symmetric rule; the portal never does).
DO $e02$
DECLARE
  broker uuid := pg_temp.id('u_t1_broker');
  admin  uuid := pg_temp.id('u_t1_admin');
  v1 uuid := pg_temp.build_v1('fixture-3608-e02');
  v2 uuid := pg_temp.new_version(v1, 2);
  h jsonb; u uuid;
  q text := $q$UPDATE public.transaction_submissions SET status_history = COALESCE(status_history, '[]'::jsonb) || jsonb_build_array(%L::jsonb) WHERE id = %L$q$;
BEGIN
  PERFORM pg_temp.snap_as(pg_temp.id('u_t1_agent'), v2, pg_temp.base_payload());
  PERFORM pg_temp.set_status(v2, 'resubmitted');
  h := pg_temp.hist(v2);
  FOREACH u IN ARRAY ARRAY[broker, admin] LOOP
    PERFORM pg_temp.act_as(u);
    PERFORM pg_temp.check(pg_temp.n(format('SELECT count(*) FROM public.transaction_submissions WHERE id = %L', v2)) = 1,
                          'E02 the reviewer sees the version');
    PERFORM pg_temp.expect('E02 reviewer appends checklist_review naming self',
      format(q, jsonb_build_object('type', 'checklist_review', 'changed_by', u, 'from', false, 'to', true)::text, v2),
      '~^42501:status_history_append_only$');
    PERFORM pg_temp.expect('E02 reviewer appends a status-shaped entry',
      format(q, jsonb_build_object('type', 'x', 'status', 'approved', 'changed_by', u)::text, v2),
      '~^42501:status_history_append_only$');
    PERFORM pg_temp.expect('E02 reviewer appends while deciding',
      format($q$UPDATE public.transaction_submissions SET status = 'approved', reviewed_by = %L, status_history = status_history || jsonb_build_array(jsonb_build_object('type', 'checklist_added', 'changed_by', %L::text)) WHERE id = %L$q$, u, u, v2),
      '~^42501:status_history_append_only$');
    PERFORM pg_temp.act_owner();
  END LOOP;
  PERFORM pg_temp.check(pg_temp.hist(v2) = h, 'E02 history unchanged');
END
$e02$;
