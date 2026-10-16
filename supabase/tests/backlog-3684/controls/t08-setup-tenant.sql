-- T8: /setup?token path, accept_invitation(token, tenant). The bind is checked BEFORE the
-- claim, so a refusal leaves the invite pending (founder Q1 = a).
SELECT pg_temp.mk_org('o_t8', NULL, 50);
SELECT pg_temp.mk_azure3851('u_x3', 't_t8');
SELECT pg_temp.mk_invite('i_t8', 'o_t8', 'u_x3-3917@example.test', 'admin');
-- tenant held by another org -> tenant_in_use; nothing claimed or bound.
SELECT pg_temp.mk_org('o_t8held', pg_temp.tid('t_t8'), 50);
SELECT pg_temp.check('T8 tenant held elsewhere -> tenant_in_use', pg_temp.outcome(pg_temp.acc('u_x3', pg_temp.tok('i_t8'), 't_t8')) = 'tenant_in_use', NULL);
SELECT pg_temp.check('T8 tenant_in_use leaves the invite pending', pg_temp.row_state('i_t8') = '<null>|pending|false|invite', pg_temp.row_state('i_t8'));
SELECT pg_temp.check('T8 tenant_in_use binds nothing', pg_temp.org_tenant('o_t8') = '<null>', pg_temp.org_tenant('o_t8'));
-- held in upper case elsewhere -> tenant_in_use too.
UPDATE public.organizations SET microsoft_tenant_id = upper(pg_temp.tid('t_t8')) WHERE id = pg_temp.id('o_t8held');
SELECT pg_temp.check('T8 held upper case -> tenant_in_use', pg_temp.outcome(pg_temp.acc('u_x3', pg_temp.tok('i_t8'), 't_t8')) = 'tenant_in_use', NULL);
-- org holds another tenant -> tenant_mismatch.
UPDATE public.organizations SET microsoft_tenant_id = NULL WHERE id = pg_temp.id('o_t8held');
UPDATE public.organizations SET microsoft_tenant_id = pg_temp.tid('t_t8_other') WHERE id = pg_temp.id('o_t8');
SELECT pg_temp.check('T8 org holds another tenant -> tenant_mismatch', pg_temp.outcome(pg_temp.acc('u_x3', pg_temp.tok('i_t8'), 't_t8')) = 'tenant_mismatch', NULL);
SELECT pg_temp.check('T8 tenant_mismatch leaves the invite pending', pg_temp.row_state('i_t8') = '<null>|pending|false|invite', pg_temp.row_state('i_t8'));
-- identity checks (3882 c1/c6 shapes): a tenant the caller did not sign in with -> 42501.
UPDATE public.organizations SET microsoft_tenant_id = NULL WHERE id = pg_temp.id('o_t8');
SELECT pg_temp.check('T8 tenant not among the caller identities -> 42501', pg_temp.outcome(pg_temp.acc('u_x3', pg_temp.tok('i_t8'), 't_t8_not_mine')) = 'ERR 42501', NULL);
UPDATE auth.users SET raw_user_meta_data = jsonb_build_object('custom_claims', jsonb_build_object('tid', pg_temp.tid('t_t8_meta'))) WHERE id = pg_temp.id('u_x3');
SELECT pg_temp.check('T8 metadata tenant -> 42501', pg_temp.outcome(pg_temp.acc('u_x3', pg_temp.tok('i_t8'), 't_t8_meta')) = 'ERR 42501', NULL);
SELECT pg_temp.mk_auth_only('u_t8c', 'u_t8c-3917@example.test');
INSERT INTO auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
VALUES ('c-3684-t8', pg_temp.id('u_t8c'), jsonb_build_object('sub', 'c-3684-t8', 'custom_claims', jsonb_build_object('tid', '9188040d-6c67-4c5b-b112-36a304b66dad')), 'azure', now(), now(), now()); -- pii-allow-uuid: Microsoft's public personal-account tenant constant
SELECT pg_temp.mk_invite('i_t8c', 'o_t8', 'u_t8c-3917@example.test', 'admin');
SELECT pg_temp.check('T8 personal-account tenant -> 42501',
  pg_temp.outcome(pg_temp.acc('u_t8c', pg_temp.tok('i_t8c'), NULL, '9188040d-6c67-4c5b-b112-36a304b66dad')) = 'ERR 42501', NULL); -- pii-allow-uuid: Microsoft's public personal-account tenant constant
SELECT pg_temp.check('T8 refusals claimed and bound nothing',
  pg_temp.row_state('i_t8') = '<null>|pending|false|invite' AND pg_temp.row_state('i_t8c') = '<null>|pending|false|invite'
  AND pg_temp.org_tenant('o_t8') = '<null>', NULL);
-- free tenant, padded upper case -> claimed and bound lower case.
CREATE TEMP TABLE r_t8 AS SELECT pg_temp.acc('u_x3', pg_temp.tok('i_t8'), NULL, ' ' || upper(pg_temp.tid('t_t8')) || ' ') AS r;
SELECT pg_temp.check('T8 free tenant -> success, tenant_linked', pg_temp.outcome(r) = 'success' AND (r->>'tenant_linked')::boolean AND r->>'role' = 'admin', r::text) FROM r_t8;
SELECT pg_temp.check('T8 claimed', pg_temp.row_state('i_t8') = pg_temp.id('u_x3')::text || '|active|true|invite', pg_temp.row_state('i_t8'));
SELECT pg_temp.check('T8 bound lower case', pg_temp.org_tenant('o_t8') = pg_temp.tid('t_t8'), pg_temp.org_tenant('o_t8'));
-- an invited agent with a tenant: claimed, tenant never bound or checked against holders.
SELECT pg_temp.mk_org('o_t8a', NULL, 50);
SELECT pg_temp.mk_auth_only('u_t8a', 'u_t8a-3917@example.test');
SELECT pg_temp.mk_azure3851('u_t8a', 't_t8');
SELECT pg_temp.mk_invite('i_t8a', 'o_t8a', 'u_t8a-3917@example.test', 'agent');
CREATE TEMP TABLE r_t8a AS SELECT pg_temp.acc('u_t8a', pg_temp.tok('i_t8a'), 't_t8') AS r;
SELECT pg_temp.check('T8 agent with a held tenant -> success, not linked', pg_temp.outcome(r) = 'success' AND NOT (r->>'tenant_linked')::boolean, r::text) FROM r_t8a;
SELECT pg_temp.check('T8 agent org tenant untouched', pg_temp.org_tenant('o_t8a') = '<null>', pg_temp.org_tenant('o_t8a'));
