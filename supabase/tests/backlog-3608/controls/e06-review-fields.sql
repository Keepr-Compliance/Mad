-- E06: reviewed_by / reviewed_at / review_notes change only for a reviewer of
-- the row's organization, and reviewed_by only to the caller's own id.
--   refused ('review_fields_reviewer_only'): the agent on its own uploading
--     row sets reviewed_by (to the broker, to itself), review_notes alone,
--     reviewed_at alone, or all three with the finalize status move; a broker
--     decision naming the admin or the agent.
--   allowed (rows:1): desktop finalize (status only); markUnderReview;
--     ReviewActions needs_changes naming the broker (entry names the broker);
--     admin approve with notes NULL; owner and service_role writes.
--   the agent's status move on its decided needs_changes row matches no row
--     and leaves it needs_changes.
DO $e06$
DECLARE
  agent  uuid := pg_temp.id('u_t1_agent');
  broker uuid := pg_temp.id('u_t1_broker');
  admin  uuid := pg_temp.id('u_t1_admin');
  v1 uuid; v2 uuid; v3 uuid; e jsonb;
  refused text := '~^42501:review_fields_reviewer_only$';
BEGIN
  v1 := pg_temp.mk_sub('fixture-3608-e06a', 1, NULL, 'uploading');
  PERFORM pg_temp.act_as(agent);
  PERFORM pg_temp.expect('E06-F1 agent finalize + reviewed_by broker + notes',
    format($q$UPDATE public.transaction_submissions SET status='resubmitted', reviewed_by=%L, reviewed_at=now(), review_notes='Looks good' WHERE id=%L$q$, broker, v1), refused);
  PERFORM pg_temp.expect('E06-F2 agent sets review_notes only',
    format($q$UPDATE public.transaction_submissions SET review_notes='x' WHERE id=%L$q$, v1), refused);
  PERFORM pg_temp.expect('E06-F3 agent sets reviewed_at only',
    format($q$UPDATE public.transaction_submissions SET reviewed_at=now() WHERE id=%L$q$, v1), refused);
  PERFORM pg_temp.expect('E06-F4 agent sets reviewed_by to itself',
    format($q$UPDATE public.transaction_submissions SET reviewed_by=%L WHERE id=%L$q$, agent, v1), refused);
  PERFORM pg_temp.expect('E06-L1 desktop finalize status only',
    format($q$UPDATE public.transaction_submissions SET status='submitted' WHERE id=%L$q$, v1), 'rows:1');
  PERFORM pg_temp.act_as(broker);
  PERFORM pg_temp.expect('E06-L2 markUnderReview',
    format($q$UPDATE public.transaction_submissions SET status='under_review' WHERE id=%L$q$, v1), 'rows:1');
  PERFORM pg_temp.expect('E06-R1 broker decides naming the admin',
    format($q$UPDATE public.transaction_submissions SET status='needs_changes', reviewed_by=%L, reviewed_at=now(), review_notes='n' WHERE id=%L$q$, admin, v1), refused);
  PERFORM pg_temp.expect('E06-R2 broker decides naming the agent',
    format($q$UPDATE public.transaction_submissions SET status='approved', reviewed_by=%L, reviewed_at=now() WHERE id=%L$q$, agent, v1), refused);
  PERFORM pg_temp.expect('E06-L3 ReviewActions needs_changes naming the broker',
    format($q$UPDATE public.transaction_submissions SET status='needs_changes', reviewed_by=%L, reviewed_at=now(), review_notes='Fix it' WHERE id=%L AND status IN ('submitted','resubmitted','under_review')$q$, broker, v1), 'rows:1');
  PERFORM pg_temp.act_owner();
  e := pg_temp.hist(v1) -> -1;
  PERFORM pg_temp.check((e->>'changed_by')::uuid = broker AND e->>'status' = 'needs_changes', 'E06 decision entry names the broker');
  PERFORM pg_temp.act_as(agent);
  PERFORM pg_temp.expect('E06-L4 agent status move on its decided needs_changes row',
    format($q$UPDATE public.transaction_submissions SET status='resubmitted' WHERE id=%L$q$, v1), 'rows:0');
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.check((SELECT status FROM public.transaction_submissions WHERE id = v1) = 'needs_changes', 'E06 v1 still needs_changes');
  v2 := pg_temp.mk_sub('fixture-3608-e06b', 1, NULL, 'submitted');
  PERFORM pg_temp.act_as(admin);
  PERFORM pg_temp.expect('E06-L5 admin approves (self, notes NULL)',
    format($q$UPDATE public.transaction_submissions SET status='approved', reviewed_by=%L, reviewed_at=now(), review_notes=NULL WHERE id=%L AND status IN ('submitted','resubmitted','under_review')$q$, admin, v2), 'rows:1');
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.expect('E06-O1 owner rewrites reviewed_by',
    format($q$UPDATE public.transaction_submissions SET reviewed_by=%L WHERE id=%L$q$, broker, v2), 'rows:1');
  v3 := pg_temp.mk_sub('fixture-3608-e06c', 1, NULL, 'uploading');
  PERFORM set_config('request.jwt.claims', jsonb_build_object('role','service_role')::text, true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('role', 'service_role', true);
  PERFORM pg_temp.expect('E06-O2 service_role sets reviewed_*, ownership and history',
    format($q$UPDATE public.transaction_submissions SET reviewed_by=%L, review_notes='svc', version=7, status_history='[{"type":"svc"}]'::jsonb WHERE id=%L$q$, broker, v3), 'rows:1');
  PERFORM pg_temp.act_owner();
END
$e06$;
