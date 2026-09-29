-- D06 (plan §2): the broker removes a checklist at review.
--   refusals (write nothing): other-org broker, the submitter -> not_authorized;
--   needs_changes -> not_open_for_review; newer version -> superseded.
--   linked_documents / linked_emails count distinct LOCAL ids per kind:
--   fixture A links 4 attachment upload rows (L-att-1 is two uploads of one
--   file) = 3 documents, and 2 emails. One more member is added whose upload
--   row has NO local id: not counted (the carry skips such a member too).
--   That row is an owner insert: the snapshot RPC links by local id and does
--   not emit it today; it pins the count rule, not a producer shape.
--   success: soft marker by the broker; items, agent ticks and links intact;
--   one checklist_removed {source review, linked_documents}; a repeat ->
--   already_removed, no entry; a tick on its item -> checklist_removed, while
--   another checklist's item still ticks; adding the template again on this
--   version un-removes it (readded), rows untouched.
DO $d06$
DECLARE
  agent  uuid := pg_temp.id('u_t1_agent');
  broker uuid := pg_temp.id('u_t1_broker');
  v1 uuid; ha uuid; hb uuid; nullatt uuid; res jsonb; n integer; links0 integer; e jsonb; q text;
BEGIN
  v1 := pg_temp.build_v1('fixture-3607-d06');
  PERFORM pg_temp.set_status(v1, 'under_review');
  ha := pg_temp.hdr(v1, 'Fixture starter A');
  hb := pg_temp.hdr(v1, 'Fixture custom B');
  n := jsonb_array_length(pg_temp.hist(v1));
  INSERT INTO public.submission_attachments (submission_id, filename, storage_path, document_type, local_attachment_id)
  VALUES (v1, 'fixture-no-local-id.pdf', 'fixture-3607/' || v1 || '/no-local-id', 'other', NULL)
  RETURNING id INTO nullatt;
  INSERT INTO public.submission_checklist_link_members (submission_id, link_id, kind, submission_attachment_id)
  SELECT v1, l.id, 'attachment', nullatt
    FROM public.submission_checklist_links l
   WHERE l.submission_checklist_item_id = pg_temp.item(v1, 'L-item-1') AND l.kind = 'attachment';
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM pg_temp.check(n = 1, 'D06 null-local-id member inserted: ' || n);
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
  PERFORM pg_temp.check(res ->> 'status' = 'removed' AND (res ->> 'linked_documents')::int = 3
                        AND (res ->> 'linked_emails')::int = 2, 'D06 removed: ' || res::text);
  PERFORM pg_temp.check((SELECT removed_at_review_by = broker AND removed_at_review_at IS NOT NULL FROM public.submission_checklists WHERE id = ha),
                        'D06 marker names the broker');
  PERFORM pg_temp.check((SELECT count(*) FROM public.submission_checklist_items WHERE submission_checklist_id = ha) = 5
                        AND (SELECT count(*) FROM public.submission_checklist_links WHERE submission_id = v1) = links0
                        AND pg_temp.tick_state(v1) = pg_temp.base_ticks(),
                        'D06 items, links and ticks untouched: ' || pg_temp.tick_state(v1));
  e := pg_temp.typed(v1, 'checklist_removed') -> -1;
  PERFORM pg_temp.check(jsonb_array_length(pg_temp.hist(v1)) = n + 3 -- two status moves + the removal
                        AND e ->> 'source' = 'review' AND (e ->> 'changed_by')::uuid = broker
                        AND (e ->> 'checklist_id')::uuid = ha AND (e ->> 'linked_documents')::int = 3 AND (e ->> 'linked_emails')::int = 2,
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
