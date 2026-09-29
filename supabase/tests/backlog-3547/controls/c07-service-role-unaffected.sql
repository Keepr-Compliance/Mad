-- C07: the service role is unaffected (service_role_full_access_submissions
-- is FOR ALL and ORed): it may insert a reviewed row.
DO $c07$
DECLARE
  agent  uuid := pg_temp.id('u_t1_agent');
  broker uuid := pg_temp.id('u_t1_broker');
  o_t1   uuid := pg_temp.id('o_t1');
BEGIN
  PERFORM pg_temp.act_service();
  PERFORM pg_temp.expect('C07 service role reviewed insert',
    pg_temp.desk('00000000-0000-4000-8000-000035470701', o_t1, agent, 'fixture-3547-c07-1', '''approved''', -- pii-allow-uuid: invented fixture id
                 ', reviewed_by, reviewed_at, review_notes', format(', %L, now(), ''ok''', broker)), 'rows:1');
  PERFORM pg_temp.act_owner();
END
$c07$;
