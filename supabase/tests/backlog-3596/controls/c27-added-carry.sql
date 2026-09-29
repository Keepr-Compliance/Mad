-- C27: a tick on an added item carries to the next version when the desktop
-- sends that item keyed on its cloud id (the pull), with the ORIGINAL broker
-- and time. An unmatched ticked added item (here: renamed on v2, so the title
-- term fails) gets exactly one checklist_review_cleared entry with reason
-- 'not_carried'; an unmatched agent item on the same version keeps
-- 'removed'. A second carry writes nothing.
DO $c27$
DECLARE
  agent  uuid := pg_temp.id('u_t1_agent');
  broker uuid := pg_temp.id('u_t1_broker');
  admin  uuid := pg_temp.id('u_t1_admin');
  tpl    uuid := pg_temp.id('tpl_t1_a');
  v1 uuid; v2 uuid; hdr uuid; a1 uuid; a2 uuid; i6 uuid; p2 jsonb; res jsonb; e jsonb; n integer;
BEGIN
  v1  := pg_temp.added_v1('fixture-3596-c27');
  hdr := pg_temp.add_as(broker, v1, tpl);
  SELECT id INTO a1 FROM public.submission_checklist_items WHERE submission_checklist_id = hdr ORDER BY sort_order, title LIMIT 1;
  SELECT id INTO a2 FROM public.submission_checklist_items WHERE submission_checklist_id = hdr ORDER BY sort_order, title OFFSET 1 LIMIT 1;
  i6 := pg_temp.item(v1, 'L-item-6');
  PERFORM pg_temp.check((pg_temp.tick_as(broker, a1, true) ->> 'changed')::boolean, 'C27 broker ticks A1');
  PERFORM pg_temp.check((pg_temp.tick_as(broker, a2, true) ->> 'changed')::boolean, 'C27 broker ticks A2');
  PERFORM pg_temp.check((pg_temp.tick_as(admin, i6, true) ->> 'changed')::boolean, 'C27 admin ticks the agent item I6');
  UPDATE public.submission_checklist_items SET reviewer_checked_at = '2026-09-01 11:01:00+00' WHERE id = a1;
  UPDATE public.submission_checklist_items SET reviewer_checked_at = '2026-09-01 11:02:00+00' WHERE id = a2;
  UPDATE public.submission_checklist_items SET reviewer_checked_at = '2026-09-01 11:06:00+00' WHERE id = i6;
  PERFORM pg_temp.set_status(v1, 'needs_changes');

  -- v2: the agent drops I6 from its own checklist, keeps A1 as pulled, and
  -- renames A2.
  v2 := pg_temp.new_version(v1, 2);
  p2 := pg_temp.item_drop(pg_temp.pb(), 'L-item-6') || pg_temp.pulled(hdr);
  p2 := pg_temp.item_set(p2, a2::text, 'title', to_jsonb('Renamed on v2'::text));
  res := pg_temp.snap_as(agent, v2, p2);
  PERFORM pg_temp.check((res -> 'carry' ->> 'carried')::int = 1 AND (res -> 'carry' ->> 'cleared')::int = 0
                        AND (res -> 'carry' ->> 'removed')::int = 2, 'C27 v2 carry: ' || (res -> 'carry')::text);
  PERFORM pg_temp.check(pg_temp.tick_state(v2) = a1::text || ':broker:2026-09-01 11:01',
                        'C27 A1 carried with the original broker and time; nothing else ticked: ' || replace(pg_temp.tick_state(v2), a1::text, 'A1'));
  PERFORM pg_temp.check((SELECT NOT reviewer_checked AND cleared_reviewer_id IS NULL
                           FROM public.submission_checklist_items WHERE submission_id = v2 AND local_item_id = a2::text),
                        'C27 renamed A2 on v2: unticked, no cleared marker');

  PERFORM pg_temp.check(jsonb_array_length(pg_temp.typed(v2, 'checklist_review_cleared')) = 2,
                        'C27 two cleared entries: ' || jsonb_array_length(pg_temp.typed(v2, 'checklist_review_cleared')));
  SELECT x.e INTO e FROM jsonb_array_elements(pg_temp.typed(v2, 'checklist_review_cleared')) AS x(e)
   WHERE x.e ->> 'cleared_from_item_id' = a2::text;
  PERFORM pg_temp.check(e ->> 'reason' = 'not_carried' AND e -> 'item_id' = 'null'::jsonb
                        AND (e ->> 'cleared_reviewer_id')::uuid = broker AND (e ->> 'changed_by')::uuid = agent
                        AND (e ->> 'cleared_reviewer_checked_at')::timestamptz = '2026-09-01 11:02:00+00',
                        'C27 A2 entry: not_carried, names the broker and time: ' || COALESCE(e ->> 'reason', 'missing'));
  SELECT x.e INTO e FROM jsonb_array_elements(pg_temp.typed(v2, 'checklist_review_cleared')) AS x(e)
   WHERE x.e ->> 'cleared_from_item_id' = i6::text;
  PERFORM pg_temp.check(e ->> 'reason' = 'removed' AND (e ->> 'cleared_reviewer_id')::uuid = admin,
                        'C27 agent item I6 entry keeps reason removed: ' || COALESCE(e ->> 'reason', 'missing'));

  -- A second carry adds nothing.
  n := jsonb_array_length(pg_temp.hist(v2));
  PERFORM pg_temp.act_as(agent);
  res := public.carry_submission_checklist_reviews(v2);
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.check((res ->> 'carried')::int = 0 AND (res ->> 'removed')::int = 0 AND (res ->> 'cleared')::int = 0,
                        'C27 second carry: ' || res::text);
  PERFORM pg_temp.check(jsonb_array_length(pg_temp.hist(v2)) = n, 'C27 second carry wrote no history');
  PERFORM pg_temp.check(pg_temp.tick_state(v2) = a1::text || ':broker:2026-09-01 11:01', 'C27 second carry left the ticks alone');
END
$c27$;
