-- m06 (M1 + M2) deactivated member -> individual pay-as-you-go; reactivation retires the
-- personal row; an unassigned member is still "in the brokerage" (no personal org).
INSERT INTO public.plans (id, name, slug, tier, is_default, is_active) VALUES
  (md5('backlog-3851:plan_ind')::uuid, 'Individual 3851', 'individual-3851', 'individual', true, true);
INSERT INTO public.licenses (user_id, license_key)
SELECT pg_temp.id(u), 'lic-3851-' || u FROM unnest(ARRAY['u_otact','u_otun','u_oag','u_otsus']) u;
SELECT pg_temp.set_status('o_tun', 'unassigned');
CREATE FUNCTION pg_temp.personal(p_user text) RETURNS text LANGUAGE sql AS $f$
  SELECT coalesce(string_agg(m.license_status, ','), '<none>') FROM public.organization_members m
    JOIN public.organizations o ON o.id = m.organization_id
   WHERE m.user_id = pg_temp.id(p_user) AND o.personal_owner_user_id = pg_temp.id(p_user) $f$;

-- 1. Deactivation (deactivateUser.ts writes license_status = 'suspended' with the service client).
SELECT pg_temp.check('m06 deactivate o_tact',
  pg_temp.keep('service_role', NULL, format('update public.organization_members set license_status = %L where id = %L', 'suspended', pg_temp.id('o_tact'))) = 'OK rows=1', NULL);
SELECT pg_temp.check('m06 deactivated member now has an active personal membership', pg_temp.personal('u_otact') = 'active', pg_temp.personal('u_otact'));
SELECT pg_temp.check('m06 brokerage row stays suspended', pg_temp.status('o_tact') = 'suspended', NULL);
-- 2. A later status change on the deactivated row keeps the personal row.
SELECT pg_temp.check('m06 suspended -> expired',
  pg_temp.keep('service_role', NULL, format('update public.organization_members set license_status = %L where id = %L', 'expired', pg_temp.id('o_tact'))) = 'OK rows=1', NULL);
SELECT pg_temp.check('m06 personal row survives suspended -> expired', pg_temp.personal('u_otact') = 'active', pg_temp.personal('u_otact'));
-- 3. Reactivation retires the personal row.
SELECT pg_temp.check('m06 reactivate via set_member_license', (pg_temp.sml_keep('u_oad', 'o_tact', 'reactivate') ->> 'success') = 'true', NULL);
SELECT pg_temp.check('m06 reactivation retired the personal membership', pg_temp.personal('u_otact') = '<none>', pg_temp.personal('u_otact'));
-- 4. Unassigned is still in the brokerage: the desktop self-heal is refused.
SELECT pg_temp.check('m06 unassigned member: ensure_personal_organization -> has_membership',
  pg_temp.as_user('u_otun', 'select public.ensure_personal_organization() ->> ''status''') = 'OK has_membership',
  pg_temp.as_user('u_otun', 'select public.ensure_personal_organization() ->> ''status'''));
-- 5. Already-deactivated member (fixture o_tsus): the desktop self-heal now succeeds.
SELECT pg_temp.check('m06 deactivated member: ensure_personal_organization -> created',
  pg_temp.as_user('u_otsus', 'select public.ensure_personal_organization() ->> ''status''') = 'OK created',
  pg_temp.as_user('u_otsus', 'select public.ensure_personal_organization() ->> ''status'''));
-- 6. Active in another brokerage: deactivation in one does not create a personal org.
INSERT INTO public.organization_members (organization_id, user_id, role, license_status, provisioned_by)
VALUES (pg_temp.id('x_org'), pg_temp.id('u_oag'), 'agent', 'active', 'invite');
SELECT pg_temp.check('m06 deactivate o_ag (still active in x_org)',
  pg_temp.keep('service_role', NULL, format('update public.organization_members set license_status = %L where id = %L', 'suspended', pg_temp.id('o_ag'))) = 'OK rows=1', NULL);
SELECT pg_temp.check('m06 ... no personal org while another brokerage membership is active', pg_temp.personal('u_oag') = '<none>', pg_temp.personal('u_oag'));
-- 7. No licence: deactivation commits, no personal org.
SELECT pg_temp.check('m06 deactivate o_tbr (no licence) commits',
  pg_temp.keep('service_role', NULL, format('update public.organization_members set license_status = %L where id = %L', 'suspended', pg_temp.id('o_tbr'))) = 'OK rows=1'
  AND pg_temp.status('o_tbr') = 'suspended', NULL);
SELECT pg_temp.check('m06 ... and no personal org', pg_temp.personal('u_otbr') = '<none>', NULL);
