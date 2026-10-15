-- The caller's user metadata says tenant t_b; the identity says t_x.
-- Only the identity is used.
UPDATE auth.users SET raw_user_meta_data = jsonb_set(raw_user_meta_data, '{custom_claims,tid}', to_jsonb(pg_temp.tid('t_b')))
 WHERE id = pg_temp.id('u_x');
SELECT pg_temp.want('c3 fixture: metadata tid is t_b',
  (SELECT raw_user_meta_data->'custom_claims'->>'tid' FROM auth.users WHERE id = pg_temp.id('u_x')), pg_temp.tid('t_b'));
SELECT pg_temp.want('c3 refused with 42501', pg_temp.provision(pg_temp.id('u_x'), pg_temp.tid('t_b')), '~^ERR 42501 ');
SELECT pg_temp.want('c3 no membership in org_b', pg_temp.role_in(pg_temp.id('u_x'), pg_temp.tid('t_b')), '<none>');
