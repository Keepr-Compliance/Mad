-- S-k1: only the database's own functions may set or change
-- organizations.personal_owner_user_id.
--   brokerage admin (signed in), own brokerage, set to self       : ERROR 42501
--   brokerage admin (signed in), own brokerage, set to other user : ERROR 42501
--   brokerage admin (signed in), own brokerage, change `name`     : 1 row   <- proves the
--       admin's UPDATE reaches the row, so the errors above are the guard, not RLS
--   service_role UPDATE and INSERT naming the column              : ERROR 42501
--   the functions' owner role                                     : allowed

SELECT pg_temp.act_as(current_setting('t3364.u_brk_admin')::uuid);
DO $as_admin$
DECLARE
  n integer;
BEGIN
  BEGIN
    UPDATE public.organizations SET personal_owner_user_id = auth.uid()
     WHERE id = current_setting('t3364.o_brk_a')::uuid;
    GET DIAGNOSTICS n = ROW_COUNT;
    PERFORM set_config('t3364.k1_self', 'updated:' || n, true);
  EXCEPTION WHEN insufficient_privilege THEN
    PERFORM set_config('t3364.k1_self', 'error:' || SQLERRM, true);
  END;

  BEGIN
    UPDATE public.organizations SET personal_owner_user_id = current_setting('t3364.u_target')::uuid
     WHERE id = current_setting('t3364.o_brk_a')::uuid;
    GET DIAGNOSTICS n = ROW_COUNT;
    PERFORM set_config('t3364.k1_other', 'updated:' || n, true);
  EXCEPTION WHEN insufficient_privilege THEN
    PERFORM set_config('t3364.k1_other', 'error:' || SQLERRM, true);
  END;

  UPDATE public.organizations SET name = name WHERE id = current_setting('t3364.o_brk_a')::uuid;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('t3364.k1_name', n::text, true);
END
$as_admin$;
RESET ROLE;

SET LOCAL ROLE service_role;
DO $as_service$
DECLARE
  n integer;
BEGIN
  BEGIN
    UPDATE public.organizations SET personal_owner_user_id = current_setting('t3364.u_joiner')::uuid
     WHERE id = current_setting('t3364.o_brk_b')::uuid;
    GET DIAGNOSTICS n = ROW_COUNT;
    PERFORM set_config('t3364.k1_service_update', 'updated:' || n, true);
  EXCEPTION WHEN insufficient_privilege THEN
    PERFORM set_config('t3364.k1_service_update', 'error:' || SQLERRM, true);
  END;

  BEGIN
    INSERT INTO public.organizations (name, slug, personal_owner_user_id)
    VALUES ('fixture-3364 service insert', 'fixture-3364-service-insert', current_setting('t3364.u_leaver')::uuid);
    PERFORM set_config('t3364.k1_service_insert', 'inserted', true);
  EXCEPTION WHEN insufficient_privilege THEN
    PERFORM set_config('t3364.k1_service_insert', 'error:' || SQLERRM, true);
  END;
END
$as_service$;
RESET ROLE;

DO $assert$
DECLARE
  n integer;
BEGIN
  PERFORM pg_temp.check(current_setting('t3364.k1_self') LIKE 'error:%personal_owner_user_id%',
                        format('admin setting the column to self is refused by the guard, got %s', current_setting('t3364.k1_self')));
  PERFORM pg_temp.check(current_setting('t3364.k1_other') LIKE 'error:%personal_owner_user_id%',
                        format('admin setting the column to another user is refused by the guard, got %s', current_setting('t3364.k1_other')));
  PERFORM pg_temp.check(current_setting('t3364.k1_name') = '1',
                        format('the same admin CAN update another column of the row (RLS admits them), got %s', current_setting('t3364.k1_name')));
  PERFORM pg_temp.check(current_setting('t3364.k1_service_update') LIKE 'error:%personal_owner_user_id%',
                        format('service_role update of the column is refused, got %s', current_setting('t3364.k1_service_update')));
  PERFORM pg_temp.check(current_setting('t3364.k1_service_insert') LIKE 'error:%personal_owner_user_id%',
                        format('service_role insert naming the column is refused, got %s', current_setting('t3364.k1_service_insert')));
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM public.organizations
                                    WHERE id IN (current_setting('t3364.o_brk_a')::uuid, current_setting('t3364.o_brk_b')::uuid)
                                      AND personal_owner_user_id IS NOT NULL),
                        'both brokerages still have the column NULL');

  -- The owner role (the role running this block, which owns the functions) may.
  PERFORM pg_temp.check(current_user = (SELECT pg_get_userbyid(proowner) FROM pg_proc
                                        WHERE oid = 'public._ensure_personal_organization_for(uuid)'::regprocedure),
                        'this block runs as the functions'' owner');
  UPDATE public.organizations SET personal_owner_user_id = current_setting('t3364.u_claimer')::uuid
   WHERE id = current_setting('t3364.o_brk_b')::uuid;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM pg_temp.check(n = 1, format('the owner role can set the column, got %s rows', n));
END
$assert$;
