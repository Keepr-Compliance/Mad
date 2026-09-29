-- C20 (BACKLOG-3592, ruling 78a23534): a reviewer's UPDATE matches only rows
-- open for a decision (submitted, resubmitted, under_review). The
-- submitter's own transitions and the status trigger are unaffected.
--   refused (0 rows, row unchanged): broker decision on needs_changes,
--     approved, rejected; broker review_notes alone on needs_changes
--   allowed (1 row + status entry naming the reviewer): broker
--     under_review -> needs_changes; broker submitted -> under_review;
--     admin resubmitted -> approved
--   submitter: uploading -> submitted, uploading -> resubmitted,
--     needs_changes -> resubmitted (older desktops) -> 1 row + status entry
--   observed, unchanged: the submitter cannot update an under_review row;
--     it_admin is not in this rule's role list
DO $c20$
DECLARE
  agent  uuid := pg_temp.id('u_t1_agent');
  broker uuid := pg_temp.id('u_t1_broker');
  admin  uuid := pg_temp.id('u_t1_admin');
  dec    text := $q$UPDATE public.transaction_submissions SET status = %L, reviewed_by = %L, reviewed_at = now(), review_notes = 'fixture' WHERE id = %L$q$;
  r      record;
  u1     uuid;
  u2     uuid;
  n0     integer;
BEGIN
  PERFORM pg_temp.act_as(broker);
  FOR r IN SELECT * FROM (VALUES ('s_nc', 'needs_changes'), ('s_appr', 'approved'), ('s_rej', 'rejected')) v(sub, st) LOOP
    PERFORM pg_temp.expect('C20 broker decision on ' || r.st, format(dec, 'approved', broker, pg_temp.id(r.sub)), 'rows:0');
  END LOOP;
  PERFORM pg_temp.expect('C20 broker notes on needs_changes', format($q$UPDATE public.transaction_submissions SET review_notes = 'x' WHERE id = %L$q$, pg_temp.id('s_nc')), 'rows:0');
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.check((SELECT status = 'needs_changes' AND reviewed_by IS NULL AND review_notes IS NULL
                           FROM public.transaction_submissions WHERE id = pg_temp.id('s_nc')), 'C20 needs_changes row unchanged');

  n0 := jsonb_array_length(pg_temp.hist(pg_temp.id('s_rev')));
  PERFORM pg_temp.act_as(broker);
  PERFORM pg_temp.expect('C20 broker under_review -> needs_changes', format(dec, 'needs_changes', broker, pg_temp.id('s_rev')), 'rows:1');
  PERFORM pg_temp.expect('C20 broker submitted -> under_review', format($q$UPDATE public.transaction_submissions SET status = 'under_review' WHERE id = %L$q$, pg_temp.id('s_sub')), 'rows:1');
  PERFORM pg_temp.act_as(admin);
  PERFORM pg_temp.expect('C20 admin resubmitted -> approved', format(dec, 'approved', admin, pg_temp.id('s_resub')), 'rows:1');
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.check(jsonb_array_length(pg_temp.hist(pg_temp.id('s_rev'))) = n0 + 1
                        AND pg_temp.hist(pg_temp.id('s_rev')) -> -1 ->> 'status' = 'needs_changes'
                        AND (pg_temp.hist(pg_temp.id('s_rev')) -> -1 ->> 'changed_by')::uuid = broker,
                        'C20 status trigger wrote the decision entry');

  u1 := pg_temp.mk_sub('fixture-3596-c20-u1', 1, NULL, 'uploading');
  u2 := pg_temp.mk_sub('fixture-3596-c20-u2', 1, NULL, 'uploading');
  PERFORM pg_temp.act_as(agent);
  PERFORM pg_temp.expect('C20 submitter uploading -> submitted', format($q$UPDATE public.transaction_submissions SET status = 'submitted' WHERE id = %L$q$, u1), 'rows:1');
  PERFORM pg_temp.expect('C20 submitter uploading -> resubmitted', format($q$UPDATE public.transaction_submissions SET status = 'resubmitted' WHERE id = %L$q$, u2), 'rows:1');
  PERFORM pg_temp.expect('C20 submitter needs_changes -> resubmitted', format($q$UPDATE public.transaction_submissions SET status = 'resubmitted' WHERE id = %L$q$, pg_temp.id('s_nc')), 'rows:1');
  PERFORM pg_temp.expect('C20 submitter on an under_review row', format($q$UPDATE public.transaction_submissions SET review_notes = 'x' WHERE id = %L$q$, pg_temp.id('s_sub')), 'rows:0');
  PERFORM pg_temp.act_as(pg_temp.id('u_t1_itadmin'));
  PERFORM pg_temp.expect('C20 it_admin (not in this rule, unchanged)', format($q$UPDATE public.transaction_submissions SET review_notes = 'x' WHERE id = %L$q$, u1), 'rows:0');
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.check(pg_temp.hist(u1) -> -1 ->> 'status' = 'submitted' AND pg_temp.hist(u2) -> -1 ->> 'status' = 'resubmitted'
                        AND pg_temp.hist(pg_temp.id('s_nc')) -> -1 ->> 'status' = 'resubmitted',
                        'C20 status entries for the submitter''s transitions');
END
$c20$;
