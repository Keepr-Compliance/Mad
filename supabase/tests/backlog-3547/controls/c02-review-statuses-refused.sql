-- C02: a submitter cannot insert a row already in a review state, or with a
-- NULL status (the status CHECK passes NULL; the rule must not).
--   under_review, needs_changes, resubmitted, approved, rejected, NULL  -> RLS
-- Wrong implementations this catches: no status term (m01), 'resubmitted'
-- admitted (m02), a deny-list of only approved/rejected (m04), the reviewer
-- terms ORed instead of ANDed (m08), the rule added beside the old one (m11).
DO $c02$
DECLARE
  agent uuid := pg_temp.id('u_t1_agent');
  o_t1  uuid := pg_temp.id('o_t1');
  s text;
  i int := 0;
BEGIN
  PERFORM pg_temp.act_as(agent);
  FOREACH s IN ARRAY ARRAY['''under_review''', '''needs_changes''', '''resubmitted''', '''approved''', '''rejected''', 'NULL'] LOOP
    i := i + 1;
    PERFORM pg_temp.expect('C02 status ' || s,
      pg_temp.desk(('00000000-0000-4000-8000-0000354702' || lpad(i::text, 2, '0'))::uuid, o_t1, agent,
                   'fixture-3547-c02-' || i, s), 'RLS');
  END LOOP;
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.check((SELECT count(*) FROM public.transaction_submissions WHERE local_transaction_id LIKE 'fixture-3547-c02-%') = 0,
                        'C02 no refused row stored');
  PERFORM pg_temp.check(i = 6, 'C02 six statuses tried');
END
$c02$;
