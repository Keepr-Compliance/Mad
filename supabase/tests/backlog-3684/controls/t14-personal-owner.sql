-- T14 (XPP): the owner of a personal organization with a pending brokerage invite.
-- Detector true; without the token nothing is accepted; with it, accepted and the
-- personal membership retired.
SELECT pg_temp.mk_org('o_t14', NULL, 50);
SELECT pg_temp.mk_invite('i_t14', 'o_t14', 'u_pp-3917@example.test', 'agent');
SELECT pg_temp.check('T14 personal owner: detector true', pg_temp.det('u_pp') = 'true', pg_temp.det('u_pp'));
SELECT pg_temp.check('T14 no token -> invalid_invite', pg_temp.outcome(pg_temp.acc('u_pp', NULL)) = 'invalid_invite', NULL);
SELECT pg_temp.check('T14 invite still pending', pg_temp.row_state('i_t14') = '<null>|pending|false|invite', pg_temp.row_state('i_t14'));
SELECT pg_temp.check('T14 with the token -> success', pg_temp.outcome(pg_temp.acc('u_pp', pg_temp.tok('i_t14'))) = 'success', NULL);
SELECT pg_temp.check('T14 claimed', pg_temp.row_state('i_t14') = pg_temp.id('u_pp')::text || '|active|true|invite', pg_temp.row_state('i_t14'));
SELECT pg_temp.check('T14 personal membership retired', NOT EXISTS (SELECT 1 FROM public.organization_members WHERE id = pg_temp.id('pp_m')), NULL);
