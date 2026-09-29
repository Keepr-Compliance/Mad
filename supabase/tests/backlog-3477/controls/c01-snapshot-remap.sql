-- C01 (A-C1): the snapshot writes every checklist of a submission and maps
-- the desktop's local ids to this submission's rows.
-- As u_t1_agent on S_up (uploading, T1 holds the feature), one call with:
--   checklist 1 (template A), item A1 with three links:
--     attachment [local-a, local-missing] -> A1 and A2 (both carry local-a);
--                                            local-missing dropped
--     email [m1, m3]                      -> M1; M3 is sms, dropped
--     attachment [local-none]             -> no member left: link not written
--   item A2, no links
--   checklist 2 (no template), one item, attachment [local-b] -> A6
-- Returns checklists 2, items 3, links 3, members 4, dropped_members 3,
-- dropped_links 1; the owner then reads exactly those rows.
-- Wrong implementations this catches: one member per link (first match
-- only); writing a link with no member; passing reviewer values through.
DO $c01$
DECLARE
  res jsonb;
  s   uuid := pg_temp.id('s_up');
  payload jsonb := jsonb_build_array(
    jsonb_build_object('template_id', pg_temp.id('tpl_t1_a'), 'template_name', 'Fixture starter A', 'sort_order', 0,
      'items', jsonb_build_array(
        jsonb_build_object('title', 'Fixture item A1', 'description', 'c01 description', 'is_required', true,
          'expected_document_type', 'contract', 'is_checked', true, 'note', 'c01 note', 'sort_order', 10,
          'links', jsonb_build_array(
            jsonb_build_object('kind', 'attachment', 'label', 'fixture-a.pdf', 'sort_order', 10,
                               'local_ids', jsonb_build_array('fixture-3477-local-a', 'fixture-3477-local-missing')),
            jsonb_build_object('kind', 'email', 'label', 'Fixture thread', 'sort_order', 20,
                               'local_ids', jsonb_build_array('fixture-3473-m1', 'fixture-3473-m3')),
            jsonb_build_object('kind', 'attachment', 'label', 'never uploaded', 'sort_order', 30,
                               'local_ids', jsonb_build_array('fixture-3477-local-none')))),
        jsonb_build_object('title', 'Fixture item A2', 'is_required', false, 'sort_order', 20))),
    jsonb_build_object('template_name', 'Manual list', 'sort_order', 1,
      'items', jsonb_build_array(
        jsonb_build_object('title', 'Only item', 'is_required', true,
          'links', jsonb_build_array(jsonb_build_object('kind', 'attachment', 'label', 'fixture-a6.pdf',
                                                        'local_ids', jsonb_build_array('fixture-3477-local-b')))))));
  v_h1 uuid;
  v_i1 uuid;
BEGIN
  PERFORM pg_temp.act_as(pg_temp.id('u_t1_agent'));
  res := public.snapshot_submission_checklists(s, payload);
  PERFORM pg_temp.act_owner();

  PERFORM pg_temp.check(res = '{"checklists": 2, "items": 3, "links": 3, "members": 4, "dropped_members": 3, "dropped_links": 1}'::jsonb,
                        'C01 counts: got ' || res::text);

  -- Rows written (the fixture already holds header H_up with item I_up on S_up).
  PERFORM pg_temp.check((SELECT count(*) FROM public.submission_checklists WHERE submission_id = s) = 3, 'C01 3 headers on S_up');
  PERFORM pg_temp.check((SELECT count(*) FROM public.submission_checklist_items WHERE submission_id = s) = 4, 'C01 4 items on S_up');
  PERFORM pg_temp.check((SELECT count(*) FROM public.submission_checklist_links WHERE submission_id = s) = 3, 'C01 3 links on S_up');
  PERFORM pg_temp.check((SELECT count(*) FROM public.submission_checklist_link_members WHERE submission_id = s) = 4, 'C01 4 members on S_up');

  SELECT id INTO v_h1 FROM public.submission_checklists WHERE submission_id = s AND template_id = pg_temp.id('tpl_t1_a');
  PERFORM pg_temp.check(v_h1 IS NOT NULL, 'C01 header carries template_id');
  SELECT id INTO v_i1 FROM public.submission_checklist_items WHERE submission_checklist_id = v_h1 AND title = 'Fixture item A1';
  PERFORM pg_temp.check((SELECT description = 'c01 description' AND expected_document_type = 'contract' AND is_required
                                AND is_checked AND note = 'c01 note' AND sort_order = 10
                                AND NOT reviewer_checked AND reviewer_checked_by IS NULL AND reviewer_checked_at IS NULL
                           FROM public.submission_checklist_items WHERE id = v_i1),
                        'C01 item fields copied; reviewer layer empty');

  PERFORM pg_temp.check((SELECT array_agg(m.submission_attachment_id ORDER BY m.submission_attachment_id)
                           FROM public.submission_checklist_link_members m
                           JOIN public.submission_checklist_links l ON l.id = m.link_id
                          WHERE l.submission_checklist_item_id = v_i1 AND l.kind = 'attachment')
                        = (SELECT array_agg(x ORDER BY x) FROM unnest(ARRAY[pg_temp.id('a1'), pg_temp.id('a2')]) x),
                        'C01 the shared local id links BOTH uploads (A1, A2)');
  PERFORM pg_temp.check((SELECT array_agg(m.submission_message_id)
                           FROM public.submission_checklist_link_members m
                           JOIN public.submission_checklist_links l ON l.id = m.link_id
                          WHERE l.submission_checklist_item_id = v_i1 AND l.kind = 'email')
                        = ARRAY[pg_temp.id('m1')], 'C01 email link holds M1 only (sms M3 dropped)');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM public.submission_checklist_links WHERE submission_id = s AND label = 'never uploaded'),
                        'C01 a link with no member is not written');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM public.submission_checklist_link_members WHERE submission_id = s AND submission_attachment_id = pg_temp.id('a6')),
                        'C01 second checklist links A6');
END
$c01$;
