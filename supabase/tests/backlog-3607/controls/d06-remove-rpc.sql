-- D06 (plan §2): the broker removes a checklist at review.
--   refusals (write nothing): other-org broker, the submitter -> not_authorized;
--   needs_changes -> not_open_for_review; newer version -> superseded.
--   linked_documents counts DOCUMENTS: fixture A links 6 upload rows but
--   5 documents (L-att-1 is two uploads of one file).
--   success: soft marker by the broker; items, agent ticks and links intact;
--   one checklist_removed {source review, linked_documents}; a repeat ->
--   already_removed, no entry; a tick on its item -> checklist_removed, while
--   another checklist's item still ticks; adding the template again on this
--   version un-removes it (readded), rows untouched.
DO $d06$
DECLARE
  agent  uuid := pg_temp.id('u_t1_agent');
  broker uuid := pg_temp.id('u_t1_broker');
  v1 uuid; ha uuid; hb uuid; res jsonb; n integer; links0 integer; e jsonb; q text;
BEGIN
  v1 := pg_temp.build_v1('fixture-3607-d06');
  PERFORM pg_temp.set_status(v1, 'under_review');
  ha := pg_temp.hdr(v1, 'Fixture starter A');
  hb := pg_temp.hdr(v1, 'Fixture custom B');
  n := jsonb_array_length(pg_temp.hist(v1));
  SELECT count(*) INTO links0 FROM public.submission_checklist_links WHERE submission_id = v1;
  q := format('SELECT public.remove_submission_checklist_at_review(%L)', ha);

  PERFORM pg_temp.act_as(pg_temp.id('u_t2_broker'));
  PERFORM pg_temp.expect('D06 other org broker', q, '~^42501:not_authorized$');
  PERFORM pg_temp.act_as(agent);
  PERFORM pg_temp.expect('D06 submitter', q, '~^42501:not_authorized$');
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.set_status(v1, 'needs_changes');
  PERFORM pg_temp.act_as(broker);
  PERFORM pg_temp.expect('D06 needs_changes', q, '~^42501:not_open_for_review$');
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.set_status(v1, 'under_review');
  PERFORM pg_temp.check((SELECT removed_at_review_by FROM public.submission_checklists WHERE id = ha) IS NULL,
                        'D06 refusals wrote no marker');

  res := pg_temp.remove_as(broker, ha);
  PERFORM pg_temp.check(res ->> 'status' = 'removed' AND (res ->> 'linked_documents')::int = 5, 'D06 removed: ' || res::text);
  PERFORM pg_temp.check((SELECT removed_at_review_by = broker AND removed_at_review_at IS NOT NULL FROM public.submission_checklists WHERE id = ha),
                        'D06 marker names the broker');
  PERFORM pg_temp.check((SELECT count(*) FROM public.submission_checklist_items WHERE submission_checklist_id = ha) = 5
                        AND (SELECT count(*) FROM public.submission_checklist_links WHERE submission_id = v1) = links0
                        AND pg_temp.tick_state(v1) = pg_temp.base_ticks(),
                        'D06 items, links and ticks untouched: ' || pg_temp.tick_state(v1));
  e := pg_temp.typed(v1, 'checklist_removed') -> -1;
  PERFORM pg_temp.check(jsonb_array_length(pg_temp.hist(v1)) = n + 3 -- two status moves + the removal
                        AND e ->> 'source' = 'review' AND (e ->> 'changed_by')::uuid = broker
                        AND (e ->> 'checklist_id')::uuid = ha AND (e ->> 'linked_documents')::int = 5,
                        'D06 one review entry: ' || COALESCE(e::text, 'missing'));

  n := jsonb_array_length(pg_temp.hist(v1));
  res := pg_temp.remove_as(broker, ha);
  PERFORM pg_temp.check(res ->> 'status' = 'already_removed' AND jsonb_array_length(pg_temp.hist(v1)) = n,
                        'D06 repeat: ' || res::text);

  PERFORM pg_temp.act_as(broker);
  PERFORM pg_temp.expect('D06 tick on a removed checklist',
    format('SELECT public.set_submission_checklist_reviewer_check(%L, false)', pg_temp.item(v1, 'L-item-1')), '~^42501:checklist_removed$');
  PERFORM pg_temp.act_owner();
  res := pg_temp.tick_as(broker, pg_temp.item(v1, 'L-item-6'), false);
  PERFORM pg_temp.check((res ->> 'changed')::boolean, 'D06 other checklist still ticks: ' || res::text);

  PERFORM pg_temp.act_as(broker);
  res := public.add_submission_checklist_at_review(v1, pg_temp.id('tpl_t1_a'));
  PERFORM pg_temp.act_owner();
  e := pg_temp.typed(v1, 'checklist_added') -> -1;
  PERFORM pg_temp.check(res ->> 'status' = 'readded' AND (res ->> 'checklist_id')::uuid = ha
                        AND (SELECT removed_at_review_by IS NULL AND removed_at_review_at IS NULL FROM public.submission_checklists WHERE id = ha)
                        AND (e ->> 'readded')::boolean AND (e ->> 'changed_by')::uuid = broker
                        AND (SELECT count(*) FROM public.submission_checklist_items WHERE submission_checklist_id = ha) = 5,
                        'D06 add again un-removes: ' || res::text || ' ' || COALESCE(e::text, 'missing'));

  PERFORM pg_temp.new_version(v1, 2);
  PERFORM pg_temp.act_as(broker);
  PERFORM pg_temp.expect('D06 superseded', format('SELECT public.remove_submission_checklist_at_review(%L)', hb), '~^42501:superseded$');
  PERFORM pg_temp.act_owner();
END
$d06$;
