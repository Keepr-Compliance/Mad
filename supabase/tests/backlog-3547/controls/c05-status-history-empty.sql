-- C05: status_history stays covered by the BACKLOG-3477 trigger, which this
-- migration does not duplicate: a submitter insert that satisfies the new rule
-- ('uploading', no reviewer fields) but carries a history entry is refused by
-- the trigger (42501 status_history_append_only), not by RLS.
DO $c05$
DECLARE
  agent  uuid := pg_temp.id('u_t1_agent');
  broker uuid := pg_temp.id('u_t1_broker');
  o_t1   uuid := pg_temp.id('o_t1');
BEGIN
  PERFORM pg_temp.act_as(agent);
  PERFORM pg_temp.expect('C05 typed entry naming the broker',
    pg_temp.desk('00000000-0000-4000-8000-000035470501', o_t1, agent, 'fixture-3547-c05-1', '''uploading''', -- pii-allow-uuid: invented fixture id
                 ', status_history',
                 format(', jsonb_build_array(jsonb_build_object(''type'', ''checklist_review'', ''changed_at'', now(), ''changed_by'', %L::uuid))', broker)),
    '~^42501:status_history_append_only$');
  PERFORM pg_temp.expect('C05 untyped approved entry',
    pg_temp.desk('00000000-0000-4000-8000-000035470502', o_t1, agent, 'fixture-3547-c05-2', '''uploading''', -- pii-allow-uuid: invented fixture id
                 ', status_history', ', jsonb_build_array(jsonb_build_object(''status'', ''approved'', ''changed_at'', now()))'),
    '~^42501:status_history_append_only$');
  PERFORM pg_temp.expect('C05 empty history passes',
    pg_temp.desk('00000000-0000-4000-8000-000035470503', o_t1, agent, 'fixture-3547-c05-3', '''uploading''', -- pii-allow-uuid: invented fixture id
                 ', status_history', ', ''[]''::jsonb'), 'rows:1');
  PERFORM pg_temp.act_owner();
END
$c05$;
