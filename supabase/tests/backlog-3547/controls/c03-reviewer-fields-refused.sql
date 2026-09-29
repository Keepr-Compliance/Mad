-- C03: a submitter cannot insert reviewer fields, each one alone, on an
-- otherwise-valid 'uploading' insert, naming the org's broker.
--   reviewed_by = broker / reviewed_at = now() / review_notes = 'ok'   -> RLS
-- Wrong implementations this catches: any reviewer term missing (m05, m06,
-- m07), the rule added beside the old one (m11).
DO $c03$
DECLARE
  agent  uuid := pg_temp.id('u_t1_agent');
  broker uuid := pg_temp.id('u_t1_broker');
  o_t1   uuid := pg_temp.id('o_t1');
BEGIN
  PERFORM pg_temp.act_as(agent);
  PERFORM pg_temp.expect('C03 reviewed_by',
    pg_temp.desk('00000000-0000-4000-8000-000035470301', o_t1, agent, 'fixture-3547-c03-1', '''uploading''', -- pii-allow-uuid: invented fixture id
                 ', reviewed_by', format(', %L', broker)), 'RLS');
  PERFORM pg_temp.expect('C03 reviewed_at',
    pg_temp.desk('00000000-0000-4000-8000-000035470302', o_t1, agent, 'fixture-3547-c03-2', '''uploading''', -- pii-allow-uuid: invented fixture id
                 ', reviewed_at', ', now()'), 'RLS');
  PERFORM pg_temp.expect('C03 review_notes',
    pg_temp.desk('00000000-0000-4000-8000-000035470303', o_t1, agent, 'fixture-3547-c03-3', '''uploading''', -- pii-allow-uuid: invented fixture id
                 ', review_notes', ', ''Looks good'''), 'RLS');
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.check((SELECT count(*) FROM public.transaction_submissions WHERE local_transaction_id LIKE 'fixture-3547-c03-%') = 0,
                        'C03 no refused row stored');
END
$c03$;
