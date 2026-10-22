-- T3: the invited email holder presents a wrong / empty / NULL token -> invalid_invite.
SELECT pg_temp.mk_org('o_t3', NULL, 50);
SELECT pg_temp.mk_auth_only('u_t3', 'u_t3-3917@example.test');
SELECT pg_temp.mk_invite('i_t3', 'o_t3', 'u_t3-3917@example.test', 'agent');
SELECT pg_temp.check('T3 wrong token -> invalid_invite', pg_temp.outcome(pg_temp.acc('u_t3', 'tok-3851-setup-nope')) = 'invalid_invite', NULL);
SELECT pg_temp.check('T3 empty token -> invalid_invite', pg_temp.outcome(pg_temp.acc('u_t3', '')) = 'invalid_invite', NULL);
SELECT pg_temp.check('T3 NULL token -> invalid_invite', pg_temp.outcome(pg_temp.acc('u_t3', NULL)) = 'invalid_invite', NULL);
SELECT pg_temp.check('T3 row unchanged', pg_temp.row_state('i_t3') = '<null>|pending|false|invite', pg_temp.row_state('i_t3'));
