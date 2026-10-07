-- Regression: no client role reads auth.users, no organization_members policy
-- reads it, the guard function is not client-executable, and the guard still
-- refuses the attacks even if auth.users were opened to the caller later.
DO $$ DECLARE m text; r text; BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    PERFORM pg_temp.check('k08 ' || r || ' has no SELECT on auth.users',
      NOT has_table_privilege(r, 'auth.users', 'SELECT') AND NOT has_column_privilege(r, 'auth.users', 'email', 'SELECT'));
    PERFORM pg_temp.check('k08 ' || r || ' cannot execute guard_invite_acceptance()',
      NOT has_function_privilege(r, 'public.guard_invite_acceptance()', 'EXECUTE'));
  END LOOP;
  PERFORM pg_temp.check('k08 no organization_members policy reads auth.users',
    NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='organization_members'
                AND (coalesce(qual,'') ~* 'auth\.users' OR coalesce(with_check,'') ~* 'auth\.users')));
  PERFORM pg_temp.check('k08 guard trigger present and enabled',
    EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.organization_members'::regclass
            AND tgname='guard_invite_acceptance' AND tgenabled='O'));
  PERFORM pg_temp.check('k08 accept policy is TO authenticated with a WITH CHECK',
    EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='organization_members'
            AND policyname='users_can_accept_invite' AND roles = '{authenticated}' AND with_check IS NOT NULL));
END $$;
-- Open auth.users to the caller; the guard must not depend on it staying closed.
GRANT SELECT ON auth.users TO authenticated;
CREATE POLICY t3679_self ON auth.users FOR SELECT TO authenticated USING (id = auth.uid());
DO $$ DECLARE m text; BEGIN
  m := pg_temp.as_user(pg_temp.ua(), 'invitee-3679@example.test',
    $q$update public.organization_members set user_id=auth.uid(), role='admin'$q$);
  PERFORM pg_temp.check('k08 with auth.users opened: no-WHERE role escalation still refused', pg_temp.refused(m), m);
  m := pg_temp.as_user(pg_temp.ua(), 'invitee-3679@example.test',
    $q$update public.organization_members set organization_id='{org2}'$q$);
  PERFORM pg_temp.check('k08 with auth.users opened: no-WHERE org move still refused', pg_temp.refused(m), m);
END $$;
