-- C13 (SR condition C13): status_history accepts appends only.
-- S_sub holds one status entry; S_rev holds none.
--   refused (42501 status_history_append_only), as T1's broker:
--     set to []; set to NULL; set to an object (on S_sub and on empty S_rev);
--     edit entry 0; append a typed entry naming the admin;
--     a rewrite sent together with a status change;
--     append an untyped entry naming someone else; append an untyped entry
--     naming the caller; append a non-object entry
--   allowed:
--     append a typed entry naming the caller            (residual, recorded)
--     ReviewActions-shaped update (status, reviewed_by, reviewed_at, notes)
--     markAsUnderReview-shaped update (status only)
--     the submitter's needs_changes -> uploading (BACKLOG-3497 shape)
--     the reviewer tick
--     a rewrite by the service role; a rewrite with no request JWT
-- Wrong implementations this catches: the prefix test dropped; the typed
-- entry's changed_by not checked; untyped appends let through; non-array
-- values let through; exemption for every caller; the trigger never created.
-- The ReviewActions, markAsUnderReview and reopen probes are real status
-- changes: the status trigger appends an untyped entry after this guard has
-- run, so they also catch a guard that fires after it (m39).
DO $c13$
DECLARE
  broker uuid := pg_temp.id('u_t1_broker');
  admin  uuid := pg_temp.id('u_t1_admin');
  s      uuid := pg_temp.id('s_sub');
  upd    text := 'UPDATE public.transaction_submissions SET %s WHERE id = %L';
  n      integer;
BEGIN
  PERFORM pg_temp.act_as(broker);
  PERFORM pg_temp.expect('C13 set []', format(upd, 'status_history = ''[]''::jsonb', s), '~^42501:status_history_append_only$');
  PERFORM pg_temp.expect('C13 set NULL', format(upd, 'status_history = NULL', s), '~^42501:status_history_append_only$');
  PERFORM pg_temp.expect('C13 set object', format(upd, 'status_history = ''{"a": 1}''::jsonb', s), '~^42501:status_history_append_only$');
  PERFORM pg_temp.expect('C13 set object on empty history', format(upd, 'status_history = ''{"a": 1}''::jsonb', pg_temp.id('s_rev')), '~^42501:status_history_append_only$');
  PERFORM pg_temp.expect('C13 edit entry 0', format(upd, 'status_history = jsonb_set(status_history, ''{0,notes}'', ''"edited"'')', s), '~^42501:status_history_append_only$');
  PERFORM pg_temp.expect('C13 typed entry naming someone else',
    format(upd, format('status_history = status_history || jsonb_build_array(jsonb_build_object(''type'', ''checklist_review'', ''changed_at'', now(), ''changed_by'', %L::uuid))', admin), s),
    '~^42501:status_history_append_only$');
  PERFORM pg_temp.expect('C13 rewrite with a status change',
    format(upd, 'status = ''under_review'', status_history = ''[]''::jsonb', s), '~^42501:status_history_append_only$');
  PERFORM pg_temp.expect('C13 untyped entry naming someone else',
    format(upd, format('status_history = status_history || jsonb_build_array(jsonb_build_object(''status'', ''approved'', ''changed_at'', now(), ''changed_by'', %L::uuid))', admin), s),
    '~^42501:status_history_append_only$');
  PERFORM pg_temp.expect('C13 untyped entry naming the caller',
    format(upd, format('status_history = status_history || jsonb_build_array(jsonb_build_object(''status'', ''approved'', ''changed_at'', now(), ''changed_by'', %L::uuid))', broker), s),
    '~^42501:status_history_append_only$');
  PERFORM pg_temp.expect('C13 non-object entry',
    format(upd, 'status_history = status_history || ''["approved"]''::jsonb', s),
    '~^42501:status_history_append_only$');
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.check(jsonb_array_length(pg_temp.hist(s)) = 1 AND (SELECT status FROM public.transaction_submissions WHERE id = s) = 'submitted',
                        'C13 S_sub unchanged after the refusals');

  PERFORM pg_temp.act_as(broker);
  PERFORM pg_temp.expect('C13 typed entry naming the caller (residual)',
    format(upd, format('status_history = status_history || jsonb_build_array(jsonb_build_object(''type'', ''note'', ''changed_at'', now(), ''changed_by'', %L::uuid))', broker), s),
    'rows:1');
  PERFORM pg_temp.expect('C13 ReviewActions shape',
    format(upd, format('status = ''approved'', reviewed_by = %L, reviewed_at = now(), review_notes = ''ok''', broker), pg_temp.id('s_rev')), 'rows:1');
  PERFORM pg_temp.expect('C13 markAsUnderReview shape', format(upd, 'status = ''under_review''', pg_temp.id('s_resub')), 'rows:1');
  PERFORM pg_temp.expect('C13 reviewer tick', format('SELECT public.set_submission_checklist_reviewer_check(%L, true)', pg_temp.id('i_req')), 'rows:1');
  PERFORM pg_temp.act_as(pg_temp.id('u_t1_agent'));
  PERFORM pg_temp.expect('C13 submitter reopen (3497 shape)', format(upd, 'status = ''uploading''', pg_temp.id('s_nc')), 'rows:1');
  PERFORM pg_temp.act_owner();

  PERFORM pg_temp.check(jsonb_array_length(pg_temp.hist(pg_temp.id('s_rev'))) = 1
                        AND pg_temp.hist(pg_temp.id('s_rev')) -> 0 ->> 'status' = 'approved'
                        AND (pg_temp.hist(pg_temp.id('s_rev')) -> 0 ->> 'changed_by')::uuid = broker, 'C13 ReviewActions: one status entry');
  PERFORM pg_temp.check(jsonb_array_length(pg_temp.hist(pg_temp.id('s_resub'))) = 1, 'C13 markAsUnderReview: one status entry');
  PERFORM pg_temp.check(jsonb_array_length(pg_temp.hist(pg_temp.id('s_nc'))) = 1, 'C13 reopen: one status entry');
  PERFORM pg_temp.check(jsonb_array_length(pg_temp.hist(s)) = 3, 'C13 S_sub: 1 + 1 residual append + 1 tick');

  PERFORM pg_temp.act_service();
  PERFORM pg_temp.expect('C13 service role rewrite', format(upd, 'status_history = ''[]''::jsonb', s), 'rows:1');
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.check(jsonb_array_length(pg_temp.hist(s)) = 0, 'C13 service role rewrite applied');
  PERFORM pg_temp.expect('C13 no-JWT rewrite', format(upd, 'status_history = ''[{"x": 1}]''::jsonb', s), 'rows:1');
  PERFORM pg_temp.check(pg_temp.hist(s) = '[{"x": 1}]'::jsonb, 'C13 no-JWT rewrite applied');
END
$c13$;
