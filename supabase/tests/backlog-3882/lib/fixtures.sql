-- BACKLOG-3882 fixtures. Synthetic users, identities and organizations,
-- created inside the run's transaction (always rolled back).
--
-- Row SHAPES are transcribed from production (keys only, read 2026-10-10,
-- SELECT on jsonb_object_keys; no values copied):
--   azure  auth.identities.identity_data keys: custom_claims, email,
--          email_verified (boolean), full_name, iss, phone_verified,
--          preferred_username, provider_id, sub; custom_claims keys: email,
--          oid, sid, tid; provider_id = sub; iss contains the tid; tid is
--          lowercase. raw_user_meta_data carries the same keys.
--   google identity_data keys: avatar_url, custom_claims (hd), email,
--          email_verified, full_name, iss, name, phone_verified, picture,
--          provider_id, sub.
-- Values are invented: ids and tenant ids are md5-derived from fixture names,
-- addresses use the .example.test domain.
CREATE FUNCTION pg_temp.azure_data(p_user text, p_tid text) RETURNS jsonb LANGUAGE sql AS $f$
  SELECT jsonb_build_object(
    'custom_claims', jsonb_build_object('email', p_user || '@fixture-3882.example.test',
                                        'oid', pg_temp.tid('oid_' || p_user), 'sid', md5('sid:' || p_user), 'tid', p_tid),
    'email', p_user || '@fixture-3882.example.test',
    'email_verified', true,
    'full_name', 'Fixture ' || p_user,
    'iss', 'https://login.microsoftonline.com/' || p_tid || '/v2.0',
    'phone_verified', false,
    'preferred_username', p_user || '@fixture-3882.example.test',
    'provider_id', md5('sub:' || p_user),
    'sub', md5('sub:' || p_user)) $f$;

CREATE FUNCTION pg_temp.mk_user(p_user text, p_meta jsonb, p_provider text) RETURNS void LANGUAGE sql AS $f$
  INSERT INTO auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
  VALUES (pg_temp.id(p_user), p_user || '@fixture-3882.example.test', p_meta,
          jsonb_build_object('provider', p_provider, 'providers', jsonb_build_array(p_provider))) $f$;

CREATE FUNCTION pg_temp.mk_azure(p_user text, p_tid text) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE d jsonb := pg_temp.azure_data(p_user, p_tid);
BEGIN
  PERFORM pg_temp.mk_user(p_user, d, 'azure');
  INSERT INTO auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  VALUES (d->>'sub', pg_temp.id(p_user), d, 'azure', now(), now(), now());
END $f$;

DO $fx$
DECLARE g jsonb;
BEGIN
  PERFORM pg_temp.mk_azure('u_a1', pg_temp.tid('t_a'));
  PERFORM pg_temp.mk_azure('u_a2', pg_temp.tid('t_a'));
  PERFORM pg_temp.mk_azure('u_x', pg_temp.tid('t_x'));
  -- u_x's identity sub / provider_id is a uuid-shaped value controls can pass as a tenant
  UPDATE auth.identities SET provider_id = pg_temp.tid('oid_x'),
         identity_data = identity_data || jsonb_build_object('provider_id', pg_temp.tid('oid_x'), 'sub', pg_temp.tid('oid_x'))
   WHERE user_id = pg_temp.id('u_x');
  PERFORM pg_temp.mk_azure('u_cons', '9188040d-6c67-4c5b-b112-36a304b66dad'); -- pii-allow-uuid: Microsoft's public personal-account tenant constant
  PERFORM pg_temp.mk_azure('u_badmin', pg_temp.tid('t_b'));
  PERFORM pg_temp.mk_azure('u_p', pg_temp.tid('t_p'));
  PERFORM pg_temp.mk_azure('u_inviter', pg_temp.tid('t_p'));

  g := jsonb_build_object('avatar_url', 'https://fixture-3882.example.test/a.png',
         'custom_claims', jsonb_build_object('hd', 'fixture-3882.example.test'),
         'email', 'u_g@fixture-3882.example.test', 'email_verified', true, 'full_name', 'Fixture u_g',
         'iss', 'https://accounts.google.com', 'name', 'Fixture u_g', 'phone_verified', false,
         'picture', 'https://fixture-3882.example.test/a.png', 'provider_id', pg_temp.tid('t_g'), 'sub', pg_temp.tid('t_g'));
  PERFORM pg_temp.mk_user('u_g', g, 'google');
  INSERT INTO auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  VALUES (pg_temp.tid('t_g'), pg_temp.id('u_g'), g, 'google', now(), now(), now());

  -- org_b: an existing tenant org with a claimed admin
  INSERT INTO public.organizations (id, name, slug, microsoft_tenant_id, plan, max_seats)
  VALUES (pg_temp.id('org_b'), 'Fixture Org B 3882', 'fixture-org-b-3882', pg_temp.tid('t_b'), 'trial', 10);
  INSERT INTO public.users (id, email, oauth_provider, oauth_id)
  VALUES (pg_temp.id('u_badmin'), 'u_badmin@fixture-3882.example.test', 'azure', md5('sub:u_badmin')),
         (pg_temp.id('u_inviter'), 'u_inviter@fixture-3882.example.test', 'azure', md5('sub:u_inviter'));
  INSERT INTO public.organization_members (organization_id, user_id, role, joined_at, license_status, provisioned_by)
  VALUES (pg_temp.id('org_b'), pg_temp.id('u_badmin'), 'admin', now(), 'active', 'jit');

  -- org_p: pre-created white-glove org with two UNCLAIMED invite rows (one 'admin')
  INSERT INTO public.organizations (id, name, slug, microsoft_tenant_id, plan, max_seats)
  VALUES (pg_temp.id('org_p'), 'Fixture Org P 3882', 'fixture-org-p-3882', pg_temp.tid('t_p'), 'trial', 10);
  INSERT INTO public.organization_members (organization_id, user_id, invited_email, role, license_status,
         invitation_token, invitation_expires_at, invited_by, invited_at, provisioned_by)
  VALUES (pg_temp.id('org_p'), NULL, 'invitee-agent@fixture-3882.example.test', 'agent', 'pending',
          'fixture-token-3882-agent', now() + interval '7 days', pg_temp.id('u_inviter'), now(), 'invite'),
         (pg_temp.id('org_p'), NULL, 'invitee-admin@fixture-3882.example.test', 'admin', 'pending',
          'fixture-token-3882-admin', now() + interval '7 days', pg_temp.id('u_inviter'), now(), 'invite');
END $fx$;
