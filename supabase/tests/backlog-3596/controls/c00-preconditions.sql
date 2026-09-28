-- C00: the fixture deal is what the other controls assume.
--   version 1 built through the real snapshot and tick RPCs: 2 checklists,
--   6 items each with its own local_item_id, 5 reviewer ticks with the
--   backdated times, status needs_changes; its snapshot returned
--   carry.status 'no_parent'; its links point at uploads carrying the local
--   ids (L-att-1 at two uploads).
DO $c00$
DECLARE
  v1  uuid := pg_temp.build_v1('fixture-3596-c00');
  res jsonb;
BEGIN
  PERFORM pg_temp.check(current_setting('t3473.tpl_t1_a') <> '', 'C00 template A id published');
  PERFORM pg_temp.check((SELECT count(*) FROM public.submission_checklists WHERE submission_id = v1) = 2, 'C00 two checklists');
  PERFORM pg_temp.check((SELECT count(*) FROM public.submission_checklist_items WHERE submission_id = v1 AND local_item_id IS NOT NULL) = 6,
                        'C00 six items with local ids');
  PERFORM pg_temp.check(pg_temp.tick_state(v1) = pg_temp.base_ticks(), 'C00 ticks: ' || pg_temp.tick_state(v1));
  PERFORM pg_temp.check((SELECT status FROM public.transaction_submissions WHERE id = v1) = 'needs_changes', 'C00 v1 needs_changes');
  PERFORM pg_temp.check((SELECT count(*) FROM public.submission_checklist_link_members lm
                           JOIN public.submission_attachments a ON a.id = lm.submission_attachment_id
                          WHERE lm.submission_id = v1 AND a.local_attachment_id = 'L-att-1') = 2,
                        'C00 L-att-1 is linked at two uploads');
  PERFORM pg_temp.check(jsonb_array_length(pg_temp.typed(v1, 'checklist_review')) = 5, 'C00 five tick entries');

  -- a version-1 snapshot returns the carry's no_parent, and writes nothing more
  PERFORM pg_temp.act_owner();
  res := pg_temp.snap_as(pg_temp.id('u_t1_agent'),
                         pg_temp.mk_sub('fixture-3596-c00b', 1, NULL, 'uploading'), '[]'::jsonb);
  PERFORM pg_temp.check(res -> 'carry' ->> 'status' = 'no_parent', 'C00 v1 snapshot carry: ' || res::text);
END
$c00$;
