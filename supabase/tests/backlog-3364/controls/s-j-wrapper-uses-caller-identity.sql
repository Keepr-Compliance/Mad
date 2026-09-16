-- S-j: public.ensure_personal_organization takes no argument and acts on the
-- caller (auth.uid()). As a signed-in user it creates THAT user's personal
-- organization; with no claim it writes nothing.

DO $catalog$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'ensure_personal_organization';
  PERFORM pg_temp.check(n = 1, format('exactly one function named ensure_personal_organization, got %s', n));
  PERFORM pg_temp.check((SELECT pronargs FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'ensure_personal_organization') = 0,
                        'the wrapper takes no arguments');
  PERFORM pg_temp.check((SELECT prosecdef FROM pg_proc WHERE oid = 'public._ensure_personal_organization_for(uuid)'::regprocedure),
                        'internal function is SECURITY DEFINER');
  PERFORM set_config('t3364.sj_orgs_before', (SELECT count(*) FROM public.organizations)::text, true);
END
$catalog$;

SELECT pg_temp.act_as(current_setting('t3364.u_solo')::uuid);
SELECT set_config('t3364.sj_result', public.ensure_personal_organization()::text, true) IS NOT NULL AS called;
RESET ROLE;

SELECT pg_temp.act_as(NULL);
SELECT set_config('t3364.sj_anon_result', public.ensure_personal_organization()::text, true) IS NOT NULL AS called_without_claim;
RESET ROLE;

DO $assert$
DECLARE
  k_user uuid := current_setting('t3364.u_solo')::uuid;
  v  jsonb := current_setting('t3364.sj_result')::jsonb;
  v0 jsonb := current_setting('t3364.sj_anon_result')::jsonb;
BEGIN
  PERFORM pg_temp.check(v->>'status' = 'created', format('signed-in call returns created, got %s', v));
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM public.organizations WHERE id = (v->>'organization_id')::uuid AND personal_owner_user_id = k_user),
                        'the organization belongs to the caller');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM public.organization_members WHERE organization_id = (v->>'organization_id')::uuid AND user_id = k_user),
                        'the caller is its member');
  PERFORM pg_temp.check(v0->>'status' = 'not_authenticated', format('call without a claim returns not_authenticated, got %s', v0));
  PERFORM pg_temp.check((SELECT count(*) FROM public.organizations) = current_setting('t3364.sj_orgs_before')::bigint + 1,
                        'exactly one organization written across both calls');
END
$assert$;
