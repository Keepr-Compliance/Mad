-- R03: A and B re-applied after rollback-b: B's pre-check accepts the re-granted ACL, and
-- the end state is B's again.
SELECT pg_temp.check('R03 policies false again',
  (SELECT qual = 'false' FROM pg_policies WHERE tablename = 'organization_members' AND policyname = 'users_can_view_own_invite'), NULL);
SELECT pg_temp.check('R03 claim_pending_invite withdrawn again', NOT has_function_privilege('authenticated', 'public.claim_pending_invite()', 'EXECUTE'), NULL);
