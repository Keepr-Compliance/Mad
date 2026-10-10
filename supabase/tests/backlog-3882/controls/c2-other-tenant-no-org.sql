-- Same caller asks for t_a, which has no org yet: nothing is created.
SELECT pg_temp.want('c2 refused with 42501', pg_temp.provision(pg_temp.id('u_x'), pg_temp.tid('t_a')), '~^ERR 42501 ');
SELECT pg_temp.want('c2 no org created for t_a', pg_temp.org_count(pg_temp.tid('t_a')), '0');
