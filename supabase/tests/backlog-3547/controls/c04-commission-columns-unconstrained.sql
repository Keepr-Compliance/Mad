-- C04: with the table widened by the four BACKLOG-3519 commission columns
-- (lib/widen-commission.sql), the desktop insert carrying all four passes, and
-- the same insert plus reviewed_by is still refused.
-- Keys transcribed from the desktop mapping
-- (electron/services/submissionService.ts mapToSubmission :1591-1594). The
-- gross amount is whole dollars, as the writer stores it:
-- round(495000 x 2.25%) = 11138.
DO $c04$
DECLARE
  agent  uuid := pg_temp.id('u_t1_agent');
  broker uuid := pg_temp.id('u_t1_broker');
  o_t1   uuid := pg_temp.id('o_t1');
  cols text := ', commission_offered_rate, commission_actual_rate, commission_gross_amount, commission_adjustment_reason';
  vals text := ', 2.5, 2.25, 11138, ''Reduced to close''';
BEGIN
  PERFORM pg_temp.act_as(agent);
  PERFORM pg_temp.expect('C04 desktop insert with commission columns',
    pg_temp.desk('00000000-0000-4000-8000-000035470401', o_t1, agent, 'fixture-3547-c04-1', '''uploading''', cols, vals), 'rows:1'); -- pii-allow-uuid: invented fixture id
  PERFORM pg_temp.expect('C04 same plus reviewed_by',
    pg_temp.desk('00000000-0000-4000-8000-000035470402', o_t1, agent, 'fixture-3547-c04-2', '''uploading''', -- pii-allow-uuid: invented fixture id
                 cols || ', reviewed_by', vals || format(', %L', broker)), 'RLS');
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.check((SELECT commission_offered_rate = 2.5 AND commission_actual_rate = 2.25
                                  AND commission_gross_amount = 11138
                                  AND commission_adjustment_reason = 'Reduced to close'
                           FROM public.transaction_submissions WHERE local_transaction_id = 'fixture-3547-c04-1'),
                        'C04 commission values stored as sent');
END
$c04$;
