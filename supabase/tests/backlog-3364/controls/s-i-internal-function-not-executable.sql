-- S-i: the internal function cannot be executed by anon, authenticated or PUBLIC;
-- the wrapper can be executed by authenticated and not by anon. Checked in the
-- catalog AND by calling the internal function as the signed-in user.

DO $catalog$
BEGIN
  PERFORM pg_temp.check(NOT has_function_privilege('authenticated', 'public._ensure_personal_organization_for(uuid)', 'EXECUTE'),
                        'authenticated has no EXECUTE on the internal function');
  PERFORM pg_temp.check(NOT has_function_privilege('anon', 'public._ensure_personal_organization_for(uuid)', 'EXECUTE'),
                        'anon has no EXECUTE on the internal function');
  PERFORM pg_temp.check(NOT EXISTS (
    SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    WHERE p.oid = 'public._ensure_personal_organization_for(uuid)'::regprocedure
      AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
  ), 'PUBLIC has no EXECUTE on the internal function');
  PERFORM pg_temp.check(has_function_privilege('authenticated', 'public.ensure_personal_organization()', 'EXECUTE'),
                        'authenticated can EXECUTE the wrapper');
  PERFORM pg_temp.check(NOT has_function_privilege('anon', 'public.ensure_personal_organization()', 'EXECUTE'),
                        'anon cannot EXECUTE the wrapper');
  PERFORM pg_temp.check(NOT EXISTS (
    SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    WHERE p.oid = 'public.ensure_personal_organization()'::regprocedure
      AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
  ), 'PUBLIC has no EXECUTE on the wrapper');
END
$catalog$;

SELECT pg_temp.act_as(current_setting('t3364.u_solo')::uuid);
DO $as_user$
BEGIN
  BEGIN
    PERFORM public._ensure_personal_organization_for(current_setting('t3364.u_target')::uuid);
    PERFORM set_config('t3364.si_call', 'executed', true);
  EXCEPTION WHEN insufficient_privilege THEN
    PERFORM set_config('t3364.si_call', 'denied', true);
  END;
END
$as_user$;
RESET ROLE;

DO $assert$
BEGIN
  PERFORM pg_temp.check(current_setting('t3364.si_call') = 'denied',
                        format('signed-in user calling the internal function is denied, got %s', current_setting('t3364.si_call')));
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM public.organizations WHERE personal_owner_user_id = current_setting('t3364.u_target')::uuid),
                        'no organization created for the other user');
END
$assert$;
