-- A personal Microsoft account (consumer tenant) with a matching identity is refused.
SELECT pg_temp.want('c6 consumer tenant refused',
  pg_temp.provision(pg_temp.id('u_cons'), (SELECT identity_data->'custom_claims'->>'tid' FROM auth.identities WHERE user_id = pg_temp.id('u_cons'))),
  '~^ERR 42501 personal Microsoft accounts');
SELECT pg_temp.want('c6 no org for the consumer tenant',
  (SELECT count(*)::text FROM public.organizations o JOIN auth.identities i ON i.user_id = pg_temp.id('u_cons')
    WHERE o.microsoft_tenant_id = i.identity_data->'custom_claims'->>'tid'), '0');
