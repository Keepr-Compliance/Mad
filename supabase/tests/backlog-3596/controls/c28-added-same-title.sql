-- C28: two items with the SAME title in one added checklist, only the second
-- ticked. The tick lands on the v2 item keyed on that item's cloud id, not
-- on the other one: the match is the id, not the title.
-- The template is inserted by the owner (template authoring is not under
-- test; checklist_template_items has no uniqueness on (template_id, title)).
DO $c28$
DECLARE
  agent  uuid := pg_temp.id('u_t1_agent');
  broker uuid := pg_temp.id('u_t1_broker');
  org    uuid;
  tpl    uuid;
  v1 uuid; v2 uuid; hdr uuid; s1 uuid; s2 uuid; res jsonb;
BEGIN
  SELECT organization_id INTO org FROM public.checklist_templates WHERE id = pg_temp.id('tpl_t1_a');
  INSERT INTO public.checklist_templates (organization_id, name, created_by)
  VALUES (org, 'Fixture duplicate titles', NULL) RETURNING id INTO tpl;
  INSERT INTO public.checklist_template_items (template_id, title, sort_order)
  VALUES (tpl, 'Same title', 0), (tpl, 'Same title', 1);

  v1  := pg_temp.added_v1('fixture-3596-c28');
  hdr := pg_temp.add_as(broker, v1, tpl);
  SELECT id INTO s1 FROM public.submission_checklist_items WHERE submission_checklist_id = hdr AND sort_order = 0;
  SELECT id INTO s2 FROM public.submission_checklist_items WHERE submission_checklist_id = hdr AND sort_order = 1;
  PERFORM pg_temp.check(s1 IS NOT NULL AND s2 IS NOT NULL AND s1 <> s2, 'C28 two same-title items added');
  PERFORM pg_temp.check((pg_temp.tick_as(broker, s2, true) ->> 'changed')::boolean, 'C28 broker ticks the second one only');
  UPDATE public.submission_checklist_items SET reviewer_checked_at = '2026-09-01 12:00:00+00' WHERE id = s2;
  PERFORM pg_temp.set_status(v1, 'needs_changes');

  v2  := pg_temp.new_version(v1, 2);
  res := pg_temp.snap_as(agent, v2, pg_temp.pb() || pg_temp.pulled(hdr));
  PERFORM pg_temp.check((res -> 'carry' ->> 'carried')::int = 1 AND (res -> 'carry' ->> 'removed')::int = 0
                        AND (res -> 'carry' ->> 'cleared')::int = 0, 'C28 v2 carry: ' || (res -> 'carry')::text);
  PERFORM pg_temp.check((SELECT reviewer_checked AND reviewer_checked_by = broker AND reviewer_checked_at = '2026-09-01 12:00:00+00'
                           FROM public.submission_checklist_items WHERE submission_id = v2 AND local_item_id = s2::text),
                        'C28 the tick lands on the v2 copy of the ticked item');
  PERFORM pg_temp.check((SELECT NOT reviewer_checked AND cleared_reviewer_id IS NULL
                           FROM public.submission_checklist_items WHERE submission_id = v2 AND local_item_id = s1::text),
                        'C28 the same-title sibling stays unticked and unmarked');
  PERFORM pg_temp.check(jsonb_array_length(pg_temp.typed(v2, 'checklist_review_cleared')) = 0, 'C28 no cleared entry');
END
$c28$;
