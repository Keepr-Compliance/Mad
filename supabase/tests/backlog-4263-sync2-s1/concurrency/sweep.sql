-- run.sh cleanup: removes every fixture this folder can leave, for one run (__PAT__ = the run id) or for all runs
-- (__PAT__ = %). Fixture users are matched ONLY by the email pattern p4263s1cc-<run>@example.test, organizations by the
-- slug p4263s1cc-<run>. For each matched user: cloud rows, settings, assignment, membership, plan, organization, the
-- public.users row and the auth user (moves and move notices cascade). Then answers how many are left (must be 0).
DO $s1sweep$
DECLARE u record; n int := 0;
BEGIN
  FOR u IN SELECT id, email FROM auth.users WHERE email LIKE 'p4263s1cc-' || '__PAT__' || '@example.test' LOOP
    DELETE FROM public.cloud_deals WHERE owner_user_id = u.id;
    DELETE FROM public.cloud_blobs WHERE owner_user_id = u.id;
    DELETE FROM public.cloud_removed_installs WHERE owner_user_id = u.id;
    DELETE FROM public.cloud_todo_feed_head WHERE owner_user_id = u.id;
    DELETE FROM public.cloud_autosave_settings WHERE user_id = u.id;
    DELETE FROM public.member_addons WHERE user_id = u.id;
    SET LOCAL session_replication_role = replica;
    DELETE FROM public.organization_plans WHERE organization_id IN
      (SELECT m.organization_id FROM public.organization_members m JOIN public.organizations o ON o.id = m.organization_id
        WHERE m.user_id = u.id AND o.slug LIKE 'p4263s1cc-%');
    DELETE FROM public.organizations o WHERE o.slug LIKE 'p4263s1cc-%'
      AND o.id IN (SELECT m.organization_id FROM public.organization_members m WHERE m.user_id = u.id);
    DELETE FROM public.organization_members WHERE user_id = u.id;
    DELETE FROM public.users WHERE id = u.id AND email = u.email;
    SET LOCAL session_replication_role = origin;
    DELETE FROM auth.users WHERE id = u.id AND email = u.email;
    n := n + 1;
  END LOOP;
  RAISE NOTICE 'swept % fixture user(s)', n;
END
$s1sweep$;
SELECT (SELECT count(*) FROM auth.users WHERE email LIKE 'p4263s1cc-' || '__PAT__' || '@example.test') AS users_left,
       (SELECT count(*) FROM public.organizations WHERE slug LIKE 'p4263s1cc-' || '__PAT__') AS orgs_left,
       (SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE '%\_m4263') AS mutants_left;
