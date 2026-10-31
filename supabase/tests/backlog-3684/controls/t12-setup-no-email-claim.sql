-- T12: auto_provision_it_admin no longer accepts an invitation by email (S3 inverted);
-- the placed-admin tenant bind still works.
SELECT pg_temp.mk_org('o_t12', NULL, 50);
SELECT pg_temp.mk_azure3851('u_x3', 't_t12');
SELECT pg_temp.mk_invite('i_t12', 'o_t12', 'u_x3-3917@example.test', 'admin');
SELECT pg_temp.check('T12 unplaced caller with a matching invite -> no_invite', pg_temp.outcome(pg_temp.prov('u_x3', 't_t12')) = 'no_invite', NULL);
SELECT pg_temp.check('T12 invite stays pending', pg_temp.row_state('i_t12') = '<null>|pending|false|invite', pg_temp.row_state('i_t12'));
SELECT pg_temp.check('T12 nothing bound', pg_temp.org_tenant('o_t12') = '<null>', NULL);
SELECT pg_temp.check('T12 no membership for the caller', pg_temp.member_rows('u_x3') = 0, NULL);
-- placed active admin, org without tenant -> binds (target a).
SELECT pg_temp.mk_org('o_t12b', NULL, 50);
SELECT pg_temp.mk_user3851('u_t12b');
SELECT pg_temp.mk_azure3851('u_t12b', 't_t12b');
SELECT pg_temp.mk_member('mem_t12b', 'o_t12b', 'u_t12b', 'admin', 'active');
CREATE TEMP TABLE r_t12 AS SELECT pg_temp.prov('u_t12b', 't_t12b') AS r;
SELECT pg_temp.check('T12 placed admin bind -> success, linked', pg_temp.outcome(r) = 'success' AND (r->>'tenant_linked')::boolean, r::text) FROM r_t12;
SELECT pg_temp.check('T12 placed admin tenant bound', pg_temp.org_tenant('o_t12b') = pg_temp.tid('t_t12b'), NULL);
-- placed admin, tenant held elsewhere -> tenant_in_use; other tenant on the org -> tenant_mismatch.
SELECT pg_temp.mk_org('o_t12c', NULL, 50);
SELECT pg_temp.mk_user3851('u_t12c');
SELECT pg_temp.mk_azure3851('u_t12c', 't_t12b');
SELECT pg_temp.mk_member('mem_t12c', 'o_t12c', 'u_t12c', 'admin', 'active');
SELECT pg_temp.check('T12 placed admin, tenant held -> tenant_in_use', pg_temp.outcome(pg_temp.prov('u_t12c', 't_t12b')) = 'tenant_in_use', NULL);
UPDATE public.organizations SET microsoft_tenant_id = pg_temp.tid('t_t12_other') WHERE id = pg_temp.id('o_t12c');
SELECT pg_temp.check('T12 placed admin, other tenant -> tenant_mismatch', pg_temp.outcome(pg_temp.prov('u_t12c', 't_t12b')) = 'tenant_mismatch', NULL);
-- placed suspended admin -> membership_inactive.
SELECT pg_temp.mk_org('o_t12d', NULL, 50);
SELECT pg_temp.mk_user3851('u_t12d');
SELECT pg_temp.mk_azure3851('u_t12d', 't_t12d');
SELECT pg_temp.mk_member('mem_t12d', 'o_t12d', 'u_t12d', 'admin', 'suspended');
SELECT pg_temp.check('T12 placed suspended admin -> membership_inactive', pg_temp.outcome(pg_temp.prov('u_t12d', 't_t12d')) = 'membership_inactive', NULL);
SELECT pg_temp.check('T12 no organization created', (SELECT count(*) FROM public.organizations) = (SELECT n FROM t3851s_orgs0) + 4, NULL);
