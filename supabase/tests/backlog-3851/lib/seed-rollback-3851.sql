-- BACKLOG-3851 rollback seed (between the migrations and rollback-3851.sql): the states a
-- rollback must handle. Two 'unassigned' rows; with M2, one deactivation that attached a
-- personal organization (R7d: survives the rollback, stated in its header).
SELECT pg_temp.set_status('f_un', 'unassigned');
SELECT pg_temp.set_status('o_tun', 'unassigned');
DO $seed$ BEGIN
  IF to_regprocedure('public._revert_deactivated_member_to_paygo()') IS NOT NULL THEN
    INSERT INTO public.plans (id, name, slug, tier, is_default, is_active) VALUES
      (md5('backlog-3851:plan_ind')::uuid, 'Individual 3851', 'individual-3851', 'individual', true, true);
    INSERT INTO public.licenses (user_id, license_key) VALUES (pg_temp.id('u_otact'), 'lic-3851-rb');
    UPDATE public.organization_members SET license_status = 'suspended' WHERE id = pg_temp.id('o_tact');
  END IF;
END $seed$;
SELECT 'SEED3851|' || count(*) FROM public.organization_members WHERE license_status = 'unassigned';
