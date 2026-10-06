-- C05 (A-C5, C3, C4): the reviewer tick.
--   broker ticks I_req (S_sub, submitted; the agent already checked it):
--     changed true; reviewer_checked/_by/_at set; is_checked untouched;
--     exactly one new Status History entry, typed, with no status key
--   the same tick again: changed false, no entry
--   untick: reviewer columns cleared, one entry (from true to false)
--   ticking I_opt leaves its is_checked false
--   admin, it_admin tick; resubmitted, under_review and needs_changes are open
--   an item of a checklist added at review is refused (added_at_review)
-- Wrong implementations this catches: writing is_checked; appending on a
-- no-op; a status key in the entry; it_admin left out of the helper.
DO $c05$
DECLARE
  broker uuid := pg_temp.id('u_t1_broker');
  s      uuid := pg_temp.id('s_sub');
  n0     integer := jsonb_array_length(pg_temp.hist(pg_temp.id('s_sub')));
  res    jsonb;
  e      jsonb;
BEGIN
  PERFORM pg_temp.act_as(broker);
  res := public.set_submission_checklist_reviewer_check(pg_temp.id('i_req'), true);
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.check((res ->> 'changed')::boolean AND (res ->> 'reviewer_checked')::boolean
                        AND (res ->> 'reviewer_checked_by')::uuid = broker, 'C05 tick result: ' || res::text);
  PERFORM pg_temp.check((SELECT reviewer_checked AND reviewer_checked_by = broker AND reviewer_checked_at IS NOT NULL AND is_checked
                           FROM public.submission_checklist_items WHERE id = pg_temp.id('i_req')),
                        'C05 reviewer columns set; is_checked still true');
  PERFORM pg_temp.check(jsonb_array_length(pg_temp.hist(s)) = n0 + 1, 'C05 one entry appended');
  e := pg_temp.hist(s) -> n0;
  PERFORM pg_temp.check(e ->> 'type' = 'checklist_review' AND (e ->> 'changed_by')::uuid = broker AND e ? 'changed_at'
                        AND NOT (e ? 'status') AND e ->> 'field' = 'reviewer_checked'
                        AND e -> 'from' = 'false'::jsonb AND e -> 'to' = 'true'::jsonb
                        AND e ->> 'item_title' = 'Fixture item A1' AND e ->> 'checklist_name' = 'Fixture starter A'
                        AND (e ->> 'item_id')::uuid = pg_temp.id('i_req'),
                        'C05 entry shape: ' || e::text);

  PERFORM pg_temp.act_as(broker);
  res := public.set_submission_checklist_reviewer_check(pg_temp.id('i_req'), true);
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.check(NOT (res ->> 'changed')::boolean, 'C05 repeat: changed false');
  PERFORM pg_temp.check(jsonb_array_length(pg_temp.hist(s)) = n0 + 1, 'C05 repeat: no entry');

  PERFORM pg_temp.act_as(broker);
  res := public.set_submission_checklist_reviewer_check(pg_temp.id('i_req'), false);
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.check((res ->> 'changed')::boolean, 'C05 untick: changed');
  PERFORM pg_temp.check((SELECT NOT reviewer_checked AND reviewer_checked_by IS NULL AND reviewer_checked_at IS NULL AND is_checked
                           FROM public.submission_checklist_items WHERE id = pg_temp.id('i_req')),
                        'C05 untick clears the reviewer columns; is_checked still true');
  PERFORM pg_temp.check(jsonb_array_length(pg_temp.hist(s)) = n0 + 2
                        AND pg_temp.hist(s) -> (n0 + 1) -> 'from' = 'true'::jsonb
                        AND pg_temp.hist(s) -> (n0 + 1) -> 'to' = 'false'::jsonb, 'C05 untick: one entry, true -> false');

  PERFORM pg_temp.act_as(pg_temp.id('u_t1_admin'));
  PERFORM pg_temp.expect('C05 admin ticks I_opt',
    format('SELECT public.set_submission_checklist_reviewer_check(%L, true)', pg_temp.id('i_opt')), 'rows:1');
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.check((SELECT reviewer_checked AND NOT is_checked AND reviewer_checked_by = pg_temp.id('u_t1_admin')
                           FROM public.submission_checklist_items WHERE id = pg_temp.id('i_opt')),
                        'C05 I_opt: reviewer ticked by admin, is_checked still false');

  PERFORM pg_temp.act_as(pg_temp.id('u_t1_itadmin'));
  PERFORM pg_temp.expect('C05 it_admin ticks I_rev (under_review)',
    format('SELECT public.set_submission_checklist_reviewer_check(%L, true)', pg_temp.id('i_rev')), 'rows:1');
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.check((SELECT reviewer_checked_by = pg_temp.id('u_t1_itadmin') FROM public.submission_checklist_items WHERE id = pg_temp.id('i_rev')),
                        'C05 it_admin tick recorded');

  PERFORM pg_temp.act_as(broker);
  PERFORM pg_temp.expect('C05 resubmitted is open',
    format('SELECT public.set_submission_checklist_reviewer_check(%L, true)', pg_temp.id('i_resub')), 'rows:1');
  PERFORM pg_temp.expect('C05 needs_changes is open',
    format('SELECT public.set_submission_checklist_reviewer_check(%L, true)', pg_temp.id('i_nc')), 'rows:1');
  PERFORM pg_temp.expect('C05 added-at-review item refused',
    format('SELECT public.set_submission_checklist_reviewer_check(%L, true)', pg_temp.id('i_added')), '~^42501:added_at_review$');
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.check((SELECT NOT reviewer_checked FROM public.submission_checklist_items WHERE id = pg_temp.id('i_added')),
                        'C05 added-at-review item unchanged');
END
$c05$;
