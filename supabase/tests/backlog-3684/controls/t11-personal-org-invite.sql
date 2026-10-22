-- T11: an invite row inside a personal organization is never accepted, nor detected.
SELECT pg_temp.mk_user3851('u_t11o');
SELECT pg_temp.mk_personal('p_t11', 'u_t11o');
SELECT pg_temp.mk_auth_only('u_t11', 'u_t11-3917@example.test');
SELECT pg_temp.mk_invite('i_t11', 'p_t11', 'u_t11-3917@example.test', 'agent');
SELECT pg_temp.check('T11 detector false for a personal-org invite', pg_temp.det('u_t11') = 'false', pg_temp.det('u_t11'));
SELECT pg_temp.check('T11 personal-org invite -> invalid_invite', pg_temp.outcome(pg_temp.acc('u_t11', pg_temp.tok('i_t11'))) = 'invalid_invite', NULL);
SELECT pg_temp.check('T11 row unchanged', pg_temp.row_state('i_t11') = '<null>|pending|false|invite', pg_temp.row_state('i_t11'));
