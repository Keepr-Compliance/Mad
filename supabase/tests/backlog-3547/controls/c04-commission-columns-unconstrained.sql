-- C04: with the table widened by the nine BACKLOG-3519 commission/split
-- columns (lib/widen-commission.sql), the desktop insert carrying all of them
-- passes, and the same insert plus reviewed_by is still refused.
-- Values transcribed from the 3519 desktop mapping (rates, gross amount,
-- adjustment reason, and the split snapshot: agreement id, agent/brokerage pct
-- summing to 100, effective-from, resolved-on).
DO $c04$
DECLARE
  agent  uuid := pg_temp.id('u_t1_agent');
  broker uuid := pg_temp.id('u_t1_broker');
  o_t1   uuid := pg_temp.id('o_t1');
  cols text := ', commission_offered_rate, commission_actual_rate, commission_gross_amount, commission_adjustment_reason, '
               'split_agreement_id, split_agent_pct, split_brokerage_pct, split_effective_from, split_resolved_on';
  vals text := ', 2.5, 2.25, 11137.5, ''Reduced to close'', ''00000000-0000-4000-8000-000035470499'', 70, 30, ''2026-01-01'', ''2026-09-01'''; -- pii-allow-uuid: invented fixture id
BEGIN
  PERFORM pg_temp.act_as(agent);
  PERFORM pg_temp.expect('C04 desktop insert with commission columns',
    pg_temp.desk('00000000-0000-4000-8000-000035470401', o_t1, agent, 'fixture-3547-c04-1', '''uploading''', cols, vals), 'rows:1'); -- pii-allow-uuid: invented fixture id
  PERFORM pg_temp.expect('C04 same plus reviewed_by',
    pg_temp.desk('00000000-0000-4000-8000-000035470402', o_t1, agent, 'fixture-3547-c04-2', '''uploading''', -- pii-allow-uuid: invented fixture id
                 cols || ', reviewed_by', vals || format(', %L', broker)), 'RLS');
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.check((SELECT commission_actual_rate = 2.25 AND split_agent_pct = 70
                           FROM public.transaction_submissions WHERE local_transaction_id = 'fixture-3547-c04-1'),
                        'C04 commission values stored as sent');
END
$c04$;
