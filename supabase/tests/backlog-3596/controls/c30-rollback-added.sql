-- harness: rollback-added
-- C30: rollback-added.sql restores the catalogue exactly as the refusals file
-- left it. run.sh snapshots after the refusals file (t3596_a0), applies the
-- added-ticks file, snapshots again (t3596_a1), runs rollback-added.sql.
-- Then, on the restored bodies: a tick on an added item is refused
-- ('added_at_review') and writes nothing, and a tick already on an added
-- item (made before the rollback; set here by the owner, since the restored
-- tick refuses it) no longer carries and leaves no entry.
DO $c30$
DECLARE
  agent  uuid := pg_temp.id('u_t1_agent');
  broker uuid := pg_temp.id('u_t1_broker');
  a bigint; b bigint; d bigint;
  v1 uuid; v2 uuid; hdr uuid; x1 uuid; x2 uuid; n integer; res jsonb;
BEGIN
  SELECT count(*) INTO d FROM (SELECT * FROM t3596_a1 EXCEPT SELECT * FROM t3596_a0) x;
  PERFORM pg_temp.check(d = 2, 'C30 the added-ticks file changed exactly two catalogue rows: ' || d);
  SELECT count(*) INTO a FROM (SELECT * FROM t3596_a0 EXCEPT SELECT * FROM pg_temp.snap3596()) x;
  SELECT count(*) INTO b FROM (SELECT * FROM pg_temp.snap3596() EXCEPT SELECT * FROM t3596_a0) x;
  PERFORM pg_temp.check(a = 0 AND b = 0, format('C30 rollback-added restores everything: only-before %s, only-after %s', a, b));

  v1  := pg_temp.added_v1('fixture-3596-c30');
  hdr := pg_temp.add_as(broker, v1, pg_temp.id('tpl_t1_a'));
  SELECT id INTO x1 FROM public.submission_checklist_items WHERE submission_checklist_id = hdr ORDER BY sort_order, title LIMIT 1;
  SELECT id INTO x2 FROM public.submission_checklist_items WHERE submission_checklist_id = hdr ORDER BY sort_order, title OFFSET 1 LIMIT 1;
  n := jsonb_array_length(pg_temp.hist(v1));
  PERFORM pg_temp.act_as(broker);
  PERFORM pg_temp.expect('C30 restored tick refuses an added item',
                         format('SELECT public.set_submission_checklist_reviewer_check(%L, true)', x2), '~^42501:added_at_review$');
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.check(NOT (SELECT reviewer_checked FROM public.submission_checklist_items WHERE id = x2)
                        AND jsonb_array_length(pg_temp.hist(v1)) = n, 'C30 the refused tick wrote nothing');

  UPDATE public.submission_checklist_items
     SET reviewer_checked = true, reviewer_checked_by = broker, reviewer_checked_at = '2026-09-01 11:01:00+00'
   WHERE id = x1;
  PERFORM pg_temp.set_status(v1, 'needs_changes');
  v2  := pg_temp.new_version(v1, 2);
  res := pg_temp.snap_as(agent, v2, pg_temp.pb() || pg_temp.pulled(hdr));
  PERFORM pg_temp.check((res -> 'carry' ->> 'carried')::int = 0 AND (res -> 'carry' ->> 'removed')::int = 0
                        AND (res -> 'carry' ->> 'cleared')::int = 0, 'C30 restored carry ignores added items: ' || (res -> 'carry')::text);
  PERFORM pg_temp.check(pg_temp.tick_state(v2) = '' AND jsonb_array_length(pg_temp.typed(v2, 'checklist_review_cleared')) = 0,
                        'C30 restored carry: nothing ticked, no entry');
END
$c30$;
