-- W14: the outbox insert raises -> WARNING only; the suspension and the reinstatement still land.
CREATE FUNCTION pg_temp.boom() RETURNS trigger LANGUAGE plpgsql AS $b$ BEGIN RAISE EXCEPTION 'fixture: outbox insert refused'; END $b$;
CREATE TRIGGER t3878_boom BEFORE INSERT ON public.billing_outbox FOR EACH ROW EXECUTE FUNCTION pg_temp.boom();
SELECT pg_temp.suspend_test_user();
SELECT pg_temp.admin_ok('SELECT public.admin_unsuspend_user(''{u_test}'')::text');
SELECT pg_temp.check('licence active again, no outbox row', pg_temp.lic_status('u_test') = 'active' AND NOT EXISTS (SELECT 1 FROM public.billing_outbox));
DROP TRIGGER t3878_boom ON public.billing_outbox;
