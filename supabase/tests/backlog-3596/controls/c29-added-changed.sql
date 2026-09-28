-- C29 (SR C-2, PM ruling): an added item the broker ticked on v1, which the
-- agent then changes on v2, is CLEARED with the reviewer marker ("Changed
-- since you checked") and one 'edited' entry -- the same rule as every item.
--   X1: v2 attaches evidence           -> cleared, marked, 'edited'
--   X2: v2 writes a note               -> cleared, marked, 'edited'
--   (second deal) X: v2 unchanged      -> carried with the original broker/time
DO $c29$
DECLARE
  agent  uuid := pg_temp.id('u_t1_agent');
  broker uuid := pg_temp.id('u_t1_broker');
  tpl    uuid := pg_temp.id('tpl_t1_a');
  v1 uuid; v2 uuid; hdr uuid; x1 uuid; x2 uuid; p2 jsonb; res jsonb; e jsonb;
  w1 uuid; w2 uuid; whdr uuid; wx uuid;
BEGIN
  v1  := pg_temp.added_v1('fixture-3596-c29');
  hdr := pg_temp.add_as(broker, v1, tpl);
  SELECT id INTO x1 FROM public.submission_checklist_items WHERE submission_checklist_id = hdr ORDER BY sort_order, title LIMIT 1;
  SELECT id INTO x2 FROM public.submission_checklist_items WHERE submission_checklist_id = hdr ORDER BY sort_order, title OFFSET 1 LIMIT 1;
  PERFORM pg_temp.tick_as(broker, x1, true);
  PERFORM pg_temp.tick_as(broker, x2, true);
  UPDATE public.submission_checklist_items SET reviewer_checked_at = '2026-09-01 11:01:00+00' WHERE id = x1;
  UPDATE public.submission_checklist_items SET reviewer_checked_at = '2026-09-01 11:02:00+00' WHERE id = x2;
  PERFORM pg_temp.set_status(v1, 'needs_changes');

  v2 := pg_temp.new_version(v1, 2);
  p2 := pg_temp.pb() || pg_temp.pulled(hdr);
  p2 := pg_temp.item_set(p2, x1::text, 'links',
          jsonb_build_array(jsonb_build_object('kind', 'attachment', 'label', 'Doc 1', 'local_ids', jsonb_build_array('L-att-1'))));
  p2 := pg_temp.item_set(p2, x2::text, 'note', to_jsonb('Added by the agent on v2'::text));
  res := pg_temp.snap_as(agent, v2, p2);
  PERFORM pg_temp.check((res -> 'carry' ->> 'carried')::int = 0 AND (res -> 'carry' ->> 'cleared')::int = 2
                        AND (res -> 'carry' ->> 'removed')::int = 0, 'C29 v2 carry: ' || (res -> 'carry')::text);
  PERFORM pg_temp.check((SELECT NOT reviewer_checked AND reviewer_checked_by IS NULL AND cleared_reviewer_id = broker AND cleared_at IS NOT NULL
                           FROM public.submission_checklist_items WHERE submission_id = v2 AND local_item_id = x1::text),
                        'C29 X1 (evidence attached on v2): unticked and marked');
  PERFORM pg_temp.check((SELECT NOT reviewer_checked AND reviewer_checked_by IS NULL AND cleared_reviewer_id = broker AND cleared_at IS NOT NULL
                           FROM public.submission_checklist_items WHERE submission_id = v2 AND local_item_id = x2::text),
                        'C29 X2 (note written on v2): unticked and marked');
  PERFORM pg_temp.check(jsonb_array_length(pg_temp.typed(v2, 'checklist_review_cleared')) = 2, 'C29 two cleared entries');
  FOR e IN SELECT x.e FROM jsonb_array_elements(pg_temp.typed(v2, 'checklist_review_cleared')) AS x(e) LOOP
    PERFORM pg_temp.check(e ->> 'reason' = 'edited' AND (e ->> 'cleared_reviewer_id')::uuid = broker
                          AND e ->> 'cleared_from_item_id' IN (x1::text, x2::text)
                          AND e ->> 'item_id' = (SELECT id::text FROM public.submission_checklist_items
                                                  WHERE submission_id = v2 AND local_item_id = e ->> 'cleared_from_item_id'),
                          'C29 entry reason edited, names the broker and the v2 item: ' || (e ->> 'reason'));
  END LOOP;

  -- Unchanged on v2 -> carried.
  w1   := pg_temp.added_v1('fixture-3596-c29b');
  whdr := pg_temp.add_as(broker, w1, tpl);
  SELECT id INTO wx FROM public.submission_checklist_items WHERE submission_checklist_id = whdr ORDER BY sort_order, title LIMIT 1;
  PERFORM pg_temp.tick_as(broker, wx, true);
  UPDATE public.submission_checklist_items SET reviewer_checked_at = '2026-09-01 11:05:00+00' WHERE id = wx;
  PERFORM pg_temp.set_status(w1, 'needs_changes');
  w2  := pg_temp.new_version(w1, 2);
  res := pg_temp.snap_as(agent, w2, pg_temp.pb() || pg_temp.pulled(whdr));
  PERFORM pg_temp.check((res -> 'carry' ->> 'carried')::int = 1 AND (res -> 'carry' ->> 'cleared')::int = 0
                        AND (res -> 'carry' ->> 'removed')::int = 0, 'C29 unchanged: carry ' || (res -> 'carry')::text);
  PERFORM pg_temp.check((SELECT reviewer_checked AND reviewer_checked_by = broker AND reviewer_checked_at = '2026-09-01 11:05:00+00'
                                AND cleared_reviewer_id IS NULL
                           FROM public.submission_checklist_items WHERE submission_id = w2 AND local_item_id = wx::text),
                        'C29 unchanged added item carried with the original broker and time');
  PERFORM pg_temp.check(jsonb_array_length(pg_temp.typed(w2, 'checklist_review_cleared')) = 0, 'C29 unchanged: no entry');
END
$c29$;
