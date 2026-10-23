-- T2: a non-member with a different email presents a forwarded token -> email_mismatch.
SELECT pg_temp.mk_org('o_t2', NULL, 50);
SELECT pg_temp.mk_auth_only('u_t2', 'u_t2-3917@example.test');
SELECT pg_temp.mk_invite('i_t2', 'o_t2', 'victim-t2-3917@example.test', 'admin');
SELECT pg_temp.check('T2 detector false (not their email)', pg_temp.det('u_t2') = 'false', pg_temp.det('u_t2'));
SELECT pg_temp.check('T2 forwarded token -> email_mismatch', pg_temp.outcome(pg_temp.acc('u_t2', pg_temp.tok('i_t2'))) = 'email_mismatch', NULL);
SELECT pg_temp.check('T2 row unchanged', pg_temp.row_state('i_t2') = '<null>|pending|false|invite', pg_temp.row_state('i_t2'));
SELECT pg_temp.check('T2 no membership for the caller', pg_temp.member_rows('u_t2') = 0, NULL);
