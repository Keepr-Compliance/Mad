-- R01: after rollback-3684-b.sql every object file B touched is back to production's
-- state (read from pg_policies / pg_proc on production 2026-10-16), and the old email
-- claim works again (S3 shape). File A's functions remain.
SELECT pg_temp.check('R01 auto_provision_it_admin md5 = 0ca68b8c',
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.auto_provision_it_admin(text,text,text)'::regprocedure) = '0ca68b8cee9820322274e1f1a4817b0a', NULL);
SELECT pg_temp.check('R01 auto_provision_it_admin ACL',
  (SELECT proacl::text FROM pg_proc WHERE oid = 'public.auto_provision_it_admin(text,text,text)'::regprocedure) = '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}', NULL);
SELECT pg_temp.check('R01 claim_pending_invite ACL and body',
  (SELECT (SELECT string_agg(a::text, ',' ORDER BY a::text) FROM unnest(proacl) a) = 'authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'
          AND md5(prosrc) = '96ae2f67bbe19d5091466ab0f123e9b5'
     FROM pg_proc WHERE oid = 'public.claim_pending_invite()'::regprocedure),
  (SELECT proacl::text FROM pg_proc WHERE oid = 'public.claim_pending_invite()'::regprocedure));
SELECT pg_temp.check('R01 users_can_accept_invite text = production',
  (SELECT qual = '((user_id IS NULL) AND (invited_email IS NOT NULL) AND (lower(btrim(invited_email)) = lower(btrim(COALESCE((( SELECT auth.jwt() AS jwt) ->> ''email''::text), ''''::text)))) AND ((invitation_expires_at IS NULL) OR (invitation_expires_at > now())))' AND with_check = '((user_id = ( SELECT auth.uid() AS uid)) AND (invited_email IS NOT NULL) AND (lower(btrim(invited_email)) = lower(btrim(COALESCE((( SELECT auth.jwt() AS jwt) ->> ''email''::text), ''''::text)))))'
     FROM pg_policies WHERE tablename = 'organization_members' AND policyname = 'users_can_accept_invite'),
  (SELECT qual FROM pg_policies WHERE tablename = 'organization_members' AND policyname = 'users_can_accept_invite'));
SELECT pg_temp.check('R01 users_can_view_own_invite text = production',
  (SELECT qual = '((user_id IS NULL) AND (invited_email IS NOT NULL) AND (lower(btrim(invited_email)) = lower(btrim(COALESCE((( SELECT auth.jwt() AS jwt) ->> ''email''::text), ''''::text)))) AND ((invitation_expires_at IS NULL) OR (invitation_expires_at > now())))' AND with_check IS NULL
     FROM pg_policies WHERE tablename = 'organization_members' AND policyname = 'users_can_view_own_invite'),
  (SELECT qual FROM pg_policies WHERE tablename = 'organization_members' AND policyname = 'users_can_view_own_invite'));
SELECT pg_temp.mk_org('o_r01', NULL, 50);
SELECT pg_temp.mk_azure3851('u_x3', 't_r01');
SELECT pg_temp.mk_invite('i_r01', 'o_r01', 'u_x3-3917@example.test', 'admin');
SELECT pg_temp.check('R01 old /setup email claim works again', pg_temp.outcome(pg_temp.prov('u_x3', 't_r01')) = 'success'
  AND pg_temp.row_state('i_r01') = pg_temp.id('u_x3')::text || '|active|true|invite', pg_temp.row_state('i_r01'));
SELECT pg_temp.check('R01 file A functions still present',
  to_regprocedure('public.accept_invitation(text,text)') IS NOT NULL AND to_regprocedure('public.caller_has_pending_invite()') IS NOT NULL
  AND to_regprocedure('public._invite_bind_tenant(uuid,text)') IS NOT NULL, NULL);
