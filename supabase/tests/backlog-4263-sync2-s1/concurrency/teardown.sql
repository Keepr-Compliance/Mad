-- /*t:teardown*/ Removes the rows of one run, keyed on the fixture user id (and this run's exact email and slug).
-- Does nothing unless an auth user with exactly that id AND this run's email exists. Moves and move notices cascade
-- with the auth user. The organization is the one this user is a member of whose slug is this run's.
DO $s1td$
DECLARE A uuid := '__A__'::uuid; v_org uuid[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = A AND email = 'p4263s1cc-__RUN__@example.test') THEN
    RETURN;
  END IF;
  SELECT coalesce(array_agg(o.id), '{}') INTO v_org FROM public.organizations o
   WHERE o.slug = 'p4263s1cc-__RUN__' AND o.id IN (SELECT m.organization_id FROM public.organization_members m WHERE m.user_id = A);
  DELETE FROM public.cloud_deals WHERE owner_user_id = A;
  DELETE FROM public.cloud_blobs WHERE owner_user_id = A;
  DELETE FROM public.cloud_removed_installs WHERE owner_user_id = A;
  DELETE FROM public.cloud_todo_feed_head WHERE owner_user_id = A;
  DELETE FROM public.cloud_autosave_settings WHERE user_id = A;
  DELETE FROM public.member_addons WHERE user_id = A;
  SET LOCAL session_replication_role = replica;
  DELETE FROM public.organization_members WHERE user_id = A AND organization_id = ANY (v_org);
  DELETE FROM public.organization_plans WHERE organization_id = ANY (v_org);
  DELETE FROM public.organizations WHERE id = ANY (v_org);
  DELETE FROM public.users WHERE id = A AND email = 'p4263s1cc-__RUN__@example.test';
  SET LOCAL session_replication_role = origin;
  DELETE FROM auth.users WHERE id = A AND email = 'p4263s1cc-__RUN__@example.test';
END
$s1td$;
