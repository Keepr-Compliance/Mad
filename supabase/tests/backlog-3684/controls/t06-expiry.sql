-- T6: expiry swept at the boundary, for accept_invitation and for the detector (control 12).
SELECT pg_temp.mk_org('o_t6', NULL, 50);
SELECT pg_temp.mk_auth_only('u_t6a', 'u_t6a-3917@example.test');
SELECT pg_temp.mk_auth_only('u_t6b', 'u_t6b-3917@example.test');
SELECT pg_temp.mk_auth_only('u_t6c', 'u_t6c-3917@example.test');
SELECT pg_temp.mk_auth_only('u_t6d', 'u_t6d-3917@example.test');
SELECT pg_temp.mk_invite('i_t6a', 'o_t6', 'u_t6a-3917@example.test', 'agent', now() - interval '1 second');
SELECT pg_temp.mk_invite('i_t6b', 'o_t6', 'u_t6b-3917@example.test', 'agent', now());
SELECT pg_temp.mk_invite('i_t6c', 'o_t6', 'u_t6c-3917@example.test', 'agent', now() + interval '1 second');
SELECT pg_temp.mk_invite('i_t6d', 'o_t6', 'u_t6d-3917@example.test', 'agent', NULL);
SELECT pg_temp.check('T6 detector -1 s false', pg_temp.det('u_t6a') = 'false', pg_temp.det('u_t6a'));
SELECT pg_temp.check('T6 detector now() false', pg_temp.det('u_t6b') = 'false', pg_temp.det('u_t6b'));
SELECT pg_temp.check('T6 detector +1 s true', pg_temp.det('u_t6c') = 'true', pg_temp.det('u_t6c'));
SELECT pg_temp.check('T6 detector NULL expiry true', pg_temp.det('u_t6d') = 'true', pg_temp.det('u_t6d'));
SELECT pg_temp.check('T6 accept -1 s -> expired', pg_temp.outcome(pg_temp.acc('u_t6a', pg_temp.tok('i_t6a'))) = 'expired', NULL);
SELECT pg_temp.check('T6 accept now() -> expired', pg_temp.outcome(pg_temp.acc('u_t6b', pg_temp.tok('i_t6b'))) = 'expired', NULL);
SELECT pg_temp.check('T6 expired rows unchanged',
  pg_temp.row_state('i_t6a') = '<null>|pending|false|invite' AND pg_temp.row_state('i_t6b') = '<null>|pending|false|invite', NULL);
SELECT pg_temp.check('T6 accept +1 s -> success', pg_temp.outcome(pg_temp.acc('u_t6c', pg_temp.tok('i_t6c'))) = 'success', NULL);
SELECT pg_temp.check('T6 accept NULL expiry -> success', pg_temp.outcome(pg_temp.acc('u_t6d', pg_temp.tok('i_t6d'))) = 'success', NULL);
