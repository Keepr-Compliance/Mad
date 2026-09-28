-- C26: the broker ticks an item of a checklist they added at review (the
-- 'added_at_review' refusal is gone), and every other refusal still holds:
-- outsiders and the submitter read not_authorized, a needs_changes version
-- reads not_open_for_review, a version with a newer version reads
-- superseded. Refused calls write nothing.
DO $c26$
DECLARE
  agent  uuid := pg_temp.id('u_t1_agent');
  broker uuid := pg_temp.id('u_t1_broker');
  tpl    uuid := pg_temp.id('tpl_t1_a');
  v1 uuid; v2 uuid; hdr uuid; x1 uuid; x2 uuid; res jsonb; n integer; e jsonb;
  s2 uuid; hdr2 uuid; y1 uuid;
BEGIN
  v1  := pg_temp.added_v1('fixture-3596-c26');
  hdr := pg_temp.add_as(broker, v1, tpl);
  SELECT id INTO x1 FROM public.submission_checklist_items WHERE submission_checklist_id = hdr ORDER BY sort_order, title LIMIT 1;
  SELECT id INTO x2 FROM public.submission_checklist_items WHERE submission_checklist_id = hdr ORDER BY sort_order, title OFFSET 1 LIMIT 1;
  PERFORM pg_temp.check(x1 IS NOT NULL AND x2 IS NOT NULL, 'C26 the added checklist has two items');

  n := jsonb_array_length(pg_temp.hist(v1));
  res := pg_temp.tick_as(broker, x1, true);
  PERFORM pg_temp.check((res ->> 'changed')::boolean AND (res ->> 'reviewer_checked')::boolean,
                        'C26 broker ticks an added item: ' || res::text);
  PERFORM pg_temp.check((SELECT reviewer_checked AND reviewer_checked_by = broker AND reviewer_checked_at IS NOT NULL
                           FROM public.submission_checklist_items WHERE id = x1), 'C26 the added item row is ticked by the broker');
  PERFORM pg_temp.check(jsonb_array_length(pg_temp.hist(v1)) = n + 1, 'C26 exactly one history entry');
  e := pg_temp.typed(v1, 'checklist_review') -> -1;
  PERFORM pg_temp.check(e ->> 'item_id' = x1::text AND (e ->> 'to')::boolean AND (e ->> 'changed_by')::uuid = broker,
                        'C26 the entry names the item and the broker: ' || COALESCE(e::text, 'missing'));

  -- Outsiders (x2 read as the owner first: outsiders cannot see the row).
  n := jsonb_array_length(pg_temp.hist(v1));
  PERFORM pg_temp.act_as(pg_temp.id('u_t2_broker'));
  PERFORM pg_temp.expect('C26 other org broker', format('SELECT public.set_submission_checklist_reviewer_check(%L, true)', x2), '~^42501:not_authorized$');
  PERFORM pg_temp.act_as(agent);
  PERFORM pg_temp.expect('C26 the submitter', format('SELECT public.set_submission_checklist_reviewer_check(%L, true)', x2), '~^42501:not_authorized$');
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.check(jsonb_array_length(pg_temp.hist(v1)) = n, 'C26 refused outsiders wrote no history');

  -- needs_changes: closed to new ticks and unticks. (A status move appends
  -- its own history entry, so the count is re-read after each move.)
  PERFORM pg_temp.set_status(v1, 'needs_changes');
  n := jsonb_array_length(pg_temp.hist(v1));
  PERFORM pg_temp.act_as(broker);
  PERFORM pg_temp.expect('C26 needs_changes refuses a new tick on an added item', format('SELECT public.set_submission_checklist_reviewer_check(%L, true)', x2), '~^42501:not_open_for_review$');
  PERFORM pg_temp.expect('C26 needs_changes refuses an untick on an added item', format('SELECT public.set_submission_checklist_reviewer_check(%L, false)', x1), '~^42501:not_open_for_review$');
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.check(jsonb_array_length(pg_temp.hist(v1)) = n, 'C26 refused needs_changes calls wrote no history');

  -- superseded: a newer version exists (uploading).
  v2 := pg_temp.new_version(v1, 2);
  n := jsonb_array_length(pg_temp.hist(v1));
  PERFORM pg_temp.act_as(broker);
  PERFORM pg_temp.expect('C26 superseded refuses a new tick on an added item', format('SELECT public.set_submission_checklist_reviewer_check(%L, true)', x2), '~^42501:superseded$');
  PERFORM pg_temp.expect('C26 superseded refuses an untick on an added item', format('SELECT public.set_submission_checklist_reviewer_check(%L, false)', x1), '~^42501:superseded$');
  PERFORM pg_temp.act_owner();

  PERFORM pg_temp.check((SELECT reviewer_checked FROM public.submission_checklist_items WHERE id = x1)
                        AND NOT (SELECT reviewer_checked FROM public.submission_checklist_items WHERE id = x2),
                        'C26 refused calls left x1 ticked and x2 unticked');
  PERFORM pg_temp.check(jsonb_array_length(pg_temp.hist(v1)) = n, 'C26 refused superseded calls wrote no history');

  -- A second deal: an added item on a resubmitted version ticks too (every
  -- open status), and unticking it clears the reviewer fields.
  s2   := pg_temp.added_v1('fixture-3596-c26b');
  PERFORM pg_temp.set_status(s2, 'resubmitted');
  hdr2 := pg_temp.add_as(broker, s2, tpl);
  SELECT id INTO y1 FROM public.submission_checklist_items WHERE submission_checklist_id = hdr2 ORDER BY sort_order, title LIMIT 1;
  res := pg_temp.tick_as(broker, y1, true);
  PERFORM pg_temp.check((res ->> 'changed')::boolean, 'C26 resubmitted: tick on an added item: ' || res::text);
  res := pg_temp.tick_as(broker, y1, false);
  PERFORM pg_temp.check((res ->> 'changed')::boolean AND NOT (res ->> 'reviewer_checked')::boolean
                        AND (SELECT NOT reviewer_checked AND reviewer_checked_by IS NULL AND reviewer_checked_at IS NULL
                               FROM public.submission_checklist_items WHERE id = y1),
                        'C26 resubmitted: untick clears the reviewer fields: ' || res::text);
END
$c26$;
