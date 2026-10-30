-- S13: the BACKLOG-3882 identity checks (3882 c1-c6) against this body.
SELECT pg_temp.mk_azure3851('u_x3', 't_s13');
SELECT pg_temp.mk_invite('i_s13', 'x_org', 'u_x3-3917@example.test', 'admin');
-- c1/c2: a tenant the caller did not sign in with (held / not held).
SELECT pg_temp.check('S13 c1 other tenant, org exists -> 42501', pg_temp.outcome(pg_temp.prov('u_x3', 't_o')) = 'ERR 42501', NULL);
SELECT pg_temp.check('S13 c2 other tenant, no org -> 42501', pg_temp.outcome(pg_temp.prov('u_x3', 't_s13_other')) = 'ERR 42501', NULL);
-- c3: user metadata tenant is not trusted.
UPDATE auth.users SET raw_user_meta_data = jsonb_build_object('custom_claims', jsonb_build_object('tid', pg_temp.tid('t_s13_meta')))
 WHERE id = pg_temp.id('u_x3');
SELECT pg_temp.check('S13 c3 metadata tenant -> 42501', pg_temp.outcome(pg_temp.prov('u_x3', 't_s13_meta')) = 'ERR 42501', NULL);
-- c5: provider_id is not a tenant; a google-only user is refused.
SELECT pg_temp.check('S13 c5 provider id as tenant -> 42501', pg_temp.outcome(pg_temp.prov('u_x3', NULL, 'sub-3851-u_x3')) = 'ERR 42501', NULL);
SELECT pg_temp.mk_auth_only('u_s13g', 'u_s13g-3917@example.test');
INSERT INTO auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
VALUES ('g-3851-s13', pg_temp.id('u_s13g'), jsonb_build_object('sub', 'g-3851-s13', 'custom_claims', jsonb_build_object('tid', pg_temp.tid('t_s13g'))), 'google', now(), now(), now());
SELECT pg_temp.check('S13 c5 google identity -> 42501', pg_temp.outcome(pg_temp.prov('u_s13g', 't_s13g')) = 'ERR 42501', NULL);
-- c6: the personal Microsoft account tenant, with a matching identity.
SELECT pg_temp.mk_auth_only('u_s13c', 'u_s13c-3917@example.test');
INSERT INTO auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
VALUES ('c-3851-s13', pg_temp.id('u_s13c'), jsonb_build_object('sub', 'c-3851-s13', 'custom_claims', jsonb_build_object('tid', '9188040d-6c67-4c5b-b112-36a304b66dad')), 'azure', now(), now(), now()); -- pii-allow-uuid: Microsoft's public personal-account tenant constant
SELECT pg_temp.check('S13 c6 consumer tenant -> 42501',
  pg_temp.outcome(pg_temp.prov('u_s13c', NULL, '9188040d-6c67-4c5b-b112-36a304b66dad')) = 'ERR 42501', NULL); -- pii-allow-uuid: Microsoft's public personal-account tenant constant
SELECT pg_temp.check('S13 nothing claimed or bound by the refusals',
  pg_temp.row_state('i_s13') = '<null>|pending|false|invite' AND pg_temp.org_tenant('x_org') = '<null>', pg_temp.row_state('i_s13'));
-- c4: upper case and padding accepted; stored under the identity's lower-case value.
CREATE TEMP TABLE r_s13 AS SELECT pg_temp.prov('u_x3', NULL, ' ' || upper(pg_temp.tid('t_s13')) || ' ') AS r;
SELECT pg_temp.check('S13 c4 padded upper-case tenant -> success', pg_temp.outcome(r) = 'success', r::text) FROM r_s13;
SELECT pg_temp.check('S13 c4 stored lower case', pg_temp.org_tenant('x_org') = pg_temp.tid('t_s13'), pg_temp.org_tenant('x_org'));
