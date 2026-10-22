-- S12: an organization already uses the slug the caller passes -> no 23505 (no INSERT).
INSERT INTO public.organizations (id, name, slug, max_seats) VALUES (pg_temp.id('org_s12'), 'Happyhomey Test 3851 setup S12', 'probe-3851-setup', 5);
SELECT pg_temp.mk_azure3851('u_x3', 't_s12');
CREATE TEMP TABLE r_s12 AS SELECT pg_temp.prov('u_x3', 't_s12') AS r;
SELECT pg_temp.check('S12 no-invite caller with a clashing slug -> no_invite, not an error', pg_temp.outcome(r) = 'no_invite', r::text) FROM r_s12;
SELECT pg_temp.mk_azure3851('u_m2', 't_s12b');
CREATE TEMP TABLE r_s12b AS SELECT pg_temp.prov('u_m2', 't_s12b') AS r;
SELECT pg_temp.check('S12 placed admin with a clashing slug -> success', pg_temp.outcome(r) = 'success', r::text) FROM r_s12b;
