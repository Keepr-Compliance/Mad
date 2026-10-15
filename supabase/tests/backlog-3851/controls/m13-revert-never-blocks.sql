-- m13 (M1 + M2) R8: a failure inside the pay-go revert never blocks a deactivation.
INSERT INTO public.licenses (user_id, license_key) VALUES (pg_temp.id('u_otact'), 'lic-3851-m13');
CREATE OR REPLACE FUNCTION public._ensure_personal_organization_for(p_user_id uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $f$ BEGIN RAISE EXCEPTION 'forced failure (m13)'; END $f$;
SELECT pg_temp.check('m13 deactivation commits although the revert raises',
  pg_temp.keep('service_role', NULL, format('update public.organization_members set license_status = %L where id = %L', 'suspended', pg_temp.id('o_tact'))) = 'OK rows=1',
  pg_temp.keep('service_role', NULL, 'select 1'));
SELECT pg_temp.check('m13 row is suspended', pg_temp.status('o_tact') = 'suspended', pg_temp.status('o_tact'));
