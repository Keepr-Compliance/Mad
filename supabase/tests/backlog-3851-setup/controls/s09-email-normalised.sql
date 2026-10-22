-- S9: invited_email with padding and upper case matches the caller's auth email.
SELECT pg_temp.mk_azure3851('u_x3', 't_s9');
SELECT pg_temp.mk_invite('i_s9', 'x_org', '  U_X3-3917@Example.TEST ', 'agent');
CREATE TEMP TABLE r_s9 AS SELECT pg_temp.prov('u_x3', 't_s9') AS r;
SELECT pg_temp.check('S9 outcome success', pg_temp.outcome(r) = 'success', r::text) FROM r_s9;
SELECT pg_temp.check('S9 invite claimed', pg_temp.row_state('i_s9') = pg_temp.id('u_x3')::text || '|active|true|invite', pg_temp.row_state('i_s9'));
