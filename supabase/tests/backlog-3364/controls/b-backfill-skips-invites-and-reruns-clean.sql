-- B-a / B-b: the parked backfill, run on fixtures inside this control's
-- rolled-back transaction.
--   B-b  licensed, no membership, no invite           -> personal organization
--        licensed, EXPIRED unclaimed invite           -> skipped (nothing written)
--        licensed, UNEXPIRED unclaimed invite         -> skipped
--        brokerage member                             -> not in the cohort
--   B-a  a second run writes nothing
--
-- run.sh passes the backfill path as -v backfill=... so a mutant copy can be
-- substituted without editing this file.

\i :backfill

DO $after_first$
DECLARE
  k_plain uuid := current_setting('t3364.u_bf_plain')::uuid;
  k_old   uuid := current_setting('t3364.u_bf_old_invite')::uuid;
  k_live  uuid := current_setting('t3364.u_bf_live_inv')::uuid;
  k_brk   uuid := current_setting('t3364.u_broker_agent')::uuid;
BEGIN
  PERFORM pg_temp.check(EXISTS (
    SELECT 1 FROM public.organization_members m JOIN public.organizations o ON o.id = m.organization_id
    WHERE m.user_id = k_plain AND o.personal_owner_user_id = k_plain
  ), 'plain licensed user got a personal organization');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM public.organization_members WHERE user_id = k_old)
                        AND NOT EXISTS (SELECT 1 FROM public.organizations WHERE personal_owner_user_id = k_old),
                        'user with an EXPIRED unclaimed invite was skipped');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM public.organization_members WHERE user_id = k_live)
                        AND NOT EXISTS (SELECT 1 FROM public.organizations WHERE personal_owner_user_id = k_live),
                        'user with an UNEXPIRED unclaimed invite was skipped');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM public.organizations WHERE personal_owner_user_id = k_brk),
                        'brokerage member got no personal organization');

  PERFORM set_config('t3364.bf_orgs',    (SELECT count(*) FROM public.organizations)::text, true);
  PERFORM set_config('t3364.bf_members', (SELECT count(*) FROM public.organization_members)::text, true);
  PERFORM set_config('t3364.bf_plans',   (SELECT count(*) FROM public.organization_plans)::text, true);
  PERFORM set_config('t3364.bf_rows',    (SELECT md5(string_agg(m.id::text || m.organization_id || coalesce(m.user_id::text, ''), ',' ORDER BY m.id))
                                          FROM public.organization_members m), true);
END
$after_first$;

\i :backfill

DO $after_second$
BEGIN
  PERFORM pg_temp.check((SELECT count(*) FROM public.organizations)::text = current_setting('t3364.bf_orgs'),
                        'second run: organization count unchanged');
  PERFORM pg_temp.check((SELECT count(*) FROM public.organization_members)::text = current_setting('t3364.bf_members'),
                        'second run: membership count unchanged');
  PERFORM pg_temp.check((SELECT count(*) FROM public.organization_plans)::text = current_setting('t3364.bf_plans'),
                        'second run: plan row count unchanged');
  PERFORM pg_temp.check((SELECT md5(string_agg(m.id::text || m.organization_id || coalesce(m.user_id::text, ''), ',' ORDER BY m.id))
                         FROM public.organization_members m) = current_setting('t3364.bf_rows'),
                        'second run: membership rows identical');
END
$after_second$;
