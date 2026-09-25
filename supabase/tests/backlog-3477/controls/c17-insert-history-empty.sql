-- C17 (SR R1): a new submission row starts with an empty status_history.
--   allowed, as T1's agent (the submitter), run FIRST so a refusal below can
--   only come from the guard, not from the INSERT rule:
--     the desktop's insert shape (no status_history key: the column default
--       '[]' applies) -> rows:1, history []
--     status_history sent as NULL                              -> rows:1
--     the desktop's finalize: uploading -> submitted           -> rows:1, one status entry
--   refused (42501 status_history_append_only), as the submitter:
--     a typed entry naming the broker
--     an untyped {status: approved} entry
--     a typed entry naming the submitter themself
--   allowed: the same typed entry inserted by the service role.
-- Wrong implementations this catches: the trigger attached to UPDATE only
-- (m37); the INSERT case run through the UPDATE append test with an empty
-- old history, which lets a typed entry naming the caller through (m38).
DO $c17$
DECLARE
  agent  uuid := pg_temp.id('u_t1_agent');
  broker uuid := pg_temp.id('u_t1_broker');
  o_t1   uuid := pg_temp.id('o_t1');
  ins    text := 'INSERT INTO public.transaction_submissions (id, organization_id, submitted_by, local_transaction_id, property_address, status%s) VALUES (%L, %L, %L, %L, ''17 Fixture Way'', ''uploading''%s)';
  n1 uuid := '00000000-0000-4000-8000-000034771701'; -- pii-allow-uuid: invented fixture id
  n2 uuid := '00000000-0000-4000-8000-000034771702'; -- pii-allow-uuid: invented fixture id
  n3 uuid := '00000000-0000-4000-8000-000034771703'; -- pii-allow-uuid: invented fixture id
  n4 uuid := '00000000-0000-4000-8000-000034771704'; -- pii-allow-uuid: invented fixture id
  n5 uuid := '00000000-0000-4000-8000-000034771705'; -- pii-allow-uuid: invented fixture id
  n6 uuid := '00000000-0000-4000-8000-000034771706'; -- pii-allow-uuid: invented fixture id
  typed_broker text := format('jsonb_build_array(jsonb_build_object(''type'', ''checklist_review'', ''changed_at'', now(), ''changed_by'', %L::uuid))', broker);
  typed_agent  text := format('jsonb_build_array(jsonb_build_object(''type'', ''checklist_review'', ''changed_at'', now(), ''changed_by'', %L::uuid))', agent);
BEGIN
  PERFORM pg_temp.act_as(agent);
  PERFORM pg_temp.expect('C17 desktop insert shape', format(ins, '', n1, o_t1, agent, 'fixture-3477-c17-1', ''), 'rows:1');
  PERFORM pg_temp.expect('C17 NULL history', format(ins, ', status_history', n2, o_t1, agent, 'fixture-3477-c17-2', ', NULL'), 'rows:1');
  PERFORM pg_temp.expect('C17 desktop finalize', format('UPDATE public.transaction_submissions SET status = ''submitted'' WHERE id = %L', n1), 'rows:1');

  PERFORM pg_temp.expect('C17 typed entry naming the broker',
    format(ins, ', status_history', n3, o_t1, agent, 'fixture-3477-c17-3', ', ' || typed_broker), '~^42501:status_history_append_only$');
  PERFORM pg_temp.expect('C17 untyped status entry',
    format(ins, ', status_history', n4, o_t1, agent, 'fixture-3477-c17-4',
           ', jsonb_build_array(jsonb_build_object(''status'', ''approved'', ''changed_at'', now()))'), '~^42501:status_history_append_only$');
  PERFORM pg_temp.expect('C17 typed entry naming the submitter',
    format(ins, ', status_history', n5, o_t1, agent, 'fixture-3477-c17-5', ', ' || typed_agent), '~^42501:status_history_append_only$');

  PERFORM pg_temp.act_service();
  PERFORM pg_temp.expect('C17 service role insert with history',
    format(ins, ', status_history', n6, o_t1, agent, 'fixture-3477-c17-6', ', ' || typed_broker), 'rows:1');
  PERFORM pg_temp.act_owner();

  PERFORM pg_temp.check(pg_temp.hist(n1) -> 0 ->> 'status' = 'submitted' AND jsonb_array_length(pg_temp.hist(n1)) = 1,
                        'C17 desktop row: empty at insert, one status entry after finalize');
  PERFORM pg_temp.check((SELECT status_history IS NULL FROM public.transaction_submissions WHERE id = n2), 'C17 NULL-history row kept NULL');
  PERFORM pg_temp.check((SELECT count(*) FROM public.transaction_submissions WHERE id IN (n3, n4, n5)) = 0, 'C17 refused rows absent');
  PERFORM pg_temp.check(jsonb_array_length(pg_temp.hist(n6)) = 1, 'C17 service role row kept its entry');
END
$c17$;
