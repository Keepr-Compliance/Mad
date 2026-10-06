-- C17 (SR C-2): the parent must be the same organization, deal and
-- submitter, one version back. Otherwise the carry refuses (42501) and the
-- whole snapshot rolls back: nothing is carried from a colleague's review.
--   another agent pointing at this agent's reviewed v1
--   this agent skipping a version (v3 -> v1)
--   this agent, another deal id, pointing at v1
--   control: the right v2 carries
DO $c17$
DECLARE
  agent  uuid := pg_temp.id('u_t1_agent');
  agent2 uuid := pg_temp.id('u_t1_agent2');
  v1     uuid := pg_temp.build_v1('fixture-3596-c17');
  s      uuid;
  r      record;
  res    jsonb;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('another submitter', 2, agent2, 'fixture-3596-c17'),
      ('a skipped version', 3, agent,  'fixture-3596-c17'),
      ('another deal',      2, agent,  'fixture-3596-c17-other')) v(label, ver, who, txn) LOOP
    s := pg_temp.new_version(v1, r.ver, NULL, r.who, r.txn);
    PERFORM pg_temp.act_as(r.who);
    PERFORM pg_temp.expect('C17 ' || r.label, format('SELECT public.snapshot_submission_checklists(%L, %L::jsonb)', s, pg_temp.base_payload()),
                           '~^42501:not_authorized$');
    PERFORM pg_temp.act_owner();
    PERFORM pg_temp.check((SELECT count(*) FROM public.submission_checklist_items WHERE submission_id = s) = 0
                          AND pg_temp.tick_state(s) = '' AND jsonb_array_length(pg_temp.hist(s)) = 0,
                          'C17 ' || r.label || ': nothing written');
  END LOOP;
  s := pg_temp.new_version(v1, 2);
  res := pg_temp.snap_as(agent, s, pg_temp.base_payload());
  PERFORM pg_temp.check((res -> 'carry' ->> 'carried')::int = 5, 'C17 the right parent carries: ' || res::text);
END
$c17$;
