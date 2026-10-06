-- D09 (C-4): restore_submission_checklist_at_review.
--   v1 = A + B reviewed (A: 4 broker ticks, backdated 10:01..10:05);
--   v2 = B only (the agent removed A), resubmitted.
--   refusals: other-org broker / submitter -> not_authorized; a source not on
--   the direct parent -> not_authorized; B (not removed) -> not_removed.
--   restore A: a header on v2 added at review by the broker with
--   restored_from = A; 5 items with A's titles / required / order, no agent
--   state (local id, tick, note, links); the 4 ticks with their ORIGINAL
--   broker and time; one checklist_added {restored, ticks_restored 4}.
--   repeat -> already_present, no entry. Removed again on v2 -> removed_here.
--   needs_changes -> not_open_for_review; newer version -> superseded.
--   An archived template still restores (the template is never read).
DO $d09$
DECLARE
  agent  uuid := pg_temp.id('u_t1_agent');
  broker uuid := pg_temp.id('u_t1_broker');
  v1 uuid; v2 uuid; src uuid; srcb uuid; other uuid; res jsonb; hdr uuid; n integer; e jsonb; q text; bad integer;
BEGIN
  v2 := pg_temp.rm_v2('fixture-3607-d09');
  v1 := (SELECT parent_submission_id FROM public.transaction_submissions WHERE id = v2);
  src := pg_temp.hdr(v1, 'Fixture starter A');
  srcb := pg_temp.hdr(v1, 'Fixture custom B');
  other := pg_temp.hdr(pg_temp.build_v1('fixture-3607-d09-other'), 'Fixture starter A');
  q := format('SELECT public.restore_submission_checklist_at_review(%L, %L)', v2, src);
  n := jsonb_array_length(pg_temp.hist(v2));

  PERFORM pg_temp.act_as(pg_temp.id('u_t2_broker'));
  PERFORM pg_temp.expect('D09 other org broker', q, '~^42501:not_authorized$');
  PERFORM pg_temp.act_as(agent);
  PERFORM pg_temp.expect('D09 submitter', q, '~^42501:not_authorized$');
  PERFORM pg_temp.act_as(broker);
  PERFORM pg_temp.expect('D09 source of another deal',
    format('SELECT public.restore_submission_checklist_at_review(%L, %L)', v2, other), '~^42501:not_authorized$');
  PERFORM pg_temp.act_owner();
  res := pg_temp.restore_as(broker, v2, srcb);
  PERFORM pg_temp.check(res ->> 'status' = 'not_removed', 'D09 B was not removed: ' || res::text);
  PERFORM pg_temp.check(jsonb_array_length(pg_temp.hist(v2)) = n
                        AND NOT EXISTS (SELECT 1 FROM public.submission_checklists WHERE submission_id = v2 AND template_name = 'Fixture starter A'),
                        'D09 refusals wrote nothing');

  -- restored by the ADMIN: a re-stamp with the caller would show as admin
  res := pg_temp.restore_as(pg_temp.id('u_t1_admin'), v2, src);
  hdr := (res ->> 'checklist_id')::uuid;
  PERFORM pg_temp.check(res ->> 'status' = 'restored' AND (res ->> 'items')::int = 5 AND (res ->> 'ticks_restored')::int = 4,
                        'D09 restored: ' || res::text);
  PERFORM pg_temp.check((SELECT added_at_review_by = pg_temp.id('u_t1_admin') AND restored_from_checklist_id = src AND template_id = pg_temp.id('tpl_t1_a')
                                AND removed_at_review_by IS NULL
                           FROM public.submission_checklists WHERE id = hdr), 'D09 header: added at review, restored from A');
  SELECT count(*) INTO bad
    FROM (SELECT * FROM public.submission_checklist_items WHERE submission_checklist_id = hdr) ni
    FULL JOIN (SELECT * FROM public.submission_checklist_items WHERE submission_checklist_id = src) si ON si.id = ni.restored_from_item_id
   WHERE si.id IS NULL OR ni.id IS NULL
      OR ni.title IS DISTINCT FROM si.title OR ni.is_required IS DISTINCT FROM si.is_required
      OR ni.sort_order IS DISTINCT FROM si.sort_order OR ni.description IS DISTINCT FROM si.description
      OR ni.local_item_id IS NOT NULL OR ni.is_checked OR ni.note IS NOT NULL
      OR ni.reviewer_checked IS DISTINCT FROM si.reviewer_checked
      OR ni.reviewer_checked_by IS DISTINCT FROM si.reviewer_checked_by
      OR ni.reviewer_checked_at IS DISTINCT FROM si.reviewer_checked_at;
  PERFORM pg_temp.check(bad = 0, 'D09 items copied, ticks original, no agent state: ' || bad || ' bad rows');
  PERFORM pg_temp.check((SELECT string_agg(title || ':' || pg_temp.who(reviewer_checked_by) || ':' || to_char(reviewer_checked_at AT TIME ZONE 'UTC', 'HH24:MI'), ',' ORDER BY title)
                           FROM public.submission_checklist_items WHERE submission_checklist_id = hdr AND reviewer_checked)
                        = 'Item five:broker:10:05,Item one:broker:10:01,Item three:broker:10:03,Item two:broker:10:02',
                        'D09 original broker and time');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM public.submission_checklist_links l JOIN public.submission_checklist_items i ON i.id = l.submission_checklist_item_id
                                     WHERE i.submission_checklist_id = hdr), 'D09 no links');
  e := pg_temp.typed(v2, 'checklist_added') -> -1;
  PERFORM pg_temp.check(jsonb_array_length(pg_temp.hist(v2)) = n + 1 AND (e ->> 'restored')::boolean
                        AND (e ->> 'ticks_restored')::int = 4 AND (e ->> 'restored_from_version')::int = 1
                        AND (e ->> 'changed_by')::uuid = pg_temp.id('u_t1_admin') AND e ->> 'source' = 'review',
                        'D09 one entry: ' || COALESCE(e::text, 'missing'));

  n := jsonb_array_length(pg_temp.hist(v2));
  res := pg_temp.restore_as(broker, v2, src);
  PERFORM pg_temp.check(res ->> 'status' = 'already_present' AND jsonb_array_length(pg_temp.hist(v2)) = n,
                        'D09 repeat: ' || res::text);
  PERFORM pg_temp.remove_as(broker, hdr);
  res := pg_temp.restore_as(broker, v2, src);
  PERFORM pg_temp.check(res ->> 'status' = 'removed_here', 'D09 removed on this version: ' || res::text);

  PERFORM pg_temp.set_status(v2, 'needs_changes');
  PERFORM pg_temp.act_as(broker);
  PERFORM pg_temp.expect('D09 needs_changes', q, '~^42501:not_open_for_review$');
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.set_status(v2, 'under_review');
  PERFORM pg_temp.new_version(v2, 3);
  PERFORM pg_temp.act_as(broker);
  PERFORM pg_temp.expect('D09 superseded', q, '~^42501:superseded$');
  PERFORM pg_temp.act_owner();

  -- a source on the GRANDPARENT (v1) is refused, even for an open v3
  v2 := pg_temp.rm_v2('fixture-3607-d09-gp');
  v1 := (SELECT parent_submission_id FROM public.transaction_submissions WHERE id = v2);
  PERFORM pg_temp.set_status(v2, 'needs_changes');
  q := pg_temp.new_version(v2, 3)::text;
  PERFORM pg_temp.snap_as(agent, q::uuid, pg_temp.pb());
  PERFORM pg_temp.set_status(q::uuid, 'resubmitted');
  PERFORM pg_temp.act_as(broker);
  PERFORM pg_temp.expect('D09 grandparent source',
    format('SELECT public.restore_submission_checklist_at_review(%L, %L)', q, pg_temp.hdr(v1, 'Fixture starter A')), '~^42501:not_authorized$');
  PERFORM pg_temp.act_owner();

  -- archived template: never read
  v2 := pg_temp.rm_v2('fixture-3607-d09-arch');
  v1 := (SELECT parent_submission_id FROM public.transaction_submissions WHERE id = v2);
  UPDATE public.checklist_templates SET archived_at = now() WHERE id = pg_temp.id('tpl_t1_a');
  res := pg_temp.restore_as(broker, v2, pg_temp.hdr(v1, 'Fixture starter A'));
  PERFORM pg_temp.check(res ->> 'status' = 'restored', 'D09 archived template restores: ' || res::text);
END
$d09$;
