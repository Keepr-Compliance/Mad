-- BACKLOG-3538 fixtures. Run as postgres after ../backlog-3679/lib/fixtures.sql
-- and BEFORE any guard exists (neither migration has run yet), so these writes
-- cannot be changed by the joined_at pin or by any mutant of it.
-- Fixed join dates for k14: the column default is NULL, so they are set explicitly.
UPDATE public.organization_members SET joined_at = '2021-05-05 00:00:00+00' WHERE id = pg_temp.id('m_member');
INSERT INTO public.organization_members
 (id, organization_id, user_id, role, license_status, invited_email, invitation_token, invitation_expires_at, invited_by, provisioned_by, joined_at) VALUES
 -- an invite B accepted in O2 in 2021 (target of the service_role write in k14).
 -- Not E: backlog-3679 k07 moves E's O1 membership into O2 as postgres.
 (pg_temp.id('m_claimed'), pg_temp.id('org2'), pg_temp.id('u_b'), 'agent', 'active', 'other-3679@example.test', NULL, NULL, pg_temp.id('u_d'), 'invite', '2021-05-05 00:00:00+00');
