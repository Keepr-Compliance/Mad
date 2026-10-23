-- T7: matching uses auth.users.email only, trimmed and case-insensitive; never metadata.
SELECT pg_temp.mk_org('o_t7', NULL, 50);
-- auth email NULL, metadata email = the invite.
SELECT pg_temp.mk_auth_only('u_t7n', NULL, jsonb_build_object('email', 'u_t7n-3917@example.test', 'mail', 'u_t7n-3917@example.test'));
SELECT pg_temp.mk_invite('i_t7n', 'o_t7', 'u_t7n-3917@example.test', 'admin');
SELECT pg_temp.check('T7 NULL auth email + metadata match -> email_mismatch', pg_temp.outcome(pg_temp.acc('u_t7n', pg_temp.tok('i_t7n'))) = 'email_mismatch', NULL);
SELECT pg_temp.check('T7 detector false for NULL auth email', pg_temp.det('u_t7n') = 'false', pg_temp.det('u_t7n'));
-- auth email different, metadata email = the invite.
SELECT pg_temp.mk_auth_only('u_t7d', 'other-t7d-3917@example.test', jsonb_build_object('email', 'u_t7d-3917@example.test'));
SELECT pg_temp.mk_invite('i_t7d', 'o_t7', 'u_t7d-3917@example.test', 'admin');
SELECT pg_temp.check('T7 other auth email + metadata match -> email_mismatch', pg_temp.outcome(pg_temp.acc('u_t7d', pg_temp.tok('i_t7d'))) = 'email_mismatch', NULL);
SELECT pg_temp.check('T7 refused rows unchanged',
  pg_temp.row_state('i_t7n') = '<null>|pending|false|invite' AND pg_temp.row_state('i_t7d') = '<null>|pending|false|invite', NULL);
-- invited email padded and upper case; auth email lower case.
SELECT pg_temp.mk_auth_only('u_t7c', 'u_t7c-3917@example.test');
SELECT pg_temp.mk_invite('i_t7c', 'o_t7', '  U_T7C-3917@Example.TEST ', 'agent');
SELECT pg_temp.check('T7 detector true across case and padding', pg_temp.det('u_t7c') = 'true', pg_temp.det('u_t7c'));
SELECT pg_temp.check('T7 case and padding -> success', pg_temp.outcome(pg_temp.acc('u_t7c', pg_temp.tok('i_t7c'))) = 'success', NULL);
