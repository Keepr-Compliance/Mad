-- C01: what real submitters send still passes, as T1's agent.
--   the desktop insert (status 'uploading', submissionService.ts :745)  rows:1
--   the desktop resubmit insert (version 2, parent id, 'uploading')     rows:1
--   an insert with no status (column default 'submitted')              rows:1
--   an explicit 'submitted' insert (desktop v2.0/v2.1)                 rows:1
--   the desktop finalize UPDATE uploading -> submitted                  rows:1
-- Wrong implementation this catches: 'uploading' only (m03), which breaks
-- the default and older clients.
DO $c01$
DECLARE
  agent uuid := pg_temp.id('u_t1_agent');
  o_t1  uuid := pg_temp.id('o_t1');
  a1 uuid := '00000000-0000-4000-8000-000035470101'; -- pii-allow-uuid: invented fixture id
  a2 uuid := '00000000-0000-4000-8000-000035470102'; -- pii-allow-uuid: invented fixture id
  a3 uuid := '00000000-0000-4000-8000-000035470103'; -- pii-allow-uuid: invented fixture id
  a4 uuid := '00000000-0000-4000-8000-000035470104'; -- pii-allow-uuid: invented fixture id
BEGIN
  PERFORM pg_temp.act_as(agent);
  PERFORM pg_temp.expect('C01 desktop insert', pg_temp.desk(a1, o_t1, agent, 'fixture-3547-c01-1', '''uploading'''), 'rows:1');
  PERFORM pg_temp.expect('C01 desktop resubmit insert',
    replace(pg_temp.desk(a2, o_t1, agent, 'fixture-3547-c01-1', '''uploading''', ', parent_submission_id', format(', %L', a1)),
            ', 1, 3, 1, ', ', 2, 3, 1, '), 'rows:1');
  PERFORM pg_temp.expect('C01 no status (column default)', pg_temp.desk(a3, o_t1, agent, 'fixture-3547-c01-3', ''), 'rows:1');
  PERFORM pg_temp.expect('C01 explicit submitted', pg_temp.desk(a4, o_t1, agent, 'fixture-3547-c01-4', '''submitted'''), 'rows:1');
  PERFORM pg_temp.expect('C01 desktop finalize',
    format('UPDATE public.transaction_submissions SET status = ''submitted'' WHERE id = %L', a1), 'rows:1');
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.check((SELECT status FROM public.transaction_submissions WHERE id = a3) = 'submitted',
                        'C01 the no-status row took the default');
  PERFORM pg_temp.check((SELECT version FROM public.transaction_submissions WHERE id = a2) = 2,
                        'C01 the resubmit row is version 2');
  PERFORM pg_temp.check((SELECT count(*) FROM public.transaction_submissions WHERE id IN (a1, a2, a3, a4)) = 4,
                        'C01 four rows stored');
END
$c01$;
