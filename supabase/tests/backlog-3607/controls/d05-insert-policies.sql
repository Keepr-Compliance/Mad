-- D05 (C-1): the agent, on its own uploading version, cannot write any
-- review-only value: removed_at_review_by / _at or restored_from_checklist_id
-- on a header, restored_from_item_id on an item. Positive controls: the same
-- inserts without those values are accepted.
DO $d05$
DECLARE
  agent  uuid := pg_temp.id('u_t1_agent');
  broker uuid := pg_temp.id('u_t1_broker');
  v1 uuid; v2 uuid; src uuid; srci uuid; h uuid;
BEGIN
  v1 := pg_temp.build_v1('fixture-3607-d05');
  src := pg_temp.hdr(v1, 'Fixture custom B');
  srci := pg_temp.item(v1, 'L-item-6');
  v2 := pg_temp.new_version(v1, 2);
  PERFORM pg_temp.act_as(agent);
  PERFORM pg_temp.expect('D05 forged removed_at_review_by',
    format($q$INSERT INTO public.submission_checklists (submission_id, template_name, removed_at_review_by, removed_at_review_at) VALUES (%L, 'X', %L, now())$q$, v2, broker), 'RLS');
  PERFORM pg_temp.expect('D05 forged removed_at_review_at alone',
    format($q$INSERT INTO public.submission_checklists (submission_id, template_name, removed_at_review_at) VALUES (%L, 'X2', now())$q$, v2), '~^(42501:.*row-level security|23514:)');
  PERFORM pg_temp.expect('D05 forged restored_from_checklist_id',
    format($q$INSERT INTO public.submission_checklists (submission_id, template_name, restored_from_checklist_id) VALUES (%L, 'Y', %L)$q$, v2, src), 'RLS');
  PERFORM pg_temp.expect('D05 plain header accepted',
    format($q$INSERT INTO public.submission_checklists (submission_id, template_name) VALUES (%L, 'Z')$q$, v2), 'rows:1');
  PERFORM pg_temp.act_owner();
  h := pg_temp.hdr(v2, 'Z');
  PERFORM pg_temp.act_as(agent);
  PERFORM pg_temp.expect('D05 forged restored_from_item_id',
    format($q$INSERT INTO public.submission_checklist_items (submission_id, submission_checklist_id, title, is_required, sort_order, restored_from_item_id) VALUES (%L, %L, 'T', false, 0, %L)$q$, v2, h, srci), 'RLS');
  PERFORM pg_temp.expect('D05 plain item accepted',
    format($q$INSERT INTO public.submission_checklist_items (submission_id, submission_checklist_id, title, is_required, sort_order) VALUES (%L, %L, 'T', false, 0)$q$, v2, h), 'rows:1');
  PERFORM pg_temp.act_owner();
END
$d05$;
