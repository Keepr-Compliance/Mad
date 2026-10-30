-- T1: the invitee presents the token from the email and holds the invited email -> claimed.
SELECT pg_temp.mk_org('o_t1', NULL, 50);
SELECT pg_temp.mk_auth_only('u_t1', 'u_t1-3917@example.test');
SELECT pg_temp.mk_invite('i_t1', 'o_t1', 'u_t1-3917@example.test', 'agent');
SELECT pg_temp.check('T1 detector true before the claim', pg_temp.det('u_t1') = 'true', pg_temp.det('u_t1'));
CREATE TEMP TABLE r_t1 AS SELECT pg_temp.acc('u_t1', pg_temp.tok('i_t1')) AS r;
SELECT pg_temp.check('T1 outcome success', pg_temp.outcome(r) = 'success', r::text) FROM r_t1;
SELECT pg_temp.check('T1 result names the org and role', (r->>'organization_id')::uuid = pg_temp.id('o_t1') AND r->>'role' = 'agent'
  AND (r->>'user_id')::uuid = pg_temp.id('u_t1') AND NOT (r->>'tenant_linked')::boolean, r::text) FROM r_t1;
SELECT pg_temp.check('T1 row claimed: user, active, token cleared',
  pg_temp.row_state('i_t1') = pg_temp.id('u_t1')::text || '|active|true|invite', pg_temp.row_state('i_t1'));
SELECT pg_temp.check('T1 joined_at set', (SELECT joined_at IS NOT NULL FROM public.organization_members WHERE id = pg_temp.id('i_t1')), NULL);
SELECT pg_temp.check('T1 first-time caller gets a public.users row (provider from app metadata)',
  (SELECT oauth_provider FROM public.users WHERE id = pg_temp.id('u_t1')) = 'azure', NULL);
SELECT pg_temp.check('T1 detector false after the claim', pg_temp.det('u_t1') = 'false', pg_temp.det('u_t1'));
-- T5: the same token again, by a second account: the row is gone from the lookup.
SELECT pg_temp.mk_auth_only('u_t1b', 'u_t1b-3917@example.test');
SELECT pg_temp.check('T5 replayed token -> invalid_invite', pg_temp.outcome(pg_temp.acc('u_t1b', pg_temp.tok('i_t1'))) = 'invalid_invite', NULL);
-- Google first-time caller: provider kept; an unknown provider is stored as unknown.
SELECT pg_temp.mk_invite('i_t1g', 'o_t1', 'u_t1g-3917@example.test', 'agent');
INSERT INTO auth.users (id, email, aud, role, raw_user_meta_data, raw_app_meta_data)
VALUES (pg_temp.id('u_t1g'), 'u_t1g-3917@example.test', 'authenticated', 'authenticated', '{}'::jsonb, '{"provider":"google"}'::jsonb);
SELECT pg_temp.check('T1g google invitee claimed', pg_temp.outcome(pg_temp.acc('u_t1g', pg_temp.tok('i_t1g'))) = 'success', NULL);
SELECT pg_temp.check('T1g users row provider google', (SELECT oauth_provider FROM public.users WHERE id = pg_temp.id('u_t1g')) = 'google', NULL);
SELECT pg_temp.mk_invite('i_t1x', 'o_t1', 'u_t1x-3917@example.test', 'agent');
INSERT INTO auth.users (id, email, aud, role, raw_user_meta_data, raw_app_meta_data)
VALUES (pg_temp.id('u_t1x'), 'u_t1x-3917@example.test', 'authenticated', 'authenticated', '{}'::jsonb, '{"provider":"github"}'::jsonb);
CREATE TEMP TABLE r_t1x AS SELECT pg_temp.acc('u_t1x', pg_temp.tok('i_t1x')) AS r;
SELECT pg_temp.check('T1x other provider claimed, stored as unknown',
  pg_temp.outcome(r) = 'success' AND (SELECT oauth_provider FROM public.users WHERE id = pg_temp.id('u_t1x')) = 'unknown',
  r::text || ' / ' || coalesce((SELECT oauth_provider FROM public.users WHERE id = pg_temp.id('u_t1x')), '<no row>')) FROM r_t1x;
