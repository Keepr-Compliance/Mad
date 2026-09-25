-- C08 (A-C8, C3): adding one of the organization's templates at review.
--   broker adds T1 starter A to S_rev (under_review): 'added'; the header
--   records who and when, sorts after the existing two; both template items
--   are copied (title, description, required, type, order), unchecked, with no
--   reviewer tick; one 'checklist_added' entry, no status key
--   the same add again -> 'exists', no entry; S_sub already holds A -> 'exists'
--   archived starter B, E's template, an unknown id -> 'template_not_found'
--   it_admin adds on S_resub (resubmitted) -> 'added'
--   needs_changes, approved, uploading -> not_open_for_review
--   submitter, E's broker, T2's broker (feature off) -> not_authorized
--   a submitter's direct header insert with added_at_review_* set -> RLS
--     (positive control: the same insert without them -> rows:1)
-- Wrong implementations this catches: needs_changes admitted; archived or
-- other-org templates accepted; the duplicate check dropped; the header rule
-- left open to a forged "added at review".
DO $c08$
DECLARE
  broker uuid := pg_temp.id('u_t1_broker');
  s      uuid := pg_temp.id('s_rev');
  n0     integer := jsonb_array_length(pg_temp.hist(pg_temp.id('s_rev')));
  res    jsonb;
  res2   jsonb;
  e      jsonb;
  hid    uuid;
  add_q  text := 'SELECT public.add_submission_checklist_at_review(%L, %L)';
BEGIN
  PERFORM pg_temp.act_as(broker);
  res := public.add_submission_checklist_at_review(s, pg_temp.id('tpl_t1_a'));
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.check(res ->> 'status' = 'added' AND (res ->> 'items')::int = 2, 'C08 added: ' || res::text);
  hid := (res ->> 'checklist_id')::uuid;
  PERFORM pg_temp.check((SELECT added_at_review_by = broker AND added_at_review_at IS NOT NULL AND template_id = pg_temp.id('tpl_t1_a')
                                AND template_name = 'Fixture starter A' AND sort_order = 2
                           FROM public.submission_checklists WHERE id = hid), 'C08 header fields');
  PERFORM pg_temp.check((SELECT count(*) FROM public.submission_checklist_items ci
                           JOIN public.checklist_template_items ti
                             ON ti.template_id = pg_temp.id('tpl_t1_a') AND ti.title = ci.title
                            AND ti.description IS NOT DISTINCT FROM ci.description AND ti.is_required = ci.is_required
                            AND ti.expected_document_type IS NOT DISTINCT FROM ci.expected_document_type AND ti.sort_order = ci.sort_order
                          WHERE ci.submission_checklist_id = hid AND NOT ci.is_checked AND NOT ci.reviewer_checked) = 2,
                        'C08 both template items copied, unchecked');
  PERFORM pg_temp.check(jsonb_array_length(pg_temp.hist(s)) = n0 + 1, 'C08 one entry');
  e := pg_temp.hist(s) -> n0;
  PERFORM pg_temp.check(e ->> 'type' = 'checklist_added' AND (e ->> 'changed_by')::uuid = broker AND e ? 'changed_at'
                        AND NOT (e ? 'status') AND e ->> 'checklist_name' = 'Fixture starter A' AND (e ->> 'checklist_id')::uuid = hid,
                        'C08 entry shape: ' || e::text);

  PERFORM pg_temp.act_as(broker);
  res2 := public.add_submission_checklist_at_review(s, pg_temp.id('tpl_t1_a'));
  PERFORM pg_temp.check(res2 ->> 'status' = 'exists' AND (res2 ->> 'checklist_id')::uuid = hid, 'C08 repeat -> exists');
  PERFORM pg_temp.check(public.add_submission_checklist_at_review(pg_temp.id('s_sub'), pg_temp.id('tpl_t1_a')) ->> 'status' = 'exists',
                        'C08 S_sub already holds starter A (from the snapshot) -> exists');
  PERFORM pg_temp.check(public.add_submission_checklist_at_review(pg_temp.id('s_resub'), pg_temp.id('tpl_t1_b')) ->> 'status' = 'template_not_found',
                        'C08 archived template -> template_not_found');
  PERFORM pg_temp.check(public.add_submission_checklist_at_review(pg_temp.id('s_resub'), pg_temp.id('tpl_e_a')) ->> 'status' = 'template_not_found',
                        'C08 other org template -> template_not_found');
  PERFORM pg_temp.check(public.add_submission_checklist_at_review(pg_temp.id('s_resub'), '00000000-0000-4000-8000-00003477fffe') ->> 'status' = 'template_not_found', -- pii-allow-uuid: invented fixture id
                        'C08 unknown template -> template_not_found');
  PERFORM pg_temp.expect('C08 needs_changes', format(add_q, pg_temp.id('s_nc'), pg_temp.id('tpl_t1_a')), '~^42501:not_open_for_review$');
  PERFORM pg_temp.expect('C08 approved', format(add_q, pg_temp.id('s_appr'), pg_temp.id('tpl_t1_a')), '~^42501:not_open_for_review$');
  PERFORM pg_temp.expect('C08 uploading', format(add_q, pg_temp.id('s_up'), pg_temp.id('tpl_t1_a')), '~^42501:not_open_for_review$');
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.check(jsonb_array_length(pg_temp.hist(s)) = n0 + 1, 'C08 no entry for exists / refusals');

  PERFORM pg_temp.act_as(pg_temp.id('u_t1_itadmin'));
  PERFORM pg_temp.check(public.add_submission_checklist_at_review(pg_temp.id('s_resub'), pg_temp.id('tpl_t1_a')) ->> 'status' = 'added',
                        'C08 it_admin adds on resubmitted');
  PERFORM pg_temp.act_as(pg_temp.id('u_t1_agent'));
  PERFORM pg_temp.expect('C08 submitter', format(add_q, pg_temp.id('s_sub'), pg_temp.id('tpl_t1_a')), '~^42501:not_authorized$');
  PERFORM pg_temp.act_as(pg_temp.id('u_e_broker'));
  PERFORM pg_temp.expect('C08 other org broker', format(add_q, pg_temp.id('s_sub'), pg_temp.id('tpl_e_a')), '~^42501:not_authorized$');
  PERFORM pg_temp.act_as(pg_temp.id('u_t2_broker'));
  PERFORM pg_temp.expect('C08 feature off (T2)', format(add_q, pg_temp.id('s_t2sub'), pg_temp.id('tpl_t1_a')), '~^42501:not_authorized$');

  PERFORM pg_temp.act_as(pg_temp.id('u_t1_agent'));
  PERFORM pg_temp.expect('C08 forged added-at-review header',
    format('INSERT INTO public.submission_checklists (submission_id, template_name, added_at_review_by, added_at_review_at) VALUES (%L, %L, %L, now())',
           pg_temp.id('s_up'), 'Forged', broker), 'RLS');
  PERFORM pg_temp.expect('C08 positive: plain header',
    format('INSERT INTO public.submission_checklists (submission_id, template_name) VALUES (%L, %L)', pg_temp.id('s_up'), 'Plain'), 'rows:1');
  PERFORM pg_temp.act_owner();
END
$c08$;
