-- T10: a caller already in a brokerage (any status) is already_placed, before the token is read.
SELECT pg_temp.mk_org('o_t10', NULL, 50);
SELECT pg_temp.mk_org('o_t10b', NULL, 50);
SELECT pg_temp.mk_user3851('u_t10');
SELECT pg_temp.mk_member('mem_t10', 'o_t10', 'u_t10', 'agent', 'active');
SELECT pg_temp.mk_invite('i_t10', 'o_t10b', 'u_t10-3917@example.test', 'admin');
SELECT pg_temp.check('T10 active member of A with an invite to B -> already_placed', pg_temp.outcome(pg_temp.acc('u_t10', pg_temp.tok('i_t10'))) = 'already_placed', NULL);
SELECT pg_temp.check('T10 B invite stays pending', pg_temp.row_state('i_t10') = '<null>|pending|false|invite', pg_temp.row_state('i_t10'));
SELECT pg_temp.mk_user3851('u_t10s');
SELECT pg_temp.mk_member('mem_t10s', 'o_t10', 'u_t10s', 'agent', 'suspended');
SELECT pg_temp.mk_invite('i_t10s', 'o_t10b', 'u_t10s-3917@example.test', 'agent');
SELECT pg_temp.check('T10 suspended member -> already_placed', pg_temp.outcome(pg_temp.acc('u_t10s', pg_temp.tok('i_t10s'))) = 'already_placed', NULL);
SELECT pg_temp.check('T10 suspended member invite stays pending', pg_temp.row_state('i_t10s') = '<null>|pending|false|invite', pg_temp.row_state('i_t10s'));
