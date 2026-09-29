-- BACKLOG-3607 copy: feature off + no checklist copy -> quiet {status: not_in_plan} (plan rev 2 §1, P07).
-- C05 (plan C5): the carry, called directly, refuses everyone but the
-- submitter of an uploading version in an organization with the feature,
-- and writes nothing when it refuses.
--   another agent, the broker, no JWT -> 42501 not_authorized; anon -> no
--   EXECUTE; the parent (needs_changes) and a finalized version -> 42501;
--   feature off (T2) -> 42501
--   a version with no parent -> {status: no_parent}, nothing written
--   (DEVIATION from the plan's 42501: the snapshot calls the carry for every
--   version, version 1 included)
DO $c05$
DECLARE
  agent uuid := pg_temp.id('u_t1_agent');
  v1    uuid := pg_temp.build_v1('fixture-3596-c05');
  v2    uuid := pg_temp.new_version(v1, 2);
  q     text;
  h0    jsonb;
  t0    text;
  t2p   uuid;
  t2v   uuid;
  np    uuid;
  res   jsonb;
BEGIN
  PERFORM pg_temp.snap_as(agent, v2, pg_temp.item_set(pg_temp.base_payload(), 'L-item-1', 'note', to_jsonb('x'::text)));
  h0 := pg_temp.hist(v2); t0 := pg_temp.tick_state(v2);
  q := format('SELECT public.carry_submission_checklist_reviews(%L)', v2);

  PERFORM pg_temp.act_as(pg_temp.id('u_t1_agent2'));
  PERFORM pg_temp.expect('C05 another agent', q, '~^42501:not_authorized$');
  PERFORM pg_temp.act_as(pg_temp.id('u_t1_broker'));
  PERFORM pg_temp.expect('C05 the broker', q, '~^42501:not_authorized$');
  PERFORM pg_temp.act_anon();
  PERFORM pg_temp.expect('C05 anon', q, 'PRIV');
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.expect('C05 no JWT', q, '~^42501:not_authorized$');
  PERFORM pg_temp.act_as(agent);
  PERFORM pg_temp.expect('C05 the parent (needs_changes)', format('SELECT public.carry_submission_checklist_reviews(%L)', v1), '~^42501:not_authorized$');
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.set_status(v2, 'resubmitted');
  PERFORM pg_temp.act_as(agent);
  PERFORM pg_temp.expect('C05 finalized version', q, '~^42501:not_authorized$');
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.check(jsonb_array_length(pg_temp.hist(v2)) = jsonb_array_length(h0) + 1
                        AND pg_temp.hist(v2) -> -1 ->> 'status' = 'resubmitted'
                        AND pg_temp.tick_state(v2) = t0, 'C05 refusals wrote nothing');

  -- feature off
  t2p := pg_temp.mk_sub('fixture-3596-c05-t2', 1, NULL, 'needs_changes', pg_temp.id('u_t2_agent'), pg_temp.id('o_t2'));
  t2v := pg_temp.mk_sub('fixture-3596-c05-t2', 2, t2p, 'uploading', pg_temp.id('u_t2_agent'), pg_temp.id('o_t2'));
  PERFORM pg_temp.act_as(pg_temp.id('u_t2_agent'));
  PERFORM pg_temp.expect('C05 feature off, no copy -> quiet', format('SELECT public.carry_submission_checklist_reviews(%L)', t2v), 'rows:1');
  PERFORM pg_temp.act_owner();

  -- no parent
  np := pg_temp.mk_sub('fixture-3596-c05-np', 1, NULL, 'uploading');
  PERFORM pg_temp.act_as(agent);
  res := public.carry_submission_checklist_reviews(np);
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.check(res = '{"status": "no_parent"}'::jsonb AND jsonb_array_length(pg_temp.hist(np)) = 0,
                        'C05 no parent: ' || res::text);
END
$c05$;
