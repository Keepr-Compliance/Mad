-- S16: an org whose only seat is the caller's pending invite -> the claim succeeds.
SELECT pg_temp.mk_org('org_s16', NULL, 1);
SELECT pg_temp.mk_invite('i_s16', 'org_s16', 'u_x3-3917@example.test', 'admin');
SELECT pg_temp.mk_azure3851('u_x3', 't_s16');
CREATE TEMP TABLE r_s16 AS SELECT pg_temp.prov('u_x3', 't_s16') AS r;
SELECT pg_temp.check('S16 outcome success', pg_temp.outcome(r) = 'success', r::text) FROM r_s16;
SELECT pg_temp.check('S16 seats still 1 of 1', pg_temp.seats('org_s16') = 1, pg_temp.seats('org_s16')::text);
SELECT pg_temp.check('S16 invite claimed', pg_temp.row_state('i_s16') = pg_temp.id('u_x3')::text || '|active|true|invite', pg_temp.row_state('i_s16'));
