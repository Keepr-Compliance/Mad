-- C31 (SR C-4): added items across a chain.
--   A: v1 added X1, X2 ticked -> v2 keyed on the cloud ids (pulled) carries
--      both -> the broker re-ticks nothing -> v3 (same local ids, ordinary
--      local_item_id path: v2's header is the agent's, not added) carries
--      both again with the v1 broker and time.
--   B: v1 added X ticked -> v2 WITHOUT the added checklist (never pulled) ->
--      exactly one 'not_carried' entry naming the v1 item; a second carry
--      adds nothing -> v3 carries nothing and writes no entry.
DO $c31$
DECLARE
  agent  uuid := pg_temp.id('u_t1_agent');
  broker uuid := pg_temp.id('u_t1_broker');
  tpl    uuid := pg_temp.id('tpl_t1_a');
  v1 uuid; v2 uuid; v3 uuid; hdr uuid; x1 uuid; x2 uuid; p2 jsonb; res jsonb; want text;
  w1 uuid; w2 uuid; w3 uuid; whdr uuid; wx uuid; n integer;
BEGIN
  v1  := pg_temp.added_v1('fixture-3596-c31');
  hdr := pg_temp.add_as(broker, v1, tpl);
  SELECT id INTO x1 FROM public.submission_checklist_items WHERE submission_checklist_id = hdr ORDER BY sort_order, title LIMIT 1;
  SELECT id INTO x2 FROM public.submission_checklist_items WHERE submission_checklist_id = hdr ORDER BY sort_order, title OFFSET 1 LIMIT 1;
  PERFORM pg_temp.tick_as(broker, x1, true);
  PERFORM pg_temp.tick_as(broker, x2, true);
  UPDATE public.submission_checklist_items SET reviewer_checked_at = '2026-09-01 11:01:00+00' WHERE id = x1;
  UPDATE public.submission_checklist_items SET reviewer_checked_at = '2026-09-01 11:02:00+00' WHERE id = x2;
  PERFORM pg_temp.set_status(v1, 'needs_changes');
  want := (SELECT string_agg(k, ',' ORDER BY k) FROM (VALUES (x1::text || ':broker:2026-09-01 11:01'),
                                                             (x2::text || ':broker:2026-09-01 11:02')) v(k));

  v2 := pg_temp.new_version(v1, 2);
  p2 := pg_temp.pb() || pg_temp.pulled(hdr);
  res := pg_temp.snap_as(agent, v2, p2);
  PERFORM pg_temp.check((res -> 'carry' ->> 'carried')::int = 2 AND (res -> 'carry' ->> 'removed')::int = 0,
                        'C31 v2 carry: ' || (res -> 'carry')::text);
  PERFORM pg_temp.check(pg_temp.tick_state(v2) = want, 'C31 v2 ticks = v1 broker and times');
  PERFORM pg_temp.check((SELECT added_at_review_by IS NULL FROM public.submission_checklists
                          WHERE submission_id = v2 AND template_id = tpl), 'C31 v2 header is the agent''s (not added)');
  PERFORM pg_temp.set_status(v2, 'needs_changes');

  v3  := pg_temp.new_version(v2, 3);
  res := pg_temp.snap_as(agent, v3, p2);
  PERFORM pg_temp.check((res -> 'carry' ->> 'carried')::int = 2 AND (res -> 'carry' ->> 'removed')::int = 0
                        AND (res -> 'carry' ->> 'cleared')::int = 0, 'C31 v3 carry: ' || (res -> 'carry')::text);
  PERFORM pg_temp.check(pg_temp.tick_state(v3) = want, 'C31 v3 keeps the v1 broker and times');

  -- B: never pulled.
  w1   := pg_temp.added_v1('fixture-3596-c31b');
  whdr := pg_temp.add_as(broker, w1, tpl);
  SELECT id INTO wx FROM public.submission_checklist_items WHERE submission_checklist_id = whdr ORDER BY sort_order, title LIMIT 1;
  PERFORM pg_temp.tick_as(broker, wx, true);
  PERFORM pg_temp.set_status(w1, 'needs_changes');
  w2  := pg_temp.new_version(w1, 2);
  res := pg_temp.snap_as(agent, w2, pg_temp.pb());
  PERFORM pg_temp.check((res -> 'carry' ->> 'removed')::int = 1 AND (res -> 'carry' ->> 'carried')::int = 0,
                        'C31 never pulled: v2 carry ' || (res -> 'carry')::text);
  PERFORM pg_temp.act_as(agent);
  PERFORM public.carry_submission_checklist_reviews(w2);
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.check(jsonb_array_length(pg_temp.typed(w2, 'checklist_review_cleared')) = 1
                        AND pg_temp.typed(w2, 'checklist_review_cleared') -> 0 ->> 'reason' = 'not_carried'
                        AND pg_temp.typed(w2, 'checklist_review_cleared') -> 0 ->> 'cleared_from_item_id' = wx::text,
                        'C31 never pulled: exactly one not_carried entry naming the v1 item, after a second carry');
  PERFORM pg_temp.set_status(w2, 'needs_changes');
  w3  := pg_temp.new_version(w2, 3);
  n   := 0;
  res := pg_temp.snap_as(agent, w3, pg_temp.pb());
  PERFORM pg_temp.check((res -> 'carry' ->> 'carried')::int = 0 AND (res -> 'carry' ->> 'removed')::int = 0
                        AND (res -> 'carry' ->> 'cleared')::int = 0, 'C31 never pulled: v3 carry ' || (res -> 'carry')::text);
  PERFORM pg_temp.check(pg_temp.tick_state(w3) = '' AND jsonb_array_length(pg_temp.typed(w3, 'checklist_review_cleared')) = 0,
                        'C31 never pulled: v3 nothing ticked, no entry');
END
$c31$;
