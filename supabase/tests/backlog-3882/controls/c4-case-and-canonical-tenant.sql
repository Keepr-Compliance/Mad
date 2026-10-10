-- An upper-case tenant from the caller still matches the identity, and the org
-- is stored under the identity's (lower-case) value, so the next colleague,
-- passing lower case, joins the SAME org.
SELECT pg_temp.want('c4 upper-case tenant accepted', pg_temp.provision(pg_temp.id('u_a1'), upper(pg_temp.tid('t_a'))), '~^OK .*"role": "admin"');
SELECT pg_temp.want('c4 org stored under the identity tid',
  (SELECT string_agg(microsoft_tenant_id, ',') FROM public.organizations WHERE lower(microsoft_tenant_id) = pg_temp.tid('t_a')), pg_temp.tid('t_a'));
SELECT pg_temp.want('c4 padded tenant accepted', pg_temp.provision(pg_temp.id('u_a2'), ' ' || pg_temp.tid('t_a') || ' '), '~^OK .*"role": "agent"');
SELECT pg_temp.want('c4 one org for t_a', pg_temp.org_count(pg_temp.tid('t_a')), '1');
