-- provider_id / sub identify the user, not the tenant. Passing them is refused,
-- for an azure identity and for a google-only user.
SELECT pg_temp.want('c5 azure provider_id as tenant refused', pg_temp.provision(pg_temp.id('u_x'), pg_temp.tid('oid_x')), '~^ERR 42501 ');
SELECT pg_temp.want('c5 no org for the azure provider_id', pg_temp.org_count(pg_temp.tid('oid_x')), '0');
SELECT pg_temp.want('c5 no org for the caller''s real tenant either', pg_temp.org_count(pg_temp.tid('t_x')), '0');
SELECT pg_temp.want('c5 google-only user refused', pg_temp.provision(pg_temp.id('u_g'), pg_temp.tid('t_g')), '~^ERR 42501 ');
SELECT pg_temp.want('c5 no org for the google sub', pg_temp.org_count(pg_temp.tid('t_g')), '0');
